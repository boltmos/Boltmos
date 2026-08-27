const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let win = null;
let tray = null;
let userId = null;
let backendProcess = null;

function debugLog(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  console.log(...args);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), line);
  } catch (error) { /* ignore */ }
}

// boltmos-backend.exe is the PyInstaller-built local agent backend (see
// backend/boltmos_backend.spec) - it serves /task (automation) and the
// localhost:8001 websocket. In dev it lives under backend/dist/; once
// packaged it needs to ship as an extraResource under resourcesPath
// (not yet wired into package.json's build config).
function getBackendExePath() {
  const exeName = 'boltmos-backend.exe';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend', exeName);
  }
  return path.join(__dirname, '../backend/dist/boltmos-backend', exeName);
}

function startBackend() {
  const exePath = getBackendExePath();
  if (!fs.existsSync(exePath)) {
    debugLog('[backend] executable not found at', exePath, '- skipping launch');
    return;
  }

  backendProcess = spawn(exePath, [], {
    cwd: path.dirname(exePath),
    // PYTHONUNBUFFERED=1 forces Python's stdout to flush per line instead of
    // fully buffering it (the default when stdout is a pipe, not a tty) -
    // without it, print() output (Groq/Supabase connection status, etc.) can
    // sit invisible in the buffer for minutes until it fills or the process
    // exits, making debug.log lag reality.
    env: { ...process.env, PORT: '8000', PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });

  backendProcess.stdout.on('data', (data) => debugLog('[backend]', data.toString().trim()));
  backendProcess.stderr.on('data', (data) => debugLog('[backend:err]', data.toString().trim()));
  backendProcess.on('exit', (code, signal) => {
    debugLog('[backend] exited', 'code:', code, 'signal:', signal);
    backendProcess = null;
  });
  backendProcess.on('error', (error) => {
    debugLog('[backend] failed to start:', error.message);
    backendProcess = null;
  });
}

function stopBackend() {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill();
  }
  backendProcess = null;
}

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
  win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('console-message', (_event, _level, message) => {
    debugLog('[renderer]', message);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    debugLog('[did-fail-load]', errorCode, errorDescription, validatedURL);
  });

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    debugLog('[preload-error]', preloadPath, error?.message ?? error);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    debugLog('[render-process-gone]', JSON.stringify(details));
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
  const userDataPath = app.getPath('userData');
  console.log('[userData]', userDataPath);
  dialog.showMessageBoxSync({
    type: 'info',
    title: 'userData path',
    message: userDataPath,
  });

  userId = getOrCreateUserId();
  startBackend();
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
  stopBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
