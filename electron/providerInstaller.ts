import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_RUNTIMES } from './providerTraits';

export type ProviderRuntimeId = 'claude' | 'codex';
export type RuntimeRelease = { version: string; url: string; checksum?: string; signal?: AbortSignal };

export type RuntimeProgress = {
  runtime: ProviderRuntimeId;
  percent: number;
  status: string;
  receivedBytes?: number;
  totalBytes?: number;
};

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const IS_POSIX = IS_MAC || IS_LINUX;
const TAR = IS_POSIX
  ? 'tar'
  : [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')].find((candidate) => fs.existsSync(candidate)) ?? 'tar.exe';

type BundledAreInstallable = (typeof BUNDLED_RUNTIMES)[number] extends ProviderRuntimeId ? true : never;
export type { BundledAreInstallable };

export const RUNTIME_LABELS: Record<ProviderRuntimeId, string> = {
  claude: 'Claude',
  codex: 'ChatGPT'
};

export const RUNTIME_OWNER: Record<ProviderRuntimeId, 'OpenAI' | 'Claude'> = {
  codex: 'OpenAI',
  claude: 'Claude'
};

function architectureTag(arch = process.arch) {
  return arch === 'arm64' ? 'aarch64' : 'x86_64';
}

export function claudePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
}

export function codexTarget(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch) {
  if (platform === 'darwin') return `${architectureTag(arch)}-apple-darwin`;
  if (platform === 'linux') return `${architectureTag(arch)}-unknown-linux-musl`;
  return `${architectureTag(arch)}-pc-windows-msvc`;
}

export function runtimeExecutablePath(root: string, runtime: ProviderRuntimeId) {
  const suffix = IS_POSIX ? '' : '.exe';
  if (runtime === 'claude') return path.join(root, 'claude', `claude${suffix}`);
  return path.join(root, 'codex', 'bin', `codex${suffix}`);
}

export class ProviderRuntimeInstaller {
  private active = new Map<ProviderRuntimeId, Promise<string>>();

  constructor(private root: string) {}

  installedPath(runtime: ProviderRuntimeId) {
    const target = runtimeExecutablePath(this.root, runtime);
    return fs.existsSync(target) ? target : '';
  }

  install(runtime: ProviderRuntimeId, onProgress?: (progress: RuntimeProgress) => void, release?: RuntimeRelease) {
    const running = this.active.get(runtime);
    if (running) return running;
    const job = this.run(runtime, onProgress, release).finally(() => this.active.delete(runtime));
    this.active.set(runtime, job);
    return job;
  }

  private report(
    onProgress: ((progress: RuntimeProgress) => void) | undefined,
    runtime: ProviderRuntimeId,
    percent: number,
    status: string,
    bytes?: { receivedBytes: number; totalBytes: number }
  ) {
    onProgress?.({ runtime, percent: Math.max(0, Math.min(100, Math.round(percent))), status, ...bytes });
  }

  private async run(runtime: ProviderRuntimeId, onProgress?: (progress: RuntimeProgress) => void, release?: RuntimeRelease) {
    const existing = this.installedPath(runtime);
    if (existing) return existing;

    const destination = path.join(this.root, runtime);
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(destination, { recursive: true });
    const staging = path.join(this.root, `.staging-${runtime}-${Date.now().toString(36)}`);
    await fsp.mkdir(staging, { recursive: true });
    try {
      if (runtime === 'claude') await this.installClaude(destination, staging, onProgress, release);
      else await this.installCodex(destination, staging, onProgress, release);
      const target = runtimeExecutablePath(this.root, runtime);
      if (!fs.existsSync(target)) throw new Error(`${RUNTIME_LABELS[runtime]} did not unpack correctly.`);
      this.report(onProgress, runtime, 100, `${RUNTIME_LABELS[runtime]} is ready`);
      return target;
    } catch (error) {
      await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async download(
    url: string,
    destination: string,
    runtime: ProviderRuntimeId,
    label: string,
    ceiling: number,
    onProgress?: (progress: RuntimeProgress) => void,
    checksum?: string,
    signal?: AbortSignal
  ) {
    const response = await fetch(url, { headers: { 'User-Agent': 'OmniAgent' }, signal: AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) {
      throw new Error(`${label} could not be downloaded (${response.status}).`);
    }
    const expected = Number(response.headers.get('content-length') ?? 0);
    const handle = await fsp.open(destination, 'w');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256');
    let seen = 0;
    let lastTick = -1;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await handle.write(chunk.value);
        hash.update(chunk.value);
        seen += chunk.value.length;
        if (expected > 0) {
          const tick = Math.floor((seen / expected) * 100);
          if (tick !== lastTick) {
            lastTick = tick;
            this.report(
              onProgress,
              runtime,
              (seen / expected) * ceiling,
              `${label} — ${Math.round(seen / 1e6)} MB of ${Math.round(expected / 1e6)} MB`,
              { receivedBytes: seen, totalBytes: expected }
            );
          }
        }
      }
    } finally {
      await handle.close();
    }
    if (expected > 0 && (await fsp.stat(destination)).size !== expected) {
      throw new Error(`${label} finished early — the download was incomplete.`);
    }
    if (checksum && hash.digest('hex').toLowerCase() !== checksum.toLowerCase()) {
      throw new Error(`${label} failed its checksum check.`);
    }
  }

  private async installClaude(destination: string, staging: string, onProgress?: (progress: RuntimeProgress) => void, release?: RuntimeRelease) {

    this.report(onProgress, 'claude', 1, 'Checking the latest Claude Code release');
    const version = release?.version ?? (await (await fetch('https://downloads.claude.ai/claude-code-releases/latest', { signal: AbortSignal.timeout(15_000) })).text()).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Claude Code returned an unexpected version.');
    const manifest = await (await fetch(`https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`, { signal: AbortSignal.timeout(15_000) })).json() as {
      platforms?: Record<string, { checksum?: string }>;
    };
    const checksum = manifest.platforms?.[claudePlatform()]?.checksum;
    if (!checksum) throw new Error(`Claude Code has no ${claudePlatform()} build in its manifest.`);

    const binary = IS_POSIX ? 'claude' : 'claude.exe';
    const staged = path.join(staging, binary);
    await this.download(
      release?.url ?? `https://downloads.claude.ai/claude-code-releases/${version}/${claudePlatform()}/${binary}`,
      staged, 'claude', 'Downloading Anthropic dependencies', 92, onProgress, checksum, release?.signal
    );

    this.report(onProgress, 'claude', 95, 'Verifying Claude Code');
    const crypto = await import('node:crypto');
    const actual = crypto.createHash('sha256').update(await fsp.readFile(staged)).digest('hex');
    if (actual.toLowerCase() !== checksum.toLowerCase()) throw new Error('Claude Code failed its checksum check.');
    const installed = path.join(destination, binary);
    await fsp.rename(staged, installed);
    if (IS_POSIX) await fsp.chmod(installed, 0o755);
  }

  private async installCodex(destination: string, staging: string, onProgress?: (progress: RuntimeProgress) => void, release?: RuntimeRelease) {

    const asset = `codex-package-${codexTarget()}.tar.gz`;
    const staged = path.join(staging, asset);
    await this.download(
      release?.url ?? `https://github.com/openai/codex/releases/latest/download/${asset}`,
      staged, 'codex', 'Downloading OpenAI dependencies', 88, onProgress, release?.checksum, release?.signal
    );
    this.report(onProgress, 'codex', 92, 'Unpacking Codex');

    await new Promise<void>((resolve, reject) => {
      const child = spawn(TAR, ['-xzf', staged, '-C', destination], { windowsHide: true, signal: release?.signal });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Codex could not be unpacked.'))));
    });
  }



}
