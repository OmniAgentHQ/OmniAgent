import { readRange, hashFile, readResponse, saveResponse } from './streamingIo';
import crypto from 'node:crypto';
import { CdpBrowser } from './cdpBrowser';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DefaultBrowserBroker } from './defaultBrowserBroker';
import type { BrowserProfilePreference } from './defaultBrowserBroker';
import type { AutomationAction, Postcondition, SemanticTarget } from './automationContracts';

type BrowserStepResult = {
  url: string;
  title: string;
  data?: Record<string, string>;
};

export type SemanticBrowserElement = {
  id: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  href: string;
  src: string;
  value: string;
  selected: boolean;
  checked: boolean;
  disabled: boolean;
};

export function verifiedImageType(buffer: Buffer, declaredMimeType = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (/^image\/svg\+xml/i.test(declaredMimeType) && /<svg[\s>]/i.test(buffer.subarray(0, 2048).toString('utf8'))) {
    return { mimeType: 'image/svg+xml', extension: '.svg' };
  }
  throw new Error('The selected browser resource was not a verified image. OmniAgent refused to save a web page as an image.');
}

export function verifiedDownloadType(buffer: Buffer, extension: string, expectedMimeType = '') {
  const normalizedExtension = extension.toLowerCase();
  let detectedMimeType = '';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detectedMimeType = 'image/png';
  else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) detectedMimeType = 'image/jpeg';
  else if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) detectedMimeType = 'image/gif';
  else if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') detectedMimeType = 'image/webp';
  else if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') detectedMimeType = 'application/pdf';
  else if (buffer.length >= 4 && buffer.subarray(0, 2).toString('ascii') === 'PK') detectedMimeType = 'application/zip';

  const expectedByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip'
  };
  const requiredMimeType = expectedMimeType.toLowerCase() || expectedByExtension[normalizedExtension] || '';
  if (requiredMimeType && detectedMimeType !== requiredMimeType) {
    throw new Error(`The downloaded file signature did not match ${requiredMimeType}.`);
  }
  return detectedMimeType || expectedMimeType || 'application/octet-stream';
}

export function imageSearchCandidates(html: string) {
  const values: string[] = [];
  const add = (raw: string) => {
    const decoded = raw
      .replace(/\\u002f/gi, '/')
      .replace(/\\\//g, '/')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&');
    if (/^https?:\/\//i.test(decoded) && !values.includes(decoded)) values.push(decoded);
  };
  for (const expression of [
    /murl&quot;\s*:\s*&quot;((?:(?!&quot;).)+)&quot;/gis,
    /\\"murl\\"\s*:\s*\\"(https?:\\?\/\\?\/.+?)\\"/gi,
    /"murl"\s*:\s*"(https?:\\?\/\\?\/[^"]+)"/gi
  ]) {
    for (const match of html.matchAll(expression)) add(match[1]);
  }
  return values.slice(0, 100);
}

export function simplifyImageQuery(query: string) {
  const simplified = query
    .replace(/\b(?:a|an|the|image|images|picture|pictures|photo|photos|photograph|showing|holding|holds|with|inside|of|for|please|download|find)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return simplified || query.trim();
}

export function duckDuckGoImageToken(html: string) {
  return html.match(/vqd=["']([^"']+)/)?.[1] || html.match(/vqd=([\d-]+)/)?.[1] || '';
}

export type SemanticBrowserSnapshot = {
  browser: string;
  url: string;
  title: string;
  bodyText: string;
  elements: SemanticBrowserElement[];
};

type BrowserSession = {
  browserName: string;
  executable: string;
  lastOpenedUrl: string;
  launchedAt: number;
};

export type DefaultBrowserInfo = {
  executable: string;
  compatible: boolean;
  defaultBrowser: string;
  defaultBrowserId: string;
  defaultIsChromium: boolean;
};

const FAST_PAGE_BROWSERS = /chrome|msedge|edge|brave|chromium|vivaldi|opera/i;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function semanticUnavailable() {
  return new Error(
    'The default browser page is not available yet. Open a website and try again.'
  );
}

export class BrowserAutomationService {
  private sessions = new Map<string, BrowserSession>();
  private broker = new DefaultBrowserBroker();
  private engines = new Map<string, CdpBrowser>();
  private manualOnlyProfiles = new Set<string>();
  private discreetWorkers = new Set<string>();

  async fastEngine(workerId: string) {
    const headless = this.discreetWorkers.has(workerId);
    const existing = this.engines.get(workerId);
    if (existing && existing.isHeadless === headless && (existing.running || existing.launching)) return existing;
    if (existing && existing.isHeadless !== headless) {
      this.engines.delete(workerId);
      await existing.close().catch(() => undefined);
    }
    if (this.manualOnlyProfiles.has(workerId) || this.broker.profilePreference(workerId) !== 'isolated') return null;
    const executable = await this.broker.browserExecutablePath();
    if (!executable || !FAST_PAGE_BROWSERS.test(path.basename(executable))) return null;
    const engine = new CdpBrowser(executable, this.broker.workerProfileDirectory(workerId), headless);
    this.engines.set(workerId, engine);
    return engine;
  }

  async defaultBrowserInfo(fresh = false): Promise<DefaultBrowserInfo> {
    const executable = await this.broker.browserExecutablePath(fresh);
    const choice = await this.broker.defaultBrowserChoice();
    const compatible = Boolean(executable && FAST_PAGE_BROWSERS.test(path.basename(executable)));
    const resolvesTheDefault = process.platform === 'win32';
    return {
      executable: executable ?? '',
      compatible,
      defaultBrowser: choice?.name ?? '',
      defaultBrowserId: choice?.id ?? '',
      defaultIsChromium: Boolean(choice?.chromium) || (resolvesTheDefault && compatible)
    };
  }

  setDiscreet(workerId: string, enabled: boolean) {
    if (enabled) this.discreetWorkers.add(workerId);
    else this.discreetWorkers.delete(workerId);
  }

  fastEngineIfOpen(workerId: string) {
    const engine = this.engines.get(workerId);
    return engine?.running ? engine : null;
  }

  async markRunBaseline(workerId: string) {
    await this.fastEngineIfOpen(workerId)?.markRunBaseline().catch(() => undefined);
  }

  async releaseRunTabs(workerId: string) {
    const engine = this.fastEngineIfOpen(workerId);
    if (!engine) return { closed: 0, remaining: 0 };
    return engine.releaseRunTabs().catch(() => ({ closed: 0, remaining: 0 }));
  }

  async closeFastEngine(workerId: string) {
    const engine = this.engines.get(workerId);
    this.engines.delete(workerId);
    if (engine) await engine.close();
  }

  async closeAllFastEngines() {
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.allSettled(engines.map((engine) => engine.close()));
  }

  setBrowserControlMode(mode: 'default' | 'worker-profile') {
    this.broker.setMode(mode);
  }

  setProfilePreference(workerId: string, preference: BrowserProfilePreference | null) {
    this.broker.setProfilePreference(workerId, preference);
  }

  setManualOnly(workerId: string, enabled: boolean) {
    if (enabled) this.manualOnlyProfiles.add(workerId);
    else this.manualOnlyProfiles.delete(workerId);
  }

  isManualOnly(workerId: string) {
    return this.manualOnlyProfiles.has(workerId);
  }

  hasSession(workerId: string) {
    return this.sessions.has(workerId) || Boolean(this.fastEngineIfOpen(workerId));
  }

  noteVisibleNavigation(workerId: string, url: string, title?: string) {
    const session = this.sessions.get(workerId);
    if (session) session.lastOpenedUrl = url;
    this.broker.noteVisibleNavigation(workerId, url, title);
  }

  profilePreference(workerId: string) {
    return this.broker.profilePreference(workerId);
  }

  hasProfilePreference(workerId: string) {
    return this.broker.hasProfilePreference(workerId);
  }

  browserExecutablePath() {
    return this.broker.browserExecutablePath();
  }

  workerProfileDirectory(workerId: string) {
    return this.broker.workerProfileDirectory(workerId);
  }

  async browserProcessIds(workerId: string) {
    return this.broker.processesForWorker(workerId);
  }
  private launchTail: Promise<void> = Promise.resolve();

  async initialize() {
    await this.broker.initialize();
  }

  async open(workerId: string, url: string, signal?: AbortSignal): Promise<BrowserStepResult> {
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
      throw new Error('Browser automation only permits HTTP, HTTPS, or local synthetic test pages.');
    }
    const previousLaunch = this.launchTail;
    let releaseLaunch: () => void = () => {};
    this.launchTail = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    await previousLaunch;
    try {
    const result = await this.broker.command(workerId, ['open', url], { signal, timeoutMs: 45_000 });
    const browser = this.broker.sessionInfo(workerId)?.browser;
    if (!browser) throw semanticUnavailable();
    this.sessions.set(workerId, {
      browserName: browser.name,
      executable: browser.executable,
      lastOpenedUrl: url,
      launchedAt: Date.now()
    });
    const tabs = await this.broker.listTabs(workerId, { signal, timeoutMs: 10_000 });
    const requested = new URL(url).href;
    const expectedUrl = (() => {
      try {
        const reported = new URL(String(result.url || ''));
        return reported.protocol === 'http:' || reported.protocol === 'https:' || reported.protocol === 'file:'
          ? reported.href
          : requested;
      } catch {
        return requested;
      }
    })();
    const matchingTab = tabs.find((tab) => {
      try {
        return new URL(String(tab.url || '')).href === expectedUrl;
      } catch {
        return false;
      }
    });
    if (matchingTab?.tabId && !matchingTab.active) {
      await this.broker.command(workerId, ['tab', String(matchingTab.tabId)], { signal, timeoutMs: 10_000 });
    }
    let identity = await this.pageIdentity(workerId);
    if (identity.url !== expectedUrl) {
      await this.broker.command(workerId, ['open', url], { signal, timeoutMs: 45_000 });
      identity = await this.pageIdentity(workerId);
    }
    if (identity.url !== expectedUrl) {
      throw new Error(`The default browser did not reach the requested page (${url}).`);
    }
    return { url: identity.url, title: identity.title || String(result.title || `${browser.name} window`) };
    } finally {
      releaseLaunch();
    }
  }

  async show(workerId: string) {
    const engine = this.fastEngineIfOpen(workerId);
    if (engine) return engine.bringToFront();
    const tabs = await this.broker.listTabs(workerId);
    const active = tabs.find((tab) => tab.active) ?? tabs.at(-1);
    if (!active) {
      throw new Error('This worker has not opened a browser window yet, so there is nothing to bring forward.');
    }
    await this.broker.command(workerId, ['tab', active.tabId]);
    return { url: active.url, title: active.title };
  }

  async pageIdentity(workerId: string): Promise<BrowserStepResult> {
    const session = this.sessions.get(workerId);
    if (!session) throw new Error('No default-browser tab has been opened for this worker yet.');
    const [url, title] = await Promise.all([
      this.broker.command(workerId, ['get', 'url']),
      this.broker.command(workerId, ['get', 'title'])
    ]);
    session.lastOpenedUrl = String(url.url || session.lastOpenedUrl);
    return { url: session.lastOpenedUrl, title: String(title.title || `${session.browserName} window`) };
  }

  async pageAutomationAvailable(workerId: string) {
    const snapshot = await this.snapshot(workerId).catch(() => null);
    return Boolean(snapshot?.elements.length);
  }

  async snapshot(workerId: string): Promise<SemanticBrowserSnapshot | null> {
    const session = this.sessions.get(workerId);
    if (!session) return null;
    const [identity, body] = await Promise.all([
      this.pageIdentity(workerId),
      this.broker.command(workerId, ['get', 'text', 'body']).catch(() => ({ text: '' }))
    ]);

    const snapshot = await this.broker.command(workerId, ['snapshot', '-i', '--urls']);
    const refs = snapshot.refs && typeof snapshot.refs === 'object'
      ? snapshot.refs as Record<string, Record<string, unknown>>
      : {};
    return {
      browser: session.browserName,
      url: identity.url,
      title: identity.title,
      bodyText: String(body.text || snapshot.snapshot || ''),
      elements: Object.entries(refs).map(([id, item]) => ({
        id,
        tag: String(item.tag || ''),
        role: String(item.role || ''),
        name: String(item.name || ''),
        text: String(item.text || item.name || ''),
        href: String(item.href || item.url || ''),
        src: String(item.src || ''),
        value: String(item.value || ''),
        selected: Boolean(item.selected),
        checked: Boolean(item.checked),
        disabled: item.disabled === true
      }))
    };
  }

  async clickTarget(_workerId: string, _targetId: string) {
    const result = await this.broker.command(_workerId, ['click', this.ref(_targetId)]);
    await this.snapshot(_workerId).catch(() => undefined);
    return result;
  }

  async fillTarget(_workerId: string, _targetId: string, _value: string) {
    const target = this.ref(_targetId);
    const result = await this.broker.command(_workerId, ['fill', target, _value]);
    const retained = await this.broker.command(_workerId, ['get', 'value', target]);
    if (String(retained.value ?? '') !== _value) throw new Error('The browser did not retain the exact requested value.');
    return result;
  }

  async pressTarget(_workerId: string, _targetId: string | undefined, _key: string) {
    if (_targetId) await this.broker.command(_workerId, ['focus', this.ref(_targetId)]);
    const result = await this.broker.command(_workerId, ['press', _key]);
    await this.snapshot(_workerId).catch(() => undefined);
    return result;
  }

  async scroll(_workerId: string, _delta: number) {
    return this.broker.command(_workerId, ['scroll', _delta < 0 ? 'up' : 'down', String(Math.abs(Math.round(_delta)))]);
  }

  async back(_workerId: string) {
    const result = await this.broker.command(_workerId, ['back']);
    await this.snapshot(_workerId).catch(() => undefined);
    return result;
  }

  async reload(_workerId: string) {
    const result = await this.broker.command(_workerId, ['reload']);
    await this.snapshot(_workerId).catch(() => undefined);
    return result;
  }

  async openTab(workerId: string, url = 'about:blank') {
    const result = await this.broker.command(workerId, ['tab', 'new', url]);
    return { ...result, tabs: await this.broker.listTabs(workerId) };
  }

  async switchTab(workerId: string, tabId: string) {
    if (!tabId) throw new Error('Browser tab switching requires a stable tab ID.');
    await this.broker.command(workerId, ['tab', tabId]);
    return this.snapshot(workerId);
  }

  async listTabs(workerId: string) {
    return this.broker.listTabs(workerId);
  }

  private ref(targetId: string) {
    return targetId.startsWith('@') ? targetId : `@${targetId}`;
  }

  private async targetRef(workerId: string, target?: SemanticTarget) {
    if (!target) return undefined;
    const snapshot = await this.snapshot(workerId);
    if (!snapshot) return undefined;
    const normalized = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();
    const matches = snapshot.elements.filter((element) => {
      const match = target.match;
      if (match.role && normalized(element.role) !== normalized(match.role)) return false;
      if (match.name && normalized(element.name) !== normalized(match.name)) return false;
      if (match.nameContains && !normalized(element.name).includes(normalized(match.nameContains))) return false;
      if (match.text && normalized(element.text) !== normalized(match.text)) return false;
      if (match.textContains && !normalized(element.text).includes(normalized(match.textContains))) return false;
      if (match.href && normalized(element.href) !== normalized(match.href)) return false;
      if (match.value && normalized(element.value) !== normalized(match.value)) return false;
      return true;
    });
    const selected = target.selection === 'last' ? matches.at(-1)
      : target.selection === 'nth' ? matches[target.index ?? 0]
        : matches[0];
    if (!selected) return undefined;
    if (target.match.id) return `#${target.match.id.replace(/["\\]/g, '\\$&')}`;
    if (target.match.testId) return `[data-testid=${JSON.stringify(target.match.testId)}]`;
    if (target.match.placeholder) return `[placeholder=${JSON.stringify(target.match.placeholder)}]`;
    if (target.match.href) return `[href=${JSON.stringify(target.match.href)}]`;
    if (target.match.name) return `[aria-label=${JSON.stringify(target.match.name)}]`;
    const marker = `omniagent-${crypto.randomBytes(8).toString('hex')}`;
    const script = `(() => {
      const target = ${JSON.stringify(target)};
      const marker = ${JSON.stringify(marker)};
      const normalized = (value) => String(value ?? '').trim().toLocaleLowerCase();
      const implicitRole = (element) => {
        const tag = element.tagName.toLowerCase();
        const type = normalized(element.getAttribute('type'));
        if (tag === 'a' && element.hasAttribute('href')) return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'option') return 'option';
        if (tag === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)) return type === 'submit' || type === 'reset' ? 'button' : type;
        if (tag === 'input') return 'textbox';
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return '';
      };
      const accessibleName = (element) => {
        const labelledBy = String(element.getAttribute('aria-labelledby') || '')
          .split(/\\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || '').join(' ');
        const label = element.labels ? Array.from(element.labels).map((item) => item.textContent || '').join(' ') : '';
        return element.getAttribute('aria-label') || labelledBy || label
          || element.getAttribute('alt') || element.getAttribute('title')
          || element.getAttribute('placeholder') || element.textContent || '';
      };
      const match = target.match || {};
      const candidates = Array.from(document.querySelectorAll('*')).filter((element) => {
        const role = element.getAttribute('role') || implicitRole(element);
        const name = accessibleName(element);
        const text = element.textContent || '';
        if (match.role && normalized(role) !== normalized(match.role)) return false;
        if (match.name && normalized(name) !== normalized(match.name)) return false;
        if (match.nameContains && !normalized(name).includes(normalized(match.nameContains))) return false;
        if (match.text && normalized(text) !== normalized(match.text)) return false;
        if (match.textContains && !normalized(text).includes(normalized(match.textContains))) return false;
        if (match.href && normalized(element.href) !== normalized(match.href)) return false;
        if (match.value && normalized(element.value) !== normalized(match.value)) return false;
        if (match.tag && normalized(element.tagName) !== normalized(match.tag)) return false;
        if (match.id && normalized(element.id) !== normalized(match.id)) return false;
        if (match.placeholder && normalized(element.getAttribute('placeholder')) !== normalized(match.placeholder)) return false;
        if (match.testId && normalized(element.getAttribute('data-testid')) !== normalized(match.testId)) return false;
        if (match.attributes && Object.entries(match.attributes).some(([key, value]) => normalized(element.getAttribute(key)) !== normalized(value))) return false;
        return true;
      });
      const selected = target.selection === 'last' ? candidates.at(-1)
        : target.selection === 'nth' ? candidates[target.index || 0]
        : candidates[0];
      document.querySelectorAll('[data-omniagent-target]').forEach((element) => element.removeAttribute('data-omniagent-target'));
      if (!selected) return false;
      selected.setAttribute('data-omniagent-target', marker);
      return true;
    })()`;
    try {
      const marked = await this.broker.command(workerId, ['eval', script]);
      if (marked.result !== true) {
        if (process.env.OMNIAGENT_BROWSER_DEBUG_OUTPUT === '1') {
          process.stderr.write(`[OmniAgent semantic marker] ${JSON.stringify(marked)}\n`);
        }
        return this.ref(selected.id);
      }
      await wait(100);
      return `[data-omniagent-target="${marker}"]`;
    } catch {

      return this.ref(selected.id);
    }
  }

  async readImageTarget(_workerId: string, _targetId: string) {
    const target = this.ref(_targetId);
    const [source, label] = await Promise.all([
      this.broker.command(_workerId, ['get', 'attr', 'src', target]),
      this.broker.command(_workerId, ['get', 'attr', 'alt', target]).catch(() => ({ value: '' }))
    ]);
    const sourceValue = source as Record<string, unknown>;
    const labelValue = label as Record<string, unknown>;
    const resource = {
      url: String(sourceValue.value || sourceValue.attribute || ''),
      name: String(labelValue.value || labelValue.attribute || '')
    };
    const url = resource.url;
    let bytes: Buffer;
    let declaredMimeType = '';
    if (/^data:/i.test(url)) {
      const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (!match) throw new Error('The selected image used an unreadable data URL.');
      declaredMimeType = match[1] || '';
      bytes = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    } else {
      if (!/^https?:\/\//i.test(url)) throw new Error('The selected image did not expose an HTTP(S) resource.');
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'Mozilla/5.0 OmniAgent/0.1' }
      });
      if (!response.ok) throw new Error(`The selected image server returned HTTP ${response.status}.`);
      declaredMimeType = response.headers.get('content-type')?.split(';')[0] || '';
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 25 * 1024 * 1024) throw new Error('The selected image is larger than the 25 MB download limit.');
      bytes = await readResponse(response, 25 * 1024 * 1024);
    }
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('The selected image is empty or exceeds the 25 MB download limit.');
    const verified = verifiedImageType(bytes, declaredMimeType);
    return {
      bytes,
      url,
      name: String(resource.name || ''),
      mimeType: verified.mimeType,
      extension: verified.extension,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    };
  }

  async searchImage(query: string) {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error('Image search requires a query.');
    const candidates: string[] = [];
    try {
      const landing = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(normalizedQuery)}&iax=images&ia=images`, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36' }
      });
      const token = duckDuckGoImageToken(await landing.text());
      if (!token) throw new Error('Image search token was unavailable.');
      const apiUrl = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(normalizedQuery)}&vqd=${encodeURIComponent(token)}&f=,,,`;
      const apiResponse = await fetch(apiUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
          referer: 'https://duckduckgo.com/'
        }
      });
      if (!apiResponse.ok) throw new Error(`Image metadata search returned HTTP ${apiResponse.status}.`);
      const payload = await apiResponse.json() as { results?: Array<{ image?: string }> };
      for (const result of payload.results ?? []) {
        if (result.image && /^https?:\/\//i.test(result.image) && !candidates.includes(result.image)) candidates.push(result.image);
      }
    } catch {

    }
    try {
      if (candidates.length) throw new Error('Primary search already produced candidates.');
      const commonsUrl = new URL('https://commons.wikimedia.org/w/api.php');
      const commonsQuery = simplifyImageQuery(normalizedQuery);
      for (const [key, value] of Object.entries({
        action: 'query',
        generator: 'search',
        gsrsearch: commonsQuery,
        gsrnamespace: '6',
        gsrlimit: '30',
        prop: 'imageinfo',
        iiprop: 'url|mime|size',
        format: 'json',
        origin: '*'
      })) commonsUrl.searchParams.set(key, value);
      const commonsResponse = await fetch(commonsUrl, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'OmniAgent/0.1 universal image automation' }
      });
      const payload = await commonsResponse.json() as {
        query?: { pages?: Record<string, { imageinfo?: Array<{ url?: string; mime?: string }> }> };
      };
      for (const page of Object.values(payload.query?.pages ?? {})) {
        const image = page.imageinfo?.[0];
        if (image?.url && /^image\//i.test(String(image.mime || '')) && !candidates.includes(image.url)) candidates.push(image.url);
      }
    } catch {

    }
    if (!candidates.length) {
      const searchResponse = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(normalizedQuery)}&form=HDRSC2`, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36' }
      });
      if (!searchResponse.ok) throw new Error(`Image search returned HTTP ${searchResponse.status}.`);
      candidates.push(...imageSearchCandidates(await searchResponse.text()));
    }
    if (!candidates.length) throw new Error('Image search did not return any downloadable image resources.');
    const attempt = async (url: string) => {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(12_000),
          headers: { 'user-agent': 'Mozilla/5.0 OmniAgent/0.1', referer: 'https://www.bing.com/' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > 25 * 1024 * 1024) throw new Error('larger than 25 MB');
        const bytes = await readResponse(response, 25 * 1024 * 1024);
        if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error('empty or larger than 25 MB');
        const verified = verifiedImageType(bytes, response.headers.get('content-type')?.split(';')[0] || '');
        return {
          bytes,
          url: response.url,
          query: normalizedQuery,
          mimeType: verified.mimeType,
          extension: verified.extension,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex')
        };
    };
    try {
      return await Promise.any(candidates.slice(0, 12).map(attempt));
    } catch {
      throw new Error('Image search found results, but none of the first 12 resources passed download and image verification.');
    }
  }

  async executeAutomation(workerId: string, action: AutomationAction, value?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const operation = action.operation;
    if (operation === 'navigate') {
      const url = String(value ?? action.options.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Browser navigation requires an HTTP or HTTPS URL.');
      const engine = await this.fastEngine(workerId);
      if (engine) return engine.openOrReuse(url);
      if (!this.sessions.has(workerId)) return this.open(workerId, url);
      const result = await this.broker.command(workerId, ['open', url], { signal, timeoutMs: Number(action.options.timeoutMs || 45_000) });
      const session = this.sessions.get(workerId);
      if (session) session.lastOpenedUrl = url;
      await this.snapshot(workerId);
      return result;
    }
    if (operation === 'back') return this.back(workerId);
    if (operation === 'forward') return this.broker.command(workerId, ['forward']);
    if (operation === 'reload') return this.reload(workerId);
    if (operation === 'openTab') {
      const tabUrl = String(value ?? action.options.url ?? 'about:blank');
      const result = await this.broker.command(workerId, ['tab', 'new', tabUrl]);
      return { ...result, tabs: await this.broker.listTabs(workerId) };
    }
    if (operation === 'closeTab') {
      const tabId = String(value ?? action.options.tabId ?? '');
      const result = await this.broker.command(workerId, ['tab', 'close', ...(tabId ? [tabId] : [])]);
      return { ...result, tabs: await this.broker.listTabs(workerId) };
    }
    if (operation === 'switchTab') {
      const tabId = String(value ?? action.options.tabId ?? '');
      if (!tabId) throw new Error('Browser tab switching requires a stable tab ID.');
      const result = await this.broker.command(workerId, ['tab', tabId]);
      await this.snapshot(workerId);
      return result;
    }
    if (operation === 'query') {
      const snapshot = await this.snapshot(workerId);
      const target = await this.targetRef(workerId, action.target);
      return { target, snapshot };
    }
    if (operation === 'read' || operation === 'extract') {
      const target = await this.targetRef(workerId, action.target);
      const fields = Array.isArray(action.options.fields) ? action.options.fields.map(String) : ['text'];
      if (!target) return this.snapshot(workerId);
      const result: Record<string, unknown> = {};
      for (const field of fields) {
        if (field === 'text' || field === 'html' || field === 'value') {
          result[field] = (await this.broker.command(workerId, ['get', field, target]))[field];
        } else {
          result[field] = (await this.broker.command(workerId, ['get', 'attr', field, target])).value;
        }
      }
      return result;
    }
    if (operation === 'wait' || operation === 'assert') {
      const condition: Postcondition = {
        kind: 'browser',
        assertion: String(action.options.assertion ?? 'exists') as Postcondition['assertion'],
        target: action.target,
        expected: { kind: 'literal', value: value ?? action.options.expected },
        property: typeof action.options.property === 'string' ? action.options.property : undefined,
        timeoutMs: Number(action.options.timeoutMs || 10_000),
        message: typeof action.options.message === 'string' ? action.options.message : undefined
      };
      return this.verifyAutomation(workerId, condition, undefined, value ?? action.options.expected);
    }
    if (operation === 'screenshot') {
      const requestedPath = String(action.options.destination ?? action.options.path ?? '');
      if (!requestedPath) throw new Error('Browser screenshots require an explicit output path.');
      const artifactPath = path.resolve(requestedPath);
      if (fs.existsSync(artifactPath) && action.options.overwrite !== true) {
        throw new Error(`Browser screenshot destination already exists: ${artifactPath}`);
      }
      await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
      const args = ['screenshot', ...(action.options.fullPage === true ? ['--full'] : []), ...(action.options.annotate === true ? ['--annotate'] : []), artifactPath];
      const result = await this.broker.command(workerId, args);
      const bytes = await fsp.readFile(artifactPath);
      const mimeType = verifiedDownloadType(bytes, path.extname(artifactPath));
      return { ...result, artifact: { path: artifactPath, bytes: bytes.length, mimeType, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
    }
    if (operation === 'getCookies') return this.broker.command(workerId, ['cookies', 'get']);
    if (operation === 'clearCookies') return this.broker.command(workerId, ['cookies', 'clear']);
    if (operation === 'setCookie') {
      const name = String(action.options.name ?? '');
      const cookieValue = String(value ?? action.options.value ?? '');
      if (!name) throw new Error('Setting a browser cookie requires a name.');
      const args = ['cookies', 'set', name, cookieValue];
      for (const [option, flag] of [['url', '--url'], ['domain', '--domain'], ['path', '--path'], ['sameSite', '--sameSite'], ['expires', '--expires']] as const) {
        if (action.options[option] !== undefined) args.push(flag, String(action.options[option]));
      }
      if (action.options.httpOnly === true) args.push('--httpOnly');
      if (action.options.secure === true) args.push('--secure');
      return this.broker.command(workerId, args);
    }
    if (['getStorage', 'setStorage', 'clearStorage'].includes(operation)) {
      const storageType = action.options.storageType === 'session' ? 'session' : 'local';
      const storageAction = operation === 'getStorage' ? 'get' : operation === 'setStorage' ? 'set' : 'clear';
      const args = ['storage', storageType, storageAction];
      if (storageAction !== 'clear' && action.options.key !== undefined) args.push(String(action.options.key));
      if (storageAction === 'set') args.push(String(value ?? action.options.value ?? ''));
      return this.broker.command(workerId, args);
    }
    if (operation === 'saveSessionState' || operation === 'loadSessionState') {
      const requestedPath = String(action.options.path ?? action.options.destination ?? value ?? '');
      if (!requestedPath) throw new Error('Browser session state requires an explicit file path.');
      const statePath = path.resolve(requestedPath);
      if (operation === 'saveSessionState') await fsp.mkdir(path.dirname(statePath), { recursive: true });
      return this.broker.command(workerId, ['state', operation === 'saveSessionState' ? 'save' : 'load', statePath]);
    }
    if (operation === 'networkRequests') {
      const args = ['network', 'requests'];
      for (const [option, flag] of [['filter', '--filter'], ['type', '--type'], ['method', '--method'], ['status', '--status']] as const) {
        if (action.options[option] !== undefined) args.push(flag, String(action.options[option]));
      }
      if (action.options.clear === true) args.push('--clear');
      return this.broker.command(workerId, args);
    }
    if (operation === 'networkResponse') {
      const requestId = String(value ?? action.options.requestId ?? '');
      if (!requestId) throw new Error('Network response inspection requires a request ID.');
      return this.broker.command(workerId, ['network', 'request', requestId]);
    }
    if (operation === 'startHar') {
      return this.broker.command(workerId, ['network', 'har', 'start', '--content', String(action.options.content ?? 'text')]);
    }
    if (operation === 'stopHar') {
      const requestedPath = String(action.options.destination ?? action.options.path ?? value ?? '');
      if (!requestedPath) throw new Error('Stopping a HAR capture requires an explicit output path.');
      const harPath = path.resolve(requestedPath);
      await fsp.mkdir(path.dirname(harPath), { recursive: true });
      const result = await this.broker.command(workerId, ['network', 'har', 'stop', harPath]);
      if (!fs.existsSync(harPath)) throw new Error('The browser did not create the requested HAR file.');
      return { ...result, artifact: { path: harPath, bytes: (await fsp.stat(harPath)).size, mimeType: 'application/json' } };
    }
    if (
      action.target?.match.role
      && action.target.match.name
      && ['click', 'fill', 'check', 'hover'].includes(operation)
    ) {
      const findArgs = [
        'find', 'role', action.target.match.role, operation,
        ...(['fill'].includes(operation) ? [String(value ?? '')] : []),
        '--name', action.target.match.name, '--exact'
      ];
      const result = await this.broker.command(workerId, findArgs, {
        timeoutMs: Math.max(15_000, Number(action.options.timeoutMs || 0))
      });
      if (['click', 'check'].includes(operation)) await this.snapshot(workerId).catch(() => undefined);
      return result;
    }
    const target = await this.targetRef(workerId, action.target);
    if (operation === 'download') {
      const requestedDestination = action.options.destination ?? action.options.path;
      if (!requestedDestination) throw new Error('Browser downloads require an explicit output path.');
      const artifactPath = path.resolve(String(requestedDestination));
      if (fs.existsSync(artifactPath) && action.options.overwrite !== true) {
        throw new Error(`Browser download destination already exists: ${artifactPath}`);
      }
      if (!target) throw new Error('Browser download requires a fresh semantic target.');
      await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
      const resource: Record<string, unknown> = await this.broker.command(
        workerId,
        ['get', 'attr', 'href', target]
      ).catch(() => ({}));
      let downloaded: Record<string, unknown>;
      try {
        downloaded = await this.broker.command(workerId, ['download', target, artifactPath], {
          signal, timeoutMs: Math.max(60_000, Number(action.options.timeoutMs || 60_000))
        });
      } catch (error) {
        signal?.throwIfAborted();
        let href = String(resource.value ?? resource.attribute ?? '');
        if (!href) {
          const evaluated: Record<string, unknown> = await this.broker.command(
            workerId,
            ['eval', `document.querySelector(${JSON.stringify(target)})?.href || ''`]
          ).catch(() => ({}));
          href = String(evaluated.result ?? '');
        }
        if (!/download was canceled/i.test(error instanceof Error ? error.message : String(error)) || !href) throw error;
        const identity = await this.pageIdentity(workerId);
        const resourceUrl = new URL(href, identity.url).href;
        const response = await fetch(resourceUrl, { redirect: 'follow', signal });
        if (!response.ok) throw new Error(`The browser resource server returned HTTP ${response.status}.`);
        await saveResponse(response, artifactPath, signal);
        downloaded = { url: response.url, directResource: true, declaredMimeType: response.headers.get('content-type') || '' };
      }
      if (!fs.existsSync(artifactPath)) throw new Error('The browser reported a download, but the requested file was not created.');
      const size = (await fsp.stat(artifactPath)).size;
      const bytes = await readRange(artifactPath, 2048, 0, signal);
      if (!bytes.length) throw new Error('The browser download created an empty file.');
      const mimeType = verifiedDownloadType(
        bytes,
        path.extname(artifactPath),
        typeof action.options.expectedMimeType === 'string' ? action.options.expectedMimeType : ''
      );
      return {
        ...downloaded,
        artifact: {
          path: artifactPath,
          bytes: size,
          mimeType,
          sha256: await hashFile(artifactPath, signal)
        }
      };
    }
    if (operation === 'upload') {
      if (!target) throw new Error('Browser upload requires a fresh semantic file-input target.');
      const filePath = String(value ?? action.options.path ?? '');
      if (!path.isAbsolute(filePath) || !fs.existsSync(filePath)) throw new Error('Browser upload requires an existing absolute file path.');
      return this.broker.command(workerId, ['upload', target, filePath]);
    }
    if (operation === 'scroll' && !action.target) {
      return this.scroll(workerId, Number(value ?? action.options.delta ?? 0));
    }
    if (!target && !['press'].includes(operation)) {
      throw new Error('The browser page changed and the requested element is no longer available. OmniAgent refreshed the page snapshot; retry the action with a current target.');
    }
    const command = operation === 'doubleClick' ? 'dblclick'
      : operation === 'selectOption' ? 'select'
        : operation;
    const args = command === 'press'
      ? ['press', String(value ?? action.options.key ?? 'Enter')]
      : [command, target!, ...(['fill', 'type', 'select'].includes(command) ? [String(value ?? '')] : [])];
    const result = await this.broker.command(workerId, args, { signal, timeoutMs: Math.max(15_000, Number(action.options.timeoutMs || 0)) });
    if (['click', 'dblclick', 'press', 'select', 'check', 'uncheck'].includes(command)) {
      await this.snapshot(workerId).catch(() => undefined);
    }
    return result;
  }

  async verifyAutomation(_workerId: string, condition: Postcondition, actual?: unknown, expected?: unknown) {
    const deadline = Date.now() + Math.max(0, condition.timeoutMs);
    let lastActual: unknown = actual;
    do {
      try {
        const identity = await this.pageIdentity(_workerId);
        const target = await this.targetRef(_workerId, condition.target);
        if (condition.assertion === 'urlEquals') lastActual = identity.url;
        else if (condition.assertion === 'urlContains') lastActual = identity.url;
        else if (condition.assertion === 'exists' || condition.assertion === 'visible') lastActual = Boolean(target);
        else if (condition.assertion === 'notExists' || condition.assertion === 'hidden') lastActual = !target;
        else if (target && condition.assertion === 'enabled') {
          lastActual = Boolean((await this.broker.command(_workerId, ['is', 'enabled', target])).enabled);
        } else if (target && ['checked', 'unchecked'].includes(condition.assertion)) {
          const checked = Boolean((await this.broker.command(_workerId, ['is', 'checked', target])).checked);
          lastActual = condition.assertion === 'checked' ? checked : !checked;
        } else if (target && condition.property === 'value') {
          lastActual = (await this.broker.command(_workerId, ['get', 'value', target])).value;
        }
        const passed = condition.assertion === 'urlEquals' ? String(lastActual) === String(expected)
          : condition.assertion === 'urlContains' ? String(lastActual).includes(String(expected))
            : ['exists', 'notExists', 'visible', 'hidden', 'enabled', 'checked', 'unchecked'].includes(condition.assertion)
              ? lastActual === true
              : condition.assertion === 'equals' ? lastActual === expected
                : condition.assertion === 'contains' ? String(lastActual).includes(String(expected))
                  : Boolean(lastActual);
        if (passed) return { passed: true, actual: lastActual, expected };
      } catch {

      }
      await wait(150);
    } while (Date.now() < deadline);
    throw new Error(condition.message || `The browser did not satisfy ${condition.assertion}.`);
  }

  async semanticAction(
    _workerId: string,
    _action: 'click' | 'type' | 'read',
    _target: { selector?: string; role?: string; name?: string; text?: string; value?: string }
  ) {
    const snapshot = await this.snapshot(_workerId);
    if (!snapshot) throw semanticUnavailable();
    const normalized = (value: string) => value.trim().toLocaleLowerCase();
    const target = snapshot.elements.find((element) =>
      (!_target.role || normalized(element.role) === normalized(_target.role)) &&
      (!_target.name || normalized(element.name) === normalized(_target.name)) &&
      (!_target.text || normalized(element.text).includes(normalized(_target.text)))
    );
    if (!target) throw new Error(`The default browser could not find a semantic target matching ${JSON.stringify(_target)}.`);
    if (_action === 'click') return this.clickTarget(_workerId, target.id);
    if (_action === 'type') return this.fillTarget(_workerId, target.id, String(_target.value ?? ''));
    return target;
  }

  cancelWorker(workerId: string) {
    this.sessions.delete(workerId);
    this.manualOnlyProfiles.delete(workerId);
    return this.broker.cancelWorker(workerId);
  }

  async openSignInWindow(workerId: string, url: string) {
    return this.broker.openSignInWindow(workerId, url);
  }

  async cleanupWorker(workerId: string) {
    await this.closeFastEngine(workerId).catch(() => undefined);
    await this.broker.cancelWorker(workerId).catch(() => undefined);
    this.forgetBrowsedTabs(workerId);
    this.sessions.delete(workerId);
    this.manualOnlyProfiles.delete(workerId);
  }

  private forgetBrowsedTabs(workerId: string) {
    const profile = path.join(this.broker.workerProfileDirectory(workerId), 'Default');
    for (const entry of ['Sessions', 'Last Session', 'Last Tabs', 'Current Session', 'Current Tabs']) {
      try {
        fs.rmSync(path.join(profile, entry), { recursive: true, force: true });
      } catch {

      }
    }
  }

  async closeAll() {
    this.sessions.clear();
    this.manualOnlyProfiles.clear();
    await this.closeAllFastEngines();
    await this.broker.closeAll();
  }
}
