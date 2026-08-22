const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boltmos', {
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  setSize: (w, h) => ipcRenderer.send('set-size', { width: w, height: h }),
  getWindowPosition: () => ipcRenderer.invoke('get-position'),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  getUserId: () => ipcRenderer.invoke('get-user-id'),
});
