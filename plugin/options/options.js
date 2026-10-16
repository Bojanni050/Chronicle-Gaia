const baseUrlInput = document.getElementById('baseUrl');
const tokenInput = document.getElementById('token');
const cornerSelect = document.getElementById('uiCorner');
const collapsedInput = document.getElementById('uiCollapsed');
const statusEl = document.getElementById('status');

async function load() {
  const data = await chrome.storage.local.get(['baseUrl', 'token', 'uiCorner', 'uiCollapsed']);
  baseUrlInput.value = data.baseUrl || 'http://127.0.0.1:4580';
  tokenInput.value = data.token || '';
  cornerSelect.value = data.uiCorner || 'bottom-right';
  collapsedInput.checked = !!data.uiCollapsed;
}

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, '');
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({
    baseUrl,
    token,
    uiCorner: cornerSelect.value,
    uiCollapsed: collapsedInput.checked,
  });
  statusEl.textContent = 'Opgeslagen — open tabs passen de positie meteen aan.';
  setTimeout(() => (statusEl.textContent = ''), 3000);
});

load();
