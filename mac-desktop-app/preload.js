/**
 * Preload — the only bridge between the sandboxed renderer and the main process.
 * The renderer has no Node.js access and no network access (CSP connect-src 'none');
 * everything goes through these explicit, promise-based IPC calls.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (handler) => {
  const listener = (_event, data) => handler(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('nt', {
  platform: process.platform,
  // connection
  getConnection: () => ipcRenderer.invoke('conn:get'),
  saveConnection: (url, token) => ipcRenderer.invoke('conn:save', { url, token }),
  // backend (returns the envelope { ok, status, code, error, data } — never throws)
  call: (action, payload) => ipcRenderer.invoke('api:call', action, payload),
  // status + kill switch (confirmation dialog is shown natively by the main process)
  getStatus: () => ipcRenderer.invoke('status:get'),
  refreshStatus: () => ipcRenderer.invoke('status:refresh'),
  toggleKillSwitch: (engage) => ipcRenderer.invoke('kill:toggle', engage),
  // native helpers
  exportReport: (format, days) => ipcRenderer.invoke('report:export', { format, days }),
  cacheMedia: (url) => ipcRenderer.invoke('media:cache', url),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  confirm: (message, okLabel) => ipcRenderer.invoke('confirm', message, okLabel),
  notify: (title, body) => ipcRenderer.invoke('notify', title, body),
  // push events from main
  onStatus: subscribe('status:update'),
  onEvents: subscribe('backend:events'),
  onNavigate: subscribe('navigate')
});
