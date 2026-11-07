import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveProgram } from './shell';

const execFileAsync = promisify(execFile);

export async function browserProcessesOnProfile(profileDirectory: string): Promise<number[]> {
  const own = process.pid;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let entries: string[];
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return [];
  }

  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === own) continue;
    try {
      if (uid !== null && fs.statSync(`/proc/${entry}`).uid !== uid) continue;
      const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes(profileDirectory)) found.push(pid);
    } catch {
    }
  }
  return found;
}

const CHROMIUM_NAME = /chrome|chromium|brave|edge|vivaldi|opera/i;

const KNOWN_CHROMIUM = [
  'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser',
  'brave-browser', 'microsoft-edge-stable', 'microsoft-edge', 'vivaldi-stable', 'opera'
];

const URL_SCHEMES = ['x-scheme-handler/https=', 'x-scheme-handler/http='];

function directoryList(value: string | undefined, fallback: string[]) {
  const entries = (value ?? '').split(':').map((entry) => entry.trim()).filter((entry) => path.isAbsolute(entry));
  return entries.length ? entries : fallback;
}

export function mimeappsCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string[] {
  const configHome = environment.XDG_CONFIG_HOME?.trim();
  const config = configHome && path.isAbsolute(configHome) ? configHome : path.join(home, '.config');
  const dataHome = environment.XDG_DATA_HOME?.trim();
  const data = dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, '.local', 'share');
  const desktops = (environment.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const files: string[] = [];
  const add = (directory: string) => {
    for (const desktop of desktops) files.push(path.join(directory, `${desktop}-mimeapps.list`));
    files.push(path.join(directory, 'mimeapps.list'));
  };

  add(config);
  for (const directory of directoryList(environment.XDG_CONFIG_DIRS, ['/etc/xdg'])) add(directory);
  add(path.join(data, 'applications'));
  for (const directory of directoryList(environment.XDG_DATA_DIRS, ['/usr/local/share', '/usr/share'])) {
    add(path.join(directory, 'applications'));
  }
  return files;
}

function desktopIdFromMimeapps(file: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const found = new Map<string, string>();
  let inDefaults = false;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inDefaults = line === '[Default Applications]';
      continue;
    }
    if (!inDefaults) continue;
    for (const scheme of URL_SCHEMES) {
      if (!line.startsWith(scheme) || found.has(scheme)) continue;
      const first = line.slice(scheme.length).split(';')[0].trim();
      if (first) found.set(scheme, first);
    }
  }
  for (const scheme of URL_SCHEMES) {
    const value = found.get(scheme);
    if (value) return value;
  }
  return null;
}

export function defaultBrowserDesktopId(
  environment: NodeJS.ProcessEnv = process.env,
  home = os.homedir()
): string | null {
  for (const file of mimeappsCandidates(environment, home)) {
    const desktopId = desktopIdFromMimeapps(file);
    if (desktopId) return desktopId;
  }
  return null;
}

export function isSnapConfined(executable: string) {
  return executable.startsWith('/snap/');
}

export function findChromiumSync(): string | null {
  const preferred = defaultBrowserDesktopId();
  if (preferred) {
    const resolved = resolveProgram(preferred.replace(/\.desktop$/i, ''));
    if (resolved && CHROMIUM_NAME.test(path.basename(resolved.executable))) return resolved.executable;
  }
  for (const name of KNOWN_CHROMIUM) {
    const resolved = resolveProgram(name);
    if (resolved && CHROMIUM_NAME.test(path.basename(resolved.executable))) return resolved.executable;
  }
  return null;
}

async function xdgDefaultBrowser(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('xdg-settings', ['get', 'default-web-browser'], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
  }
  return null;
}

export async function defaultBrowserId(): Promise<string | null> {
  return (await xdgDefaultBrowser()) ?? defaultBrowserDesktopId();
}

export async function findChromium(): Promise<string | null> {
  const preferred = await xdgDefaultBrowser();
  if (preferred) {
    const resolved = resolveProgram(preferred.replace(/\.desktop$/i, ''));
    if (resolved && CHROMIUM_NAME.test(path.basename(resolved.executable))) return resolved.executable;
  }
  return findChromiumSync();
}

export function workerProfileRoot(userData: string, executable = findChromiumSync(), home = os.homedir()) {
  if (executable && isSnapConfined(executable)) return path.posix.join(home, 'OmniAgent', 'Browser Profiles');
  return path.posix.join(userData, 'Browser Profiles');
}
