import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ProviderRuntimeInstaller, RUNTIME_LABELS, claudePlatform, codexTarget, type ProviderRuntimeId, type RuntimeProgress, type RuntimeRelease } from './providerInstaller';

export type RuntimeDetails = {
  runtime: ProviderRuntimeId;
  label: string;
  installed: boolean;
  path: string;
  version?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  error?: string;
  override: boolean;
};

function runtimeVersion(text: string): string | undefined {
  const client = text.match(/client version is\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i);
  return client?.[1] ?? text.match(/(\d+\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1];
}

function newerRuntimeVersion(latest: string, installed: string) {
  const a = latest.split(/[.-]/).slice(0, 3).map(Number);
  const b = installed.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return !latest.includes('-') && installed.includes('-');
}

export function isExecutableFile(file: string | undefined): boolean {
  if (!file) return false;
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function managedRuntimePath(root: string, runtime: ProviderRuntimeId): string | undefined {
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, `${runtime}-active.json`), 'utf8')) as { path?: string };
    if (!pointer.path) return;
    const target = path.resolve(root, pointer.path);
    const allowed = path.resolve(root, 'updates', runtime) + path.sep;
    if (!target.startsWith(allowed) || !isExecutableFile(target)) return;
    return target;
  } catch { return; }
}

async function inspectRuntimeVersion(executable: string): Promise<string> {
  const script = executable.toLowerCase().endsWith('.js');
  const command = script ? process.execPath : executable;
  const args = script ? [executable, '--version'] : ['--version'];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: script ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Runtime version check timed out.')); }, 10_000);
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { clearTimeout(timer); reject(new Error('This runtime could not be started on this computer.')); });
    child.once('close', code => {
      clearTimeout(timer);
      const version = runtimeVersion(output);
      if (code !== 0 || !version) reject(new Error('This runtime did not report a valid version.'));
      else resolve(version);
    });
  });
}

async function releaseFetch(url: string) {
  const response = await fetch(url, { headers: { 'User-Agent': 'OmniAgent' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Update check failed (${response.status}). Try again later.`);
  return response;
}

async function latestRuntimeRelease(runtime: ProviderRuntimeId): Promise<RuntimeRelease> {
  if (runtime === 'claude') {
    const version = (await (await releaseFetch('https://downloads.claude.ai/claude-code-releases/latest')).text()).trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Claude returned an invalid release version.');
    const manifest = await (await releaseFetch(`https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`)).json() as { platforms?: Record<string, { checksum?: string }> };
    const checksum = manifest.platforms?.[claudePlatform()]?.checksum;
    if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('No verified Claude release is available for this platform.');
    return { version, checksum, url: `https://downloads.claude.ai/claude-code-releases/${version}/${claudePlatform()}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}` };
  }
  const repository = 'openai/codex';
  const release = await (await releaseFetch(`https://api.github.com/repos/${repository}/releases/latest`)).json() as {
    tag_name: string; assets: Array<{ name: string; browser_download_url: string; digest?: string }>;
  };
  const version = runtimeVersion(release.tag_name);
  if (!version) throw new Error('The provider returned an invalid release version.');
  const assetName = `codex-package-${codexTarget()}.tar.gz`;
  const asset = release.assets.find(item => item.name === assetName);
  if (!asset) throw new Error(`No ${RUNTIME_LABELS[runtime]} release is available for this platform.`);
  const expectedPrefix = `https://github.com/${repository}/releases/download/`;
  if (!asset.browser_download_url.startsWith(expectedPrefix)) throw new Error('Unexpected provider download location.');
  const checksum = asset.digest?.replace(/^sha256:/, '');
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('The provider has not published a checksum for this download. Try again later.');
  return { version, url: asset.browser_download_url, checksum };
}

export class ProviderRuntimeUpdates {
  private active = new Map<ProviderRuntimeId, Promise<string>>();
  private controllers = new Map<ProviderRuntimeId, AbortController>();
  private checked = new Map<ProviderRuntimeId, { release: RuntimeRelease; at: string }>();

  constructor(private root: string, private executable: (runtime: ProviderRuntimeId) => string) {}

  async details(checkLatest = false): Promise<RuntimeDetails[]> {
    return Promise.all((['codex', 'claude'] as const).map(async runtime => {
      const executable = this.executable(runtime);
      const detail: RuntimeDetails = {
        runtime, label: RUNTIME_LABELS[runtime], path: executable,
        installed: isExecutableFile(executable), updateAvailable: false,
        override: Boolean(process.env[`OMNIAGENT_${runtime.toUpperCase()}_PATH`])
      };
      if (detail.installed) {
        try { detail.version = await inspectRuntimeVersion(executable); }
        catch { detail.error = 'The installed runtime could not report its version. You can reinstall the latest release.'; }
      }
      if (checkLatest) {
        try { this.checked.set(runtime, { release: await latestRuntimeRelease(runtime), at: new Date().toISOString() }); }
        catch (error) {
          this.checked.delete(runtime);
          detail.error = error instanceof Error ? error.message : 'Could not check for updates.';
        }
      }
      const checked = this.checked.get(runtime);
      detail.latestVersion = checked?.release.version;
      detail.checkedAt = checked?.at;
      detail.updateAvailable = Boolean(checked && (!detail.version || newerRuntimeVersion(checked.release.version, detail.version)));
      return detail;
    }));
  }

  update(runtime: ProviderRuntimeId, onProgress?: (progress: RuntimeProgress) => void): Promise<string> {
    const active = this.active.get(runtime);
    if (active) return active;
    const controller = new AbortController();
    this.controllers.set(runtime, controller);
    const job = this.runUpdate(runtime, onProgress, controller.signal).finally(() => { this.active.delete(runtime); this.controllers.delete(runtime); });
    this.active.set(runtime, job);
    return job;
  }

  cancel(runtime: ProviderRuntimeId) { this.controllers.get(runtime)?.abort(); }

  private activeGeneration(runtime: ProviderRuntimeId) {
    const target = managedRuntimePath(this.root, runtime);
    if (!target) return undefined;
    const base = path.resolve(this.root, 'updates', runtime) + path.sep;
    const resolved = path.resolve(target);
    if (!resolved.startsWith(base)) return undefined;
    const [first] = resolved.slice(base.length).split(path.sep);
    return first ? path.resolve(base, first) : undefined;
  }

  private async pruneGenerations(runtime: ProviderRuntimeId, keep: string | undefined) {
    if (!keep) return;
    const directory = path.resolve(this.root, 'updates', runtime);
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.resolve(directory, entry.name);
      if (candidate === keep) continue;
      await fs.promises.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runUpdate(runtime: ProviderRuntimeId, onProgress?: (progress: RuntimeProgress) => void, signal?: AbortSignal) {
    if (process.env[`OMNIAGENT_${runtime.toUpperCase()}_PATH`]) throw new Error(`Remove OMNIAGENT_${runtime.toUpperCase()}_PATH to use managed runtime updates.`);
    onProgress?.({ runtime, percent: 0, status: 'Checking the latest release' });
    const release = await latestRuntimeRelease(runtime);
    signal?.throwIfAborted();
    const at = new Date().toISOString();
    this.checked.set(runtime, { release, at });
    const existing = this.executable(runtime);
    if (isExecutableFile(existing)) {
      const current = await inspectRuntimeVersion(existing).catch(() => undefined);
      if (current && !newerRuntimeVersion(release.version, current)) {
        onProgress?.({ runtime, percent: 100, status: `${RUNTIME_LABELS[runtime]} ${current} is up to date` });
        await this.pruneGenerations(runtime, this.activeGeneration(runtime));
        return existing;
      }
    }
    const generation = path.resolve(this.root, 'updates', runtime, `${release.version}-${crypto.randomUUID()}`);
    const allowed = path.resolve(this.root, 'updates', runtime) + path.sep;
    if (!generation.startsWith(allowed)) throw new Error('Invalid runtime installation path.');
    const installer = new ProviderRuntimeInstaller(generation);
    let published = false;
    const pointerTemp = path.join(this.root, `${runtime}-active-${crypto.randomUUID()}.tmp`);
    try {
      const executable = await installer.install(runtime, progress => onProgress?.({ ...progress, percent: Math.min(95, progress.percent) }), { ...release, signal });
      signal?.throwIfAborted();
      onProgress?.({ runtime, percent: 97, status: 'Verifying the installed runtime' });
      const actual = await inspectRuntimeVersion(executable);
      signal?.throwIfAborted();
      if (actual !== release.version) throw new Error('The downloaded runtime did not match the expected version.');
      await fs.promises.writeFile(pointerTemp, JSON.stringify({ path: path.relative(this.root, executable), version: actual, updatedAt: at }), 'utf8');
      await fs.promises.rename(pointerTemp, path.join(this.root, `${runtime}-active.json`));
      published = true;
      onProgress?.({ runtime, percent: 100, status: `${RUNTIME_LABELS[runtime]} ${actual} is ready` });
      return executable;
    } finally {
      await fs.promises.rm(pointerTemp, { force: true }).catch(() => undefined);
      if (!published) await fs.promises.rm(generation, { recursive: true, force: true }).catch(() => undefined);
      else await this.pruneGenerations(runtime, generation);
    }
  }
}
