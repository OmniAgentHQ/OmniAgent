import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export { loginShell, shellCommand } from '../posixShell';

export function desktopDirectories(environment: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const dataHome = environment.XDG_DATA_HOME?.trim();
  const roots = [
    dataHome && path.posix.isAbsolute(dataHome) ? dataHome : path.posix.join(home, '.local', 'share'),
    ...(environment.XDG_DATA_DIRS?.trim() || '/usr/local/share:/usr/share')
      .split(':')
      .map((entry) => entry.trim())
      .filter((entry) => entry && path.posix.isAbsolute(entry))
  ];
  return [...new Set(roots)].map((root) => path.posix.join(root, 'applications'));
}

export function execFromDesktopEntry(contents: string) {
  let inEntryGroup = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inEntryGroup = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntryGroup || !line.startsWith('Exec=')) continue;
    const command = line
      .slice('Exec='.length)
      .replace(/%%/g, '\u0000')
      .replace(/%[a-zA-Z]/g, '')
      .replace(/\u0000/g, '%')
      .trim();
    return command || null;
  }
  return null;
}

export function splitExec(command: string) {
  const parts: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    if (match[1] !== undefined) parts.push(match[1].replace(/\\(.)/g, '$1'));
    else if (match[2] !== undefined) parts.push(match[2]);
    else if (match[3] !== undefined) parts.push(match[3]);
  }
  return parts;
}

function readDesktopEntry(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function entryField(contents: string, key: string) {
  let inEntryGroup = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inEntryGroup = line === '[Desktop Entry]';
      continue;
    }
    if (inEntryGroup && line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

export function findDesktopEntry(name: string, directories = desktopDirectories()) {
  const wanted = name.replace(/\.desktop$/i, '').toLowerCase();

  const files: string[] = [];
  for (const directory of directories) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.desktop')) files.push(path.join(directory, entry));
    }
  }

  const idOf = (file: string) => path.basename(file, '.desktop').toLowerCase();

  const exact = files.find((file) => idOf(file) === wanted);
  if (exact) return exact;

  const bySuffix = files.find((file) => idOf(file).split('.').pop() === wanted);
  if (bySuffix) return bySuffix;

  for (const file of files) {
    const contents = readDesktopEntry(file);
    if (!contents) continue;
    const displayName = entryField(contents, 'Name');
    if (displayName && displayName.toLowerCase() === wanted) return file;
  }

  for (const file of files) {
    const contents = readDesktopEntry(file);
    if (!contents) continue;
    const genericName = entryField(contents, 'GenericName');
    if (genericName && genericName.toLowerCase() === wanted) return file;
  }

  const named = files
    .map((file) => ({ file, name: (entryField(readDesktopEntry(file) ?? '', 'Name') ?? '').toLowerCase() }))
    .filter((entry) => entry.name);
  const prefixed = named
    .filter((entry) => entry.name.startsWith(wanted))
    .sort((left, right) => left.name.length - right.name.length);
  if (prefixed.length) return prefixed[0].file;

  const idPrefixed = files
    .filter((file) => idOf(file).split('.').pop()?.startsWith(wanted))
    .sort((left, right) => idOf(left).length - idOf(right).length);
  if (idPrefixed.length) return idPrefixed[0];

  const contained = named.filter((entry) => entry.name.includes(wanted));
  if (contained.length === 1) return contained[0].file;
  return null;
}

function onPath(program: string, environment: NodeJS.ProcessEnv = process.env) {
  if (program.includes('/')) return fs.existsSync(program) ? program : null;
  for (const directory of (environment.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = path.join(directory, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}

export function resolveProgram(program: string): { executable: string; args: string[] } | null {
  const direct = onPath(program);
  if (direct) return { executable: direct, args: [] };

  const entry = findDesktopEntry(program);
  if (!entry) return null;
  const contents = readDesktopEntry(entry);
  if (!contents) return null;
  const exec = execFromDesktopEntry(contents);
  if (!exec) return null;
  const parts = splitExec(exec);
  if (!parts.length) return null;
  const executable = onPath(parts[0]) ?? parts[0];
  return { executable, args: parts.slice(1) };
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
  const resolved = resolveProgram(program);
  if (!resolved) {
    throw new Error(`No application or command called ${program} is installed.`);
  }
  const processId = await spawnDetached(resolved.executable, [...resolved.args, ...parsed]);
  return { launched: path.basename(program, '.desktop'), processId };
}

export async function openWith(program: string, target: string) {
  const resolved = resolveProgram(program);
  if (!resolved) {
    throw new Error(`No application or command called ${program} is installed.`);
  }
  await spawnDetached(resolved.executable, [...resolved.args, target]);
}

const TERMINAL_DIRECTORY_FLAGS: Record<string, (directory: string) => string[]> = {
  ptyxis: (directory) => ['--new-window', `--working-directory=${directory}`],
  kgx: (directory) => [`--working-directory=${directory}`],
  'gnome-terminal': (directory) => [`--working-directory=${directory}`],
  konsole: (directory) => ['--workdir', directory],
  'xfce4-terminal': (directory) => [`--working-directory=${directory}`],
  'mate-terminal': (directory) => [`--working-directory=${directory}`],
  tilix: (directory) => [`--working-directory=${directory}`],
  terminator: (directory) => [`--working-directory=${directory}`],
  alacritty: (directory) => ['--working-directory', directory],
  kitty: (directory) => ['--directory', directory],
  foot: (directory) => [`--working-directory=${directory}`],
  wezterm: (directory) => ['start', '--cwd', directory],
  xterm: () => []
};

const PREFERRED_TERMINALS = [
  'ptyxis', 'kgx', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'mate-terminal',
  'alacritty', 'kitty', 'foot', 'wezterm', 'tilix', 'terminator', 'xterm'
];

export async function openTerminal(directory: string) {
  const candidates: string[] = [];
  const configured = process.env.TERMINAL?.trim();
  if (configured) candidates.push(configured);
  candidates.push('x-terminal-emulator', ...PREFERRED_TERMINALS);

  for (const candidate of candidates) {
    const executable = onPath(candidate);
    if (!executable) continue;
    const real = fs.existsSync(executable) ? fs.realpathSync(executable) : executable;
    const name = path.basename(real);
    const flags = TERMINAL_DIRECTORY_FLAGS[name]?.(directory) ?? [];
    await spawnDetached(real, flags, directory);
    return name;
  }
  throw new Error('No terminal emulator is installed.');
}
