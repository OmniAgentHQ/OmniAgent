import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PythonRuntimeClient } from './pythonRuntime';

export type NativeAutomationElement = {
  parentIndex: number;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  processId: number;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  focused: boolean;
  password: boolean;
  helpText: string;
  accessKey: string;
  value: string;
  selected: boolean;
  checked: boolean;
  expanded: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  patterns: string[];
};

export type NativeAutomationSnapshot = {
  root: NativeAutomationElement;
  elements: NativeAutomationElement[];
  truncated: boolean;
};

function runtimeExecutablePath() {
  const override = process.env.OMNIAGENT_PYTHON_RUNTIME_PATH;
  if (override) return path.resolve(override);
  if (process.platform === 'linux') {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'omniagent_helper.py')
      : path.join(__dirname, '..', 'native', 'linux', 'omniagent_helper.py');
  }
  const executable = process.platform === 'darwin' ? 'OmniAgentHelper' : 'OmniAgent.Runtime.exe';
  return app.isPackaged
    ? path.join(process.resourcesPath, executable)
    : path.join(__dirname, '..', process.platform === 'darwin' ? 'build' : path.join('build', 'python-runtime'), executable);
}

export class NativeAutomationClient {
  private readonly runtime = new PythonRuntimeClient();
  private readonly allowedRoots = new Set<string>();
  private stopped = false;

  constructor(initialRoots: string[] = []) {
    for (const root of initialRoots) this.allowedRoots.add(path.resolve(root));
  }

  get executablePath() {
    return runtimeExecutablePath();
  }

  get installed() {
    return fs.existsSync(this.executablePath) || !app.isPackaged;
  }

  async start() {
    if (this.stopped) throw new Error('The Python Windows automation client has been stopped.');
    await this.runtime.health();
  }

  async call<T = unknown>(method: string, parameters: Record<string, unknown> = {}, timeoutMs = 30_000, _alreadyStarted = false): Promise<T> {
    if (this.stopped) throw new Error('The Python Windows automation client has been stopped.');
    const signal = AbortSignal.timeout(Math.max(1_000, timeoutMs));
    return this.runtime.call<T>('native.call', {
      native_method: method,
      native_params: parameters,
      allowed_roots: [...this.allowedRoots]
    }, { signal });
  }

  async authorizeRoot(root: string) {
    const normalized = path.resolve(root);
    this.allowedRoots.add(normalized);
    return this.call('filesystem.authorizeRoot', { path: normalized });
  }

  async snapshot(input: {
    window?: { handle?: string; title?: string; processId?: number };
    maxDepth?: number;
    maxElements?: number;
  } = {}) {
    return this.call<NativeAutomationSnapshot>('uia.snapshot', input, 15_000);
  }

  async invoke(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string };
    timeoutMs?: number;
  }) {
    return this.call('uia.invoke', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async setValue(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string };
    value: string;
    timeoutMs?: number;
  }) {
    return this.call<{ set: boolean; value: string }>('uia.setValue', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async select(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string };
    timeoutMs?: number;
  }) {
    return this.call('uia.select', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async query(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: Record<string, unknown>;
    selection?: string;
    index?: number;
    timeoutMs?: number;
  }) {
    return this.call<{ count: number; elements: NativeAutomationElement[] }>('uia.query', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async perform(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: Record<string, unknown>;
    selection?: string;
    index?: number;
    operation: string;
    value?: unknown;
    options?: Record<string, unknown>;
    timeoutMs?: number;
  }) {
    return this.call<{ count: number; results: unknown[] }>('uia.perform', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async assert(input: {
    window?: { handle?: string; title?: string; processId?: number };
    selector: Record<string, unknown>;
    selection?: string;
    index?: number;
    assertion: string;
    expected?: unknown;
    timeoutMs?: number;
  }) {
    return this.call<{ passed: boolean; actual?: unknown; count: number }>('uia.assert', input, (input.timeoutMs ?? 5_000) + 2_000);
  }

  async filesystem<T = unknown>(operation: string, parameters: Record<string, unknown>) {
    return this.call<T>(`filesystem.${operation}`, parameters);
  }

  async launch(parameters: Record<string, unknown>) {
    return this.call('process.launch', parameters);
  }

  async listWindows() {
    return this.call('windows.list', { visibleOnly: true });
  }

  async moveResizeWindow(parameters: Record<string, unknown>) {
    return this.call('windows.moveResize', parameters);
  }

  async showWindowState(parameters: Record<string, unknown>) {
    return this.call('windows.showState', parameters);
  }

  async focusWindow(input: { handle?: string; title?: string; processId?: number }) {
    return this.call('windows.focus', input);
  }

  async foregroundWindow() {
    return this.call<{ title: string; processId: number }>('windows.foreground', {}, 8_000);
  }

  async sendText(text: string) {
    return this.call('input.sendText', { text });
  }

  async sendKey(key: string) {
    return this.call('input.sendKey', { key });
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left', double = false) {
    return this.call('input.click', { x, y, button, double });
  }

  async scroll(delta: number) {
    return this.call('input.scroll', { delta });
  }

  async lastInputActivity() {
    return this.call<{ lastInputTick: number; millisecondsAgo: number; source: 'physical' | 'automation' }>('input.lastActivity');
  }

  async close() {
    this.stopped = true;
    this.runtime.close();
  }
}
