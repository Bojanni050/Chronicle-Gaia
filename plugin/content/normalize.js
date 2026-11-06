/**
 * Gedeelde UI-hulp voor de provider-scripts: de "→ Chronicle"-knop met
 * statusfeedback (✓ nieuw / ✓ bijgewerkt / duplicate / wachtrij / mislukt),
 * in een inklapbare container die in een instelbare hoek staat
 * (chrome.storage.local: `uiCorner`, `uiCollapsed`).
 *
 * Geen ES-modules: MV3 content scripts worden als gewone scripts geïnjecteerd,
 * dus deze helper hangt zijn functies aan window.__chronicleUI. Alles zit in
 * een IIFE: Chrome mag dit script vaker injecteren (extensie-herladen,
 * SPA-navigatie) zonder dat top-level declaraties botsen — de laatste injectie
 * wint en overschrijft het object.
 */
(() => {
  const CHRONICLE_STATUS = {
    idle: '→ Chronicle',
    busy: '…',
    create: '✓ In Chronicle',
    update: '✓ Bijgewerkt',
    duplicate: '✓ Actueel',
    queued: '⏳ In wachtrij',
  };

  /**
   * Positie + inklappen van de plugin-UI.
   *
   * Alle knoppen hangen in één fixed container (#chronicle-ui) die in de
   * gekozen hoek staat; de knoppen zelf zijn niet meer gepositioneerd. De
   * voorkeuren leven in chrome.storage.local (`uiCorner`, `uiCollapsed`) en
   * werken direct door op open tabs via chrome.storage.onChanged — een
   * wijziging op de optiepagina vraagt dus geen herlaad van de gesprekstabs.
   *
   * Standaardgedrag blijft ongewijzigd: rechtsonder, uitgeklapt.
   */
  const UI_CORNERS = {
    'bottom-right': { vertical: 'bottom', horizontal: 'right' },
    'bottom-left': { vertical: 'bottom', horizontal: 'left' },
    'top-right': { vertical: 'top', horizontal: 'right' },
    'top-left': { vertical: 'top', horizontal: 'left' },
  };
  const DEFAULT_CORNER = 'bottom-right';

  const uiState = { corner: DEFAULT_CORNER, collapsed: false };
  const uiButtons = { export: null, bulk: null };
  let uiPanel = null;
  let uiToggle = null;
  let uiOptions = null;

  const BUTTON_STYLE = {
    padding: '8px 14px',
    borderRadius: '8px',
    border: '1px solid rgba(0,0,0,0.15)',
    background: '#fefef9',
    color: '#1c1917',
    font: '13px system-ui, sans-serif',
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  };

  /** Maakt de container met de knoppen + de inklap-toggle (idempotent). */
  function ensurePanel() {
    if (uiPanel && uiPanel.isConnected) return uiPanel;
    uiPanel = document.createElement('div');
    uiPanel.id = 'chronicle-ui';

    uiToggle = document.createElement('button');
    uiToggle.id = 'chronicle-ui-toggle';
    Object.assign(uiToggle.style, BUTTON_STYLE, {
      padding: '4px 10px',
      lineHeight: '1',
      fontSize: '12px',
      opacity: '0.85',
    });
    uiToggle.addEventListener('click', () => setCollapsed(!uiState.collapsed, true));

    uiPanel.appendChild(uiToggle);
    (document.body || document.documentElement).appendChild(uiPanel);
    layoutPanel();
    return uiPanel;
  }

  /** Zet de container in de gekozen hoek en verbergt de knoppen als er is ingeklapt. */
  function layoutPanel() {
    if (!uiPanel) return;
    const corner = UI_CORNERS[uiState.corner] || UI_CORNERS[DEFAULT_CORNER];
    Object.assign(uiPanel.style, {
      position: 'fixed',
      top: corner.vertical === 'top' ? '20px' : '',
      bottom: corner.vertical === 'bottom' ? '20px' : '',
      left: corner.horizontal === 'left' ? '20px' : '',
      right: corner.horizontal === 'right' ? '20px' : '',
      zIndex: '9999',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      alignItems: corner.horizontal === 'left' ? 'flex-start' : 'flex-end',
    });
    for (const button of [uiButtons.bulk, uiButtons.export]) {
      if (button) button.style.display = uiState.collapsed ? 'none' : '';
    }
    if (uiOptions) {
      uiOptions.style.display = !uiState.collapsed && uiOptions.dataset.open === 'true' ? 'flex' : 'none';
    }
    if (uiToggle) {
      uiToggle.textContent = uiState.collapsed ? 'Chronicle' : '⌄';
      uiToggle.title = uiState.collapsed
        ? 'Chronicle — klik om de meldingen uit te klappen'
        : 'Chronicle-meldingen inklappen';
    }
  }

  /** In-/uitklappen; `persist` schrijft de keuze terug naar chrome.storage.local. */
  function setCollapsed(collapsed, persist) {
    uiState.collapsed = !!collapsed;
    if (persist) {
      try {
        chrome.storage.local.set({ uiCollapsed: uiState.collapsed });
      } catch (err) {
        // Geen storage beschikbaar: de keuze geldt dan alleen deze pagina.
      }
    }
    layoutPanel();
  }

  function applyStoredPreferences(data) {
    if (data && UI_CORNERS[data.uiCorner]) uiState.corner = data.uiCorner;
    if (data) uiState.collapsed = !!data.uiCollapsed;
    layoutPanel();
  }

  function loadUiPreferences() {
    try {
      chrome.storage.local.get(['uiCorner', 'uiCollapsed'], (data) => {
        if (chrome.runtime.lastError) return;
        applyStoredPreferences(data);
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.uiCorner) {
          uiState.corner = UI_CORNERS[changes.uiCorner.newValue]
            ? changes.uiCorner.newValue
            : DEFAULT_CORNER;
        }
        if (changes.uiCollapsed) uiState.collapsed = !!changes.uiCollapsed.newValue;
        layoutPanel();
      });
    } catch (err) {
      // Zonder storage blijft de standaardhoek rechtsonder, uitgeklapt.
    }
  }

  function setButtonState(button, state, title) {
    button.textContent = CHRONICLE_STATUS[state] || CHRONICLE_STATUS.idle;
    button.title = title || '';
    button.dataset.state = state;
    button.disabled = state === 'busy';
  }

  function makeButton(onClick) {
    const existing = document.getElementById('chronicle-export-button');
    if (existing) {
      existing.remove(); // tweede injectie: vervang in plaats van verdubbelen
    }
    const button = document.createElement('button');
    button.id = 'chronicle-export-button';
    Object.assign(button.style, BUTTON_STYLE);
    setButtonState(button, 'idle');
    button.addEventListener('click', onClick);
    const panel = ensurePanel();
    panel.insertBefore(button, uiToggle); // de toggle blijft het laatste element (de hoek)
    uiButtons.export = button;
    layoutPanel();
    return button;
  }

  /** Stuurt het gesprek naar de service worker en vertaalt het antwoord naar knop-status. */
  async function exportToChronicle(button, conversation) {
    setButtonState(button, 'busy');
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'chronicle-export', conversation: toPayload(conversation) });
    } catch (err) {
      button.textContent = '✗ ' + String(err).slice(0, 60);
      button.title = String(err);
      setTimeout(() => setButtonState(button, 'idle'), 4000);
      return;
    }
    console.info('[Chronicle] leveringsresultaat:', JSON.stringify(response));
    if (!response || !response.ok) {
      if (response && response.queued) {
        setButtonState(button, 'queued', response.error || '');
      } else {
        button.textContent = '✗ ' + (response?.error || 'export mislukt').slice(0, 60);
        button.title = response?.error || 'export mislukt';
        setTimeout(() => setButtonState(button, 'idle'), 6000);
      }
      return;
    }
    setButtonState(button, response.action || 'create');
    if (response.gapCount) {
      button.title = `${response.gapCount} bijlage(n) niet opgehaald — zie de chat in Chronicle`;
    }
  }

  /**
   * Normaliseert een tijdsaanduiding naar epoch-ms. Accepteert ms (al groot),
   * seconden (ChatGPT-detail-API gebruikt floats in seconden), en ISO-strings
   * — zonder deze normalisatie belandde een seconden-getal als 1970-datum
   * in het archief.
   */
  function toEpochMs(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) return toEpochMs(asNumber);
    }
    return undefined;
  }

  /** Bouwt de ParsedConversation-vorm: alleen de velden die de listener toestaat. */
  function buildConversation({ content, turns, title, url, sourceProvider, occurredAt, attachments, attachmentGaps }) {
    const conv = { content, turns, sourceProvider };
    if (title) conv.title = title;
    if (url) conv.url = url;
    const occurredMs = toEpochMs(occurredAt);
    if (occurredMs !== undefined) conv.occurredAt = occurredMs;
    // Bijlagen reizen als referenties mee, nooit als bytes: de service worker
    // haalt ze op en levert ze eerst apart aan Chronicle. Lege lijsten blijven
    // weg zodat de payload dezelfde vorm houdt als voorheen.
    if (Array.isArray(attachments) && attachments.length) conv.attachments = attachments;
    if (Array.isArray(attachmentGaps) && attachmentGaps.length) conv.attachmentGaps = attachmentGaps;
    return conv;
  }

  /**
   * Bouwt één bijlagereferentie en laat lege velden weg. `download` zegt hoe de
   * service worker aan de bytes komt ('chatgpt' | 'claude' | 'direct'), `text`
   * is een tekstextractie die als .txt bewaard wordt als de bytes ontbreken.
   */
  function attachmentRef(fields) {
    const ref = {};
    const src = fields || {};
    if (src.filename) ref.filename = String(src.filename);
    if (src.mimeType) ref.mimeType = String(src.mimeType);
    if (typeof src.size === 'number' && Number.isFinite(src.size) && src.size >= 0) ref.size = src.size;
    if (src.providerFileId) ref.providerFileId = String(src.providerFileId);
    if (src.url) ref.url = String(src.url);
    if (src.download) ref.download = String(src.download);
    if (src.org) ref.org = String(src.org);
    // Na welke beurt hoort deze bijlage? De viewer zet hem daar neer; zonder
    // dit staat alles onderaan de chat in plaats van in het gesprek.
    if (typeof src.afterTurn === 'number' && Number.isFinite(src.afterTurn) && src.afterTurn >= 0) {
      ref.afterTurn = Math.floor(src.afterTurn);
    }
    // Tekstextracties zijn fallback-bytes voor de service worker en belanden
    // nooit in de chatpayload. Ze gaan wél mee in de retry-queue (storage),
    // dus begrensd: een enorme PDF mag het queue-quotum niet opeten.
    if (src.text && String(src.text).trim()) ref.text = String(src.text).slice(0, 100000);
    // Bytes die de pagina al in het geheugen heeft. Gegenereerde foto's staan in
    // de DOM als `blob:`-url; die is pagina-gebonden, dus de service worker kan
    // hem niet zelf ophalen. Base64 reist daarom mee in de ref — nooit verder
    // dan de service worker (Chronicle krijgt de bytes via /ingest/attachment).
    if (src.dataBase64 && String(src.dataBase64).length) ref.dataBase64 = String(src.dataBase64);
    return ref;
  }

  /** Bestandsextensie bij een mime-type; gebruikt voor naamloze afbeeldingen. */
  function extensionForMime(mimeType) {
    const map = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg',
      'application/pdf': 'pdf',
      'text/plain': 'txt',
      'text/markdown': 'md',
      'text/csv': 'csv',
      'application/json': 'json',
      'application/zip': 'zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    };
    return map[String(mimeType || '').toLowerCase()] || 'bin';
  }

  /** Laatste padsegment van een URL, zonder query; decodeert %20 etc. */
  function filenameFromUrl(url, fallback) {
    try {
      const parsed = new URL(url, location.href);
      const last = parsed.pathname.split('/').filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch {
      // geen geldige URL: val terug op de opgegeven naam
    }
    return fallback || 'bestand';
  }

  /** Mime-type uit een bestandsnaam (grof; alleen als de bron niets beters geeft). */
  function mimeFromFilename(filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    const map = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      json: 'application/json',
      zip: 'application/zip',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * "User: …" / "Assistant: …" — zelfde transcriptvorm als sourceParsers.ts.
   *
   * Een bijlage met `afterTurn` wordt als marker (`[Bijlage: naam]`) achter die
   * beurt gezet, zodat de positie in de tekst zelf vastligt en niet afhangt van
   * het opnieuw splitsen van de tekst in de viewer. De marker is ook leesbaar
   * voor Foundation en in exports.
   */
  function transcriptFromTurns(turns, attachments) {
    const byTurn = new Map();
    for (const ref of Array.isArray(attachments) ? attachments : []) {
      if (!ref || typeof ref.afterTurn !== 'number' || !ref.filename) continue;
      if (!byTurn.has(ref.afterTurn)) byTurn.set(ref.afterTurn, []);
      byTurn.get(ref.afterTurn).push(ref);
    }
    const markers = (n) =>
      (byTurn.get(n) || []).map((ref) => `[Bijlage: ${ref.filename}]`).join('\n');
    const blocks = [];
    const head = markers(0);
    if (head) blocks.push(head);
    turns.forEach((t, index) => {
      const line = `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`;
      const tail = markers(index + 1);
      blocks.push(tail ? `${line}\n\n${tail}` : line);
    });
    return blocks.join('\n\n');
  }

  /**
   * Tekst die alleen voor schermlezers bedoeld is: visueel verborgen maar wél
   * gerenderd, dus `innerText` neemt hem gewoon mee. Gemini zet de volledige
   * prompt in `.screen-reader-user-query-label` ("You said …") náást de
   * zichtbare `.query-text-line`s; zonder deze strip stond elke gebruikersbeurt
   * dubbel in het archief ("Ja" → "You said Ja Ja").
   */
  const A11Y_ONLY = '.cdk-visually-hidden, .screen-reader-user-query-label, .sr-only, .visually-hidden';

  /**
   * Zet een DOM-node om naar tekst waarbij codeblokken als echte markdown-
   * fences gemarkeerd worden, zodat de archive-viewer (react-markdown) ze als
   * codeblok rendert i.p.v. platgeslagen tekst.
   *
   * Let op: `clone.innerText` op een losse knoop is géén innerText — een node
   * die niet gerenderd wordt valt volgens de spec terug op `textContent`. Dat
   * kostte de newlines tussen blokken (een prompt van dertien regels werd één
   * regel) én liet verborgen tekst door. De kloon hangt daarom even renderbaar
   * maar buiten beeld in de pagina; `visibility: hidden` mag niet, want dan is
   * innerText leeg.
   */
  function innerTextWithCodeFences(node) {
    const clone = node.cloneNode(true);
    const pres = [...clone.querySelectorAll('pre')];
    for (const pre of pres) {
      const code = pre.querySelector('code');
      // jsdom (de tests) kent innerText niet; daar valt het terug op textContent.
      const block = code || pre;
      const text = typeof block.innerText === 'string' ? block.innerText : block.textContent || '';
      const langMatch = (code?.className || '').match(/language-([\w-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const fenced = '\n```' + lang + '\n' + text.replace(/\n+$/, '') + '\n```\n';
      pre.replaceWith(document.createTextNode(fenced));
    }
    for (const a11y of clone.querySelectorAll(A11Y_ONLY)) a11y.remove();

    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', top: '0px', left: '-99999px' });
    host.appendChild(clone);
    (document.body || document.documentElement).appendChild(host);
    try {
      // jsdom (de tests) kent innerText niet; daar valt het terug op textContent.
      const text = typeof clone.innerText === 'string' ? clone.innerText : clone.textContent;
      return text || '';
    } finally {
      host.remove();
    }
  }

  /**
   * Keert een bericht-tree om naar alleen de actieve tak: van de huidige node
   * terug naar de root. Zonder deze reconstructie bevatten exports ook de
   * alternatieve takken (edits/regenerates) — allemaal plat in het transcript.
   * Werkt voor Claude (uuid-lijst met parent pointers) en ChatGPT (mapping-
   * tree met children): beide reducties lopen van "hier" terug naar de root.
   */
  function activeBranchTurns(collectors, current) {
    for (const collect of collectors) {
      const turns = collect(current);
      if (turns && turns.length) return turns;
    }
    return [];
  }

  /** De toolbar-knop van de extensie triggert dezelfde export op het actieve tab. */
  function bindToolbarClick(handler) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'chronicle-click') handler();
    });
  }

  /** Tweede knop: alles tegelijk (bulk). De provider levert de gesprekkenlijst. */
  function makeBulkButton(onClick) {
    const existing = document.getElementById('chronicle-bulk-button');
    if (existing) existing.remove();
    const button = document.createElement('button');
    button.id = 'chronicle-bulk-button';
    Object.assign(button.style, BUTTON_STYLE);
    button.textContent = '⇊ Alles naar Chronicle';
    button.addEventListener('click', onClick);
    const panel = ensurePanel();
    panel.insertBefore(button, uiToggle); // de toggle blijft het laatste element (de hoek)
    uiButtons.bulk = button;
    layoutPanel();
    return button;
  }

  /**
   * Hangt een provider-eigen blok (het bulk-filterformulier) direct boven de
   * bulk-knop. Openen/sluiten gaat via `setBulkOptionsOpen`, zodat de
   * inklap-toggle het blok niet per ongeluk weer tevoorschijn haalt.
   */
  function mountBulkOptions(node) {
    const panel = ensurePanel();
    uiOptions = node;
    if (!node.id) node.id = 'chronicle-bulk-options';
    node.dataset.open = 'false';
    panel.insertBefore(node, uiButtons.bulk || uiToggle);
    layoutPanel();
    return node;
  }

  function setBulkOptionsOpen(open) {
    if (!uiOptions) return;
    uiOptions.dataset.open = open ? 'true' : 'false';
    layoutPanel();
  }

  // ── Bulkfilter ───────────────────────────────────────────────────────────
  // Filteren vóór er één detailverzoek de deur uit gaat: honderden gesprekken
  // ophalen om er twintig te bewaren is minuten werk voor niets.
  const BULK_FILTER_KEY = 'bulkFilter';
  const EMPTY_BULK_FILTER = { since: '', archive: 'skip', lastN: 0, fromN: 0, fromId: '' };
  let bulkFilter = Object.assign({}, EMPTY_BULK_FILTER);

  function loadBulkFilter(cb) {
    try {
      chrome.storage.local.get([BULK_FILTER_KEY], (data) => {
        bulkFilter = Object.assign({}, EMPTY_BULK_FILTER, (data && data[BULK_FILTER_KEY]) || {});
        if (cb) cb(bulkFilter);
      });
    } catch (err) {
      if (cb) cb(bulkFilter);
    }
  }

  function saveBulkFilter(filter) {
    bulkFilter = Object.assign({}, EMPTY_BULK_FILTER, filter || {});
    try {
      chrome.storage.local.set({ [BULK_FILTER_KEY]: bulkFilter });
    } catch (err) {
      // Zonder storage geldt de keuze alleen voor deze pagina.
    }
  }

  /** Tijdstempel van een lijstregel; 0 als de provider niets bruikbaars gaf. */
  function bulkTimestamp(conv) {
    const ms = toEpochMs(conv.updated_at || conv.update_time || conv.created_at || conv.create_time);
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
  }

  function bulkIsArchived(conv) {
    return conv.is_archived === true || conv.archived === true || Boolean(conv.archived_at);
  }

  /**
   * Filtert de gesprekkenlijst. `hasDates`/`hasArchive` komen van de provider:
   * de Gemini-zijbalk heeft geen van beide, en dan zou filteren alles
   * weggooien. `lastN` en `fromN` werken overal — elke lijst komt in
   * actualiteitsvolgorde (ChatGPT `order=updated`, Claude gesorteerd op
   * updated_at, Gemini zijbalk nieuwste eerst).
   */
  function applyBulkFilter(list, filter, capabilities = {}) {
    if (!filter || !Array.isArray(list)) return list;
    const hasDates = capabilities.hasDates !== false;
    const hasArchive = capabilities.hasArchive !== false;
    let out = list;

    if (filter.since) {
      if (!hasDates) {
        console.info('[Chronicle] bulkfilter: datumfilter overgeslagen — deze lijst heeft geen datums');
      } else {
        // Een datumveld levert YYYY-MM-DD; Date.parse maakt daar UTC-middernacht
        // van, wat in CET een gesprek van 00:30 zou wegfilteren. Lokaal parse.
        const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filter.since);
        const sinceMs = parts
          ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime()
          : Date.parse(filter.since);
        if (Number.isFinite(sinceMs)) out = out.filter((conv) => bulkTimestamp(conv) >= sinceMs);
      }
    }

    if (filter.archive === 'skip' || filter.archive === 'only') {
      if (!hasArchive) {
        console.info('[Chronicle] bulkfilter: archieffilter overgeslagen — deze lijst markeert geen archief');
      } else {
        if (!list.some(bulkIsArchived)) {
          // De lijst-API markeert archief niet (altijd); dan is dit filter een
          // stille no-op en dat mag je weten vóór je denkt dat het werkte.
          console.info('[Chronicle] bulkfilter: geen archiefmarkering in de lijst — archieffilter doet niets');
        }
        out =
          filter.archive === 'only'
            ? out.filter(bulkIsArchived)
            : out.filter((conv) => !bulkIsArchived(conv));
      }
    }

    if (hasDates) {
      // Nieuwste eerst: "laatste N" moet ook echt de laatste N zijn.
      out = out.slice().sort((a, b) => bulkTimestamp(b) - bulkTimestamp(a));
    }
    // "Vanaf dit gesprek": je opent het gesprek waar je wilt beginnen en de
    // bulk pakt dat en alles daarna. Ook op id en niet op positie, want de
    // lijst verschuift tussen twee runs (nieuw gesprek bovenaan) en dan zou
    // "vanaf #16" stilletjes het verkeerde gesprek worden. `uuid` is het
    // Claude-veld, `id` dat van ChatGPT en Gemini.
    if (filter.fromId) {
      const idx = out.findIndex(
        (conv) => String((conv && (conv.id || conv.uuid)) || '') === String(filter.fromId)
      );
      if (idx > 0) out = out.slice(idx);
      if (idx < 0) {
        console.info(
          '[Chronicle] bulkfilter: "vanaf dit gesprek" staat niet in de lijst — filter overgeslagen'
        );
      }
    }
    // "Vanaf gesprek N" is 1-gebaseerd en index-gebaseerd: het werkt dus ook
    // voor de Gemini-zijbalk, die geen datums heeft. Handig om een run te
    // hervatten na een afgebroken rit — de eerste N zijn dan al binnen.
    // Samen met `fromId` is het dubbelop; dan wint het gesprek.
    if (!filter.fromId && Number(filter.fromN) > 1) {
      out = out.slice(Math.min(Number(filter.fromN) - 1, out.length));
    }
    if (filter.lastN > 0) out = out.slice(0, filter.lastN);
    return out;
  }

  const FILTER_LABEL_STYLE = {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    fontSize: '11px',
    color: '#57534e',
  };
  const FILTER_INPUT_STYLE = {
    font: '12px system-ui, sans-serif',
    padding: '4px 6px',
    border: '1px solid rgba(0,0,0,0.2)',
    borderRadius: '6px',
    background: '#fff',
    color: '#1c1917',
    width: '100%',
    boxSizing: 'border-box',
  };

  function filterField(text, control) {
    const label = document.createElement('label');
    Object.assign(label.style, FILTER_LABEL_STYLE);
    const caption = document.createElement('span');
    caption.textContent = text;
    label.append(caption, control);
    return label;
  }

  /**
   * Het filterformulier voor de bulk-knop. `onStart(filter)` start de run;
   * welke velden zin hebben bepaalt de provider via `supportsDate` en
   * `supportsArchive`. De keuze blijft bewaard in chrome.storage.local.
   */
  function makeBulkFilterPanel(options = {}) {
    const supportsDate = options.supportsDate !== false;
    const supportsArchive = options.supportsArchive !== false;

    const panel = document.createElement('div');
    panel.id = 'chronicle-bulk-filter';
    Object.assign(panel.style, {
      flexDirection: 'column',
      gap: '8px',
      padding: '10px',
      borderRadius: '10px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#fefef9',
      color: '#1c1917',
      font: '12px system-ui, sans-serif',
      boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
      width: '210px',
    });

    const since = document.createElement('input');
    since.type = 'date';
    Object.assign(since.style, FILTER_INPUT_STYLE);

    const archive = document.createElement('select');
    Object.assign(archive.style, FILTER_INPUT_STYLE);
    for (const [value, text] of [
      ['skip', 'Archief overslaan'],
      ['only', 'Alleen archief'],
      ['all', 'Alles meenemen'],
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      archive.appendChild(option);
    }

    const lastN = document.createElement('input');
    lastN.type = 'number';
    lastN.min = '0';
    lastN.step = '1';
    lastN.placeholder = 'alles';
    Object.assign(lastN.style, FILTER_INPUT_STYLE);

    // Index-gebaseerd en dus overal bruikbaar — ook op de Gemini-zijbalk, die
    // geen datums heeft. Nuttig om een afgebroken rit te hervatten: de eerste
    // N zijn dan immers al binnen.
    const fromN = document.createElement('input');
    fromN.type = 'number';
    fromN.min = '1';
    fromN.step = '1';
    fromN.placeholder = '1';
    fromN.title = 'Sla de eerste N-1 gesprekken over (nieuwste eerst). 16 begint bij het 16e gesprek.';
    Object.assign(fromN.style, FILTER_INPUT_STYLE);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px' });

    /**
     * "Vanaf dit gesprek" i.p.v. een nummer: je opent de chat waar je wilt
     * beginnen en klikt hier. Het nummer blijft bestaan voor het hervatten van
     * een afgebroken rit, maar dit is de route die je niet laat tellen.
     */
    let fromId = '';
    const fromHere = document.createElement('button');
    fromHere.type = 'button';
    Object.assign(fromHere.style, {
      width: '100%',
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#fff',
      color: '#1c1917',
      font: '12px system-ui, sans-serif',
      cursor: 'pointer',
    });

    const fromHereNote = document.createElement('span');
    Object.assign(fromHereNote.style, {
      display: 'none',
      fontSize: '10px',
      lineHeight: '1.3',
      color: '#57534e',
      wordBreak: 'break-word',
    });

    const paintFromHere = () => {
      fromHere.dataset.active = fromId ? 'true' : 'false';
      fromHere.textContent = fromId ? '✓ Vanaf dit gesprek' : '⌖ Vanaf dit gesprek';
      fromHere.title = fromId
        ? 'Start bij het gesprek dat nu open is — klik om te wissen'
        : 'Open het gesprek waar de rit moet beginnen en klik hier';
      fromHere.style.background = fromId ? '#dcfce7' : '#fff';
      fromHere.style.borderColor = fromId ? 'rgba(22,101,52,0.35)' : 'rgba(0,0,0,0.15)';
      // Wélk gesprek het is, niet alleen dát er iets gekozen is: een
      // blijvende keuze uit een vorige sessie mag niet ongemerkt meelopen.
      const label = fromId ? currentLabel() : '';
      fromHereNote.textContent = label ? label.slice(0, 34) : '';
      fromHereNote.style.display = label ? 'block' : 'none';
    };

    /** Titel van het geopende gesprek; de id alleen zegt de gebruiker niets. */
    const currentLabel = () => {
      const raw = options.currentLabel ? options.currentLabel() : document.title;
      return String(raw || '')
        .replace(/\s+[-–—|]\s+(Gemini|ChatGPT|Claude).*$/i, '')
        .trim();
    };

    const start = document.createElement('button');
    start.textContent = '⇊ Start';
    Object.assign(start.style, {
      flex: '1',
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#1c1917',
      color: '#fefef9',
      font: '12px system-ui, sans-serif',
      cursor: 'pointer',
    });

    const everything = document.createElement('button');
    everything.textContent = 'Alles';
    everything.title = 'Geen filters: elk gesprek, archief inbegrepen';
    Object.assign(everything.style, {
      padding: '6px 10px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#fff',
      color: '#1c1917',
      font: '12px system-ui, sans-serif',
      cursor: 'pointer',
    });

    const populate = () => {
      since.value = bulkFilter.since || '';
      archive.value = bulkFilter.archive || 'skip';
      lastN.value = bulkFilter.lastN ? String(bulkFilter.lastN) : '';
      fromN.value = bulkFilter.fromN > 1 ? String(bulkFilter.fromN) : '';
      fromId = bulkFilter.fromId || '';
      paintFromHere();
    };

    const launch = (filter) => {
      saveBulkFilter(filter);
      setBulkOptionsOpen(false);
      options.onStart(filter);
    };

    start.addEventListener('click', () => {
      launch({
        since: supportsDate ? since.value || '' : '',
        archive: supportsArchive ? archive.value : 'all',
        lastN: Number(lastN.value) || 0,
        // Een gesprek en een nummer samen zegt niets: het gesprek wint.
        fromN: fromId ? 0 : Number(fromN.value) || 0,
        fromId,
      });
    });

    fromHere.addEventListener('click', () => {
      if (fromId) {
        fromId = '';
        paintFromHere();
        return;
      }
      const id = options.currentId ? options.currentId() : null;
      if (!id) {
        fromHere.textContent = 'geen gesprek open';
        setTimeout(paintFromHere, 1600);
        return;
      }
      fromId = String(id);
      paintFromHere();
    });

    everything.addEventListener('click', () => {
      launch({ since: '', archive: 'all', lastN: 0, fromN: 0, fromId: '' });
    });

    if (supportsDate) panel.appendChild(filterField('Vanaf datum', since));
    if (supportsArchive) panel.appendChild(filterField('Archief', archive));
    panel.appendChild(filterField('Vanaf gesprek #', fromN));
    panel.appendChild(fromHere);
    panel.appendChild(fromHereNote);
    panel.appendChild(filterField('Laatste N gesprekken', lastN));
    panel.appendChild(row);
    row.append(start, everything);

    mountBulkOptions(panel);
    loadBulkFilter(populate);

    panel.populate = populate;
    panel.show = () => {
      loadBulkFilter(populate);
      setBulkOptionsOpen(true);
    };
    panel.hide = () => setBulkOptionsOpen(false);
    panel.toggle = () => {
      if (panel.dataset.open === 'true') panel.hide();
      else panel.show();
    };
    return panel;
  }

  function setBulkProgress(button, report) {
    const done = report.created + report.updated + report.duplicates + report.failed + report.queued;
    button.textContent = `⇊ ${done}/${report.total} • nieuw ${report.created} • bijgewerkt ${report.updated} • bekend ${report.duplicates}${report.failed ? ' • mislukt ' + report.failed : ''}${report.queued ? ' • wachtrij ' + report.queued : ''}`;
  }

  const EMPTY_REPORT = { total: 0, created: 0, updated: 0, duplicates: 0, failed: 0, queued: 0, gaps: 0 };

  /**
   * Precies de velden die de ingest-API kent (zie buildConversation). Zet een
   * provider daarna nog iets op het gesprek — een diagnoseveld bijvoorbeeld —
   * dan klapte de hele levering op "unknown field 'x'". Hier wordt dat alsnog
   * weggefilterd, zodat één vergeetpunt niet de export sloopt.
   */
  // Spiegel van ALLOWED_KEYS in service-worker.js.
  const CONVERSATION_FIELDS = [
    'content',
    'turns',
    'title',
    'url',
    'sourceProvider',
    'occurredAt',
    'createdAt',
    'attachments',
    'attachmentGaps',
  ];

  function toPayload(conversation) {
    if (!conversation || typeof conversation !== 'object') return conversation;
    const payload = {};
    const dropped = [];
    for (const key of CONVERSATION_FIELDS) {
      if (conversation[key] !== undefined) payload[key] = conversation[key];
    }
    for (const key of Object.keys(conversation)) {
      if (!CONVERSATION_FIELDS.includes(key)) dropped.push(key);
    }
    if (dropped.length) {
      console.info('[Chronicle] payload: onbekende velden weggelaten:', dropped.join(', '));
    }
    return payload;
  }

  /**
   * Levert een reeks gesprekken in brokken van 15 (sendMessage heeft een
   * berichtlimiet, en met thinking-blokken is één gesprek al flink groot) en
   * telt de rapporten op. `onChunk(optelling, chunkSize, done)` vuurt na elke
   * brok, zodat een aanroeper live kan bijwerken. Gooit bij een mislukte brok:
   * de aanroeper beslist of de rest nog de moeite is.
   */
  async function deliverMany(conversations, onChunk) {
    const CHUNK = 15;
    const total = conversations.length;
    const sum = Object.assign({}, EMPTY_REPORT);
    for (let i = 0; i < total; i += CHUNK) {
      const chunk = conversations.slice(i, i + CHUNK);
      const response = await chrome.runtime.sendMessage({
        type: 'chronicle-export-many',
        conversations: chunk.map(toPayload),
      });
      if (!response || !response.ok) {
        throw new Error(response?.error || 'onbekende fout');
      }
      const report = response.report || {};
      for (const key of Object.keys(sum)) sum[key] += Number(report[key]) || 0;
      if (onChunk) onChunk(sum, chunk.length, i + chunk.length);
      await new Promise((r) => setTimeout(r, 50));
    }
    return sum;
  }

  async function exportManyToChronicle(button, conversations) {
    button.disabled = true;
    button.textContent = `⇊ 0/${conversations.length}…`;
    const progressListener = (message) => {
      if (message && message.type === 'chronicle-bulk-progress') setBulkProgress(button, message.report);
    };
    chrome.runtime.onMessage.addListener(progressListener);
    try {
      const report = await deliverMany(conversations, (sum, _chunkSize, done) => {
        button.textContent = `⇊ geleverd ${done}/${conversations.length} • nieuw ${sum.created} • bijgewerkt ${sum.updated} • bekend ${sum.duplicates}`;
      });
      button.textContent +=
        ' ✓' + (report.gaps ? ` • ${report.gaps} bestand(en) niet` : '') + (report.failed ? ` • ${report.failed} mislukt` : '');
      setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 8000);
    } catch (err) {
      button.textContent = '✗ bulkexport mislukt: ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 6000);
    } finally {
      chrome.runtime.onMessage.removeListener(progressListener);
      button.disabled = false;
    }
  }

  window.__chronicleUI = {
    setButtonState,
    makeButton,
    exportToChronicle,
    exportManyToChronicle,
    deliverMany,
    buildConversation,
    bindToolbarClick,
    makeBulkButton,
    mountBulkOptions,
    setBulkOptionsOpen,
    makeBulkFilterPanel,
    applyBulkFilter,
    loadBulkFilter,
    toEpochMs,
    transcriptFromTurns,
    innerTextWithCodeFences,
    setCollapsed,
    attachmentRef,
    extensionForMime,
    filenameFromUrl,
    mimeFromFilename,
  };
  loadUiPreferences();
  console.info('[Chronicle] content helper geinjecteerd op', location.host);
})();
