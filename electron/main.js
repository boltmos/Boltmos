const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let win = null;
let tray = null;
let userId = null;

// Minimal per-install identity: a random UUID generated once and persisted in
// userData, so requests to the backend can be partitioned per install instead
// of every install colliding into the backend's TEST_USER_ID placeholder.
// This is not real auth - see the get_user_id() comment in backend/main.py
// and backend/cloud/main.py for what it does and does not guarantee.
function getOrCreateUserId() {
  const filePath = path.join(app.getPath('userData'), 'user-id.json');
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (existing.userId) return existing.userId;
  } catch (error) {
    // File missing, unreadable, or malformed - fall through and generate one.
  }
  const generated = crypto.randomUUID();
  fs.writeFileSync(filePath, JSON.stringify({ userId: generated }));
  return generated;
}

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: screenWidth,
    height: screenHeight,
    x: 0,
    y: 0,
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

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });

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
  userId = getOrCreateUserId();
  createWindow();
  createTray();

  ipcMain.handle('get-user-id', () => userId);

  ipcMain.on('move-window', (_event, { x, y }) => {
    if (win) {
      win.setPosition(x, y);
    }
  });

  ipcMain.handle('get-position', () => win?.getPosition() ?? [0, 0]);

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
