const baseUrlInput = document.getElementById('baseUrl');
const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');

async function load() {
  const data = await chrome.storage.local.get(['baseUrl', 'token']);
  baseUrlInput.value = data.baseUrl || 'http://127.0.0.1:4580';
  tokenInput.value = data.token || '';
}

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, '');
  const token = tokenInput.value.trim();
  await chrome.storage.local.set({ baseUrl, token });
  statusEl.textContent = 'Opgeslagen.';
  setTimeout(() => (statusEl.textContent = ''), 2000);
});

load();
