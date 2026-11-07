export type LoopDefinition =
  | { mode: 'none' }
  | { mode: 'immediate'; delaySeconds?: number }
  | { mode: 'time-spread'; runsPerPeriod: number; period: 'hour' | 'day' }
  | { mode: 'active-window'; start: string; end: string; runMode: 'once' | 'immediate' | 'time-spread'; runsPerPeriod?: number; period?: 'hour' | 'day' };

export function activeWindowDurationMinutes(start: string, end: string) {
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const from = startHour * 60 + startMinute;
  const to = endHour * 60 + endMinute;
  return (to - from + 1_440) % 1_440 || 1_440;
}

export function isWithinActiveWindow(start: string, end: string, at = new Date()) {
  const current = at.getHours() * 60 + at.getMinutes();
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const from = startHour * 60 + startMinute;
  const to = endHour * 60 + endMinute;
  if (from === to) return true;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

export function activeWindowSpreadIntervalMs(start: string, end: string, runsPerPeriod: number | undefined) {
  const windowMs = activeWindowDurationMinutes(start, end) * 60_000;
  const runs = Math.max(1, runsPerPeriod ?? 1);
  return Math.max(1, Math.floor(windowMs / runs));
}

export function activeWindowRunTimes(start: string, end: string, runsPerPeriod: number | undefined, opensAt: Date) {
  const intervalMs = activeWindowSpreadIntervalMs(start, end, runsPerPeriod);
  const times: Date[] = [];
  let cursor = new Date(opensAt);
  while (times.length < 500 && isWithinActiveWindow(start, end, cursor)) {
    times.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + intervalMs);
  }
  return times;
}

export function nextWindowOpening(start: string, end: string, at = new Date()): 'today' | 'tomorrow' | null {
  if (isWithinActiveWindow(start, end, at)) return null;
  const [startHour, startMinute] = start.split(':').map(Number);
  const current = at.getHours() * 60 + at.getMinutes();
  return current < startHour * 60 + startMinute ? 'today' : 'tomorrow';
}

export function formatClockLabel(hhmm: string) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function closedWindowWaitingLabel(start: string, end: string, at = new Date()) {
  const opening = nextWindowOpening(start, end, at);
  if (opening === null) return null;
  return opening === 'today'
    ? `Waiting for ${formatClockLabel(start)}`
    : `Waiting for ${formatClockLabel(start)} tomorrow`;
}

export function formatClockFromDate(at: Date) {
  return formatClockLabel(`${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`);
}

export function calendarDaysBetween(from: Date, to: Date) {
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((toMidnight - fromMidnight) / 86_400_000);
}

export function nextRunWaitingLabel(nextRunAt: Date | null | undefined, at = new Date()): string | null {
  if (!nextRunAt || Number.isNaN(nextRunAt.getTime()) || nextRunAt.getTime() <= at.getTime()) return null;
  const clock = formatClockFromDate(nextRunAt);
  const days = calendarDaysBetween(at, nextRunAt);
  if (days <= 0) return `Waiting for ${clock}`;
  if (days === 1) return `Waiting for ${clock} tomorrow`;
  if (days < 7) return `Waiting for ${clock} ${DAY_NAMES[nextRunAt.getDay()]}`;
  return `Waiting for ${clock} ${nextRunAt.getDate()} ${MONTH_NAMES[nextRunAt.getMonth()]}`;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type WaitingLoop =
  | { mode: 'none' }
  | { mode: 'immediate' }
  | { mode: 'time-spread' }
  | { mode: 'active-window'; start: string; end: string; runMode: 'once' | 'immediate' | 'time-spread' };

export function waitingLabelForLoop(loop: WaitingLoop, at = new Date(), nextRunAt?: Date | null): string {
  if (loop.mode === 'immediate') return 'Waiting to restart';
  if (loop.mode === 'time-spread') return nextRunWaitingLabel(nextRunAt, at) ?? 'Waiting for next run';
  if (loop.mode !== 'active-window') return 'Ready to start';

  const closed = closedWindowWaitingLabel(loop.start, loop.end, at);
  if (closed) return nextRunWaitingLabel(nextRunAt, at) ?? closed;
  if (loop.runMode === 'immediate') return 'Waiting to restart';
  if (loop.runMode === 'time-spread') return nextRunWaitingLabel(nextRunAt, at) ?? 'Waiting for next run';
  return `Waiting for ${formatClockLabel(loop.start)} tomorrow`;
}

const HHMM = /^\d{2}:\d{2}$/;

export function loopFromJson(value: unknown): LoopDefinition {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return { mode: 'none' };
    const loop = parsed as Record<string, unknown>;
    if (loop.mode === 'immediate') return { mode: 'immediate', delaySeconds: Math.max(5, Number(loop.delaySeconds) || 30) };
    if (loop.mode === 'interval') {
      const everyMinutes = Math.max(1, Number(loop.everyMinutes) || 60);
      return everyMinutes >= 1_440
        ? { mode: 'time-spread', runsPerPeriod: 1, period: 'day' }
        : { mode: 'time-spread', runsPerPeriod: Math.max(1, Math.round(60 / everyMinutes)), period: 'hour' };
    }
    if (loop.mode === 'daily-window' && HHMM.test(String(loop.start)) && HHMM.test(String(loop.end))) {
      return { mode: 'active-window', start: String(loop.start), end: String(loop.end), runMode: 'once' };
    }
    if (loop.mode === 'time-spread' && (loop.period === 'hour' || loop.period === 'day')) {
      return { mode: 'time-spread', runsPerPeriod: Math.max(1, Number(loop.runsPerPeriod) || 1), period: loop.period };
    }
    if (loop.mode === 'active-window' && HHMM.test(String(loop.start)) && HHMM.test(String(loop.end))) {
      const runMode = loop.runMode === 'immediate' || loop.runMode === 'time-spread' ? loop.runMode : 'once';
      return {
        mode: 'active-window',
        start: String(loop.start),
        end: String(loop.end),
        runMode,
        ...(runMode === 'time-spread' ? {
          runsPerPeriod: Math.max(1, Number(loop.runsPerPeriod) || 1),
          period: loop.period === 'day' ? 'day' as const : 'hour' as const
        } : {})
      };
    }
  } catch {

  }
  return { mode: 'none' };
}

export function isCustomLoop(loop: { mode?: unknown }) {
  return loop.mode === 'time-spread' || loop.mode === 'active-window';
}

export function nextSlotAfter(loop: LoopDefinition, from: Date): Date {
  if (loop.mode === 'time-spread') {
    const periodMinutes = loop.period === 'day' ? 1_440 : 60;
    const intervalMs = Math.max(1, Math.floor((periodMinutes * 60_000) / loop.runsPerPeriod));
    return new Date(from.getTime() + intervalMs);
  }
  if (loop.mode === 'active-window' && loop.runMode === 'time-spread' && isWithinActiveWindow(loop.start, loop.end, from)) {
    const candidate = new Date(from.getTime() + activeWindowSpreadIntervalMs(loop.start, loop.end, loop.runsPerPeriod));
    if (isWithinActiveWindow(loop.start, loop.end, candidate)) return candidate;
  }
  const [hour, minute] = String(loop.mode === 'active-window' ? loop.start : '09:00').split(':').map(Number);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour || 0, minute || 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next;
}
