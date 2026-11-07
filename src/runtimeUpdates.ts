import { useSyncExternalStore } from 'react';
import { omni, type RuntimeDetails, type RuntimeId } from './api';

export const runtimeLabels: Record<RuntimeId, string> = { codex: 'ChatGPT', claude: 'Claude' };

export type RuntimeDownload = { runtime: RuntimeId; index: number; total: number; percent: number; currentPercent: number; status: string; cancelling: boolean };

type RuntimeState = { runtimes: RuntimeDetails[]; checking: boolean; download: RuntimeDownload | null; error: string; notice: string };

export function runtimeSummary(runtimes: RuntimeDetails[]) {
  const installed = runtimes.filter((runtime) => runtime.installed);
  const outdated = installed.filter((runtime) => runtime.updateAvailable);
  const updates = outdated.filter((runtime) => !runtime.override && runtime.latestVersion);
  const checked = installed.length > 0 && installed.every((runtime) => runtime.checkedAt && runtime.latestVersion && !runtime.error);
  return { installed, updates, outdated, label: outdated.length ? `${outdated.length} update${outdated.length === 1 ? '' : 's'} available` : checked ? 'Everything is up to date' : 'Not checked yet' };
}

function cleanError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || 'The update did not finish.';
}

class RuntimeUpdateStore {
  private state: RuntimeState = { runtimes: [], checking: false, download: null, error: '', notice: '' };
  private listeners = new Set<() => void>();
  private checkJob?: Promise<void>;
  private checkingLatest = false;
  private lastLatestCheck = 0;

  checkIfStale() {
    if (Date.now() - this.lastLatestCheck < 30 * 60_000) return;
    this.lastLatestCheck = Date.now();
    void this.check(true);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<RuntimeState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()); }
  private patchDownload(patch: Partial<RuntimeDownload>) {
    if (this.state.download) this.set({ download: { ...this.state.download, ...patch } });
  }

  async check(latest = true): Promise<void> {
    if (this.state.download) return;
    if (this.checkJob) {
      const needsLiveCheck = latest && !this.checkingLatest;
      await this.checkJob;
      if (needsLiveCheck) await this.check(true);
      return;
    }
    this.checkingLatest = latest;
    this.set({ checking: true, error: '' });
    this.checkJob = (async () => {
      try {
        const runtimes = await omni.runtimeDetails(latest);
        const failed = runtimes.filter((runtime) => runtime.installed && runtime.error);
        this.set({ runtimes, error: failed.length ? `Could not check ${failed.map((runtime) => runtimeLabels[runtime.runtime]).join(', ')}. Try again in a moment.` : '' });
      } catch {
        this.set({ error: 'Could not check for updates. Try again in a moment.' });
      } finally {
        this.set({ checking: false });
      }
    })();
    try { await this.checkJob; } finally { this.checkJob = undefined; }
  }

  async update(only?: RuntimeId) {
    if (this.state.download || this.state.checking) return;
    const queue = runtimeSummary(this.state.runtimes).updates.filter((runtime) => !only || runtime.runtime === only);
    if (!queue.length) return;
    this.set({ error: '', notice: '', download: { runtime: queue[0].runtime, index: 0, total: queue.length, percent: 0, currentPercent: 0, status: 'Getting ready', cancelling: false } });
    const errors: string[] = [];
    const notes = new Set<string>();
    let completed = 0;
    const unsubscribe = omni.onRuntimeProgress((progress) => {
      const download = this.state.download;
      if (download?.runtime !== progress.runtime) return;
      const currentPercent = Math.max(download.currentPercent, Math.min(100, Math.max(0, progress.percent)));
      this.patchDownload({
        currentPercent,
        percent: Math.floor((download.index * 100 + currentPercent) / download.total),
        status: progress.status.replace(/Claude Code/g, 'Claude').replace(/Codex/g, 'ChatGPT')
      });
    });
    try {
      for (let index = 0; index < queue.length; index++) {
        if (this.getSnapshot().download?.cancelling) break;
        const runtime = queue[index].runtime;
        this.patchDownload({ runtime, index, currentPercent: 0, percent: Math.floor(index * 100 / queue.length), status: 'Checking the latest release' });
        try {
          const result = await omni.updateRuntime(runtime);
          completed++;
          this.set({ runtimes: result.runtimes });
          if (result.note) notes.add(result.note);
        } catch (cause) {
          const message = cleanError(cause);
          if (this.getSnapshot().download?.cancelling || /cancelled|aborted/i.test(message)) { this.patchDownload({ cancelling: true }); break; }
          errors.push(`${runtimeLabels[runtime]}: ${message}`);
        }
      }
      const cancelled = this.getSnapshot().download?.cancelling;
      this.set({
        error: errors.join(' '),
        notice: [cancelled ? `Update cancelled.${completed ? ' Finished updates were kept.' : ' Nothing changed.'}` : errors.length ? 'Some updates did not finish. You can try them again.' : 'Updated. The model lists are fresh.', ...notes].join(' ')
      });
    } finally {
      unsubscribe();
      try { this.set({ runtimes: await omni.runtimeDetails(false) }); } catch { }
      this.set({ download: null });
    }
  }

  async cancel() {
    const download = this.state.download;
    if (!download || download.cancelling || download.currentPercent >= 97) return;
    this.patchDownload({ cancelling: true });
    try { await omni.cancelRuntimeUpdate(download.runtime); }
    catch { this.patchDownload({ cancelling: false, status: 'Could not cancel. Try again.' }); }
  }
}

export const runtimeUpdates = new RuntimeUpdateStore();

export function useRuntimeUpdates() {
  return useSyncExternalStore(runtimeUpdates.subscribe, runtimeUpdates.getSnapshot);
}
