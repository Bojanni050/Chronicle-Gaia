/**
 * Gedeelde UI-hulp voor de provider-scripts: de "→ Chronicle"-knop met
 * statusfeedback (✓ nieuw / ✓ bijgewerkt / duplicate / wachtrij / mislukt).
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
    duplicate: '✓ Al bekend',
    queued: '⏳ In wachtrij',
  };

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
    Object.assign(button.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '9999',
      padding: '8px 14px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#fefef9',
      color: '#1c1917',
      font: '13px system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    });
    setButtonState(button, 'idle');
    button.addEventListener('click', onClick);
    document.documentElement.appendChild(button);
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

  /** Bouwt de ParsedConversation-vorm: alleen de velden die de listener toestaat. */
  function buildConversation({ content, turns, title, url, sourceProvider, occurredAt }) {
    const conv = { content, turns, sourceProvider };
    if (title) conv.title = title;
    if (url) conv.url = url;
    if (occurredAt !== undefined && occurredAt !== null) conv.occurredAt = occurredAt;
    return conv;
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
    Object.assign(button.style, {
      position: 'fixed',
      top: '56px',
      right: '16px',
      zIndex: '9999',
      padding: '8px 14px',
      borderRadius: '8px',
      border: '1px solid rgba(0,0,0,0.15)',
      background: '#fefef9',
      color: '#1c1917',
      font: '13px system-ui, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    });
    button.textContent = '⇊ Alles naar Chronicle';
    button.addEventListener('click', onClick);
    document.documentElement.appendChild(button);
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
      const response = await chrome.runtime.sendMessage({
        type: 'chronicle-export-many',
        conversations,
      });
      if (!response || !response.ok) {
        button.textContent = '✗ bulkexport mislukt: ' + (response?.error || 'onbekende fout');
        setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 6000);
        return;
      }
      setBulkProgress(button, response.report);
      button.textContent += ' ✓';
      setTimeout(() => (button.textContent = '⇊ Alles naar Chronicle'), 8000);
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
  };
  console.info('[Chronicle] content helper geinjecteerd op', location.host);
})();
