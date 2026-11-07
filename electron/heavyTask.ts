import { fork } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { terminateOwnedProcess } from './ownedProcess';

export const inHeavyTask = () => process.env.OMNIAGENT_HEAVY_CHILD === '1';

export function heavyTask<T>(job: string, args: unknown[], signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const temporary = job === 'editText' ? `${String(args[0])}.${crypto.randomUUID()}.partial` : undefined;
  if (temporary) args = [...args, temporary];
  return new Promise((resolve, reject) => {
    const local = path.join(__dirname, 'heavyTaskChild.js');
    const script = fs.existsSync(local) ? local : path.join(__dirname, '..', 'dist-electron', 'heavyTaskChild.js');
    const child = fork(script, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OMNIAGENT_HEAVY_CHILD: '1' },
      execArgv: [], detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced'
    });
    let settled = false;
    let diagnostic = '';
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result as T);
    };
    const abort = () => { terminateOwnedProcess(child, true); finish(new DOMException('Stopped', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('message', (message: any) => {
      finish(message.error ? Object.assign(new Error(message.error.message), { name: message.error.name }) : undefined, message.result);
    });
    child.once('error', finish);
    child.once('exit', code => { if (temporary) void fs.promises.rm(temporary, { force: true }).catch(() => undefined); if (!settled) finish(new Error(`File processing exited (${code}). ${diagnostic}`)); });
    child.send({ job, args }, error => { if (error) finish(error); });
    if (signal?.aborted) abort();
  });
}
