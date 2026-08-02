const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boltmos', {
  moveWindow: (x, y) => ipcRenderer.send('move-window', { x, y }),
  setSize: (w, h) => ipcRenderer.send('set-size', { width: w, height: h }),
});
