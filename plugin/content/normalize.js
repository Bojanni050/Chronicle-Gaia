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
      response = await chrome.runtime.sendMessage({ type: 'chronicle-export', conversation });
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
  function buildConversation({ content, turns, title, url, sourceProvider, occurredAt }) {
    const conv = { content, turns, sourceProvider };
    if (title) conv.title = title;
    if (url) conv.url = url;
    const occurredMs = toEpochMs(occurredAt);
    if (occurredMs !== undefined) conv.occurredAt = occurredMs;
    return conv;
  }

  /** "User: …" / "Assistant: …" — zelfde transcriptvorm als sourceParsers.ts. */
  function transcriptFromTurns(turns) {
    return turns
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
      .join('\n\n');
  }

  /**
   * Zet een DOM-node om naar tekst waarbij codeblokken als echte markdown-
   * fences gemarkeerd worden, zodat de archive-viewer (react-markdown) ze als
   * codeblok rendert i.p.v. platgeslagen tekst.
   */
  function innerTextWithCodeFences(node) {
    const clone = node.cloneNode(true);
    const pres = [...clone.querySelectorAll('pre')];
    for (const pre of pres) {
      const code = pre.querySelector('code');
      const text = (code || pre).innerText || '';
      const langMatch = (code?.className || '').match(/language-([\w-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const fenced = '\n```' + lang + '\n' + text.replace(/\n+$/, '') + '\n```\n';
      pre.replaceWith(document.createTextNode(fenced));
    }
    return clone.innerText || '';
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

  function setBulkProgress(button, report) {
    const done = report.created + report.updated + report.duplicates + report.failed + report.queued;
    button.textContent = `⇊ ${done}/${report.total} • nieuw ${report.created} • bijgewerkt ${report.updated} • bekend ${report.duplicates}${report.failed ? ' • mislukt ' + report.failed : ''}${report.queued ? ' • wachtrij ' + report.queued : ''}`;
  }

  async function exportManyToChronicle(button, conversations) {
    button.disabled = true;
    button.textContent = `⇊ 0/${conversations.length}…`;
    const progressListener = (message) => {
      if (message && message.type === 'chronicle-bulk-progress') setBulkProgress(button, message.report);
    };
    chrome.runtime.onMessage.addListener(progressListener);
    try {
      // In chunks van 15: sendMessage heeft een berichtlimiet, en met
      // thinking-blokken kan één groot gesprek al flink groot zijn.
      const CHUNK = 15;
      const total = conversations.length;
      let lastReport = null;
      for (let i = 0; i < total; i += CHUNK) {
        const chunk = conversations.slice(i, i + CHUNK);
        const response = await chrome.runtime.sendMessage({
          type: 'chronicle-export-many',
          conversations: chunk,
        });
        if (!response || !response.ok) {
          button.textContent = '✗ bulkexport mislukt: ' + (response?.error || 'onbekende fout');
          setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 6000);
          return;
        }
        lastReport = response.report;
        const done = Math.min(i + CHUNK, total);
        button.textContent = `⇊ geleverd ${done}/${total} • nieuw ${response.report.created} • bijgewerkt ${response.report.updated} • bekend ${response.report.duplicates} ✓`;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (lastReport) {
        setBulkProgress(button, lastReport);
        button.textContent += ' ✓';
        setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 8000);
      }
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
    buildConversation,
    bindToolbarClick,
    makeBulkButton,
    toEpochMs,
    transcriptFromTurns,
    innerTextWithCodeFences,
    setCollapsed,
  };
  loadUiPreferences();
  console.info('[Chronicle] content helper geinjecteerd op', location.host);
})();
