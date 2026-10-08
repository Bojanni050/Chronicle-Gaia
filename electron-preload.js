
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isNative: true,
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getExecutablePath: () => ipcRenderer.invoke('get-executable-path'),
  saveDatabase: (data) => ipcRenderer.invoke('save-database', data),
  loadDatabase: () => ipcRenderer.invoke('load-database'),
  clearDatabase: () => ipcRenderer.invoke('clear-database'),
  addLink: (fromId, toId, type) => ipcRenderer.invoke('add-link', { fromId, toId, type }),
  removeLink: (fromId, toId) => ipcRenderer.invoke('remove-link', { fromId, toId }),
  loadLinks: () => ipcRenderer.invoke('load-links'),
  captureChatToFoundation: (payload) => ipcRenderer.invoke('foundation-capture-chat', payload),
  captureSourceFileToFoundation: (file) => ipcRenderer.invoke('foundation-capture-source-file', file),
  uploadAttachmentToFoundation: (file) => ipcRenderer.invoke('foundation-upload-attachment', file),
  analyzeContent: (args) => ipcRenderer.invoke('analyze-content', args),
  generateEmbedding: (args) => ipcRenderer.invoke('generate-embedding', args),
  fetchModels: () => ipcRenderer.invoke('fetch-models'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  exportChats: (chats, format) => ipcRenderer.invoke('export-chats', { chats, format }),
  importChats: (existingIds) => ipcRenderer.invoke('import-chats', existingIds),
  sendNotification: (title, body) => ipcRenderer.send('notify', { title, body }),
  platform: process.platform,
  onChatIngested: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('chat-ingested', handler);
    return () => ipcRenderer.removeListener('chat-ingested', handler);
  },
});
