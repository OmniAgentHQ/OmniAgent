import { spawn, type ChildProcess } from 'node:child_process';

export function terminateOwnedProcess(child: ChildProcess, group = false) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.unref();
  } else {
    try { process.kill(group ? -child.pid : child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }
}
