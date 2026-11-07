import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { applyMigrations, openWorkspaceDatabase, readSetting, writeSetting } from './database';
import { ProviderRuntimeManager } from './providerRuntime';
import { ConnectionService, insecureStorageWarning } from './connections';
import { ComputerHub } from './computer';
import { Orchestrator } from './orchestrator';
import { PROVIDER_NAMES } from './providerTraits';
import { openPermissionSettings, permissionReport, requestAccessibility, requestScreenRecording } from './platform/macos/permissions';
import { APP_NAME, type AppSnapshot, type TeamConfig } from './shared';

app.setName(APP_NAME);

const isDev = !app.isPackaged && process.argv.includes('--dev');
const devServerUrl = process.env.OMNIAGENT_DEV_URL || 'http://127.0.0.1:5173';
const ownsPrimaryInstance = app.requestSingleInstanceLock();
if (!ownsPrimaryInstance) app.quit();

const windowIconPath = !app.isPackaged
  ? path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  : path.join(process.resourcesPath, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// A packaged .app takes its Dock icon and name from its bundle. A dev run has no bundle of its own,
// so it would show the stock Electron atom. nativeImage reads PNG, not .icns, hence the separate file.
const devDockIconPath = path.join(__dirname, '..', 'build', 'icon-dock.png');

let db: Database.Database;
let providerRuntime: ProviderRuntimeManager;
let connections: ConnectionService;
let computer: ComputerHub;
let orchestrator: Orchestrator;
let mainWindow: BrowserWindow | null = null;
let exitCleanupStarted = false;
let exitCleanupComplete = false;

const providerSchema = z.enum(PROVIDER_NAMES);
const runtimeSchema = z.enum(['claude', 'codex']);
const idSchema = z.object({ id: z.string().min(1).max(200) });

const choiceShape = {
  provider: providerSchema,
  connectionId: z.string().max(200).default(''),
  model: z.string().max(300).default(''),
  effort: z.string().max(20).default('high')
};

const loopSchema = z.union([
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('immediate'), delaySeconds: z.number().int().min(5).max(86_400).optional() }),
  z.object({ mode: z.literal('time-spread'), runsPerPeriod: z.number().int().min(1).max(1_440), period: z.enum(['hour', 'day']) }),
  z.object({
    mode: z.literal('active-window'),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
    runMode: z.enum(['once', 'immediate', 'time-spread']),
    runsPerPeriod: z.number().int().min(1).max(1_440).optional(),
    period: z.enum(['hour', 'day']).optional()
  })
]);

const teamSchema = z.object({
  agents: z.array(z.object({
    id: z.string().min(1).max(80),
    handle: z.string().min(1).max(40),
    browsing: z.enum(['visible', 'hidden']).default('hidden'),
    ...choiceShape
  })),
  finisher: z.object({ enabled: z.boolean(), rounds: z.number().int().min(1).max(100), ...choiceShape }).nullable(),
  pulseMinutes: z.number().int().min(0).max(60),
  loop: loopSchema
});

const previewImageTypes = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif']
]);

function gifFrameCount(bytes: Buffer) {
  if (bytes.length < 13 || bytes.subarray(0, 3).toString('ascii') !== 'GIF') return 0;
  let offset = 13;
  const globalPacked = bytes[10];
  if (globalPacked & 0x80) offset += 3 * (2 ** ((globalPacked & 0x07) + 1));
  let frames = 0;
  const skipSubBlocks = () => {
    while (offset < bytes.length) {
      const size = bytes[offset];
      offset += 1;
      if (!size) break;
      offset += size;
    }
  };
  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      skipSubBlocks();
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) break;
    frames += 1;
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
    offset += 1;
    skipSubBlocks();
    if (frames > 1) return frames;
  }
  return frames;
}

function themeFilePath() {
  return path.join(app.getPath('userData'), 'appearance.json');
}

function storedTheme(): 'light' | 'dark' {
  try {
    const raw = fs.readFileSync(themeFilePath(), 'utf8');
    return JSON.parse(raw).theme === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function writeStoredTheme(theme: 'light' | 'dark') {
  try {
    fs.mkdirSync(path.dirname(themeFilePath()), { recursive: true });
    fs.writeFileSync(themeFilePath(), JSON.stringify({ theme }), 'utf8');
  } catch {
  }
}

function applyThemeToChrome(window: BrowserWindow, theme: 'light' | 'dark') {
  const dark = theme === 'dark';
  nativeTheme.themeSource = dark ? 'dark' : 'light';
  if (window.isDestroyed()) return;
  window.setBackgroundColor(dark ? '#0a0b0f' : '#f6f7fb');
  if (process.platform === 'darwin') return;
  try {
    window.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: dark ? '#c9ccd6' : '#3b3f4c',
      height: 44
    });
  } catch {
  }
}

function recordFatalError(context: string, error: unknown) {
  try {
    const directory = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(directory, { recursive: true });
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    fs.appendFileSync(path.join(directory, 'main-errors.log'), `[${new Date().toISOString()}] ${context}: ${detail}\n`, 'utf8');
  } catch {
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function quitWithoutBackgroundProcesses() {
  if (exitCleanupStarted) return;
  exitCleanupStarted = true;
  const cleanup = (async () => {
    await orchestrator?.close();
    connections?.close();
    providerRuntime?.removeAllListeners();
    providerRuntime?.close();
    await computer?.close();
    computer?.desktop.closeAll();
    if (db?.open) db.close();
  })().catch((error) => recordFatalError('shutdown', error));
  await Promise.race([cleanup, wait(4_000)]);
  exitCleanupComplete = true;
  app.exit(0);
}

function attachContextMenu(contents: Electron.WebContents) {
  contents.on('context-menu', (_event, parameters) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (parameters.isEditable) {
      items.push(
        { role: 'undo', enabled: parameters.editFlags.canUndo },
        { role: 'redo', enabled: parameters.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: parameters.editFlags.canCut },
        { role: 'copy', enabled: parameters.editFlags.canCopy },
        { role: 'paste', enabled: parameters.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: parameters.editFlags.canSelectAll }
      );
    } else if (parameters.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
  });
}

function broadcast(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function snapshot(): AppSnapshot {
  return {
    connections: connections.listConnections(),
    sessions: orchestrator.listSessions(),
    runtimes: connections.providerRuntimeStatus(),
    theme: storedTheme(),
    defaultTeam: orchestrator.defaultTeam(),
    storageWarning: insecureStorageWarning(),
    platform: process.platform,
    desktopReady: computer.desktop.nativeInstalled,
    onboarded: readSetting<boolean>(db, 'onboarded', false)
  };
}

let snapshotTimer: NodeJS.Timeout | undefined;
function pushSnapshot() {
  if (snapshotTimer || exitCleanupStarted) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = undefined;
    if (!exitCleanupStarted && db?.open) broadcast('app:snapshot', snapshot());
  }, 60);
}

function createWindow() {
  const theme = storedTheme();
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 720,
    minHeight: 520,
    title: APP_NAME,
    icon: windowIconPath,
    autoHideMenuBar: true,
    backgroundColor: theme === 'dark' ? '#0a0b0f' : '#f6f7fb',
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 16 } }
      : { titleBarOverlay: { color: '#00000000', symbolColor: theme === 'dark' ? '#c9ccd6' : '#3b3f4c', height: 44 } }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--omniagent-platform=${process.platform}`, `--omniagent-theme=${theme}`, `--omniagent-dev=${isDev ? 1 : 0}`]
    }
  });
  mainWindow = window;
  applyThemeToChrome(window, theme);
  attachContextMenu(window.webContents);
  window.setMenuBarVisibility(false);
  let revealed = false;
  let lastRecoveryAt = 0;
  const reveal = () => {
    if (revealed || window.isDestroyed() || exitCleanupStarted) return;
    revealed = true;
    window.maximize();
    window.show();
  };
  const load = () => {
    if (window.isDestroyed() || exitCleanupStarted) return;
    if (isDev) void window.loadURL(devServerUrl).catch(() => undefined);
    else void window.loadFile(path.join(__dirname, '../dist/index.html')).catch(() => undefined);
  };
  const recover = () => {
    if (window.isDestroyed() || exitCleanupStarted || Date.now() - lastRecoveryAt < 1_500) return;
    lastRecoveryAt = Date.now();
    setTimeout(load, 500);
  };
  window.once('ready-to-show', reveal);
  window.webContents.once('did-finish-load', () => setTimeout(reveal, 0));
  setTimeout(reveal, 3_000);
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) recover();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (['crashed', 'oom', 'killed', 'integrity-failure'].includes(details.reason)) recover();
  });
  window.webContents.on('did-stop-loading', () => {
    if (!window.isDestroyed() && (window.webContents.getURL() === '' || window.webContents.getURL() === 'about:blank')) recover();
  });
  window.on('close', (event) => {
    if (exitCleanupComplete) return;
    event.preventDefault();
    window.hide();
    window.destroy();
    void quitWithoutBackgroundProcesses();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(devServerUrl) : url.startsWith('file:');
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  load();
}

function registerIpc() {
  ipcMain.handle('app:snapshot', () => snapshot());
  ipcMain.handle('app:set-theme', (_event, payload: unknown) => {
    const theme = z.enum(['dark', 'light']).parse(payload);
    writeStoredTheme(theme);
    if (mainWindow && !mainWindow.isDestroyed()) applyThemeToChrome(mainWindow, theme);
    pushSnapshot();
    return theme;
  });
  ipcMain.handle('app:complete-onboarding', () => {
    writeSetting(db, 'onboarded', true);
    pushSnapshot();
    return true;
  });

  ipcMain.handle('dialog:choose-folder', async (_event, payload: unknown) => {
    const value = z.object({ defaultPath: z.string().max(2_000).optional() }).optional().parse(payload);
    const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: 'Choose the workspace folder',
      defaultPath: value?.defaultPath || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0] ?? '';
  });
  ipcMain.handle('dialog:choose-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getAllWindows()[0], {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    return result.filePaths.map((file) => ({ path: file, name: path.basename(file), size: fs.statSync(file).size }));
  });
  ipcMain.handle('clipboard:save-file', (_event, payload: unknown) => {
    const value = z.object({
      name: z.string().max(260),
      bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= 50 * 1024 * 1024)
    }).parse(payload);
    const extension = path.extname(value.name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/)?.[0] ?? '.png';
    const base = path.basename(value.name, path.extname(value.name)).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'pasted';
    const directory = path.join(app.getPath('userData'), 'pasted');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
    fs.writeFileSync(file, value.bytes);
    return { path: file, name: `${base}${extension}` };
  });

  ipcMain.handle('session:create', (_event, payload: unknown) => {
    const value = z.object({ workspace: z.string().min(1).max(4_000), team: teamSchema.optional(), title: z.string().max(200).optional() }).parse(payload);
    return orchestrator.createSession(value.workspace, value.team as TeamConfig | undefined, value.title);
  });
  ipcMain.handle('team:save-default', (_event, payload: unknown) => orchestrator.saveDefaultTeam(teamSchema.parse(payload) as TeamConfig));
  ipcMain.handle('session:update', (_event, payload: unknown) => {
    const value = z.object({
      id: z.string().min(1),
      title: z.string().max(200).optional(),
      workspace: z.string().max(4_000).optional(),
      team: teamSchema.optional()
    }).parse(payload);
    return orchestrator.updateSession({ ...value, team: value.team as TeamConfig | undefined });
  });
  ipcMain.handle('session:delete', (_event, payload: unknown) => orchestrator.deleteSession(idSchema.parse(payload).id));
  ipcMain.handle('session:runs', (_event, payload: unknown) => orchestrator.listRuns(idSchema.parse(payload).id));
  ipcMain.handle('run:step-detail', (_event, payload: unknown) => {
    const value = z.object({ runId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200), stepId: z.string().min(1).max(400) }).parse(payload);
    return orchestrator.stepDetail(value.runId, value.ownerId, value.stepId);
  });
  ipcMain.handle('session:send', (_event, payload: unknown) => {
    const value = z.object({
      id: z.string().min(1),
      text: z.string().max(100_000),
      attachments: z.array(z.object({ path: z.string().min(1).max(4_000), name: z.string().max(400) })).max(20).default([])
    }).parse(payload);
    return orchestrator.send({ sessionId: value.id, text: value.text, attachments: value.attachments });
  });
  ipcMain.handle('session:stop', (_event, payload: unknown) => orchestrator.stop(idSchema.parse(payload).id));
  ipcMain.handle('session:stop-agent', (_event, payload: unknown) => {
    const value = z.object({ id: z.string().min(1), agentId: z.string().min(1) }).parse(payload);
    return orchestrator.stopAgent(value.id, value.agentId);
  });

  ipcMain.handle('path:open', async (_event, payload: unknown) => {
    const target = z.object({ path: z.string().min(1).max(4_000) }).parse(payload).path;
    if (!fs.existsSync(target)) throw new Error('That file or folder no longer exists.');
    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
    return true;
  });
  ipcMain.handle('path:reveal', (_event, payload: unknown) => {
    const target = z.object({ path: z.string().min(1).max(4_000) }).parse(payload).path;
    if (!fs.existsSync(target)) throw new Error('That file or folder no longer exists.');
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('path:exists', (_event, payload: unknown) => {
    const target = z.object({ path: z.string().min(1).max(4_000) }).parse(payload).path;
    return fs.existsSync(target);
  });
  ipcMain.handle('file:image-preview', async (_event, payload: unknown) => {
    const value = z.object({ path: z.string().min(1).max(32_000) }).parse(payload);
    const absolutePath = path.resolve(value.path);
    const mimeType = previewImageTypes.get(path.extname(absolutePath).toLowerCase());
    if (!mimeType) return { previewable: false, reason: 'unsupported' };
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return { previewable: false, reason: 'missing' };
    }
    const bytes = fs.readFileSync(absolutePath);
    if (mimeType === 'image/gif' && gifFrameCount(bytes) > 1) {
      return { previewable: false, reason: 'animated-gif' };
    }
    return {
      previewable: true,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
    };
  });
  ipcMain.handle('file:save-copy', async (_event, payload: unknown) => {
    const value = z.object({ path: z.string().min(1).max(32_000) }).parse(payload);
    const source = path.resolve(value.path);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('The file no longer exists.');
    const extension = path.extname(source).slice(1);
    const result = await dialog.showSaveDialog({
      title: 'Save a copy',
      defaultPath: path.basename(source),
      filters: extension ? [{ name: `${extension.toUpperCase()} file`, extensions: [extension] }] : undefined
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const destination = path.resolve(result.filePath);
    if (destination !== source) fs.copyFileSync(source, destination);
    return { canceled: false, filePath: destination };
  });
  ipcMain.handle('external:open', async (_event, payload: unknown) => {
    const url = z.object({ url: z.string().url().max(4_000) }).parse(payload).url;
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened.');
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('permissions:status', () => process.platform === 'darwin' ? permissionReport() : null);
  ipcMain.handle('permissions:request', async (_event, payload: unknown) => {
    if (process.platform !== 'darwin') return null;
    const which = z.enum(['accessibility', 'screenRecording']).parse(payload);
    if (which === 'accessibility') requestAccessibility();
    else await requestScreenRecording();
    await openPermissionSettings(which);
    return permissionReport();
  });

  ipcMain.handle('connection:connect', (_event, payload: unknown) => connections.connectProvider(z.object({ provider: providerSchema }).parse(payload).provider));
  ipcMain.handle('connection:cancel-connect', (_event, payload: unknown) => connections.cancelProviderConnect(z.object({ provider: providerSchema }).parse(payload).provider));
  ipcMain.handle('connection:disconnect', (_event, payload: unknown) => connections.disconnectProvider(idSchema.parse(payload).id));
  ipcMain.handle('connection:refresh', (_event, payload: unknown) => connections.refreshProviderConnections(z.object({ models: z.boolean().optional() }).optional().parse(payload)?.models ?? false));
  ipcMain.handle('credential:add', (_event, payload: unknown) => {
    const parsed = z.object({
      provider: providerSchema,
      label: z.string().trim().max(80).default(''),
      secret: z.string().trim().min(8, 'Paste the whole key.').max(500)
    }).safeParse(payload);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'That key could not be added.');
    return connections.addCredential(parsed.data.provider, parsed.data.label, parsed.data.secret);
  });
  ipcMain.handle('credential:delete', (_event, payload: unknown) => connections.deleteCredential(idSchema.parse(payload).id));

  ipcMain.handle('runtime:status', () => connections.providerRuntimeStatus());
  ipcMain.handle('runtime:install', (event, payload: unknown) => {
    const { runtime } = z.object({ runtime: runtimeSchema }).parse(payload);
    return connections.installProviderRuntime(runtime, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('runtime:progress', progress);
    });
  });

  ipcMain.handle('runtime:details', (_event, payload: unknown) => connections.providerRuntimeDetails(z.object({ checkLatest: z.boolean().optional() }).optional().parse(payload)?.checkLatest ?? false));
  ipcMain.handle('runtime:cancel-update', (_event, payload: unknown) => connections.cancelRuntimeUpdate(z.object({ runtime: runtimeSchema }).parse(payload).runtime));
  ipcMain.handle('runtime:update', (event, payload: unknown) => {
    const { runtime } = z.object({ runtime: runtimeSchema }).parse(payload);
    return connections.updateProviderRuntime(runtime, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('runtime:progress', progress);
    });
  });
}

if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
if (process.platform === 'win32') app.setAppUserModelId('app.omniagent.core');

if (ownsPrimaryInstance) app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(devDockIconPath);
    } catch {
    }
  }
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write');
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  const userData = app.getPath('userData');
  try {
    fs.mkdirSync(userData, { recursive: true });
    db = openWorkspaceDatabase(userData).db;
    applyMigrations(db);
    providerRuntime = new ProviderRuntimeManager(userData);
    connections = new ConnectionService(db, providerRuntime, userData);
    computer = new ComputerHub((workerId, prompt, png, signal) => orchestrator.visionFor(workerId, prompt, png, signal));
    orchestrator = new Orchestrator(db, providerRuntime, connections, computer, path.join(userData, 'Attachments'));
    connections.initialize();
    orchestrator.initialize();
  } catch (error) {
    recordFatalError('startup', error);
    dialog.showErrorBox(
      'OmniAgent could not start',
      'OmniAgent could not open its local data and was unable to start.\n\n'
      + `A record of what happened is in:\n${path.join(userData, 'logs', 'main-errors.log')}`
    );
    app.exit(1);
    return;
  }
  connections.on('changed', pushSnapshot);
  orchestrator.on('sessions', pushSnapshot);
  orchestrator.on('run', (payload) => broadcast('run:update', payload));
  orchestrator.on('pulse', (payload) => broadcast('run:pulse', payload));
  orchestrator.on('notice', (payload) => broadcast('app:notice', payload));
  registerIpc();
  Menu.setApplicationMenu(null);
  createWindow();
  void computer.initialize().catch((error) => recordFatalError('browser', error));
  app.on('activate', () => {
    if (!exitCleanupStarted && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

if (ownsPrimaryInstance) app.on('second-instance', () => {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

app.on('window-all-closed', () => {
  if (!exitCleanupStarted) void quitWithoutBackgroundProcesses();
});

app.on('before-quit', (event) => {
  if (exitCleanupComplete) return;
  event.preventDefault();
  void quitWithoutBackgroundProcesses();
});
