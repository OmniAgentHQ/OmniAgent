import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export { loginShell, shellCommand } from '../posixShell';

function looksLikeApplication(program: string) {
  if (program.endsWith('.app')) return true;
  if (program.includes('/')) return false;
  return applicationPath(program) !== null;
}

export function applicationPath(name: string) {
  const bare = name.replace(/\.app$/i, '');
  for (const directory of ['/Applications', '/System/Applications', `${process.env.HOME}/Applications`, '/System/Applications/Utilities', '/Applications/Utilities']) {
    const candidate = path.join(directory, `${bare}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnDetached(executable: string, args: string[], cwd?: string) {
  return new Promise<number | undefined>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

export async function launchApp(program: string, args = '') {
  const parsed = args.trim() ? args.trim().split(/\s+/) : [];
  if (looksLikeApplication(program)) {
    const bundle = program.includes('/') ? program : applicationPath(program) ?? program;
    const openArgs = ['-a', bundle, ...(parsed.length ? ['--args', ...parsed] : [])];
    await spawnDetached('/usr/bin/open', openArgs);
    return { launched: path.basename(program, '.app'), processId: undefined as number | undefined };
  }
  const processId = await spawnDetached(program, parsed);
  return { launched: program, processId };
}

export async function openWith(program: string, target: string) {
  const bundle = looksLikeApplication(program)
    ? (program.includes('/') ? program : applicationPath(program) ?? program)
    : null;
  if (bundle) {
    await spawnDetached('/usr/bin/open', ['-a', bundle, target]);
    return;
  }
  await spawnDetached(program, [target]);
}

export async function openTerminal(directory: string) {
  const preferred = ['iTerm', 'Ghostty', 'Warp', 'Alacritty', 'kitty', 'Terminal'];
  const application = preferred.map(applicationPath).find(Boolean) ?? '/System/Applications/Utilities/Terminal.app';
  await spawnDetached('/usr/bin/open', ['-a', application, directory]);
  return path.basename(application, '.app');
}
