import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const APPLICATION_DIRECTORIES = ['/Applications', path.join(os.homedir(), 'Applications')];

const KNOWN_CHROMIUM_APPS = [
  'Google Chrome.app',
  'Brave Browser.app',
  'Microsoft Edge.app',
  'Chromium.app',
  'Vivaldi.app',
  'Opera.app'
];

const CHROMIUM_NAME = /chrome|chromium|brave|edge|vivaldi|opera/i;

async function executableInside(applicationPath: string) {
  try {
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleExecutable', path.join(applicationPath, 'Contents', 'Info.plist')
    ]);
    const executable = path.join(applicationPath, 'Contents', 'MacOS', stdout.trim());
    return fs.existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

async function bundleIdentifier(applicationPath: string) {
  try {
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
      '-c', 'Print :CFBundleIdentifier', path.join(applicationPath, 'Contents', 'Info.plist')
    ]);
    return stdout.trim().toLowerCase();
  } catch {
    return null;
  }
}

export async function defaultBrowserIdentifier() {
  const plist = path.join(
    os.homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist'
  );
  try {
    const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', plist]);
    const parsed = JSON.parse(stdout) as { LSHandlers?: Array<Record<string, unknown>> };
    const byScheme = new Map<string, string>();
    for (const handler of parsed.LSHandlers ?? []) {
      const scheme = handler.LSHandlerURLScheme;
      if (scheme !== 'https' && scheme !== 'http') continue;
      const identifier = handler.LSHandlerRoleAll;
      if (typeof identifier === 'string' && identifier && !byScheme.has(scheme)) {
        byScheme.set(scheme, identifier.toLowerCase());
      }
    }
    for (const scheme of ['https', 'http']) {
      const identifier = byScheme.get(scheme);
      if (identifier) return identifier;
    }
  } catch {

  }
  return null;
}

async function installedApplications() {
  const found: string[] = [];
  for (const directory of APPLICATION_DIRECTORIES) {
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.app')) found.push(path.join(directory, entry));
    }
  }
  return found;
}

export async function findChromium(): Promise<string | null> {
  const preferred = await defaultBrowserIdentifier();
  const applications = await installedApplications();

  if (preferred) {
    for (const application of applications) {
      if (await bundleIdentifier(application) !== preferred) continue;
      if (!CHROMIUM_NAME.test(path.basename(application))) break;
      const executable = await executableInside(application);
      if (executable) return executable;
      break;
    }
  }

  for (const name of KNOWN_CHROMIUM_APPS) {
    const application = applications.find((candidate) => path.basename(candidate) === name);
    if (!application) continue;
    const executable = await executableInside(application);
    if (executable) return executable;
  }
  return null;
}

export async function isDefaultBrowser(executable: string) {
  const preferred = await defaultBrowserIdentifier();
  if (!preferred) return false;
  const application = executable.split('/Contents/MacOS/')[0];
  return (await bundleIdentifier(application)) === preferred;
}

export async function browserProcessesOnProfile(profileDirectory: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-f', profileDirectory]);
    const own = process.pid;
    return stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== own);
  } catch {
    return [];
  }
}
