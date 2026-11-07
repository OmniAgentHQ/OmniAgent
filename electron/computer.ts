import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserAutomationService } from './browserAutomation';
import { verificationChallengePage } from './cdpBrowser';
import { DesktopAutomationService } from './desktopAutomation';
import { launchApp as macLaunchApp } from './platform/macos/shell';
import { launchApp as linuxLaunchApp } from './platform/linux/shell';
import type { ProviderTurnInput } from './providerRuntime';

export function parseModelJson<T>(response: string, label = 'JSON response'): T {
  const source = String(response ?? '')
    .replace(/^﻿/, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  for (let start = 0; start < source.length; start += 1) {
    const opening = source[start];
    if (opening !== '{' && opening !== '[') continue;
    const stack: string[] = [];
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{' || character === '[') {
        stack.push(character);
        continue;
      }
      if (character !== '}' && character !== ']') continue;
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) break;
      if (stack.length) continue;
      try {
        return JSON.parse(source.slice(start, index + 1)) as T;
      } catch {
        break;
      }
    }
  }
  throw new Error(`The AI returned an invalid ${label}.`);
}

export function browserVerificationChallenge(value: unknown) {
  const text = String(value ?? '');
  return /\b(?:cloudflare|verification challenge|challenge page)\b/i.test(text)
    || verificationChallengePage(text, text);
}

export type VisionAsk = (workerId: string, prompt: string, png: Buffer, signal?: AbortSignal) => Promise<string>;

export class ComputerHub {
  readonly browser = new BrowserAutomationService();
  readonly desktop = new DesktopAutomationService();
  private foregroundInputTail: Promise<void> = Promise.resolve();

  constructor(private askVisionModel: VisionAsk) {}

  async initialize() {
    await this.browser.initialize();
  }

  prepareAgent(workerId: string, browsing: 'visible' | 'hidden') {
    this.browser.setDiscreet(workerId, browsing === 'hidden');
    this.browser.setProfilePreference(workerId, 'isolated');
  }

  async releaseAgent(workerId: string) {
    await this.browser.releaseRunTabs(workerId).catch(() => undefined);
  }

  async stopAgent(workerId: string) {
    this.browser.cancelWorker(workerId);
    await this.browser.releaseRunTabs(workerId).catch(() => undefined);
    await this.browser.cleanupWorker(workerId).catch(() => undefined);
    await this.browser.closeFastEngine(workerId).catch(() => undefined);
  }

  async close() {
    await this.browser.closeAll().catch(() => undefined);
  }

  async openUrl(workerId: string, url: string) {
    const engine = await this.browser.fastEngine(workerId);
    if (engine) {
      await engine.openOrReuse(url);
      return;
    }
    await this.browser.openTab(workerId, url);
  }

  private async withForegroundInput<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.foregroundInputTail;
    let release: () => void = () => {};
    this.foregroundInputTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }

  private async requireFastPage(workerId: string) {
    const engine = this.browser.fastEngineIfOpen(workerId);
    if (engine) return engine;
    throw new Error('No page is open yet in this agent’s browser. Call open_page with a URL first, then read it.');
  }

  private async focusWorkerBrowserWindow(workerId: string, url?: string, title?: string) {
    if (!this.desktop.nativeInstalled) return false;
    try {
      const owned = new Set((await this.browser.browserProcessIds(workerId)).map(Number));
      if (!owned.size) return false;
      const listed = await this.desktop.windowsAutomation('listWindows', {});
      const windows = (Array.isArray(listed)
        ? listed
        : (listed as { windows?: unknown[] } | null)?.windows ?? []) as Array<{
          handle?: string; title?: string; processId?: number;
        }>;
      const mine = windows.filter((item) => owned.has(Number(item.processId)));
      if (!mine.length) return false;
      const host = url ? new URL(url).hostname.replace(/^www\./i, '') : '';
      const preferred = mine.find((item) => {
        const name = String(item.title ?? '').toLowerCase();
        return Boolean((host && name.includes(host.toLowerCase()))
          || (title && name.includes(String(title).toLowerCase().slice(0, 24))));
      }) ?? mine[0];
      await this.desktop.windowsAutomation('focusWindow', {
        ...(preferred.handle ? { handle: preferred.handle } : {}),
        ...(preferred.processId ? { processId: Number(preferred.processId) } : {})
      });
      const front = await this.desktop.foregroundWindow().catch(() => null);
      return Boolean(front && owned.has(Number(front.processId)));
    } catch {
      return false;
    }
  }

  access(workerId: string, activeSignal: () => AbortSignal | undefined): NonNullable<ProviderTurnInput['computer']> {
    const settle = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const foreground = <T>(action: () => Promise<T>) => this.withForegroundInput(action, activeSignal());

    const readableControls = async () => {
      if (!this.desktop.nativeInstalled) {
        throw new Error('This computer cannot read the screen: the OmniAgent automation runtime is not installed. Answer from web_search and fetch_url instead.');
      }
      const front = await this.desktop.foregroundWindow();
      refuseOwnWindow(front?.processId);
      let cause = '';
      for (const target of [
        ...(front?.handle ? [{ handle: front.handle }] : []),
        ...(front?.processId ? [{ processId: front.processId }] : []),
        ...(front?.title ? [{ title: front.title }] : []),
        undefined
      ]) {
        try {
          const snapshot = await this.desktop.semanticSnapshot(300, target);
          if (snapshot?.elements?.length) return snapshot;
        } catch (error) {
          cause = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(!front
        ? 'There is no window in front to read. Call open_page with a URL, or open_app and focus_window for a program, and then read the screen again.'
        : `The window in front ("${front.title.slice(0, 60)}") could not be read${cause ? ` (${cause.slice(0, 140)})` : ''}. Try open_page with a URL, or answer from web_search and fetch_url instead.`);
    };

    const refuseOwnWindow = (processId: number | undefined) => {
      if (processId !== process.pid) return;
      throw new Error('That is the OmniAgent window itself, not the task. Call open_page with a URL, or open_app and focus_window for a program, and then read the screen.');
    };
    const foregroundIsOwnWindow = async () => {
      const front = await this.desktop.foregroundWindow().catch(() => null);
      refuseOwnWindow(front?.processId);
    };
    return {
      downloadState: async (name) => this.browser.fastEngineIfOpen(workerId)?.downloadState(name, 0) ?? 'unknown',
      pageAvailable: async () => Boolean(await this.browser.fastEngine(workerId)),
      pageOpen: async (url) => {
        const engine = await this.browser.fastEngine(workerId);
        if (!engine) throw new Error('Fast page control is not available for this agent.');
        return engine.openOrReuse(url);
      },
      pageOpenNewTab: async (url) => (await this.requireFastPage(workerId)).openNewTab(url),
      pageRead: async () => {
        const engine = await this.requireFastPage(workerId);
        await engine.assertNoVerificationChallenge();
        const reading = await engine.snapshotIfChanged();
        if ('unchanged' in reading) {
          return {
            url: reading.url,
            title: reading.title,
            unchanged: true,
            note: 'This page has not changed since your last read. Act on the element ids you already have, or scroll before reading again.'
          };
        }
        const snapshot = reading;
        const pageText = `${snapshot.title}\n${snapshot.text}`;
        if (browserVerificationChallenge(pageText)) {
          throw new Error('Cloudflare verification challenge detected. Do not retry or attempt to bypass it. Ask the user to complete the check in a normal browser if the site permits it.');
        }
        return {
          url: snapshot.url,
          title: snapshot.title,
          elementCount: snapshot.elements.length,
          elements: snapshot.elements,
          text: snapshot.text.slice(0, 12_000),
          truncated: snapshot.truncated
        };
      },
      pageFind: async (query) => (await this.requireFastPage(workerId)).find(query),
      pageClick: async (ref) => (await this.requireFastPage(workerId)).click(ref),
      pageFill: async (ref, value) => (await this.requireFastPage(workerId)).fill(ref, value),
      pagePress: async (key, ref) => (await this.requireFastPage(workerId)).press(key, ref),
      pageScroll: async (delta) => (await this.requireFastPage(workerId)).scroll(delta),
      pageBack: async () => (await this.requireFastPage(workerId)).back(),
      pageWaitFor: async (needle) => (await this.requireFastPage(workerId)).waitForText(needle, 0, activeSignal()),
      pageTabs: async () => (await this.requireFastPage(workerId)).listTabs(),
      pageSwitchTab: async (tabId) => (await this.requireFastPage(workerId)).switchTab(tabId),
      pageCloseTab: async (tabId) => (await this.requireFastPage(workerId)).closeTab(tabId),
      pageText: async (maxCharacters) => (await this.requireFastPage(workerId)).readableText(maxCharacters),
      pageScreenshot: async (destination) => {
        const engine = await this.requireFastPage(workerId);
        const image = await engine.screenshot();
        if (!image.length) throw new Error('The page returned an empty screenshot.');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, image);
        return { path: destination, bytes: image.length };
      },
      pageEvaluate: async (expression, resultId, offset, destination) => (await this.requireFastPage(workerId)).evaluateForWorker(expression, resultId, offset, destination),
      pageConsole: async (options) => (await this.requireFastPage(workerId)).consoleMessages(options),
      pageNetwork: async (options) => (await this.requireFastPage(workerId)).networkRequests(options),
      pageHover: async (ref) => (await this.requireFastPage(workerId)).hover(ref),
      pageClickWith: async (ref, options) => (await this.requireFastPage(workerId)).clickWith(ref, options),
      pageDrag: async (fromRef, toRef) => (await this.requireFastPage(workerId)).drag(fromRef, toRef),
      pageResize: async (width, height, mobile) => (await this.requireFastPage(workerId)).resizeViewport(width, height, mobile),
      pageSavePdf: async (destination) => (await this.requireFastPage(workerId)).savePdf(destination),
      pageUpload: async (ref, filePath) => (await this.requireFastPage(workerId)).uploadFile(ref, filePath),
      pageExtract: async (rowSelector, fields) => (await this.requireFastPage(workerId)).extract(rowSelector, fields),
      pageWaitForIdle: async (quietMillis, timeoutMs) => (await this.requireFastPage(workerId)).waitForIdle(quietMillis, timeoutMs, activeSignal()),
      pageClickAndWait: async (ref, waitFor) => (await this.requireFastPage(workerId)).clickAndWait(ref, waitFor, activeSignal()),
      pageFillForm: async (fields) => (await this.requireFastPage(workerId)).fillForm(fields),
      pageExtensions: async () => {
        const engine = await this.requireFastPage(workerId);
        const [open, installed] = await Promise.all([engine.listExtensionViews(), engine.listInstalledExtensions()]);
        return { openWindows: open, installed: installed.extensions };
      },
      pageFocusExtension: async (viewId) => (await this.requireFastPage(workerId)).focusExtensionView(viewId),
      browserOpen: async (url) => foreground(async () => {
        if (this.browser.hasSession(workerId)) {
          const current = await this.browser.pageIdentity(workerId).catch(() => null);
          if (current) {
            await this.browser.show(workerId).catch(() => undefined);
            if (await this.focusWorkerBrowserWindow(workerId, current.url, current.title)) {
              await this.desktop.sendKey('CTRL_L', '^l');
              await this.desktop.sendText(url);
              await this.desktop.sendKey('ENTER', '{ENTER}');
              this.browser.noteVisibleNavigation(workerId, url, current.title);
              await settle(1_200);
              return { url, title: current.title || 'Default browser' };
            }
          }
        }
        const page = await this.browser.open(workerId, url);
        await settle(1_500);
        return { url: page.url, title: page.title };
      }),
      readForeground: async () => foreground(async () => {
        const snapshot = await readableControls();
        refuseOwnWindow(snapshot.root?.processId);
        const visible = snapshot.elements.filter((element) => !element.offscreen && (element.name || element.value));
        const controls = visible
          .filter((element) => element.name || element.value)
          .map((element) => ({
            name: element.name.slice(0, 200),
            type: element.controlType,
            ...(element.value ? { value: element.value.slice(0, 300) } : {})
          }));
        const seen = new Set<string>();
        const text = visible
          .map((element) => element.name.trim())
          .filter((name) => name.length > 1 && !seen.has(name) && seen.add(name))
          .join('\n');
        return { window: snapshot.root?.name || 'The window in front', text, controls };
      }),
      checkScreen: async (assertion: string) => {
        const capture = await this.desktop.capturePrimaryScreen();
        const response = await this.askVisionModel(workerId, [
          'Answer one question about what is on this screen right now.',
          `Question: ${assertion}`,
          'Return strict JSON only: {"passed":true|false,"observation":"what you can actually see"}.',
          'Report only what the question asked about. Do not suggest a next step.'
        ].join('\n\n'), capture.png, activeSignal());
        const decision = parseModelJson<{ passed?: unknown; observation?: unknown }>(response, 'check_screen answer');
        return {
          passed: decision.passed === true,
          observation: String(decision.observation ?? '').trim().slice(0, 400)
        };
      },
      clickByName: async (name) => foreground(async () => {
        await foregroundIsOwnWindow();
        try {
          await this.desktop.semanticInvoke({ name });
        } catch {
          try {
            await this.desktop.semanticInvoke({ nameContains: name });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(/ambiguous/i.test(detail)
              ? `Several things on screen are called "${name}". Call read_screen and use the fuller wording of the one you want.`
              : `Nothing on screen is called "${name}". Call read_screen and click one of the control names it lists, spelled exactly.`);
          }
        }
        await settle(900);
        return { clicked: name };
      }),
      typeByName: async (text, into) => foreground(async () => {
        await foregroundIsOwnWindow();
        if (into) {
          try {
            await this.desktop.semanticSetValue({ name: into }, text);
          } catch {
            try {
              await this.desktop.semanticSetValue({ nameContains: into }, text);
            } catch {
              await this.desktop.semanticInvoke({ nameContains: into }).catch(() => undefined);
              await this.desktop.sendText(text);
            }
          }
          await settle(400);
          return { typed: text, into };
        }
        await this.desktop.sendText(text);
        await settle(400);
        return { typed: text };
      }),
      pressKey: async (key) => foreground(async () => {
        await foregroundIsOwnWindow();
        const canonical = String(key).trim().toUpperCase().replace(/[\s+-]+/g, '_');
        let sendKeys = '';
        try {
          sendKeys = this.desktopKeySequence(canonical);
        } catch {
          throw new Error(`"${key}" is not a key this computer accepts. Use one of Enter, Tab, Escape, Backspace, Delete, Up, Down, Left, Right, PageUp, PageDown, Home, End, ${process.platform === 'win32' ? 'F5, Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+S' : `a letter, or a combination such as ${process.platform === 'darwin' ? 'Cmd+N, Cmd+S or Cmd+Shift+N' : 'Ctrl+N, Ctrl+S or Ctrl+Shift+N'}`}.`);
        }
        await this.desktop.sendKey(canonical, sendKeys);
        await settle(700);
        return { pressed: canonical };
      }),
      scrollForeground: async (delta) => foreground(async () => {
        await this.desktop.scroll(delta * 120);
        await settle(500);
        return { scrolled: delta };
      }),
      screenshot: async (destination) => foreground(async () => {
        const capture = await this.desktop.capturePrimaryScreen();
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.writeFile(destination, capture.png);
        const written = await fsp.stat(destination);
        if (!written.size) throw new Error('The screenshot came out empty. Try take_screenshot again.');
        return { path: destination, bytes: written.size, width: capture.imageWidth, height: capture.imageHeight };
      }),
      listWindows: async () => {
        if (process.platform !== 'win32') {
          const listed = await this.desktop.listWindows().catch(() => null) as { windows?: Array<Record<string, unknown>> } | null;
          return (listed?.windows ?? [])
            .map((item) => ({ title: String(item.title ?? ''), process: String(item.processName ?? '') }))
            .filter((item) => item.title);
        }
        const result = await promisify(execFile)('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress"
        ], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
        const parsed = ((): Array<Record<string, unknown>> => {
          try {
            const value = JSON.parse(String(result.stdout).trim() || '[]');
            return Array.isArray(value) ? value : [value];
          } catch {
            return [];
          }
        })();
        return parsed
          .map((item) => ({ title: String(item.MainWindowTitle ?? ''), process: String(item.ProcessName ?? '') }))
          .filter((item) => item.title);
      },
      focusWindow: async (title) => foreground(async () => {
        try {
          await this.desktop.windowsAutomation('focusWindow', { title });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (/ambiguous/i.test(detail)) {
            throw new Error(`More than one window matches "${title}". Call list_windows and use the full title of the one you want.`);
          }
          if (process.platform === 'darwin' && detail.trim() && !/no window matching/i.test(detail)) {
            throw new Error(`"${title}" could not be brought to the front: ${detail}`);
          }
          throw new Error(`No open window matches "${title}". Call list_windows to see what is actually open, or open_app to start the program.`);
        }
        await settle(800);
        return { focused: title };
      }),
      launchApp: async (fileName, args) => foreground(async () => {
        if (process.platform === 'darwin') {
          const launched = await macLaunchApp(fileName, args ?? '').catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`${fileName} could not be started (${detail}). Use the application's real name, such as TextEdit, Safari, Calculator, or its full path.`);
          });
          await settle(2_000);
          return { launched: launched.launched, processId: launched.processId };
        }
        if (process.platform === 'linux') {
          const launched = await linuxLaunchApp(fileName, args ?? '').catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`${fileName} could not be started (${detail}). Use the application's real name, such as Text Editor, Files, Calculator, or its full path.`);
          });
          await settle(2_000);
          return { launched: launched.launched, processId: launched.processId };
        }
        const launched = await this.desktop.launch(fileName, args ?? '').catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`${fileName} could not be started (${detail}). Use the program's real name, such as notepad, calc, mspaint, or its full path.`);
        });
        await settle(2_000);
        return { launched: fileName, processId: launched.processId };
      })
    };
  }

  private desktopKeySequence(key: string) {
    const keys: Record<string, string> = {
      ENTER: '{ENTER}', TAB: '{TAB}', ESCAPE: '{ESC}', BACKSPACE: '{BACKSPACE}', DELETE: '{DELETE}',
      UP: '{UP}', DOWN: '{DOWN}', LEFT: '{LEFT}', RIGHT: '{RIGHT}', PAGEUP: '{PGUP}', PAGEDOWN: '{PGDN}',
      HOME: '{HOME}', END: '{END}', CTRL_A: '^a', CTRL_C: '^c', CTRL_V: '^v', CTRL_L: '^l',
      F5: '{F5}', ALT_LEFT: '%{LEFT}', CTRL_S: '^s', CTRL_Z: '^z', CTRL_Y: '^y', CTRL_ESC: '^{ESC}', ALT_TAB: '%{TAB}'
    };
    const result = keys[key.toUpperCase()];
    if (result) return result;
    if (process.platform !== 'win32' && this.posixPressableKey(key)) return '';
    throw new Error(`Unsupported computer key: ${key}`);
  }

  private posixPressableKey(key: string) {
    const parts = String(key).toUpperCase().split(/[+_\s-]+/).filter(Boolean);
    if (!parts.length) return false;
    const named = new Set([
      'ENTER', 'RETURN', 'TAB', 'SPACE', 'DELETE', 'BACKSPACE', 'ESCAPE', 'ESC',
      'LEFT', 'RIGHT', 'UP', 'DOWN', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
      'INSERT', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
    ]);
    const modifiers = new Set(['CMD', 'COMMAND', 'META', 'SUPER', 'CTRL', 'CONTROL', 'ALT', 'OPTION', 'SHIFT']);
    const target = parts[parts.length - 1];
    if (!named.has(target) && !/^[A-Z]$/.test(target)) return false;
    return parts.slice(0, -1).every((part) => modifiers.has(part));
  }
}
