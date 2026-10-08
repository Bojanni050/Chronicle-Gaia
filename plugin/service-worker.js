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

/** Velden die de listener accepteert — alles wat er niet in staat is een 422. */
const ALLOWED_KEYS = ['content', 'turns', 'title', 'url', 'sourceProvider', 'occurredAt', 'createdAt'];

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
  return null;
}

async function getConfig() {
  const data = await chrome.storage.local.get(['baseUrl', 'token']);
  return {
    baseUrl: (data.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, ''),
    token: data.token || '',
  };
}

async function getQueue() {
  const data = await chrome.storage.local.get(QUEUE_KEY);
  return data[QUEUE_KEY] || [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [QUEUE_KEY]: queue.slice(-MAX_QUEUE) });
}

async function enqueue(conv) {
  const queue = await getQueue();
  queue.push({ conv, at: Date.now() });
  await setQueue(queue);
}

/** Levert één gesprek af. Transport-fout → queue; 4xx → definitief, niet queuen. */
async function deliver(conv) {
  const { baseUrl, token } = await getConfig();
  if (!token) {
    return { ok: false, error: 'geen token ingesteld — open de opties van de extensie' };
  }
  let response;
  try {
    response = await fetch(`${baseUrl}/ingest/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(conv),
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
  };
}

async function flushQueue(sender) {
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
  if (delivered && sender) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'queue-flushed', delivered, remaining: remaining.length }).catch(() => {});
  }
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
      sendResponse(result);
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
