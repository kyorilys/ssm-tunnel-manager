const { app, BrowserWindow, Tray, dialog, Menu, Notification, clipboard, globalShortcut, nativeImage, powerMonitor, screen, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { Store } = require('./lib/store');
const { TunnelManager } = require('./lib/tunnelManager');
const scan = require('./lib/scan');
const archive = require('./lib/archive');
const { Controller } = require('./lib/controller');
const { registerIpc } = require('./lib/ipc');
const env = require('./lib/env');
const { createLazyWindow } = require('./lib/lazyWindow');
const { createLogger, defaultLogFile, readEntries } = require('./lib/logger');

const POPOVER_WIDTH = 340;
const RENDERER_URL = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;
const asset = (name) => nativeImage.createFromPath(path.join(__dirname, 'assets', name));

app.setPath('userData', path.join(app.getPath('appData'), 'SSM Tunnels'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  let mainWindow = null; // built on demand and released when closed (see lib/lazyWindow.js)
  let popover = null;
  let tray = null;
  let controller = null;
  let popoverHiddenAt = 0; // set when blur hides the popover, so the tray click that caused it does not reopen it
  let quitting = false;
  let shutdownStarted = false;
  const logger = createLogger({ file: defaultLogFile(process.env), source: 'app' });

  const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };
  const alive = (w) => w && !w.isDestroyed();
  const isTrustedSender = (event) => String(event.senderFrame?.url || '').startsWith(RENDERER_URL);

  function harden(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  // Sends to a window's renderer once it has finished loading; destroyed or still-loading windows are skipped.
  function sendTo(win, channel, payload) {
    if (alive(win) && !win.webContents.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(channel, payload);
  }
  const broadcast = (channel, payload) => {
    mainWindow?.send(channel, payload);
    sendTo(popover, channel, payload);
  };

  // Closing the main window releases it (about 95 MB); it is rebuilt the next time it is opened.
  // Tunnels are unaffected: they belong to the main process, not to the window.
  function createMainWindow() {
    mainWindow = createLazyWindow({
      activate: () => app.focus({ steal: true }),
      create: () => {
        const win = new BrowserWindow({
          width: 1000, height: 680, minWidth: 720, minHeight: 440, show: false,
          titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
          vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000', webPreferences,
        });
        harden(win);
        win.loadFile(path.join('renderer', 'index.html'));
        win.on('closed', () => { if (!quitting) app.dock?.hide(); });
        return win;
      },
    });
    // A login launch starts in the menu bar only, without building the window.
    if (app.getLoginItemSettings().wasOpenedAtLogin) app.dock?.hide();
    else showMain();
  }

  function showMain() {
    app.dock?.show();
    mainWindow.show();
  }

  function createPopover() {
    popover = new BrowserWindow({
      width: POPOVER_WIDTH, height: 200, show: false, frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      vibrancy: 'popover', backgroundColor: '#00000000', webPreferences,
    });
    harden(popover);
    popover.loadFile(path.join('renderer', 'popover.html'));
    popover.on('blur', () => { popoverHiddenAt = Date.now(); popover.hide(); });
  }

  const workAreaFor = (bounds) => screen.getDisplayMatching(bounds).workArea;

  function positionPopover() {
    const bounds = tray.getBounds();
    const area = workAreaFor(bounds);
    const [width, height] = popover.getSize();
    const x = Math.round(Math.min(Math.max(bounds.x + bounds.width / 2 - width / 2, area.x), area.x + area.width - width));
    const y = Math.round(Math.min(bounds.y + bounds.height + 4, area.y + area.height - height));
    popover.setPosition(x, Math.max(y, area.y));
  }

  function togglePopover() {
    if (!alive(popover)) return;
    if (popover.isVisible()) return popover.hide();
    if (Date.now() - popoverHiddenAt < 300) return;
    positionPopover();
    popover.show();
    popover.focus();
  }

  const ui = {
    openMain({ view, sheet } = {}) {
      if (alive(popover)) popover.hide();
      showMain();
      if (view || sheet) mainWindow.sendWhenReady('ssm:event', { type: 'navigate', view, sheet });
    },
    resizePopover(height) {
      if (!alive(popover)) return;
      const area = workAreaFor(tray.getBounds());
      popover.setSize(POPOVER_WIDTH, Math.round(Math.min(Math.max(height, 120), area.height - 40)));
      if (popover.isVisible()) positionPopover();
    },
  };

  function updateTray(snapshot) {
    const live = snapshot.tunnels.filter((t) => !t.archived);
    const active = live.filter((t) => t.state === 'active');
    const activeCount = active.length + snapshot.terminal.length;
    const trouble = live.filter((t) => t.state === 'failed' || t.state === 'reconnecting' || t.state === 'waiting');
    const prodLive = active.some((t) => t.env === 'production');

    tray.setTitle(activeCount ? String(activeCount) : '', { fontType: 'monospacedDigit' });
    tray.setImage(asset(prodLive ? 'trayProd.png' : trouble.length ? 'trayAlertTemplate.png' : 'trayTemplate.png'));
    const parts = [`${activeCount} active`];
    const signIn = live.filter((t) => t.state === 'waiting').length;
    if (trouble.length - signIn) parts.push(`${trouble.length - signIn} failing`);
    if (signIn) parts.push(`${signIn} need sign-in`);
    tray.setToolTip(`SSM Tunnels: ${parts.join(', ')}`);
  }

  function createTray() {
    const icon = asset('trayTemplate.png');
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', togglePopover);
    tray.on('right-click', () => {
      if (alive(popover)) popover.hide();
      tray.popUpContextMenu(Menu.buildFromTemplate([
        { label: 'Open SSM Tunnels', click: () => ui.openMain() },
        { label: 'Settings…', click: () => ui.openMain({ sheet: 'settings' }) },
        { type: 'separator' },
        { label: 'Quit SSM Tunnels', click: () => app.quit() },
      ]));
    });
  }

  function buildAppMenu() {
    const command = (label, command, accelerator) => ({
      label, accelerator, registerAccelerator: false,
      click: () => { showMain(); mainWindow.sendWhenReady('ssm:event', { type: 'command', command }); },
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [
        { role: 'about' },
        command('Settings…', 'settings', 'Cmd+,'),
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', accelerator: 'Cmd+Q' },
      ] },
      { label: 'File', submenu: [
        command('New Tunnel', 'new', 'Cmd+N'),
        { role: 'close', accelerator: 'Cmd+W' },
      ] },
      { label: 'Edit', submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ] },
      { label: 'Tunnel', submenu: [
        command('Connect/Disconnect', 'toggle', 'Space'),
        command('Toggle Auto-connect', 'toggleAuto', 'Alt+Cmd+A'),
        command('Retry', 'retry', 'Cmd+R'),
        command('Edit…', 'edit', 'Cmd+I'),
        command('Duplicate…', 'duplicate', 'Cmd+D'),
        command('Copy localhost:port', 'copy'),
        command('Delete', 'delete', 'Cmd+Backspace'),
        { type: 'separator' },
        command('Connect All…', 'connectAll', 'Shift+Cmd+K'),
        command('Disconnect All', 'disconnectAll', 'Alt+Shift+Cmd+K'),
      ] },
      { label: 'View', submenu: [
        command('Find', 'find', 'Cmd+F'),
        command('Keyboard Shortcuts', 'shortcuts', '?'),
      ] },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    ]));
  }

  function createController() {
    const awsBin = env.resolveAwsBin(fs.existsSync);
    const childEnv = env.buildEnv(process.env);
    const manager = new TunnelManager({
      awsBin, env: childEnv, spawn: env.spawnDetached(childProcess.spawn), kill: env.killGroup(),
      stderrSink: env.fileStderrSink({ dir: path.join(app.getPath('userData'), 'sessions'), fs }),
    });
    const dataPath = path.join(app.getPath('userData'), 'connections.json');
    controller = new Controller({
      store: new Store({ file: dataPath }),
      manager, scan, archive,
      // Optional one-time import; set SSM_CONNECT_PATH, or have ssm-connect on PATH when launching.
      importPath: process.env.SSM_CONNECT_PATH || env.findOnPath('ssm-connect', process.env.PATH, fs.existsSync) || '',
      displayPath: (p) => env.displayPath(p, os.homedir()),
      dataPath,
      tools: env.readToolVersions({ execFile: childProcess.execFile, awsBin, env: childEnv }),
      loginItem: {
        supported: app.isPackaged,
        set: (on) => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on }); },
      },
      notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body }).show(); },
      clipboard,
      logger,
      // AWS profile management and sign-in use the same aws binary and child env as the tunnels (PATH has the plugin).
      aws: { home: os.homedir(), fs, execFile: childProcess.execFile, spawn: childProcess.spawn, awsBin, env: childEnv },
    });
    controller.on('state', (snapshot) => {
      updateTray(snapshot);
      broadcast('ssm:state', snapshot);
    });
    controller.on('event', (evt) => broadcast('ssm:event', evt));
  }

  app.on('second-instance', showMain);
  app.on('activate', showMain);
  app.on('window-all-closed', () => {});

  app.on('before-quit', (e) => {
    quitting = true;
    if (shutdownStarted || !controller) return;
    shutdownStarted = true;
    e.preventDefault();
    controller.shutdown().catch(() => {}).finally(() => app.quit());
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // `kill <pid>` or Ctrl-C: quit through before-quit so tunnels are stopped per the setting, not orphaned.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());

  app.whenReady().then(async () => {
    createController();
    createMainWindow();
    createPopover();
    createTray();
    buildAppMenu();
    registerIpc({
      ipcMain, controller, ui, isTrustedSender, shell,
      logs: { file: logger.file, maxBytes: logger.maxBytes, keep: logger.keep, readEntries, fs },
    });
    globalShortcut.register('Control+Alt+T', togglePopover);
    powerMonitor.on('resume', () => controller.onWake());
    await controller.start();
  }).catch((err) => dialog.showErrorBox('SSM Tunnels could not start', err.message));
}
