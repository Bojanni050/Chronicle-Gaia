/**
 * Gedeelde UI-hulp voor de provider-scripts: de "→ Chronicle"-knop met
 * statusfeedback (✓ nieuw / ✓ bijgewerkt / duplicate / wachtrij / mislukt).
 */

const CHRONICLE_BUTTON_ID = 'chronicle-export-button';

const STATUS = {
  idle: '→ Chronicle',
  busy: '…',
  create: '✓ In Chronicle',
  update: '✓ Bijgewerkt',
  duplicate: '✓ Al bekend',
  queued: '⏳ In wachtrij',
};

export function setButtonState(button, state, title) {
  button.textContent = STATUS[state] || STATUS.idle;
  button.title = title || '';
  button.dataset.state = state;
  button.disabled = state === 'busy';
}

export function makeButton(onClick) {
  const button = document.createElement('button');
  button.id = CHRONICLE_BUTTON_ID;
  Object.assign(button.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
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
export async function exportToChronicle(button, conversation) {
  setButtonState(button, 'busy');
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'chronicle-export', conversation });
  } catch (err) {
    setButtonState(button, 'queued', String(err));
    return;
  }
  if (!response || !response.ok) {
    if (response && response.queued) {
      setButtonState(button, 'queued', response.error || '');
    } else {
      setButtonState(button, 'idle', response?.error || 'export mislukt');
      button.textContent = '✗ ' + (response?.error || 'mislukt').slice(0, 40);
      setTimeout(() => setButtonState(button, 'idle'), 4000);
    }
    return;
  }
  setButtonState(button, response.action || 'create');
}

/** Bouwt de ParsedConversation-vorm: alleen de velden die de listener toestaat. */
export function buildConversation({ content, turns, title, url, sourceProvider, occurredAt }) {
  const conv = { content, turns, sourceProvider };
  if (title) conv.title = title;
  if (url) conv.url = url;
  if (occurredAt !== undefined && occurredAt !== null) conv.occurredAt = occurredAt;
  return conv;
}
