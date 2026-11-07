import type { AppSnapshot, RunView, RuntimeProgressEvent, SessionView, TeamConfig, ToolStepDetail } from '../electron/shared';

export type RuntimeId = 'codex' | 'claude';

export type RuntimeDetails = {
  runtime: RuntimeId;
  label: string;
  installed: boolean;
  path: string;
  version?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  error?: string;
  override: boolean;
};

export type MacPermission = 'accessibility' | 'screenRecording';
export type MacPermissionReport = Record<MacPermission, 'granted' | 'denied' | 'unknown'>;

type Unsubscribe = () => void;

export type OmniApi = {
  platform: string;
  initialTheme: string;
  isDev: boolean;
  completeOnboarding(): Promise<boolean>;
  snapshot(): Promise<AppSnapshot>;
  setTheme(theme: 'dark' | 'light'): Promise<string>;
  chooseFolder(defaultPath?: string): Promise<string>;
  chooseFiles(): Promise<Array<{ path: string; name: string; size: number }>>;
  pathForFile(file: File): string;
  saveClipboardFile(name: string, bytes: Uint8Array): Promise<{ path: string; name: string }>;
  createSession(workspace: string, team?: TeamConfig, title?: string): Promise<SessionView>;
  saveDefaultTeam(team: TeamConfig): Promise<TeamConfig>;
  updateSession(payload: { id: string; title?: string; workspace?: string; team?: TeamConfig }): Promise<SessionView>;
  deleteSession(id: string): Promise<void>;
  runs(id: string): Promise<RunView[]>;
  stepDetail(runId: string, ownerId: string, stepId: string): Promise<ToolStepDetail | null>;
  send(id: string, text: string, attachments: Array<{ path: string; name: string }>): Promise<{ runId: string }>;
  stop(id: string): Promise<void>;
  stopAgent(id: string, agentId: string): Promise<void>;
  openPath(path: string): Promise<boolean>;
  revealPath(path: string): Promise<boolean>;
  pathExists(path: string): Promise<boolean>;
  imagePreview(path: string): Promise<{ previewable: boolean; dataUrl?: string; reason?: string }>;
  saveCopy(path: string): Promise<{ canceled: boolean; filePath?: string }>;
  openExternal(url: string): Promise<boolean>;
  macPermissions(): Promise<MacPermissionReport | null>;
  requestMacPermission(which: MacPermission): Promise<MacPermissionReport | null>;
  connect(provider: string): Promise<void>;
  cancelConnect(provider: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  refreshConnections(models?: boolean): Promise<void>;
  addKey(provider: string, label: string, secret: string): Promise<string>;
  deleteKey(id: string): Promise<void>;
  installRuntime(runtime: string): Promise<Record<string, boolean>>;
  runtimeDetails(checkLatest?: boolean): Promise<RuntimeDetails[]>;
  updateRuntime(runtime: RuntimeId): Promise<{ runtimes: RuntimeDetails[]; note?: string }>;
  cancelRuntimeUpdate(runtime: RuntimeId): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): Unsubscribe;
  onRun(listener: (payload: { sessionId: string; run: RunView }) => void): Unsubscribe;
  onPulse(listener: (payload: { sessionId: string; runId: string; pulseId: string }) => void): Unsubscribe;
  onNotice(listener: (payload: { sessionId: string; message: string }) => void): Unsubscribe;
  onRuntimeProgress(listener: (payload: RuntimeProgressEvent) => void): Unsubscribe;
};

declare global {
  interface Window {
    omni: OmniApi;
  }
}

export const omni = window.omni;

export function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '').trim() || 'Something went wrong.';
}
