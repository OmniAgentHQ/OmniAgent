import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

export type PythonAutomationPlan = {
  schema_version: '1.0';
  plan_id: string;
  mode: 'reply' | 'run';
  title: string;
  public_message: string;
  kind: 'normal' | 'ai' | 'condition' | 'wait';
  instruction: string;
  code?: string;
  capabilities: string[];
  requires_approval: boolean;
  approval_reason?: string;
  timeout_seconds?: number;
  max_attempts?: number;
  expected_outputs?: string[];
  success_criteria?: string[];
  estimated_duration_ms?: number;
};

export type PythonExecutionResult = {
  ok: boolean;
  plan: PythonAutomationPlan;
  result?: unknown;
  public_summary?: string;
  artifacts: Array<{ path: string; exists: boolean; size?: number | null }>;
  verification: { passed: boolean; evidence: unknown[]; artifacts?: unknown[] };
  attempts: unknown[];
  data?: Record<string, unknown>;
  duration_ms: number;
  error?: { type?: string; code?: string; message?: string; traceback?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (event: Record<string, unknown>) => void;
  abortCleanup?: () => void;
};

type RuntimeMessage = {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  event?: boolean;
  requestId?: string;
  [key: string]: unknown;
};

function runtimeCommand() {
  const runtimeEnvironment = { ...process.env };
  if (process.platform === 'darwin') {
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'OmniAgentHelper')
      : path.join(__dirname, '..', 'build', 'OmniAgentHelper');
    return { command: helper, args: [] as string[], env: runtimeEnvironment };
  }
  if (process.platform === 'linux') {
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, 'omniagent_helper.py')
      : path.join(__dirname, '..', 'native', 'linux', 'omniagent_helper.py');
    return { command: 'python3', args: [helper], env: runtimeEnvironment };
  }
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, 'OmniAgent.Runtime.exe')
    : path.join(__dirname, '..', 'build', 'python-runtime', 'OmniAgent.Runtime.exe');
  if (fs.existsSync(executable)) return { command: executable, args: [] as string[], env: runtimeEnvironment };
  const pythonRoot = path.join(__dirname, '..', 'native', 'windows');
  const venvPython = path.join(pythonRoot, '.venv', 'Scripts', 'python.exe');
  return {
    command: fs.existsSync(venvPython) ? venvPython : 'py.exe',
    args: fs.existsSync(venvPython) ? ['-m', 'omniagent_runtime'] : ['-3.12', '-m', 'omniagent_runtime'],
    env: {
      ...runtimeEnvironment,
      PYTHONPATH: [pythonRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    }
  };
}

export class PythonRuntimeClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closing = false;
  private readonly pending = new Map<string, PendingRequest>();
  private stderrTail = '';

  private async start() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const runtime = runtimeCommand();
      const child = spawn(runtime.command, runtime.args, {
        env: runtime.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => this.handleLine(line));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-20_000);
        this.emit('diagnostic', chunk);
      });
      child.once('spawn', () => resolve());
      child.once('error', (error) => {
        if (this.child === child) this.child = undefined;
        reject(error);
        this.rejectAll(error);
      });
      child.once('exit', (code) => {
        lines.close();
        if (this.child === child) this.child = undefined;
        if (!this.closing) {
          this.rejectAll(new Error(
            `The OmniAgent Python runtime exited unexpectedly (${code ?? 'unknown'}). ${this.stderrTail}`.trim()
          ));
        }
      });
    }).finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private handleLine(line: string) {
    let message: RuntimeMessage;
    try {
      message = JSON.parse(line) as RuntimeMessage;
    } catch {
      this.stderrTail = `${this.stderrTail}\nUnexpected runtime output: ${line}`.slice(-20_000);
      return;
    }
    if (message.event && message.requestId) {
      const pending = this.pending.get(message.requestId);
      pending?.onProgress?.(message);
      this.emit('progress', message);
      return;
    }
    const requestId = String(message.id ?? '');
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.abortCleanup?.();
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message || 'The Python automation runtime could not complete the request.');
      error.name = message.error?.code || 'PythonRuntimeError';
      pending.reject(error);
    }
  }

  private write(message: Record<string, unknown>) {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error('The OmniAgent Python runtime is not available.');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; onProgress?: (event: Record<string, unknown>) => void } = {}
  ): Promise<T> {
    options.signal?.throwIfAborted();
    await this.start();
    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        const cancelId = crypto.randomUUID();
        try {
          this.write({ id: cancelId, method: 'cancel', params: { request_id: requestId } });
        } catch {

        }
        reject(new DOMException('The Python automation was stopped by the user.', 'AbortError'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        onProgress: options.onProgress,
        abortCleanup: () => options.signal?.removeEventListener('abort', onAbort)
      });
      try {
        this.write({ id: requestId, method, params });
      } catch (error) {
        this.pending.delete(requestId);
        options.signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    });
  }

  health() {
    return this.call<{ name: string; version: string; python: string; capabilities: number }>('health');
  }

  compile(
    input: {
      instruction: string;
      provider: Record<string, unknown>;
      stepType?: string;
      context?: Record<string, unknown>;
      forceRun?: boolean;
    },
    signal?: AbortSignal
  ) {
    return this.call<PythonAutomationPlan>('compile', {
      instruction: input.instruction,
      provider: input.provider,
      step_type: input.stepType ?? 'normal',
      context: input.context ?? {},
      force_run: input.forceRun ?? false,
      maximum_attempts: 3
    }, { signal });
  }

  execute(
    input: {
      plan: PythonAutomationPlan;
      outputDir: string;
      workspace: string;
      provider?: Record<string, unknown>;
      inputs?: Record<string, unknown>;
      data?: Record<string, unknown>;
    },
    options: { signal?: AbortSignal; onProgress?: (event: Record<string, unknown>) => void } = {}
  ) {
    return this.call<PythonExecutionResult>('execute', {
      plan: input.plan,
      output_dir: input.outputDir,
      workspace: input.workspace,
      provider: input.provider ?? {},
      inputs: input.inputs ?? {},
      data: input.data ?? {}
    }, options);
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      child.stdin.end();
      child.kill();
    }
    this.rejectAll(new Error('The OmniAgent Python runtime was closed.'));
  }
}
