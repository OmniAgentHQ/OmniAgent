import { contextBridge, ipcRenderer, webUtils } from 'electron';

const argument = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1] ?? '';

function subscribe(channel: string, listener: (payload: any) => void) {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('omni', {
  platform: argument('omniagent-platform'),
  initialTheme: argument('omniagent-theme'),
  isDev: argument('omniagent-dev') === '1',
  snapshot: () => invoke('app:snapshot'),
  setTheme: (theme: string) => invoke('app:set-theme', theme),
  completeOnboarding: () => invoke('app:complete-onboarding'),
  chooseFolder: (defaultPath?: string) => invoke('dialog:choose-folder', { defaultPath }),
  chooseFiles: () => invoke('dialog:choose-files'),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  saveClipboardFile: (name: string, bytes: Uint8Array) => invoke('clipboard:save-file', { name, bytes }),
  createSession: (workspace: string, team?: unknown, title?: string) => invoke('session:create', { workspace, team, title }),
  saveDefaultTeam: (team: unknown) => invoke('team:save-default', team),
  updateSession: (payload: unknown) => invoke('session:update', payload),
  deleteSession: (id: string) => invoke('session:delete', { id }),
  runs: (id: string) => invoke('session:runs', { id }),
  stepDetail: (runId: string, ownerId: string, stepId: string) => invoke('run:step-detail', { runId, ownerId, stepId }),
  send: (id: string, text: string, attachments: Array<{ path: string; name: string }>) => invoke('session:send', { id, text, attachments }),
  stop: (id: string) => invoke('session:stop', { id }),
  stopAgent: (id: string, agentId: string) => invoke('session:stop-agent', { id, agentId }),
  openPath: (path: string) => invoke('path:open', { path }),
  revealPath: (path: string) => invoke('path:reveal', { path }),
  pathExists: (path: string) => invoke('path:exists', { path }),
  imagePreview: (path: string) => invoke('file:image-preview', { path }),
  saveCopy: (path: string) => invoke('file:save-copy', { path }),
  openExternal: (url: string) => invoke('external:open', { url }),
  macPermissions: () => invoke('permissions:status'),
  requestMacPermission: (which: string) => invoke('permissions:request', which),
  connect: (provider: string) => invoke('connection:connect', { provider }),
  cancelConnect: (provider: string) => invoke('connection:cancel-connect', { provider }),
  disconnect: (id: string) => invoke('connection:disconnect', { id }),
  refreshConnections: (models = false) => invoke('connection:refresh', { models }),
  addKey: (provider: string, label: string, secret: string) => invoke('credential:add', { provider, label, secret }),
  deleteKey: (id: string) => invoke('credential:delete', { id }),
  installRuntime: (runtime: string) => invoke('runtime:install', { runtime }),
  runtimeDetails: (checkLatest = false) => invoke('runtime:details', { checkLatest }),
  updateRuntime: (runtime: string) => invoke('runtime:update', { runtime }),
  cancelRuntimeUpdate: (runtime: string) => invoke('runtime:cancel-update', { runtime }),
  onSnapshot: (listener: (payload: any) => void) => subscribe('app:snapshot', listener),
  onRun: (listener: (payload: any) => void) => subscribe('run:update', listener),
  onPulse: (listener: (payload: any) => void) => subscribe('run:pulse', listener),
  onNotice: (listener: (payload: any) => void) => subscribe('app:notice', listener),
  onRuntimeProgress: (listener: (payload: any) => void) => subscribe('runtime:progress', listener)
});
