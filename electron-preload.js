
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isNative: true,
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  getExecutablePath: () => ipcRenderer.invoke('get-executable-path'),
  saveDatabase: (data) => ipcRenderer.invoke('save-database', data),
  loadDatabase: () => ipcRenderer.invoke('load-database'),
  addLink: (fromId, toId, type) => ipcRenderer.invoke('add-link', { fromId, toId, type }),
  removeLink: (fromId, toId) => ipcRenderer.invoke('remove-link', { fromId, toId }),
  loadLinks: () => ipcRenderer.invoke('load-links'),
  exportChats: (chats, format) => ipcRenderer.invoke('export-chats', { chats, format }),
  importChats: (existingIds) => ipcRenderer.invoke('import-chats', existingIds),
  sendNotification: (title, body) => ipcRenderer.send('notify', { title, body }),
  platform: process.platform,
});
