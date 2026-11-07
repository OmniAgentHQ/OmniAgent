import { z } from 'zod';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const waitInstructionSchema = z.object({
  version: z.literal(1),
  category: z.enum(['Date or time', 'File or download', 'App or page state', 'Other']),
  instruction: z.string().min(1).max(100_000)
});
export function compileWaitInstruction(category: unknown, instruction: string) {
  return waitInstructionSchema.parse({ version: 1,
    category: ['Date or time', 'File or download', 'App or page state'].includes(String(category)) ? category : 'Other',
    instruction });
}
export const waitPlanSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duration'), milliseconds: z.number().finite().nonnegative() }),
  z.object({ kind: z.literal('time'), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timeZone: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ kind: z.literal('instant'), at: z.string().datetime({ offset: true }) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1), state: z.enum(['exists', 'absent', 'downloaded']) }),
  z.object({ kind: z.literal('download'), name: z.string().min(1) }),
  z.object({ kind: z.literal('browser'), text: z.string().min(1), state: z.enum(['present', 'absent']) }),
  z.object({ kind: z.literal('window'), title: z.string().min(1), state: z.enum(['present', 'absent']) }),
  z.object({ kind: z.literal('desktop'), text: z.string().min(1), window: z.string().optional(), state: z.enum(['present', 'absent']) }),
  z.object({ kind: z.literal('visual'), condition: z.string().min(1) }),
  z.object({ kind: z.literal('blocked'), reason: z.string().min(1) })
]);
export type WaitPlan = z.infer<typeof waitPlanSchema>;
export type WaitState = { plan: WaitPlan; startedAt: number; targetAt?: number; partialSeen?: boolean };

export function localWaitPlan(instruction: string): WaitPlan | undefined {
  const duration = instruction.trim().match(/^(?:please\s+)?(?:wait|pause|sleep)(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|days?)[.!]?$/i);
  if (duration) return { kind: 'duration', milliseconds: Number(duration[1]) * (/^s/i.test(duration[2]) ? 1000 : /^m/i.test(duration[2]) ? 60_000 : /^h/i.test(duration[2]) ? 3_600_000 : 86_400_000) };
  const clock = instruction.trim().match(/^(?:please\s+)?(?:wait|pause)(?:\s+until|\s+till|\s+for)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s+(?:local time|today))?[.!]?$/i);
  if (!clock) return;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  if (clock[3]) { if (hour < 1 || hour > 12) return; hour = hour % 12 + (/pm/i.test(clock[3]) ? 12 : 0); }
  else if (!clock[2]) return;
  if (hour > 23 || minute > 59) return;
  return { kind: 'time', hour, minute };
}

export function timeTarget(plan: Extract<WaitPlan, { kind: 'time' }>, now: number) {
  const zone = plan.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const parts = (at: number) => Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
  const current = parts(now);
  const date = plan.date ?? `${current.year}-${current.month}-${current.day}`;
  const [y, m, d] = date.split('-').map(Number);
  const desired = Date.UTC(y, m - 1, d, plan.hour, plan.minute);
  let target = desired;
  for (let i = 0; i < 4; i++) {
    const actual = parts(target);
    target += desired - Date.UTC(+actual.year, +actual.month - 1, +actual.day, +actual.hour, +actual.minute);
  }
  const actual = parts(target);
  if (`${actual.year}-${actual.month}-${actual.day}` !== date || +actual.hour !== plan.hour || +actual.minute !== plan.minute) {
    throw new Error('That local time does not exist on this date. Specify a valid time and timezone.');
  }
  return target;
}

export function waitState(plan: WaitPlan, now = Date.now()): WaitState {
  if (plan.kind === 'blocked') throw new Error(plan.reason);
  return { plan, startedAt: now, ...(plan.kind === 'duration' ? { targetAt: now + plan.milliseconds }
    : plan.kind === 'instant' ? { targetAt: Date.parse(plan.at) }
    : plan.kind === 'time' ? { targetAt: timeTarget(plan, now) } : {}) };
}
export function waitDelay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, Math.min(2_147_483_647, Math.max(0, ms)));
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('Stopped', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export type WaitHost = {
  signal?: AbortSignal;
  save(state: WaitState): void | Promise<void>;
  browserText(): Promise<string | null>;
  desktopText(window?: string): Promise<string | null>;
  windowTitles(): Promise<string | null>;
  download(name: string, since: number): Promise<'completed' | 'cancelled' | 'pending' | 'unknown'>;
  visual(condition: string): Promise<boolean>;
};
async function stopAware<T>(action: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return action;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    action.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
export async function checkLocalWait(state: WaitState, host: WaitHost): Promise<boolean | undefined> {
  const plan = state.plan;
  if (state.targetAt !== undefined) return Date.now() >= state.targetAt;
  if (plan.kind === 'file') {
    const exists = await fsp.stat(plan.path).then(s => s.isFile(), e => { if (e.code === 'ENOENT') return false; throw e; });
    if (plan.state !== 'downloaded') return plan.state === 'exists' ? exists : !exists;
    const status = await host.download(path.basename(plan.path), state.startedAt);
    if (status === 'cancelled') throw new Error('The download was cancelled or interrupted.');
    if (status === 'completed') return exists;
    const partial = await Promise.all(['.crdownload', '.part', '.partial', '.download'].map(ext => fsp.stat(plan.path + ext).then(() => true, () => false)));
    if (partial.some(Boolean)) {
      if (!state.partialSeen) { state.partialSeen = true; await host.save(state); }
      return false;
    }
    if (state.partialSeen && exists) return true;
    if (!exists) return false;
    return status === 'pending' ? false : undefined;
  }
  if (plan.kind === 'download') {
    const result = await host.download(plan.name, state.startedAt);
    if (result === 'cancelled') throw new Error('The download was cancelled or interrupted.');
    return result === 'unknown' ? undefined : result === 'completed';
  }
  if (plan.kind === 'browser' || plan.kind === 'desktop' || plan.kind === 'window') {
    const text = plan.kind === 'browser' ? await host.browserText() : plan.kind === 'window' ? await host.windowTitles() : await host.desktopText(plan.window);
    if (text === null) return undefined;
    const found = text.toLowerCase().includes((plan.kind === 'window' ? plan.title : plan.text).toLowerCase());
    return plan.state === 'present' ? found : !found;
  }
  return undefined;
}
export async function runWait(state: WaitState, host: WaitHost, instruction: string) {
  let nextVisualAt = 0;
  while (true) {
    host.signal?.throwIfAborted();
    const ready = await stopAware(checkLocalWait(state, host), host.signal);
    host.signal?.throwIfAborted();
    if (ready) return;
    if (ready === undefined && Date.now() >= nextVisualAt) {
      if (await stopAware(host.visual(instruction), host.signal)) { host.signal?.throwIfAborted(); return; }
      nextVisualAt = Date.now() + 15_000;
    }
    await waitDelay(state.targetAt !== undefined ? Math.min(60_000, Math.max(1, state.targetAt - Date.now())) : 1000, host.signal);
  }
}
