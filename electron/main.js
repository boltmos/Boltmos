const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');

let win = null;
let tray = null;

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().size;

  win = new BrowserWindow({
    width: 500,
    height: 765,
    x: screenWidth - 520,
    y: screenHeight - 805,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  win.on('close', (event) => {
    event.preventDefault();
    win.hide();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
        }
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  ipcMain.on('move-window', (_event, { x, y }) => {
    if (win) {
      win.setPosition(x, y);
    }
  });

  ipcMain.on('set-size', (_event, { width, height }) => {
    if (win) {
      win.setSize(width, height);
    }
  });

  ipcMain.on('set-ignore-mouse', (_event, ignore) => {
    if (win) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });
});

app.on('window-all-closed', () => {
  // Keep app running in tray when window is closed
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
