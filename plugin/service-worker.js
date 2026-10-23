/**
 * Chronicle Chat Exporter — service worker.
 *
 * De enige plek met het ingest-token. Content scripts leveren een genormaliseerd
 * gesprek (ParsedConversation-vorm) aan; de worker valideert tegen de whitelist,
 * bewaart transport-fouten in een retry-queue en POST naar Chronicle's lokale
 * ingest-listener (http://127.0.0.1:4580/ingest/chat). Van daaruit loopt de
 * bestaande pijp: archiefkopie in Chronicle, forward naar Foundation.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:4580';
const QUEUE_KEY = 'chronicle_retry_queue';
const MAX_QUEUE = 100;
// Attachments are fetched and delivered one by one before the chat; the chat
// payload itself carries references only. 25 MB matches Chronicle's listener
// and Foundation's attachment store — bigger files are reported as gaps.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_CACHE_KEY = 'chronicle_attachment_cache';
const MAX_CACHED_ATTACHMENTS = 400;

/** Velden die de listener accepteert — alles wat er niet in staat is een 422. */
const ALLOWED_KEYS = [
  'content', 'turns', 'title', 'url', 'sourceProvider', 'occurredAt', 'createdAt',
  'attachments', 'attachmentGaps',
];

/** Server-owned velden — nooit aanbieden, ook niet per ongeluk. */
const FORBIDDEN_KEYS = [
  'status', 'providerConversationId', 'contentHash', 'id',
  'ingestedAt', 'updatedAt', 'objectType',
  'tags', 'summary', 'embedding', 'assets', 'links',
];

/** Client-side typeward: identiek beleid als de listener en ingestPolicy.js. */
function validateConversation(conv) {
  if (!conv || typeof conv !== 'object') return 'conversation must be an object';
  for (const key of Object.keys(conv)) {
    if (FORBIDDEN_KEYS.includes(key)) return `"${key}" is server-owned and must not be sent`;
    if (!ALLOWED_KEYS.includes(key)) return `unknown field "${key}"`;
  }
  if (typeof conv.content !== 'string' || !conv.content.trim()) {
    return '"content" is required and must be a non-empty string';
  }
  if (conv.turns !== undefined && !Array.isArray(conv.turns)) {
    return '"turns" must be an array of {role, text}';
  }
  if (conv.url !== undefined && typeof conv.url !== 'string') {
    return '"url" must be a string';
  }
  if (conv.title !== undefined && typeof conv.title !== 'string') {
    return '"title" must be a string';
  }
  if (conv.sourceProvider !== undefined && typeof conv.sourceProvider !== 'string') {
    return '"sourceProvider" must be a string';
  }
  if (conv.attachments !== undefined) {
    if (!Array.isArray(conv.attachments)) return '"attachments" must be an array';
    for (const att of conv.attachments) {
      if (!att || typeof att !== 'object') return '"attachments" items must be objects';
    }
  }
  if (conv.attachmentGaps !== undefined) {
    if (!Array.isArray(conv.attachmentGaps)) return '"attachmentGaps" must be an array';
    for (const gap of conv.attachmentGaps) {
      if (!gap || typeof gap !== 'object' || typeof gap.reason !== 'string') {
        return '"attachmentGaps" items must carry a reason';
      }
    }
  }
  return null;
}

async function getConfig() {
  const data = await chrome.storage.local.get(['baseUrl', 'token']);
  return {
    baseUrl: (data.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
    token: data.token || '',
  };
}

let queueWrite = Promise.resolve();

/**
 * Serialiseert alle queue-mutaties achter één promise-ketting, zodat een
 * enqueue tijdens een flush niet meer door een setQueue(remaining) van die
 * flush wordt weggegooid (de race die eerder items kon verliezen).
 */
function withQueueLock(fn) {
  queueWrite = queueWrite.then(fn, fn);
  return queueWrite;
}

async function getQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  return data[QUEUE_KEY] || [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
}

/**
 * Zet een levering in de wachtrij, gedupliceerd op gespreks-URL: herhaalde
 * transport-fouten van hetzelfde gesprek stapelden eerder tientallen kopieën
 * op. De nieuwste versie wint (het gesprek kan groeien tussen pogingen).
 */
async function enqueue(conv) {
  return withQueueLock(async () => {
    const queue = await getQueue();
    const url = conv && conv.url;
    const kept = url ? queue.filter((e) => !e.conv || e.conv.url !== url) : queue;
    kept.push({ conv: withoutInlineBytes(conv), at: Date.now() });
    await setQueue(kept);
  });
}

// ── Attachments ──────────────────────────────────────────────────────────────
// Bytes never travel with the chat payload: each file is downloaded here (the
// service worker has the provider host permissions and the session cookies),
// POSTed to Chronicle's /ingest/attachment, and the chat then references the
// returned id. That keeps the 5 MB chat limit and Postgres free of base64.

/**
 * Naam voor een tekstextractie: de originele naam blijft staan, zodat je ziet
 * wélk bestand het was, met een suffix dat zegt dat dit de tekst is en niet het
 * origineel (bijv. "rapport.pdf-tekstextractie.txt").
 */
function extractionFilename(filename) {
  const base = filename ? String(filename) : 'document';
  return `${base}-tekstextractie.txt`;
}

function extensionForMime(mimeType) {
  const map = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt',
  };
  return map[String(mimeType || '').toLowerCase()] || 'bin';
}

async function chatgptAccessToken() {
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.accessToken ? body.accessToken : null;
  } catch {
    return null;
  }
}

async function fetchDirect(ref) {
  const res = await fetch(ref.url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_ATTACHMENT_BYTES) throw new Error('groter dan 25 MB');
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('groter dan 25 MB');
  const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim();
  // Een bron die 'pdf' in plaats van 'application/pdf' zegt is geen mime-type;
  // de response-header is dan betrouwbaarder.
  const refMime = String(ref.mimeType || '').includes('/') ? ref.mimeType : null;
  return {
    bytes,
    filename: ref.filename || null,
    mimeType: refMime || contentType || null,
  };
}

async function fetchChatGptFile(ref) {
  const id = ref.providerFileId;
  // Gegenereerde foto's (sediment://) hebben geen download-endpoint; de CDN-url
  // uit de pagina is dan de enige route. Een id met underscore is zo'n
  // sediment-bestand, dus die proberen we niet eerst via de API.
  const sediment = /^file_/.test(String(id));
  let lastError = null;
  if (!sediment) {
    try {
      const token = await chatgptAccessToken();
      const res = await fetch(
        `https://chatgpt.com/backend-api/files/${encodeURIComponent(id)}/download`,
        {
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: 'include',
          cache: 'no-store',
        }
      );
      if (!res.ok) throw new Error(`chatgpt download ${res.status}`);
      const body = await res.json().catch(() => null);
      const url = body && (body.download_url || body.url);
      if (!url) throw new Error('chatgpt gaf geen download-url');
      return await fetchDirect({ url, filename: ref.filename, mimeType: ref.mimeType });
    } catch (err) {
      lastError = err;
    }
  }
  if (ref.url) {
    return fetchDirect({ url: ref.url, filename: ref.filename, mimeType: ref.mimeType });
  }
  throw lastError || new Error('geen download-url voor deze chatgpt-afbeelding');
}

/**
 * Claude's webclient kent geen gedocumenteerde downloadroute; deze kandidaten
 * zijn de paden die de UI zelf gebruikt. Een HTML-antwoord is een pagina, geen
 * bestand — dat telt als mislukking, zodat de tekstextractie de kans krijgt.
 */
async function fetchClaudeFile(ref) {
  if (!ref.org) throw new Error('claude org-id ontbreekt');
  const base = `https://claude.ai/api/organizations/${ref.org}/files/${encodeURIComponent(ref.providerFileId)}`;
  const candidates = [`${base}/contents`, `${base}/download`, `${base}/preview`];
  let lastError = 'claude-bestand niet downloadbaar';
  for (const url of candidates) {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        lastError = `claude download ${res.status}`;
        continue;
      }
      const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim();
      if (/text\/html/i.test(contentType)) {
        lastError = 'claude gaf een pagina in plaats van het bestand';
        continue;
      }
      const bytes = await res.arrayBuffer();
      if (!bytes.byteLength) {
        lastError = 'claude gaf een leeg bestand';
        continue;
      }
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('groter dan 25 MB');
      return {
        bytes,
        filename: ref.filename || null,
        mimeType: ref.mimeType || contentType || null,
      };
    } catch (err) {
      if (/groter dan 25 MB/.test(String(err && err.message))) throw err;
      lastError = String((err && err.message) || err);
    }
  }
  throw new Error(lastError);
}

function textExtraction(ref) {
  return {
    bytes: new TextEncoder().encode(String(ref.text)),
    filename: extractionFilename(ref.filename),
    mimeType: 'text/plain',
  };
}

/**
 * Haalt de bytes voor één referentie op. De originele bytes gaan vóór: alleen
 * als de download écht niet lukt, valt een Claude-bijlage terug op de
 * tekstextractie die de API al meegaf (als .txt, met een naam die dat zegt).
 */
async function fetchAttachment(ref) {
  // Bytes die de pagina al had (blob:-afbeeldingen van gegenereerde foto's).
  // Ze staan als base64 in de ref; de service worker kan die blob zelf niet
  // ophalen, het content script wel.
  if (ref.dataBase64) {
    const binary = atob(String(ref.dataBase64));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return {
      bytes,
      filename: ref.filename || 'chatgpt-afbeelding',
      mimeType: ref.mimeType || 'image/png',
    };
  }
  if (ref.download === 'chatgpt' && ref.providerFileId) {
    return fetchChatGptFile(ref);
  }
  if (ref.download === 'claude' && ref.providerFileId) {
    try {
      return await fetchClaudeFile(ref);
    } catch (err) {
      if (ref.text) return textExtraction(ref);
      throw err;
    }
  }
  if (ref.url) {
    try {
      return await fetchDirect(ref);
    } catch (err) {
      if (ref.text) return textExtraction(ref);
      throw err;
    }
  }
  if (ref.text) return textExtraction(ref);
  throw new Error('geen downloadroute voor deze bijlage');
}

function attachmentCacheKey(ref) {
  if (ref.providerFileId) return 'id:' + ref.providerFileId;
  if (ref.url) return 'url:' + ref.url;
  if (ref.text) return 'text:' + (ref.filename || '') + ':' + ref.text.length;
  return null;
}

async function getCachedAttachment(ref) {
  const key = attachmentCacheKey(ref);
  if (!key) return null;
  const data = await chrome.storage.local.get(ATTACHMENT_CACHE_KEY);
  const cache = data[ATTACHMENT_CACHE_KEY] || {};
  return cache[key] || null;
}

async function cacheAttachment(ref, attachment) {
  const key = attachmentCacheKey(ref);
  if (!key) return;
  // Een tekstextractie is de tweedekeuze: niet cachen onder het file-id, zodat
  // een volgende levering het origineel opnieuw probeert (netwerk kan terug zijn).
  if (ref.providerFileId && /-tekstextractie\.txt$/i.test(String(attachment.filename || ''))) return;
  // Alleen lokaal bewaard (Foundation was onbereikbaar): ook niet cachen, zodat
  // een volgende levering de upload opnieuw probeert en het echte id oplevert.
  if (attachment && (attachment.foundationPending === true || /^local:/i.test(String(attachment.id || '')))) return;
  const data = await chrome.storage.local.get(ATTACHMENT_CACHE_KEY);
  const cache = data[ATTACHMENT_CACHE_KEY] || {};
  cache[key] = attachment;
  // Bounded: drop the oldest insertions (object key order is insertion order).
  const keys = Object.keys(cache);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_ATTACHMENTS))) {
    delete cache[stale];
  }
  await chrome.storage.local.set({ [ATTACHMENT_CACHE_KEY]: cache });
}

/** POST de bytes naar Chronicle; die spiegelt lokaal en uploadt naar Foundation. */
async function uploadAttachment({ bytes, filename, mimeType }, { baseUrl, token }) {
  // Naam zonder extensie (bijv. een gegenereerde foto) krijgt er één bij, anders
  // staat er een bestand zonder type in de lijst en in de download.
  let name = filename ? String(filename) : '';
  if (!name) name = `bijlage.${extensionForMime(mimeType)}`;
  else if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = `${name}.${extensionForMime(mimeType)}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/ingest/attachment`, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'X-Attachment-Filename': encodeURIComponent(name),
      },
      body: bytes,
    });
  } catch (err) {
    return { ok: false, error: 'Chronicle niet bereikbaar — bijlage niet opgeslagen' };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: body.error || `bijlage-upload mislukt (${response.status})` };
  }
  return { ok: true, body };
}

/**
 * Vervangt de referenties door wat Chronicle teruggeeft. Wat niet lukt wordt
 * een gap op de chat — eerlijk vastgelegd, nooit naar Foundation gestuurd.
 */
async function resolveAttachments(conv, config) {
  const refs = Array.isArray(conv.attachments) ? conv.attachments : [];
  const gaps = Array.isArray(conv.attachmentGaps) ? conv.attachmentGaps.slice() : [];
  if (!refs.length) return conv;

  const resolved = [];
  for (const ref of refs) {
    try {
      const cached = await getCachedAttachment(ref);
      if (cached && cached.id) {
        resolved.push(cached);
        continue;
      }
      const payload = await fetchAttachment(ref);
      const uploaded = await uploadAttachment(payload, config);
      if (!uploaded.ok) {
        gaps.push({ filename: ref.filename, mimeType: ref.mimeType, reason: uploaded.error });
        continue;
      }
      const attachment = {
        id: uploaded.body.id,
        filename: uploaded.body.filename,
        mimeType: uploaded.body.mimeType,
        size: uploaded.body.size,
        url: uploaded.body.url,
        hash: uploaded.body.hash,
        localUrl: uploaded.body.localUrl,
      };
      await cacheAttachment(ref, attachment);
      resolved.push(attachment);
    } catch (err) {
      gaps.push({
        filename: ref.filename,
        mimeType: ref.mimeType,
        reason: String((err && err.message) || err),
      });
    }
  }

  // Twee referenties kunnen op dezelfde bytes uitkomen (bijv. dezelfde foto als
  // API-pointer én als DOM-url). Chronicle dedupliceert de blob, maar de chat
  // zou het bestand dan twee keer in de lijst hebben — dus dedupe op id.
  const deduped = [];
  const seenIds = new Set();
  for (const attachment of resolved) {
    if (attachment.id && seenIds.has(attachment.id)) continue;
    if (attachment.id) seenIds.add(attachment.id);
    deduped.push(attachment);
  }

  const out = { ...conv };
  if (deduped.length) out.attachments = deduped;
  else delete out.attachments;
  if (gaps.length) out.attachmentGaps = gaps;
  else delete out.attachmentGaps;
  return out;
}

/**
 * Haalt inline bytes uit een gesprek vóór het in de wachtrij gaat. Base64 van
 * een paar MB zou het storage-quotum van de extensie opeten; de bijlage wordt
 * bij een retry dan een gap, de tekst blijft behouden.
 */
function withoutInlineBytes(conv) {
  if (!conv || !Array.isArray(conv.attachments)) return conv;
  const attachments = conv.attachments.map((ref) => {
    if (!ref || !ref.dataBase64) return ref;
    const { dataBase64, ...rest } = ref;
    return rest;
  });
  return { ...conv, attachments };
}

/** Levert één gesprek af. Transport-fout → queue; 4xx → definitief, niet queuen. */
async function deliver(conv) {
  const { baseUrl, token } = await getConfig();
  if (!token) {
    return { ok: false, error: 'geen token ingesteld — open de opties van de extensie' };
  }
  // Eerst de bijlagen (bytes apart), dan de chat met alleen verwijzingen.
  // De wachtrij bewaart het onbewerkte gesprek: een retry haalt opnieuw op en
  // hergebruikt wat al in de cache zit. Een fout in de bijlagelaag mag de
  // tekstlevering nooit blokkeren — dan gaat de chat zonder bijlagen door.
  let outgoing = conv;
  try {
    outgoing = await resolveAttachments(conv, { baseUrl, token });
  } catch (err) {
    console.warn('[Chronicle] bijlagen overslaan:', String((err && err.message) || err));
    outgoing = withoutInlineBytes(conv);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/ingest/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(outgoing),
    });
  } catch (err) {
    await enqueue(conv);
    return { ok: false, error: 'Chronicle niet bereikbaar — in de wachtrij gezet', queued: true };
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 422 || response.status === 400) {
    return { ok: false, error: body.details?.length ? body.details.join('; ') : (body.error || `afgewezen (${response.status})`), status: response.status };
  }
  if (!response.ok) {
    await enqueue(conv);
    return { ok: false, error: body.error || `Chronicle-fout (${response.status})`, queued: true };
  }
  return {
    ok: true,
    status: response.status,
    action: body.action, // 'create' | 'update' | 'duplicate'
    id: body.id,
    captured: body.captured,
    insertedNew: body.insertedNew,
    attachmentCount: (outgoing.attachments || []).length,
    gapCount: (outgoing.attachmentGaps || []).length,
  };
}

async function flushQueue(sender) {
  return withQueueLock(async () => {
    const queue = await getQueue();
    if (!queue.length) return;
    const remaining = [];
    let delivered = 0;
    for (const entry of queue) {
      const result = await deliver(entry.conv);
      if (result.ok || result.status === 400 || result.status === 401 || result.status === 422) {
        delivered++;
      } else {
        remaining.push(entry);
      }
    }
    await setQueue(remaining);
    if (delivered && sender && sender.tab) {
      chrome.tabs.sendMessage(sender.tab.id, { type: 'queue-flushed', delivered, remaining: remaining.length }).catch(() => {});
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === 'chronicle-export') {
      const invalid = validateConversation(message.conversation);
      if (invalid) {
        sendResponse({ ok: false, error: invalid });
        return;
      }
      const result = await deliver(message.conversation);
      // Eén levering is een goede moment om ook eerder vastgelopen
      // transport-fouten opnieuw te proberen.
      flushQueue(sender).catch(() => {});
      sendResponse(result);
      return;
    }
    if (message.type === 'chronicle-export-many') {
      const report = { total: 0, created: 0, updated: 0, duplicates: 0, failed: 0, queued: 0, gaps: 0 };
      const conversations = Array.isArray(message.conversations) ? message.conversations : [];
      report.total = conversations.length;
      const progress = () => {
        if (sender && sender.tab) {
          chrome.tabs.sendMessage(sender.tab.id, { type: 'chronicle-bulk-progress', report }).catch(() => {});
        }
      };
      for (const conv of conversations) {
        const invalid = validateConversation(conv);
        if (invalid) {
          report.failed++;
          continue;
        }
        const result = await deliver(conv);
        report.gaps += result.gapCount || 0;
        if (!result.ok && result.queued) report.queued++;
        else if (!result.ok) report.failed++;
        else if (result.action === 'update') report.updated++;
        else if (result.action === 'duplicate') report.duplicates++;
        else report.created++;
        progress();
      }
      await flushQueue(sender).catch(() => {});
      sendResponse({ ok: true, report });
      return;
    }
    if (message.type === 'chronicle-ping') {
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: 'unknown message type' });
  })();
  return true; // async sendResponse
});

// Bij het starten van de worker: wachtrij doorspoelen (alleen transport-fouten).
chrome.runtime.onStartup.addListener(() => { flushQueue(null); });
chrome.runtime.onInstalled.addListener(() => { flushQueue(null); });

// De toolbar-knop: alleen de provider-scripts kunnen het gesprek ophalen
// (same-origin cookies), dus de actie vraagt het actieve tab het gesprek te
// exporteren. Werkt ook als de zwevende knop door de site-CSS wordt bedekt.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'chronicle-click' });
  } catch {
    // Geen content script op dit tab (bijv. geen claude.ai/chatgpt.com) —
    //Chrome kan hier geen alert tonen vanuit de worker; stil negeren.
  }
});
