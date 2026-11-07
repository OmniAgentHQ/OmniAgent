import { app, desktopCapturer, screen } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NativeAutomationClient, type NativeAutomationSnapshot } from './nativeAutomation';
import type { LinuxPermissionStatus } from './platform/linux/permissions';
import type { AutomationAction, Postcondition, SemanticTarget } from './automationContracts';

export type DesktopEvent = {
  type: 'window' | 'click' | 'key' | 'text' | 'scroll';
  offsetMs: number;
  process?: string;
  windowTitle?: string;
  button?: 'left' | 'right';
  x?: number;
  y?: number;
  sendKeys?: string;
  text?: string;
  delta?: number;
  redacted?: boolean;
};

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'input-helper.ps1')
    : path.join(__dirname, '../electron/input-helper.ps1');
}

export class DesktopAutomationService {
  private native = new NativeAutomationClient();

  async inputPermissionStatus(): Promise<LinuxPermissionStatus | null> {
    if (process.platform !== 'linux') return null;
    try {
      return await this.native.call<LinuxPermissionStatus>('input.permissionStatus', {}, 10_000);
    } catch {
      return null;
    }
  }

  async requestInputPermission(): Promise<LinuxPermissionStatus | null> {
    if (process.platform !== 'linux') return null;
    try {
      return await this.native.call<LinuxPermissionStatus>('input.requestPermission', {}, 180_000);
    } catch (error) {
      const status = await this.inputPermissionStatus();
      if (status?.granted) return status;
      const detail = error instanceof Error ? error.message : String(error);
      return { ...(status ?? { route: 'portal', granted: false, needsGrant: true, capture: '' }), detail };
    }
  }

  private powershellJson<T>(script: string): Promise<T | null> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.once('error', () => resolve(null));
      child.once('exit', () => {
        try {
          resolve(JSON.parse(out.trim() || 'null') as T);
        } catch {
          resolve(null);
        }
      });
    });
  }

  private async windowsAutomationSnapshot(
    maxElements: number,
    window?: { processId?: number }
  ): Promise<NativeAutomationSnapshot | null> {
    const processId = Number(window?.processId || (await this.foregroundWindow())?.processId || 0);
    if (!processId) return null;
    const limit = Math.max(1, Math.min(1_000, Math.round(maxElements)));
    const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$targetPid = ${processId}
$limit = ${limit}
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if ($null -eq $window) { [Console]::Out.Write('null'); exit 0 }
function Convert-Element($element) {
  $current = $element.Current
  $bounds = $current.BoundingRectangle
  $value = ''
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $pattern) { $value = $pattern.Current.Value }
  } catch {}
  return [ordered]@{
    parentIndex = -1
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    className = [string]$current.ClassName
    controlType = [string]$current.ControlType.ProgrammaticName
    processId = [int]$current.ProcessId
    enabled = [bool]$current.IsEnabled
    offscreen = [bool]$current.IsOffscreen
    focusable = [bool]$current.IsKeyboardFocusable
    focused = [bool]$current.HasKeyboardFocus
    password = [bool]$current.IsPassword
    helpText = [string]$current.HelpText
    accessKey = [string]$current.AccessKey
    value = [string]$value
    selected = $false
    checked = $false
    expanded = $false
    bounds = [ordered]@{ x = [double]$bounds.X; y = [double]$bounds.Y; width = [double]$bounds.Width; height = [double]$bounds.Height }
    patterns = @()
  }
}
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$elements = New-Object System.Collections.Generic.List[object]
for ($index = 0; $index -lt $all.Count -and $index -lt $limit; $index++) {
  try { $elements.Add((Convert-Element $all.Item($index))) } catch {}
}
$payload = [ordered]@{
  root = Convert-Element $window
  elements = @($elements)
  truncated = ($all.Count -gt $limit)
}
[Console]::Out.Write(($payload | ConvertTo-Json -Depth 8 -Compress))`;
    return this.powershellJson<NativeAutomationSnapshot>(script);
  }

  private async fallbackElement(name: string) {
    const snapshot = await this.windowsAutomationSnapshot(500);
    const wanted = name.trim().toLocaleLowerCase();
    const visible = snapshot?.elements.filter((element) => !element.offscreen && element.bounds.width > 0 && element.bounds.height > 0) ?? [];
    return visible.find((element) => element.name.trim().toLocaleLowerCase() === wanted)
      ?? visible.find((element) => element.name.trim().toLocaleLowerCase().includes(wanted));
  }

  private async waitForForegroundLease(minimumPhysicalIdleMs = 900, timeoutMs = 300_000) {
    if (!this.native.installed) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const activity = await this.native.lastInputActivity();
      if (activity.source === 'automation' || activity.millisecondsAgo >= minimumPhysicalIdleMs) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(150, minimumPhysicalIdleMs - activity.millisecondsAgo)));
    }
    throw new Error('Desktop automation paused because the user continued using the physical keyboard or pointer.');
  }

  get nativeInstalled() {
    return this.native.installed;
  }

  async authorizeRoot(root: string) {
    return this.native.authorizeRoot(root);
  }

  private async foregroundScope() {
    const handle = await this.lookupHandle();
    return handle ? { window: { handle } } : {};
  }

  private async lookupHandle(window?: { title?: string; processId?: number }) {
    if (process.platform !== 'win32') return undefined;
    try {
      if (!window?.title && !window?.processId) return (await this.foregroundWindow())?.handle;
      const listed = await this.native.listWindows() as {
        windows?: Array<{ handle?: string; title?: string; processId?: number }>;
      };
      const wanted = String(window.title ?? '').toLowerCase();
      const match = (listed.windows ?? []).find((entry) => (
        (window.processId ? Number(entry.processId) === Number(window.processId) : false)
        || (wanted ? String(entry.title ?? '').toLowerCase().includes(wanted) : false)
      ));
      return match?.handle;
    } catch {
      return undefined;
    }
  }

  async semanticSnapshot(
    maxElements = 300,
    window?: { handle?: string; title?: string; processId?: number }
  ): Promise<NativeAutomationSnapshot | null> {
    if (!this.native.installed) return null;
    const plain = window?.title || window?.processId
      ? { title: window.title, processId: window.processId }
      : undefined;
    const targets: Array<{ handle?: string; title?: string; processId?: number } | undefined> = [];
    if (window?.handle) targets.push({ handle: window.handle });
    const looked = await this.lookupHandle(plain);
    if (looked && looked !== window?.handle) targets.push({ handle: looked });
    if (plain) targets.push(plain);
    if (!targets.length) targets.push(undefined);

    let failure: unknown;
    for (const target of targets) {
      try {
        return await this.native.snapshot({ maxDepth: 8, maxElements, ...(target ? { window: target } : {}) });
      } catch (error) {
        failure = error;
      }
    }
    const fallback = await this.windowsAutomationSnapshot(maxElements, plain);
    if (fallback?.elements.length) return fallback;
    throw failure ?? new Error('That window could not be read.');
  }

  async foregroundWindow(): Promise<{ title: string; processId: number; handle?: string } | null> {
    if (process.platform === 'darwin') {
      try {
        const front = await this.native.foregroundWindow();
        return front?.processId ? { title: front.title || '', processId: Number(front.processId) } : null;
      } catch {
        return null;
      }
    }
    const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OsFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$h = [OsFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[void][OsFg]::GetWindowTextW($h, $sb, $sb.Capacity)
$pid2 = 0
[void][OsFg]::GetWindowThreadProcessId($h, [ref]$pid2)
[Console]::Out.Write((ConvertTo-Json -Compress @{ title = $sb.ToString(); processId = $pid2; handle = $h.ToInt64().ToString() }))`;

    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += String(chunk); });
      child.once('error', () => resolve(null));
      child.once('exit', () => {
        try {
          const parsed = JSON.parse(out.trim() || '{}') as { title?: string; processId?: number; handle?: string };
          resolve(parsed.title ? {
            title: parsed.title,
            processId: Number(parsed.processId || 0),
            ...(parsed.handle && parsed.handle !== '0' ? { handle: parsed.handle } : {})
          } : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  async semanticInvoke(selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string }) {
    try {
      return await this.native.invoke({ ...(await this.foregroundScope()), selector, timeoutMs: 5_000 });
    } catch (error) {
      const name = selector.name ?? selector.nameContains;
      if (!name) throw error;
      const element = await this.fallbackElement(name);
      if (!element) throw error;
      await this.native.click(
        Math.round(element.bounds.x + element.bounds.width / 2),
        Math.round(element.bounds.y + element.bounds.height / 2)
      );
      return { invoked: true, fallback: 'uia-bounds' };
    }
  }

  async semanticSetValue(
    selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string },
    value: string
  ) {
    try {
      return await this.native.setValue({ ...(await this.foregroundScope()), selector, value, timeoutMs: 5_000 });
    } catch (error) {
      const name = selector.name ?? selector.nameContains;
      if (!name) throw error;
      const element = await this.fallbackElement(name);
      if (!element) throw error;
      await this.native.click(
        Math.round(element.bounds.x + element.bounds.width / 2),
        Math.round(element.bounds.y + element.bounds.height / 2)
      );
      await this.native.sendKey('CTRL_A');
      await this.native.sendText(value);
      return { set: true, value, fallback: 'uia-bounds' };
    }
  }

  async semanticSelect(selector: { name?: string; nameContains?: string; automationId?: string; className?: string; controlType?: string }) {
    try {
      return await this.native.select({ ...(await this.foregroundScope()), selector, timeoutMs: 5_000 });
    } catch {
      return this.semanticInvoke(selector);
    }
  }

  private nativeTarget(target: SemanticTarget | undefined) {
    if (!target) return { selector: {}, selection: 'exact' };
    const state = target.match.state ?? {};
    const selector: Record<string, unknown> = {
      ...(target.match.name ? { name: target.match.name } : {}),
      ...(target.match.nameContains ? { nameContains: target.match.nameContains } : {}),
      ...(target.match.automationId ? { automationId: target.match.automationId } : {}),
      ...(target.match.className ? { className: target.match.className } : {}),
      ...(target.match.controlType || target.match.role ? { controlType: target.match.controlType ?? target.match.role } : {}),
      ...(target.scope.processId ? { processId: target.scope.processId } : {}),
      ...(state.enabled !== undefined ? { enabled: state.enabled } : {}),
      ...(state.visible !== undefined ? { offscreen: !state.visible } : {}),
      ...(state.selected !== undefined ? { selected: state.selected } : {}),
      ...(state.checked !== undefined ? { checked: state.checked } : {}),
      ...(state.expanded !== undefined ? { expanded: state.expanded } : {})
    };
    if (target.relativeTo && ['inside', 'descendant', 'child'].includes(target.relativeTo.relation)) {
      selector.ancestor = target.relativeTo.match;
    }
    return {
      window: target.scope.windowTitle || target.scope.processId
        ? { title: target.scope.windowTitle, processId: target.scope.processId }
        : undefined,
      selector,
      selection: target.selection,
      index: target.index
    };
  }

  async executeAutomation(action: AutomationAction, value?: unknown) {
    if (!this.native.installed) throw new Error('Universal desktop automation requires the OmniAgent Python runtime.');
    if (action.operation === 'launch') {
      const argumentsValue = Array.isArray(action.options.arguments)
        ? action.options.arguments.map((item) => {
          const argument = String(item);
          return /\s|"/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
        }).join(' ')
        : String(action.options.arguments ?? '');
      return this.native.launch({
        fileName: String(value ?? action.options.fileName ?? ''),
        arguments: argumentsValue,
        workingDirectory: action.options.workingDirectory
      });
    }
    await this.waitForForegroundLease();
    if (!action.target && action.options.coordinateFallback === true) {
      const x = Number(action.options.x);
      const y = Number(action.options.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
        throw new Error('Coordinate fallback requires validated non-negative x and y values.');
      }
      if (['click', 'doubleClick', 'contextClick'].includes(action.operation)) {
        return this.native.click(Math.round(x), Math.round(y), action.operation === 'contextClick' ? 'right' : 'left', action.operation === 'doubleClick');
      }
      if (['fill', 'type'].includes(action.operation)) {
        await this.native.click(Math.round(x), Math.round(y));
        if (action.operation === 'fill') await this.native.sendKey('CTRL_A');
        return this.native.sendText(String(value ?? ''));
      }
    }
    if (action.operation === 'move' || action.operation === 'resize') {
      return this.native.moveResizeWindow({
        ...this.nativeTarget(action.target).window,
        x: action.options.x,
        y: action.options.y,
        width: action.options.width,
        height: action.options.height
      });
    }
    if (action.operation === 'scroll' && !action.target) {
      return this.native.scroll(Number(value ?? action.options.delta ?? 0));
    }
    if (action.operation === 'query') {
      return this.native.query({ ...this.nativeTarget(action.target), timeoutMs: Number(action.options.timeoutMs || 5_000) });
    }
    const operation = action.operation === 'selectOption' ? 'select' : action.operation;
    return this.native.perform({
      ...this.nativeTarget(action.target),
      operation,
      value,
      options: action.options,
      timeoutMs: Number(action.options.timeoutMs || 5_000)
    });
  }

  async verifyAutomation(condition: Postcondition, expected?: unknown) {
    if (!this.native.installed) throw new Error('Universal desktop verification requires the OmniAgent Python runtime.');
    const deadline = Date.now() + condition.timeoutMs;
    let result: { passed: boolean; actual?: unknown; count: number } = { passed: false, count: 0 };
    do {
      result = await this.native.assert({
        ...this.nativeTarget(condition.target),
        assertion: condition.assertion,
        expected,
        timeoutMs: 0
      });
      if (result.passed) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() <= deadline);
    throw new Error(condition.message || `Desktop verification failed: ${condition.assertion}.`);
  }

  async filesystemAutomation<T = unknown>(operation: string, parameters: Record<string, unknown>) {
    return this.native.filesystem<T>(operation, parameters);
  }

  async listWindows() {
    return this.native.listWindows();
  }

  async windowsAutomation(operation: string, parameters: Record<string, unknown>) {
    if (!this.native.installed) throw new Error('Universal window automation requires the OmniAgent Python runtime.');
    if (operation === 'listWindows') return this.native.listWindows();
    if (operation === 'focusWindow') return this.native.focusWindow(parameters);
    if (operation === 'minimize' || operation === 'maximize') {
      return this.native.showWindowState({ ...parameters, state: operation });
    }
    if (operation === 'move' || operation === 'resize') return this.native.moveResizeWindow(parameters);
    throw new Error(`Unsupported window operation: ${operation}.`);
  }

  async launch(fileName: string, args = '', workingDirectory?: string) {
    if (!this.native.installed) throw new Error('Starting a program requires the OmniAgent Python runtime.');
    return this.native.launch({ fileName, arguments: args, ...(workingDirectory ? { workingDirectory } : {}) }) as Promise<{ processId?: number; started?: boolean }>;
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left', double = false) {
    if (this.native.installed) {
      await this.waitForForegroundLease();
      return this.native.click(x, y, button, double);
    }
    const click: DesktopEvent = { type: 'click', offsetMs: 0, x, y, button };
    return this.replay(double ? [click, { ...click, offsetMs: 120 }] : [click], path.join(app.getPath('userData'), 'cache', 'agent-actions'));
  }

  async sendText(text: string) {
    if (this.native.installed) {
      await this.waitForForegroundLease();
      return this.native.sendText(text);
    }
    return this.replay([{ type: 'text', offsetMs: 0, text }], path.join(app.getPath('userData'), 'cache', 'agent-actions'));
  }

  async sendKey(key: string, fallbackSendKeys: string) {
    if (this.native.installed) {
      await this.waitForForegroundLease();
      return this.native.sendKey(key);
    }
    return this.replay([{ type: 'key', offsetMs: 0, sendKeys: fallbackSendKeys, redacted: false }], path.join(app.getPath('userData'), 'cache', 'agent-actions'));
  }

  async scroll(delta: number) {
    if (this.native.installed) {
      await this.waitForForegroundLease();
      return this.native.scroll(delta);
    }
    return this.replay([{ type: 'scroll', offsetMs: 0, delta }], path.join(app.getPath('userData'), 'cache', 'agent-actions'));
  }

  async replay(events: DesktopEvent[], tempDirectory: string) {
    fs.mkdirSync(tempDirectory, { recursive: true });
    const tracePath = path.join(tempDirectory, `replay-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tracePath, JSON.stringify(events), 'utf8');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath(), '-ReplayFile', tracePath], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', (data) => { stderr += String(data); });
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `Desktop replay exited with code ${code ?? 'unknown'}.`));
        });
      });
    } finally {
      fs.rmSync(tracePath, { force: true });
    }
  }

  async capturePrimaryScreen() {
    const display = screen.getPrimaryDisplay();
    const width = Math.min(1920, Math.max(1, display.size.width));
    const height = Math.max(1, Math.round(width * (display.size.height / display.size.width)));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
      fetchWindowIcons: false
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('OmniAgent could not inspect the primary display.');
    const imageSize = source.thumbnail.getSize();
    return {
      png: source.thumbnail.toPNG(),
      jpg: source.thumbnail.resize({ width: Math.min(1280, imageSize.width) }).toJPEG(65),
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      screenX: display.bounds.x,
      screenY: display.bounds.y,
      screenWidth: display.bounds.width,
      screenHeight: display.bounds.height
    };
  }

  closeAll() {
    void this.native.close();
  }
}
