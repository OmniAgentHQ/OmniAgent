import { app, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserProfilePreference } from './browserProfileRequest';
import {
  findChromium,
  browserProcessesOnProfile as macBrowserProcessesOnProfile,
  defaultBrowserIdentifier as macDefaultBrowserIdentifier
} from './platform/macos/browsers';
import {
  browserProcessesOnProfile as linuxBrowserProcessesOnProfile,
  findChromium as linuxFindChromium,
  defaultBrowserId as linuxDefaultBrowserId,
  workerProfileRoot as linuxWorkerProfileRoot
} from './platform/linux/browsers';

const execFileAsync = promisify(execFile);

const WINDOWS_URL_PROTOCOLS = ['https', 'http'];

const WINDOWS_CHROMIUM_PATHS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'Chromium\\Application\\chrome.exe',
  'Vivaldi\\Application\\vivaldi.exe',
  'Opera\\opera.exe',
  'Microsoft\\Edge\\Application\\msedge.exe'
];

export type DefaultBrowserChoice = { id: string; name: string; chromium: boolean };

const BROWSER_CATALOG: Array<{ id: string; name: string; chromium: boolean; match: RegExp }> = [
  { id: 'edge', name: 'Microsoft Edge', chromium: true, match: /msedge|edgemac|edgehtm|microsoft-edge|(^|[^a-z])edge([^a-z]|$)/ },
  { id: 'brave', name: 'Brave', chromium: true, match: /brave/ },
  { id: 'vivaldi', name: 'Vivaldi', chromium: true, match: /vivaldi/ },
  { id: 'opera', name: 'Opera', chromium: true, match: /opera/ },
  { id: 'arc', name: 'Arc', chromium: false, match: /thebrowser\.browser|(^|[^a-z])arc([^a-z]|$)/ },
  { id: 'yandex', name: 'Yandex Browser', chromium: false, match: /yandex/ },
  { id: 'chromium', name: 'Chromium', chromium: true, match: /chromium/ },
  { id: 'chrome', name: 'Google Chrome', chromium: true, match: /chromehtml|google-?chrome|(^|[^a-z])chrome([^a-z]|$)/ },
  { id: 'tor', name: 'Tor Browser', chromium: false, match: /torbrowser|tor-browser|tor browser/ },
  { id: 'zen', name: 'Zen Browser', chromium: false, match: /zen-?browser|(^|[^a-z])zen([^a-z]|$)/ },
  { id: 'librewolf', name: 'LibreWolf', chromium: false, match: /librewolf/ },
  { id: 'waterfox', name: 'Waterfox', chromium: false, match: /waterfox/ },
  { id: 'palemoon', name: 'Pale Moon', chromium: false, match: /palemoon|pale ?moon/ },
  { id: 'firefox', name: 'Mozilla Firefox', chromium: false, match: /firefox|mozilla/ },
  { id: 'safari', name: 'Safari', chromium: false, match: /safari/ },
  { id: 'orion', name: 'Orion', chromium: false, match: /kagimacos|(^|[^a-z])orion([^a-z]|$)/ },
  { id: 'explorer', name: 'Internet Explorer', chromium: false, match: /iexplore|internet ?explorer/ }
];

export function classifyBrowser(token: string): DefaultBrowserChoice | null {
  const value = token.trim().toLowerCase().replace(/\.(exe|app|desktop)$/i, '');
  if (!value) return null;
  const known = BROWSER_CATALOG.find((entry) => entry.match.test(value));
  if (known) return { id: known.id, name: known.name, chromium: known.chromium };
  return { id: 'other', name: token.replace(/\.(exe|app|desktop)$/i, ''), chromium: false };
}

export type BrowserControlMode = 'default' | 'worker-profile';

export type { BrowserProfilePreference } from './browserProfileRequest';
export { requestedBrowserProfile } from './browserProfileRequest';

export type DefaultBrowserSession = {
  workerId: string;
  browser: {
    name: string;
    family: 'system';
    executable: string;
    isDefault: true;
  };
  activeTabId?: string;
};

type CommandOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  headed?: boolean;
  downloadPath?: string;
};

type BrowserTab = {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
};

function validateUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Browser URLs must use HTTP or HTTPS.');
  }
  return url.href;
}

export class DefaultBrowserBroker {
  private sessions = new Map<string, DefaultBrowserSession>();
  private tabs = new Map<string, BrowserTab[]>();
  private nextTabId = 1;
  private mode: BrowserControlMode = 'worker-profile';
  private resolvedExecutable?: string | null;
  private resolvedExecutableAt = 0;
  private static readonly BROWSER_CACHE_MS = 30_000;
  private profilePreferences = new Map<string, BrowserProfilePreference>();
  private profileProcesses = new Map<string, Set<number>>();

  async initialize() {

  }

  setMode(mode: BrowserControlMode) {
    this.mode = mode;
  }

  setProfilePreference(workerId: string, preference: BrowserProfilePreference | null) {
    if (preference) this.profilePreferences.set(workerId, preference);
    else this.profilePreferences.delete(workerId);
  }

  hasProfilePreference(workerId: string) {
    return this.profilePreferences.has(workerId);
  }

  profilePreference(_workerId: string): BrowserProfilePreference {
    return 'isolated';
  }

  async browserExecutablePath(fresh = false) {
    return this.defaultBrowserExecutable(fresh);
  }

  async defaultBrowserChoice(): Promise<DefaultBrowserChoice | null> {
    if (process.platform === 'darwin') {
      const identifier = await macDefaultBrowserIdentifier();
      return identifier ? classifyBrowser(identifier) : { id: 'safari', name: 'Safari', chromium: false };
    }
    if (process.platform === 'linux') {
      const identifier = await linuxDefaultBrowserId();
      return identifier ? classifyBrowser(identifier) : null;
    }
    for (const protocol of WINDOWS_URL_PROTOCOLS) {
      const executable = await this.windowsUserChoiceExecutable(protocol);
      if (executable) return classifyBrowser(path.basename(executable));
    }
    return null;
  }

  private async defaultBrowserExecutable(fresh = false) {
    const cached = this.resolvedExecutable;
    if (!fresh && cached !== undefined && Date.now() - this.resolvedExecutableAt < DefaultBrowserBroker.BROWSER_CACHE_MS) {
      return cached;
    }
    const resolved = await this.resolveBrowserExecutable();
    this.resolvedExecutable = resolved;
    this.resolvedExecutableAt = Date.now();
    return resolved;
  }

  private async resolveBrowserExecutable(): Promise<string | null> {
    if (process.platform === 'darwin') return findChromium();
    if (process.platform === 'linux') return linuxFindChromium();
    for (const protocol of WINDOWS_URL_PROTOCOLS) {
      const chosen = await this.windowsUserChoiceExecutable(protocol);
      if (chosen) return chosen;
    }
    return this.windowsInstalledChromium();
  }

  private windowsInstalledChromium(): string | null {
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA
    ].filter((value): value is string => Boolean(value));

    for (const relative of WINDOWS_CHROMIUM_PATHS) {
      for (const root of roots) {
        const candidate = path.join(root, relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  private async windowsUserChoiceExecutable(protocol: string): Promise<string | null> {
    let found: string | null = null;
    try {
      const progId = await execFileAsync('reg.exe', [
        'query',
        `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${protocol}\\UserChoice`,
        '/v', 'ProgId'
      ], { windowsHide: true });
      const id = progId.stdout.trim().split(/\s+/).at(-1) ?? '';
      if (!id || id.includes('\\')) return found;

      for (const root of [`HKCU\\Software\\Classes\\${id}`, `HKCR\\${id}`]) {
        try {
          const command = await execFileAsync('reg.exe', [
            'query', `${root}\\shell\\open\\command`, '/ve'
          ], { windowsHide: true });
          const match = command.stdout.match(/([A-Za-z]:\\[^"]+?\.exe)/i);
          if (match && fs.existsSync(match[1])) {
            found = match[1];
            break;
          }
        } catch {

        }
      }
    } catch {

    }
    return found;
  }

  private profileArguments(executable: string, profileDir: string, url: string) {
    const name = path.basename(executable).toLowerCase();

    if (name === 'firefox.exe' || name === 'firefox') return ['-no-remote', '-profile', profileDir, '-new-tab', url];
    if (/chrome|msedge|edge|brave|opera|vivaldi|chromium/.test(name)) {
      return [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', url];
    }
    return null;
  }

  workerProfileDirectory(workerId: string) {
    if (process.platform === 'linux') {
      this.linuxProfileRoot ??= linuxWorkerProfileRoot(app.getPath('userData'));
      return path.join(this.linuxProfileRoot, workerId);
    }
    return path.join(app.getPath('userData'), 'Browser Profiles', workerId);
  }

  async processesForWorker(workerId: string): Promise<number[]> {
    return this.browserProcessesOnProfile(this.workerProfileDirectory(workerId));
  }

  private async openWithWorkerProfile(workerId: string, url: string) {
    const executable = await this.defaultBrowserExecutable();
    if (!executable) {
      throw new Error(
        'This worker is set to browse in its own profile, but the Windows default browser could not be identified, so its profile cannot be kept separate from yours. Set a Chromium-based browser (Edge, Chrome or Brave) as the Windows default, or switch this worker to "Your browser" in Worker Settings.'
      );
    }
    const profileDir = this.workerProfileDirectory(workerId);
    const args = this.profileArguments(executable, profileDir, url);
    if (!args) {
      throw new Error(
        `This worker is set to browse in its own profile, but ${path.basename(executable)} cannot be launched with a separate profile. Set a Chromium-based browser (Edge, Chrome or Brave) as the Windows default, or switch this worker to "Your browser" in Worker Settings.`
      );
    }
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    if (child.pid) {
      const processes = this.profileProcesses.get(workerId) ?? new Set<number>();
      processes.add(child.pid);
      this.profileProcesses.set(workerId, processes);
    }
    child.unref();
    return true;
  }

  private session(workerId: string) {
    const existing = this.sessions.get(workerId);
    if (existing) return existing;
    const session: DefaultBrowserSession = {
      workerId,
      browser: {
        name: 'Default browser',
        family: 'system',
        executable: '',
        isDefault: true
      }
    };
    this.sessions.set(workerId, session);
    this.tabs.set(workerId, []);
    return session;
  }

  private async openTab(workerId: string, rawUrl: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const url = validateUrl(rawUrl);
    const tabs = this.tabs.get(workerId) ?? [];
    const existing = tabs.find((tab) => {
      try { return new URL(tab.url).href === url; } catch { return false; }
    });
    if (existing) {
      for (const tab of tabs) tab.active = tab === existing;
      this.session(workerId).activeTabId = existing.tabId;
      return existing;
    }
    const isolated = this.profilePreference(workerId) === 'isolated';
    const openedInProfile = isolated && await this.openWithWorkerProfile(workerId, url);
    if (!openedInProfile) {
      if (isolated) {
        throw new Error(
          'This worker browses in its own profile, so OmniAgent will not open the address in your own browser. Its profile could not be started, which usually means another browser window took the address instead.'
        );
      }
      await shell.openExternal(url, { activate: true });
    }
    signal?.throwIfAborted();
    for (const tab of tabs) tab.active = false;
    const tab: BrowserTab = {
      tabId: `default-${this.nextTabId++}`,
      url,
      title: 'Default browser tab',
      active: true
    };
    tabs.push(tab);
    this.tabs.set(workerId, tabs);
    this.session(workerId).activeTabId = tab.tabId;
    return tab;
  }

  async command(workerId: string, args: string[], options: CommandOptions = {}): Promise<Record<string, unknown>> {
    const session = this.session(workerId);
    options.signal?.throwIfAborted();
    const command = args[0] ?? '';
    if (command === 'open') {
      const tab = await this.openTab(workerId, args[1] ?? '', options.signal);
      return { url: tab.url, title: tab.title, tabId: tab.tabId };
    }
    if (command === 'tab') {
      if (!args[1]) return { tabs: await this.listTabs(workerId) };
      if (args[1] === 'new') {
        const tab = await this.openTab(workerId, args[2] ?? '', options.signal);
        return { tabId: tab.tabId, url: tab.url, title: tab.title };
      }
      const tabs = this.tabs.get(workerId) ?? [];
      const requested = tabs.find((tab) => tab.tabId === args[1]);
      if (requested) {
        if (requested.active) return { tabId: requested.tabId, url: requested.url, title: requested.title };
        for (const tab of tabs) tab.active = tab === requested;
        session.activeTabId = requested.tabId;
        const switchIsolated = this.profilePreference(workerId) === 'isolated';
        const reopened = switchIsolated && await this.openWithWorkerProfile(workerId, requested.url);
        if (!reopened) {
          if (switchIsolated) {
            throw new Error('This worker browses in its own profile, so OmniAgent will not reopen that tab in your own browser.');
          }
          await shell.openExternal(requested.url, { activate: true });
        }
        return { tabId: requested.tabId, url: requested.url, title: requested.title };
      }
      return {};
    }
    const active = (this.tabs.get(workerId) ?? []).find((tab) => tab.active);
    if (command === 'get' && args[1] === 'url') return { url: active?.url ?? '' };
    if (command === 'get' && args[1] === 'title') return { title: active?.title ?? 'Default browser' };
    if (command === 'get' && args[1] === 'text') return { text: '' };
    if (command === 'snapshot') return { refs: {}, snapshot: '' };
    if (command === 'close') return {};
    throw new Error(
      'Direct page commands are unavailable in the normal browser session. Use Windows UI Automation on the visible default-browser window.'
    );
  }

  async listTabs(workerId: string, _options: CommandOptions = {}) {
    this.session(workerId);
    return [...(this.tabs.get(workerId) ?? [])];
  }

  noteVisibleNavigation(workerId: string, rawUrl: string, title = 'Default browser tab') {
    const url = validateUrl(rawUrl);
    const tabs = this.tabs.get(workerId) ?? [];
    const active = tabs.find((tab) => tab.active) ?? tabs.at(-1);
    if (active) {
      active.url = url;
      active.title = title || active.title;
      active.active = true;
      this.session(workerId).activeTabId = active.tabId;
      return;
    }
    const tab: BrowserTab = { tabId: `default-${this.nextTabId++}`, url, title, active: true };
    tabs.push(tab);
    this.tabs.set(workerId, tabs);
    this.session(workerId).activeTabId = tab.tabId;
  }

  async openSignInWindow(workerId: string, url: string) {
    const executable = await this.defaultBrowserExecutable();
    if (!executable) {
      throw new Error('The Windows default browser could not be identified, so this worker’s browser could not be opened.');
    }
    const profileDir = this.workerProfileDirectory(workerId);
    const args = this.profileArguments(executable, profileDir, validateUrl(url));
    if (!args) {
      throw new Error(`${path.basename(executable)} cannot be opened on a separate profile. Set a Chromium-based browser as the Windows default.`);
    }
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { browser: path.basename(executable), profileDirectory: profileDir };
  }

  private linuxProfileRoot?: string;

  private async browserProcessesOnProfile(profileDir: string): Promise<number[]> {
    if (process.platform === 'darwin') return macBrowserProcessesOnProfile(profileDir);
    if (process.platform === 'linux') return linuxBrowserProcessesOnProfile(profileDir);
    if (process.platform !== 'win32') return [];
    const literal = `'${profileDir.replace(/'/g, "''")}'`;
    const script = [
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe' OR Name='brave.exe' OR Name='chromium.exe' OR Name='vivaldi.exe' OR Name='opera.exe' OR Name='firefox.exe'\"",
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${literal}) }`,
      'ForEach-Object { $_.ProcessId }'
    ].join(' | ');
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10_000 }
      );
      return stdout.split(String.fromCharCode(10))
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  async cancelWorker(workerId: string) {
    const profileDir = this.workerProfileDirectory(workerId);
    this.profileProcesses.delete(workerId);
    const live = await this.browserProcessesOnProfile(profileDir);
    if (process.platform !== 'win32') {
      for (const pid of live) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {

        }
      }
    } else {
      await Promise.allSettled(live.map((pid) => execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })));
    }
    this.sessions.delete(workerId);
    this.tabs.delete(workerId);
  }

  async closeAll() {
    await Promise.allSettled([...this.profileProcesses.keys()].map((workerId) => this.cancelWorker(workerId)));
    this.profileProcesses.clear();
    this.sessions.clear();
    this.tabs.clear();
  }

  sessionInfo(workerId: string) {
    return this.sessions.get(workerId);
  }

  activeWorkerIds() {
    return [...this.sessions.keys()];
  }
}
