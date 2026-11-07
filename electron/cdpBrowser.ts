import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { waitDelay } from './waitEngine';
import type { Readable, Writable } from 'node:stream';

const execFileAsync = promisify(execFile);
import {
  elementLocatorSource,
  findElementsSource,
  pageReaderSource,
  setValueSource,
  type PageSnapshot
} from './pageReader';

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const NAVIGATION_SETTLE_MS = 450;

export function verificationChallengePage(title: string, text = '') {
  return /\bjust a moment\b|\bchecking your browser\b|\bverify (?:that )?you(?:'re| are) human\b|\bprove your humanity\b|\bcomplete the challenge below\b|\bperforming security verification\b|\bcloudflare ray id\b|\bturnstile\b|\bcaptcha\b|\brobot check\b/i
    .test(`${title}\n${text.slice(0, 4_000)}`);
}

const KEY_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 }
};

export function normalizedKeyName(raw: string) {
  const value = String(raw ?? '').trim();
  const direct = Object.keys(KEY_DEFINITIONS).find((name) => name.toLowerCase() === value.toLowerCase());
  if (direct) return direct;
  const aliases: Record<string, string> = {
    return: 'Enter',
    esc: 'Escape',
    del: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    pgdn: 'PageDown',
    pgup: 'PageUp'
  };
  return aliases[value.toLowerCase()] ?? '';
}

export type ConsoleEntry = {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  text: string;
  source?: string;
  at: string;
};

export type NetworkEntry = {
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  type?: string;
  failed?: string;
  at: string;
};

const CONSOLE_LOG_LIMIT = 200;
const NETWORK_LOG_LIMIT = 300;

export class CdpBrowser {
  private child?: ChildProcess;
  private writable?: Writable;
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private sessionId = '';
  private targetId = '';
  private closed = false;
  private runBaseline: Set<string> | null = null;
  private consoleLog: ConsoleEntry[] = [];
  private networkLog: NetworkEntry[] = [];
  private readonly requestsInFlight = new Map<string, NetworkEntry>();
  private observersEnabled = false;
  private downloads = new Map<string, { name: string; startedAt: number; updatedAt: number; state: string }>();
  downloadState(name: string, since: number): 'completed' | 'cancelled' | 'pending' | 'unknown' {
    const match = [...this.downloads.values()].filter(d => d.name.toLowerCase().includes(name.toLowerCase()))
      .filter(d => d.updatedAt >= since || d.state === 'inProgress').at(-1);
    return !match ? 'unknown' : match.state === 'completed' ? 'completed' : match.state === 'canceled' ? 'cancelled' : 'pending';
  }
  private lastSnapshot: PageSnapshot | null = null;
  private lastSnapshotFingerprint = '';
  private launchInFlight?: Promise<void>;

  constructor(
    private readonly executable: string,
    private readonly profileDirectory: string,
    private readonly headless = false
  ) {}

  get isHeadless() {
    return this.headless;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && !this.closed);
  }

  get launching() {
    return Boolean(this.launchInFlight);
  }

  async launch(url: string) {
    if (this.running) {
      await this.navigate(url);
      return;
    }
    if (this.launchInFlight) {
      await this.launchInFlight;
      if (this.running) await this.navigate(url);
      return;
    }
    this.launchInFlight = this.startBrowser(url);
    try {
      await this.launchInFlight;
    } finally {
      this.launchInFlight = undefined;
    }
  }

  private async startBrowser(url: string) {
    fs.mkdirSync(this.profileDirectory, { recursive: true });
    await this.evictStrayBrowsers();
    for (const stale of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try {
        fs.rmSync(path.join(this.profileDirectory, stale), { force: true, recursive: true });
      } catch {

      }
    }
    const child = spawn(this.executable, [
      '--remote-debugging-pipe',
      `--user-data-dir=${this.profileDirectory}`,
      ...(this.headless
        ? ['--headless=new', '--window-size=1440,900', '--mute-audio']
        : ['--new-window', '--start-maximized']),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      ...(process.platform === 'win32' ? ['--disable-blink-features=AutomationControlled'] : []),
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--lang=en-US',
      url || 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: this.headless });

    this.child = child;
    this.closed = false;
    this.writable = child.stdio[3] as Writable;
    const readable = child.stdio[4] as Readable;
    readable.on('data', (chunk: Buffer) => this.consume(chunk));
    const startedAt = Date.now();
    child.once('exit', () => this.failAll(new Error(Date.now() - startedAt < 8_000
      ? 'The worker browser closed straight after starting, which happens when the browser hands the address to a window that is already open. Close the other browser windows and try again.'
      : 'The worker browser window was closed.')));
    child.once('error', (error) => this.failAll(error));

    await this.waitForBrowser();
    await this.attachToPage();
    await this.settle();
    await this.waitForContent();
    await this.assertNoVerificationChallenge();
  }

  private async evictStrayBrowsers() {
    const directory = this.profileDirectory;
    try {
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process' +
          " | Where-Object { $_.CommandLine -like '*--user-data-dir=" + directory.replace(/'/g, "''") + "*' }" +
          ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        ], { windowsHide: true, timeout: 8_000 });
      } else {
        await execFileAsync('pkill', ['-f', `--user-data-dir=${directory}`], { timeout: 8_000 });
      }
    } catch {
    }
  }

  private async waitForContent(timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    let previous = -1;
    let stable = 0;
    let meaningfulSince = 0;
    for (;;) {
      let reading = { n: 0, t: 0 };
      try {
        reading = await this.evaluate<{ n: number; t: number }>(
          '({ n: document.querySelectorAll(\'a[href],button,input,textarea,select,[role],[onclick],[contenteditable]\').length, t: (document.body && document.body.innerText || \'\').length })',
          5_000
        );
      } catch {
        reading = { n: 0, t: 0 };
      }
      const meaningful = reading.n >= 8 || reading.t >= 200;
      if (meaningful && !meaningfulSince) meaningfulSince = Date.now();
      if (meaningful && reading.n === previous) {
        stable += 1;
        if (stable >= 1) return reading.n;
      } else {
        stable = 0;
      }
      if (meaningfulSince && Date.now() - meaningfulSince >= 1_200) return reading.n;
      previous = reading.n;
      if (Date.now() > deadline) return reading.n;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index = this.buffer.indexOf(0);
    while (index !== -1) {
      const raw = this.buffer.subarray(0, index).toString('utf8');
      this.buffer = this.buffer.subarray(index + 1);
      this.dispatch(raw);
      index = this.buffer.indexOf(0);
    }
  }

  private dispatch(raw: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = Number(message.id ?? 0);
    if (!id) {
      this.record(String(message.method ?? ''), (message.params ?? {}) as Record<string, unknown>);
      return;
    }
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    const error = message.error as { message?: string } | undefined;
    if (error) call.reject(new Error(String(error.message ?? 'The browser rejected that command.')));
    else call.resolve((message.result ?? {}) as Record<string, unknown>);
  }

  private record(method: string, params: Record<string, unknown>) {
    if (method === 'Browser.downloadWillBegin') {
      this.downloads.set(String(params.guid), { name: String(params.suggestedFilename), startedAt: Date.now(), updatedAt: Date.now(), state: 'inProgress' });
      if (this.downloads.size > 100) this.downloads.delete(this.downloads.keys().next().value!);
    }
    if (method === 'Browser.downloadProgress') {
      const download = this.downloads.get(String(params.guid));
      if (download) { download.state = String(params.state); download.updatedAt = Date.now(); }
    }
    const at = new Date().toISOString();
    const push = <T>(log: T[], entry: T, limit: number) => {
      log.push(entry);
      if (log.length > limit) log.splice(0, log.length - limit);
    };

    if (method === 'Runtime.consoleAPICalled') {
      const type = String(params.type ?? 'log');
      const args = Array.isArray(params.args) ? params.args as Array<Record<string, unknown>> : [];
      const text = args
        .map((arg) => arg.value !== undefined ? String(arg.value) : String(arg.description ?? arg.type ?? ''))
        .join(' ')
        .trim();
      if (text) {
        push(this.consoleLog, {
          level: type === 'warning' || type === 'warn' ? 'warning'
            : type === 'error' ? 'error'
              : type === 'debug' ? 'debug'
                : type === 'info' ? 'info' : 'log',
          text: text.slice(0, 2_000),
          at
        }, CONSOLE_LOG_LIMIT);
      }
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const details = (params.exceptionDetails ?? {}) as Record<string, unknown>;
      const thrown = (details.exception ?? {}) as Record<string, unknown>;
      const text = String(thrown.description ?? details.text ?? 'Uncaught error').slice(0, 2_000);
      push(this.consoleLog, { level: 'error', text, source: 'exception', at }, CONSOLE_LOG_LIMIT);
      return;
    }

    if (method === 'Log.entryAdded') {
      const entry = (params.entry ?? {}) as Record<string, unknown>;
      const text = String(entry.text ?? '').slice(0, 2_000);
      if (!text) return;
      const level = String(entry.level ?? 'info');
      push(this.consoleLog, {
        level: level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info',
        text,
        source: String(entry.source ?? '') || undefined,
        at
      }, CONSOLE_LOG_LIMIT);
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const request = (params.request ?? {}) as Record<string, unknown>;
      const entry: NetworkEntry = {
        method: String(request.method ?? 'GET'),
        url: String(request.url ?? '').slice(0, 2_000),
        type: params.type ? String(params.type) : undefined,
        at
      };
      this.requestsInFlight.set(String(params.requestId ?? ''), entry);
      push(this.networkLog, entry, NETWORK_LOG_LIMIT);
      return;
    }

    if (method === 'Network.responseReceived') {
      const response = (params.response ?? {}) as Record<string, unknown>;
      const entry = this.requestsInFlight.get(String(params.requestId ?? ''));
      if (!entry) return;
      entry.status = Number(response.status ?? 0) || undefined;
      entry.statusText = String(response.statusText ?? '') || undefined;
      if (params.type) entry.type = String(params.type);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const entry = this.requestsInFlight.get(String(params.requestId ?? ''));
      if (!entry) return;
      entry.failed = String(params.errorText ?? 'failed');
    }
  }

  private async enableObservers() {
    await this.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }, false).catch(() => undefined);
    await this.send('Runtime.enable').catch(() => undefined);
    await this.send('Log.enable').catch(() => undefined);
    await this.send('Network.enable').catch(() => undefined);
    this.observersEnabled = true;
  }

  private failAll(error: Error) {
    this.closed = true;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  private send(method: string, params: Record<string, unknown> = {}, useSession = true, timeoutMs = 30_000) {
    if (!this.writable || this.closed) {
      return Promise.reject(new Error('The worker browser is not running. Open a page first.'));
    }
    this.nextId += 1;
    const id = this.nextId;
    const payload: Record<string, unknown> = { id, method, params };
    if (useSession && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writable!.write(`${JSON.stringify(payload)}\0`);
    });
  }

  private async waitForBrowser() {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        await this.send('Browser.getVersion', {}, false, 2_000);
        return;
      } catch (error) {
        if (this.closed) throw error;
        if (Date.now() > deadline) throw new Error('The worker browser did not start in time.');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async attachToPage() {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { targetInfos } = await this.send('Target.getTargets', {}, false) as {
        targetInfos: Array<{ targetId: string; type: string; url: string }>;
      };
      const page = targetInfos.find((target) => target.type === 'page');
      if (page) {
        const attached = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false) as
          { sessionId: string };
        this.sessionId = attached.sessionId;
        this.targetId = page.targetId;
        await this.send('Page.enable');
        await this.hideAutomationSignal();
        await this.enableObservers();
            return;
      }
      if (Date.now() > deadline) throw new Error('The worker browser did not open a page.');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async refreshActivePage() {
    const { targetInfos } = await this.send('Target.getTargets', {}, false) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; attached?: boolean }>;
    };
    const pages = targetInfos.filter((target) => target.type === 'page');
    if (!pages.length) throw new Error('The worker browser has no page open.');
    const current = pages.find((page) => page.targetId === this.targetId);
    const chosen = current ?? pages[pages.length - 1];
    if (chosen.targetId === this.targetId && this.sessionId) return;
    const attached = await this.send('Target.attachToTarget', { targetId: chosen.targetId, flatten: true }, false) as
      { sessionId: string };
    this.sessionId = attached.sessionId;
    this.targetId = chosen.targetId;
    await this.send('Page.enable');
    await this.hideAutomationSignal();
    await this.enableObservers();
  }

  private async hideAutomationSignal() {
    if (process.platform === 'win32') return;
    const source = "Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });";
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => undefined);
    await this.send('Runtime.evaluate', { expression: source, returnByValue: true }).catch(() => undefined);
  }

  private async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, true, timeoutMs) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      throw new Error(String(result.exceptionDetails.text ?? 'That page script failed.'));
    }
    return result.result?.value as T;
  }

  async navigate(url: string) {
    this.invalidateSnapshot();
    await this.refreshActivePage();
    await this.send('Page.navigate', { url });
    await this.settle();
    await this.waitForContent();
    await this.assertNoVerificationChallenge();
    return this.pageIdentity();
  }

  async assertNoVerificationChallenge() {
    const readState = () => this.evaluate<{ title: string; text: string }>(
      '({ title: document.title, text: (document.body && document.body.innerText || "").slice(0, 4000) })'
    ).catch(() => ({ title: '', text: '' }));
    let state = await readState();
    if (!verificationChallengePage(state.title, state.text)) return;

    await this.bringToFront().catch(() => undefined);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await readState();
      if (!verificationChallengePage(state.title, state.text)) return;
    }
    throw new Error(
      'This site is showing a human verification check that did not clear on its own. This worker’s browser window was brought to the front so the check could be cleared by hand — run the skill again and complete it in that window while it is open. The worker keeps that profile, so it only has to be done once. If the check keeps coming back, switch Browser Control to "Your browser" in Worker Settings and retry with your own signed-in browser.'
    );
  }

  private sameSite(left: string, right: string) {
    try {
      const host = (value: string) => new URL(value).hostname.replace(/^www\./i, '').split('.').slice(-2).join('.');
      return host(left) === host(right);
    } catch {
      return false;
    }
  }

  async openOrReuse(url: string) {
    if (!this.running) {
      await this.launch(url);
      return this.pageIdentity();
    }
    const requested = new URL(url).href;
    const tabs = await this.listTabs();
    const exact = tabs.find((tab) => {
      try { return new URL(tab.url).href === requested; } catch { return false; }
    });
    if (exact) {
      if (!exact.active) await this.switchTab(exact.tabId);
      await this.dismissCommonObstructions();
      await this.assertNoVerificationChallenge();
      return this.pageIdentity();
    }
    const current = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
    if (!current.url || current.url === 'about:blank' || this.sameSite(current.url, requested)) {
      return this.navigate(url);
    }
    const sameSiteTab = tabs.find((tab) => this.sameSite(tab.url, requested));
    if (sameSiteTab) {
      await this.switchTab(sameSiteTab.tabId);
      return this.navigate(url);
    }
    const created = await this.send('Target.createTarget', { url }, false) as { targetId?: string };
    if (!created.targetId) return this.navigate(url);
    await this.switchTab(created.targetId);
    await this.settle();
    await this.waitForContent();
    await this.assertNoVerificationChallenge();
    return this.pageIdentity();
  }

  async openNewTab(url: string) {
    if (!this.running) {
      await this.launch(url);
      return this.pageIdentity();
    }
    const created = await this.send('Target.createTarget', { url }, false) as { targetId?: string };
    if (!created.targetId) throw new Error('The browser could not open another tab.');
    await this.switchTab(created.targetId);
    await this.settle();
    await this.waitForContent();
    await this.assertNoVerificationChallenge();
    return this.pageIdentity();
  }

  async markRunBaseline() {
    if (!this.running) {
      this.runBaseline = new Set();
      return;
    }
    const tabs = await this.listTabs().catch(() => []);
    this.runBaseline = new Set(tabs.map((tab) => tab.tabId));
  }

  async releaseRunTabs() {
    if (!this.running) {
      this.runBaseline = null;
      return { closed: 0, remaining: 0 };
    }
    const baseline = this.runBaseline;
    this.runBaseline = null;
    let tabs = await this.listTabs().catch(() => []);
    if (!tabs.length) return { closed: 0, remaining: 0 };

    let doomed = baseline ? tabs.filter((tab) => !baseline.has(tab.tabId)) : tabs.slice();
    let survivor = baseline ? tabs.find((tab) => baseline.has(tab.tabId)) : undefined;

    if (!survivor) {
      const keep = doomed.pop();
      if (keep) {
        survivor = keep;
        await this.switchTab(keep.tabId).catch(() => undefined);
        await this.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined);
      }
    }

    for (const tab of doomed) {
      await this.send('Target.closeTarget', { targetId: tab.tabId }, false).catch(() => undefined);
    }
    if (doomed.length) await new Promise((resolve) => setTimeout(resolve, 300));
    if (survivor) await this.switchTab(survivor.tabId).catch(() => undefined);
    tabs = await this.listTabs().catch(() => []);
    return { closed: doomed.length, remaining: tabs.length };
  }

  async closeExtraTabs() {
    const tabs = await this.listTabs();
    const doomed = tabs.filter((tab) => tab.tabId !== this.targetId);
    for (const tab of doomed) {
      await this.send('Target.closeTarget', { targetId: tab.tabId }, false).catch(() => undefined);
    }
    if (doomed.length) await new Promise((resolve) => setTimeout(resolve, 400));
    const remaining = await this.listTabs();
    return { kept: this.targetId, closed: doomed.length, remaining: remaining.length };
  }

  async back() {
    await this.evaluate('history.back()');
    await this.settle();
    return this.pageIdentity();
  }

  async reload() {
    await this.send('Page.reload', {});
    await this.settle();
    return this.pageIdentity();
  }

  private async settle() {
    await new Promise((resolve) => setTimeout(resolve, NAVIGATION_SETTLE_MS));
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const state = await this.evaluate<string>('document.readyState', 5_000);
        if (state === 'complete' || state === 'interactive') return;
      } catch {

      }
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async pageIdentity() {
    await this.refreshActivePage();
    return this.evaluate<{ url: string; title: string }>('({ url: location.href, title: document.title })');
  }

  async snapshot(): Promise<PageSnapshot> {
    await this.refreshActivePage();
    await this.dismissCommonObstructions();
    const deadline = Date.now() + 9_000;
    let best = await this.evaluate<PageSnapshot>(pageReaderSource());
    let previous = best?.elements?.length ?? 0;
    while (Date.now() < deadline) {
      const count = best?.elements?.length ?? 0;
      if (count >= 5 && count === previous && (best?.text?.length ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      const next = await this.evaluate<PageSnapshot>(pageReaderSource());
      previous = count;
      if ((next?.elements?.length ?? 0) >= count) best = next;
    }
    return best;
  }

  private async pageFingerprint() {
    return this.evaluate<string>(
      '(() => { const b = document.body; return [location.href, document.title, b ? b.innerText.length : 0, document.querySelectorAll("a[href],button,input,textarea,select,[role]").length].join("|"); })()',
      5_000
    ).catch(() => '');
  }

  async snapshotIfChanged(): Promise<PageSnapshot | { unchanged: true; url: string; title: string }> {
    await this.refreshActivePage();
    const fingerprint = await this.pageFingerprint();
    if (fingerprint && fingerprint === this.lastSnapshotFingerprint && this.lastSnapshot) {
      return { unchanged: true, url: this.lastSnapshot.url, title: this.lastSnapshot.title };
    }
    const snapshot = await this.snapshot();
    this.lastSnapshot = snapshot;
    this.lastSnapshotFingerprint = await this.pageFingerprint();
    return snapshot;
  }

  private invalidateSnapshot() {
    this.lastSnapshotFingerprint = '';
  }

  async waitForIdle(quietMillis = 700, timeoutMs = 0, signal?: AbortSignal) {
    await this.refreshActivePage();
    const started = Date.now();
    const deadline = timeoutMs > 0 ? started + timeoutMs : Infinity;
    const quiet = Math.max(200, Math.min(5_000, quietMillis));
    let lastActivity = Date.now();
    let seen = this.networkLog.length;
    for (;;) {
      await waitDelay(150, signal);
      if (!this.running) throw new Error('The browser closed while waiting.');
      if (this.networkLog.length !== seen) {
        seen = this.networkLog.length;
        lastActivity = Date.now();
      }
      const ready = await this.evaluate<string>('document.readyState', 4_000).catch(() => '');
      if ((ready === 'complete' || ready === 'interactive') && Date.now() - lastActivity >= quiet) {
        return { idle: true, waitedMs: Date.now() - started };
      }
      if (Date.now() > deadline) return { idle: false, waitedMs: timeoutMs };
    }
  }

  async clickAndWait(ref: string, waitFor?: { text?: string; urlChanges?: boolean; idle?: boolean }, signal?: AbortSignal) {
    const before = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
    const clicked = await this.click(ref);
    this.invalidateSnapshot();
    if (!waitFor) return clicked;
    if (waitFor.urlChanges) {
      while (true) {
        signal?.throwIfAborted();
        if (!this.running) throw new Error('The browser closed while waiting.');
        const now = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
        if (now.url && now.url !== before.url) break;
        await waitDelay(200, signal);
      }
    }
    if (waitFor.text) await this.waitForText(waitFor.text, 0, signal);
    if (waitFor.idle !== false) await this.waitForIdle(700, 0, signal);
    const after = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
    return { ...clicked, url: after.url, title: after.title };
  }

  async fillForm(fields: Array<{ ref: string; value: string }>) {
    const filled: Array<{ ref: string; value: string }> = [];
    for (const field of fields) {
      await this.fill(field.ref, field.value);
      filled.push({ ref: field.ref, value: /pass|secret|token/i.test(field.ref) ? '(hidden)' : field.value });
    }
    this.invalidateSnapshot();
    return { filled: filled.length, fields: filled };
  }

  async extract(rowSelector: string, fields: Record<string, string>) {
    await this.refreshActivePage();
    const source = `(() => {
      const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
      const fields = ${JSON.stringify(fields)};
      return rows.slice(0, 200).map((row) => {
        const out = {};
        for (const key of Object.keys(fields)) {
          const spec = String(fields[key]);
          const attribute = spec.includes('@') ? spec.split('@').pop() : '';
          const selector = spec.includes('@') ? spec.split('@')[0] : spec;
          const node = selector ? row.querySelector(selector) : row;
          if (!node) { out[key] = null; continue; }
          out[key] = attribute
            ? (node.getAttribute(attribute) || (attribute === 'href' || attribute === 'src' ? node[attribute] : '') || null)
            : (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() || null;
        }
        return out;
      });
    })()`;
    const rows = await this.evaluate<Array<Record<string, unknown>>>(source);
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(`No rows matched "${rowSelector}". Read the page and check the selector, or use browser_evaluate for something more specific.`);
    }
    return { rows: rows.length, items: rows };
  }

  async dismissCommonObstructions() {
    const dismissed = await this.evaluate<{ dismissed: boolean; label?: string }>(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 2 && rect.height > 2;
      };
      const safe = /^(?:close|dismiss|got it|no thanks|not now|maybe later|skip|reject additional cookies|reject all(?: cookies)?|x)$/i;
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].filter(visible);
      for (const dialog of dialogs) {
        const controls = [...dialog.querySelectorAll('button,[role="button"],[aria-label]')].filter(visible);
        const button = controls.find((element) => safe.test(String(element.getAttribute('aria-label') || element.textContent || '').trim()));
        if (button) {
          button.click();
          return { dismissed: true, label: String(button.getAttribute('aria-label') || button.textContent || '').trim() };
        }
      }
      return { dismissed: false };
    })()`).catch(() => ({ dismissed: false }));
    if (dismissed.dismissed) await new Promise((resolve) => setTimeout(resolve, 180));
    return dismissed;
  }

  async find(query: string) {
    await this.refreshActivePage();
    return this.evaluate<Array<{ ref: string; name: string; tag: string }>>(findElementsSource(query));
  }

  private async locate(ref: string) {
    const located = await this.evaluate<{
      x: number; y: number; width: number; height: number;
      tag: string; type: string; editable: boolean; select: boolean; name: string; gone?: boolean;
    } | null>(elementLocatorSource(ref));
    if (!located || located.gone) {
      throw new Error(`Element ${ref} is no longer on the page. Read the page again to get fresh element ids.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    return located;
  }

  async click(ref: string) {
    const target = await this.locate(ref);
    const beforeUrl = target.tag.toLowerCase() === 'a'
      ? (await this.pageIdentity().catch(() => ({ url: '', title: '' }))).url
      : '';
    const point = { x: target.x, y: target.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await this.settle();
    if (beforeUrl) {
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        const current = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
        if (current.url && current.url !== beforeUrl) {
          await this.waitForContent();
          await this.assertNoVerificationChallenge();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return { clicked: target.name || ref };
  }

  async fill(ref: string, value: string) {
    const target = await this.locate(ref);
    if (target.select) {
      const result = await this.evaluate<{ ok: boolean; reason?: string; options?: string[] }>(setValueSource(ref, value));
      if (!result?.ok) {
        throw new Error(result?.reason === 'no-option'
          ? `That dropdown has no option matching "${value}". Options: ${(result.options ?? []).join(', ')}`
          : `Could not set ${ref}.`);
      }
      return { filled: target.name || ref, value };
    }
    if (!target.editable) {
      throw new Error(`Element ${ref} (${target.tag}) is not a text field. Use browser_click for buttons and links.`);
    }
    const point = { x: target.x, y: target.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    const result = await this.evaluate<{ ok: boolean }>(setValueSource(ref, value));
    if (!result?.ok) throw new Error(`Could not type into ${ref}.`);
    return { filled: target.name || ref, value };
  }

  async type(text: string) {
    for (const character of String(text)) {
      await this.send('Input.dispatchKeyEvent', { type: 'char', text: character });
    }
    return { typed: String(text).length };
  }

  async press(key: string, ref?: string) {
    if (ref) await this.locate(ref).then((target) => this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1
    }).then(() => this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1
    })));
    const name = normalizedKeyName(key);
    if (!name) throw new Error(`Unsupported key "${key}". Use one of: ${Object.keys(KEY_DEFINITIONS).join(', ')}.`);
    const definition = KEY_DEFINITIONS[name];
    await this.send('Input.dispatchKeyEvent', {
      type: definition.text ? 'keyDown' : 'rawKeyDown',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
      ...(definition.text ? { text: definition.text } : {})
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode
    });
    await this.settle();
    return { pressed: name };
  }

  async evaluateForWorker(expression: string, resultId?: string, offset = 0, destination?: string) {
    await this.refreshActivePage();
    const source = String(expression ?? '').trim();
    if (!source && !resultId) throw new Error('Give an expression to evaluate on the page.');
    const outcome = await this.evaluate<unknown>(`(async () => {
      const key = Symbol.for('omniagent.browser.result-pages');
      const store = globalThis[key] || (globalThis[key] = new Map());
      const now = Date.now();
      for (const [id, item] of store) if (now - item.at > 10 * 60 * 1000) store.delete(id);
      const requested = ${JSON.stringify(resultId ?? '')};
      const whole = ${destination ? 'true' : 'false'};
      let id = requested, item;
      if (requested) {
        item = store.get(requested);
        if (!item) throw new Error('This temporary result expired or the page changed. Evaluate the expression again.');
        if (whole) return { text: item.json ? JSON.stringify(JSON.parse(item.text), null, 2) : item.text, items: item.items };
      } else {
        const value = await (${source || 'null'});
        const result = typeof value === 'undefined' ? null : value;
        const items = Array.isArray(result) ? result.length : null;
        if (whole) return { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'null', items };
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        if (!text || text.length <= 40000) return { result };
        id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(now) + '-' + Math.random().toString(36).slice(2);
        item = { text, json: typeof result !== 'string', items, at: now, timer: null }; store.set(id, item);
      }
      item.at = now;
      if (item.timer) clearTimeout(item.timer);
      item.timer = setTimeout(() => store.delete(id), 10 * 60 * 1000);
      const start = Math.max(0, ${Math.floor(Number(offset) || 0)});
      const end = Math.min(item.text.length, start + 40000);
      return { result: item.text.slice(start, end), resultId: id, offset: start,
        nextOffset: end < item.text.length ? end : null, totalCharacters: item.text.length,
        note: 'Complete result is temporarily kept in this browser page. Read further chunks with browser_evaluate using resultId and offset, or call browser_evaluate with this resultId and saveTo to write the complete result to a file in one step. No file was created.' };
    })()`);
    if (!destination) return outcome;
    const saved = outcome as { text: string; items: number | null };
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, saved.text, 'utf8');
    return { written: destination, bytes: Buffer.byteLength(saved.text, 'utf8'),
      ...(saved.items === null ? {} : { items: saved.items }) };
  }

  consoleMessages(options: { level?: 'all' | 'error'; limit?: number } = {}) {
    const wanted = options.level === 'error'
      ? this.consoleLog.filter((entry) => entry.level === 'error' || entry.level === 'warning')
      : this.consoleLog;
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return { messages: wanted.slice(-limit), total: wanted.length };
  }

  networkRequests(options: { failedOnly?: boolean; urlPattern?: string; limit?: number } = {}) {
    let wanted = this.networkLog;
    if (options.failedOnly) {
      wanted = wanted.filter((entry) => entry.failed || (entry.status !== undefined && entry.status >= 400));
    }
    if (options.urlPattern) {
      const needle = options.urlPattern.toLowerCase();
      wanted = wanted.filter((entry) => entry.url.toLowerCase().includes(needle));
    }
    const limit = Math.max(1, Math.min(200, options.limit ?? 50));
    return { requests: wanted.slice(-limit), total: wanted.length };
  }

  async hover(ref: string) {
    const target = await this.locate(ref);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: target.x, y: target.y, button: 'none', clickCount: 0
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { hovered: target.name || ref };
  }

  async clickWith(ref: string, options: { button?: 'left' | 'right'; clickCount?: number } = {}) {
    const button = options.button === 'right' ? 'right' : 'left';
    const clickCount = Math.max(1, Math.min(3, options.clickCount ?? 1));
    const target = await this.locate(ref);
    const point = { x: target.x, y: target.y };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount });
    await this.settle();
    return { clicked: target.name || ref, button, clickCount };
  }

  async drag(fromRef: string, toRef: string) {
    const from = await this.locate(fromRef);
    const to = await this.locate(toRef);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step += 1) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * step) / 8,
        y: from.y + ((to.y - from.y) * step) / 8,
        button: 'left',
        clickCount: 0
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await this.settle();
    return { dragged: from.name || fromRef, onto: to.name || toRef };
  }

  async savePdf(destination: string) {
    await this.refreshActivePage();
    const printed = await this.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: false,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4
    }, true, 60_000) as { data?: string };
    const bytes = Buffer.from(String(printed.data ?? ''), 'base64');
    if (!bytes.length) throw new Error('The browser returned an empty PDF for this page.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    const identity = await this.pageIdentity().catch(() => ({ url: '', title: '' }));
    return { saved: destination, bytes: bytes.length, from: identity.url };
  }

  async uploadFile(ref: string, filePath: string) {
    if (!fs.existsSync(filePath)) throw new Error(`There is no file at ${filePath}.`);
    const target = await this.locate(ref);
    if (target.tag.toLowerCase() !== 'input' || target.type.toLowerCase() !== 'file') {
      throw new Error(`Element ${ref} is a ${target.tag}${target.type ? `/${target.type}` : ''}, not a file upload field. Read the page again and pick the upload control.`);
    }
    const handle = await this.send('Runtime.evaluate', {
      expression: `window.__omniagentRefs && window.__omniagentRefs.get(${JSON.stringify(ref)})`,
      returnByValue: false
    }) as { result?: { objectId?: string } };
    const objectId = handle.result?.objectId;
    if (!objectId) {
      throw new Error(`Could not take hold of ${ref} to attach a file. Read the page again and retry.`);
    }
    await this.send('DOM.enable').catch(() => undefined);
    await this.send('DOM.setFileInputFiles', { files: [filePath], objectId });
    await this.settle();
    return { attached: path.basename(filePath), to: target.name || ref };
  }

  async resizeViewport(width: number, height: number, mobile = false) {
    const w = Math.max(320, Math.min(3840, Math.round(width) || 1280));
    const h = Math.max(320, Math.min(2160, Math.round(height) || 800));
    await this.refreshActivePage();
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 0, mobile: Boolean(mobile)
    });
    await this.send('Emulation.setTouchEmulationEnabled', {
      enabled: Boolean(mobile), maxTouchPoints: mobile ? 5 : 0
    }).catch(() => undefined);
    return { width: w, height: h, mobile: Boolean(mobile) };
  }

  async scroll(delta: number) {
    const amount = Math.max(-4000, Math.min(4000, Math.round(delta) || 600));
    await this.evaluate(`window.scrollBy({ top: ${amount}, behavior: 'instant' })`);
    return { scrolled: amount };
  }

  async waitForText(needle: string, timeoutMs = 0, signal?: AbortSignal) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    const wanted = String(needle).toLowerCase();
    for (;;) {
      signal?.throwIfAborted();
      if (!this.running) throw new Error('The browser closed while waiting.');
      const text = await this.evaluate<string>('(document.body && document.body.innerText || "")');
      if (String(text ?? '').toLowerCase().includes(wanted)) return { found: needle };
      if (Date.now() > deadline) throw new Error(`"${needle}" did not appear on the page within ${Math.round(timeoutMs / 1000)}s.`);
      await waitDelay(250, signal);
    }
  }

  async screenshot() {
    await this.refreshActivePage();
    const shot = await this.send('Page.captureScreenshot', { format: 'png' }) as { data?: string };
    return Buffer.from(String(shot.data ?? ''), 'base64');
  }

  async readableText(maxCharacters = 40_000) {
    await this.refreshActivePage();
    const text = await this.evaluate<string>(`(() => {
      const source = document.querySelector('article, main, [role="main"]') || document.body;
      if (!source) return '';
      const clone = source.cloneNode(true);
      for (const node of clone.querySelectorAll('script, style, noscript, svg, nav, footer, aside')) node.remove();
      return (clone.innerText || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    })()`);
    const full = String(text ?? '');
    const identity = await this.evaluate<{ url: string; title: string }>('({ url: location.href, title: document.title })');
    return {
      url: identity?.url ?? '',
      title: identity?.title ?? '',
      characters: full.length,
      truncated: full.length > maxCharacters,
      text: full.slice(0, maxCharacters)
    };
  }

  async listTabs() {
    const { targetInfos } = await this.send('Target.getTargets', {}, false) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    return targetInfos
      .filter((target) => target.type === 'page')
      .map((target) => ({ tabId: target.targetId, url: target.url, title: target.title, active: target.targetId === this.targetId }));
  }

  async listExtensionViews() {
    const { targetInfos } = await this.send('Target.getTargets', {}, false) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    return targetInfos
      .filter((target) => /^chrome-extension:\/\//i.test(target.url) && target.type !== 'service_worker')
      .map((target) => ({
        viewId: target.targetId,
        url: target.url,
        title: target.title,
        extensionId: target.url.replace(/^chrome-extension:\/\//i, '').split('/')[0],
        kind: /popup/i.test(target.url) ? 'popup' : /options/i.test(target.url) ? 'options' : 'page'
      }));
  }

  async focusExtensionView(viewId: string) {
    const views = await this.listExtensionViews();
    const view = views.find((item) => item.viewId === viewId)
      ?? (views.length === 1 ? views[0] : undefined);
    if (!view) {
      throw new Error(views.length
        ? `No extension view has the id ${viewId}. Call browser_extensions for the current list.`
        : 'No extension window is open. Open the extension from its toolbar button first, or trigger the action that makes it appear.');
    }
    const attached = await this.send('Target.attachToTarget', { targetId: view.viewId, flatten: true }, false) as
      { sessionId: string };
    this.sessionId = attached.sessionId;
    this.targetId = view.viewId;
    this.invalidateSnapshot();
    await this.send('Page.enable').catch(() => undefined);
    await this.enableObservers();
    return { focused: view.title || view.extensionId, url: view.url, kind: view.kind };
  }

  async listInstalledExtensions() {
    const directory = path.join(this.profileDirectory, 'Default', 'Extensions');
    if (!fs.existsSync(directory)) return { extensions: [] as Array<{ id: string; name: string; version: string }> };
    const extensions: Array<{ id: string; name: string; version: string }> = [];
    for (const id of fs.readdirSync(directory)) {
      const versions = fs.readdirSync(path.join(directory, id)).filter((entry) => !entry.startsWith('.'));
      const version = versions[versions.length - 1];
      if (!version) continue;
      let name = id;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, id, version, 'manifest.json'), 'utf8')) as { name?: string };
        if (manifest.name) name = String(manifest.name);
      } catch {

      }
      extensions.push({ id, name, version });
    }
    return { extensions };
  }

  async switchTab(tabId: string) {
    const attached = await this.send('Target.attachToTarget', { targetId: tabId, flatten: true }, false) as { sessionId: string };
    this.sessionId = attached.sessionId;
    this.targetId = tabId;
    await this.send('Page.enable');
    await this.enableObservers();
    await this.send('Target.activateTarget', { targetId: tabId }, false);
    return this.pageIdentity();
  }

  async closeTab(tabId: string) {
    const before = await this.listTabs();
    const target = before.find((tab) => tab.tabId === tabId);
    if (!target) throw new Error(`No open tab has the id ${tabId}. Call browser_tabs for the current list.`);
    if (before.length <= 1) {
      await this.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined);
      this.invalidateSnapshot();
      return {
        closed: target.url,
        remaining: [],
        note: 'That was the only tab, so its page was cleared rather than closing the window. OmniAgent closes the browser itself when it is no longer needed, so nothing else is required here.'
      };
    }
    await this.send('Target.closeTarget', { targetId: tabId }, false);
    const remaining = (await this.listTabs()).filter((tab) => tab.tabId !== tabId);
    if (target.active && remaining.length) await this.switchTab(remaining[remaining.length - 1].tabId);
    return { closed: target.url, remaining };
  }

  async bringToFront() {
    await this.refreshActivePage();
    await this.send('Page.bringToFront');
    return this.pageIdentity();
  }

  async close() {
    const child = this.child;
    if (child && child.exitCode === null && !this.closed) {
      const exited = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 6_000);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      try {
        await this.send('Browser.close', {}, false, 5_000);
      } catch {

      }
      await exited;
    }
    this.closed = true;
    this.failAll(new Error('The worker browser was closed.'));
    if (child && child.exitCode === null) {
      try {
        child.kill();
      } catch {

      }
    }
    this.child = undefined;
    this.writable = undefined;
    this.sessionId = '';
    this.targetId = '';
  }
}
