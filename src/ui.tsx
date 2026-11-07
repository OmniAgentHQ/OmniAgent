import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, CircleAlert } from 'lucide-react';
import openaiLogo from './assets/brand/OpenAI.png';
import claudeLogo from './assets/brand/Claude.png';
import { PROVIDER_INFO, PROVIDER_ORDER, type AgentStatus, type AIConnectionView, type ModelChoice, type Provider } from '../electron/shared';
import { Glyph, type GlyphName } from './Glyph';

export const PROVIDER_LOGOS: Record<Provider, string> = {
  OpenAI: openaiLogo,
  Claude: claudeLogo
};

export function ProviderLogo({ provider, size }: { provider: Provider; size?: 'large' | 'xl' }) {
  return <span className={`logo-badge ${size ?? ''}`}><img src={PROVIDER_LOGOS[provider]} alt={PROVIDER_INFO[provider].label} draggable={false} /></span>;
}

export function StatusPill({ status, label }: { status: AgentStatus; label?: string }) {
  const text = label ?? { queued: 'Waiting', working: 'Working', done: 'Done', failed: 'Problem', stopped: 'Stopped' }[status];
  return <span className={`status-pill ${status}`}>
    {status === 'working' ? <span className="spinner" /> : status === 'queued' ? <span className="wait-dots"><i /><i /><i /></span> : <Glyph name={{ done: 'completed', failed: 'failed', stopped: 'stopped' }[status] as GlyphName} size={14} className={status === 'stopped' ? 'dim' : ''} />}
    {text}
  </span>;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (next: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (next: T) => void }) {
  return <div className="segmented">
    {options.map((option) => <button type="button" key={option.value} className={option.value === value ? 'on' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function Popover({ anchor, onClose, children, width = 340 }: { anchor: DOMRect; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: anchor.bottom + 8, left: anchor.left });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const height = element.offsetHeight;
      const roomBelow = window.innerHeight - anchor.bottom - 12;
      const roomAbove = anchor.top - 12;
      const top = height > roomBelow && roomAbove > roomBelow ? anchor.top - height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - height - 12);
      const left = Math.min(Math.max(12, anchor.left), window.innerWidth - Math.min(width, window.innerWidth - 24) - 12);
      setPosition({ top: Math.max(12, top), left: Math.max(12, left) });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [anchor, width]);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('[data-floating-layer]')) return;
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onPointer), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return createPortal(<div ref={ref} className="popover" style={{ top: position.top, left: position.left, width: `min(${width}px, calc(100vw - 24px))` }}>{children}</div>, document.body);
}

export type SelectOption = { value: string; label: string; detail?: string; icon?: ReactNode };

export function Select({ value, options, onChange, placeholder = 'Choose', label }: { value: string; options: SelectOption[]; onChange: (next: string) => void; placeholder?: string; label?: string }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const selected = options.find((option) => option.value === value);

  const measure = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const wanted = Math.min(320, options.length * 46 + 10);
    const up = below < Math.min(wanted, 180) && above > below;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 24);
    setPlace({
      top: up ? rect.top - 6 : rect.bottom + 6,
      left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
      width,
      maxHeight: Math.max(120, Math.min(320, up ? above : below)),
      up
    });
  };

  const openMenu = () => {
    measure();
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (list.current?.contains(target) || trigger.current?.contains(target))) return;
      setOpen(false);
    };
    const reflow = () => measure();
    document.addEventListener('mousedown', close, true);
    window.addEventListener('resize', reflow);
    document.addEventListener('scroll', reflow, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('resize', reflow);
      document.removeEventListener('scroll', reflow, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (event: ReactKeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openMenu(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(options.length - 1, index + 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); return; }
    if (event.key === 'Home') { event.preventDefault(); setActive(0); return; }
    if (event.key === 'End') { event.preventDefault(); setActive(options.length - 1); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(active); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const start = active + 1;
      const order = [...options.slice(start), ...options.slice(0, start)];
      const found = order.find((option) => option.label.toLowerCase().startsWith(letter));
      if (found) setActive(options.indexOf(found));
    }
  };

  return <>
    <button
      ref={trigger}
      type="button"
      className={`select-trigger ${open ? 'open' : ''}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={label}
      onClick={() => (open ? setOpen(false) : openMenu())}
      onKeyDown={onKey}
    >
      {selected?.icon ? <span className="select-icon">{selected.icon}</span> : null}
      <span className="select-value">{selected ? selected.label : <span className="select-placeholder">{placeholder}</span>}</span>
      <ChevronDown size={15} className="select-chevron" />
    </button>
    {open && place ? createPortal(<div
      ref={list}
      data-floating-layer=""
      className={`select-menu ${place.up ? 'up' : ''}`}
      role="listbox"
      tabIndex={-1}
      onKeyDown={onKey}
      style={{ left: place.left, width: place.width, maxHeight: place.maxHeight, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}
    >
      {options.map((option, index) => <div
        key={option.value}
        data-index={index}
        role="option"
        aria-selected={option.value === value}
        className={`select-option ${index === active ? 'active' : ''} ${option.value === value ? 'chosen' : ''}`}
        onMouseEnter={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(index)}
      >
        {option.icon ? <span className="select-icon">{option.icon}</span> : null}
        <span className="select-option-text">
          <span className="select-option-label">{option.label}</span>
          {option.detail ? <small>{option.detail}</small> : null}
        </span>
        {option.value === value ? <Check size={14} className="select-check" /> : null}
      </div>)}
    </div>, document.body) : null}
  </>;
}

export function useNow(intervalMs = 1_000, active = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

export function elapsed(fromIso: string, toIso: string, now: number) {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return '';
  const to = toIso ? Date.parse(toIso) : now;
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function clock(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function relativeDay(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return clock(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let amount = value;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
}

export function baseName(target: string) {
  return target.split(/[\\/]/).filter(Boolean).pop() || target;
}

export function connectedFor(connections: AIConnectionView[], provider: Provider) {
  return connections
    .filter((connection) => connection.provider === provider && connection.status === 'connected')
    .sort((left, right) => (left.kind === right.kind ? 0 : left.kind === 'account' ? -1 : 1));
}

export function resolveChoice(connections: AIConnectionView[], choice: ModelChoice) {
  const candidates = connectedFor(connections, choice.provider);
  const connection = candidates.find((item) => item.id === choice.connectionId) ?? candidates[0];
  const model = connection?.models.find((item) => item.id === choice.model) ?? connection?.models[0];
  return { connection, model, modelId: model?.id ?? choice.model, connected: Boolean(connection) };
}

export function modelLabel(connections: AIConnectionView[], choice: ModelChoice) {
  const { model, modelId } = resolveChoice(connections, choice);
  return model?.label || modelId || 'Default model';
}

export function modelName(connections: AIConnectionView[], provider: Provider, id: string) {
  for (const connection of connections) {
    if (connection.provider !== provider) continue;
    const found = connection.models.find((model) => model.id === id);
    if (found?.label) return found.label;
  }
  return id;
}

export function contextLabel(tokens: number) {
  if (tokens >= 1_048_576) return `${Math.round(tokens / 1_048_576 * 10) / 10}M tokens`;
  return `${Math.round(tokens / 1024)}K tokens`;
}

function connectionOption(item: AIConnectionView): SelectOption {
  return { value: item.id, label: item.label, detail: item.email || (item.kind === 'account' ? 'Signed in' : 'API key'), icon: <ProviderLogo provider={item.provider} /> };
}

export function ChoiceEditor({ value, onChange, connections, onConnect, lockProvider }: { value: ModelChoice; onChange: (next: ModelChoice) => void; connections: AIConnectionView[]; onConnect: () => void; lockProvider?: boolean }) {
  const candidates = connectedFor(connections, value.provider);
  const { connection, model } = resolveChoice(connections, value);
  const efforts = model?.reasoningEfforts ?? [];
  const ready = (provider: Provider) => connectedFor(connections, provider).length > 0;
  const switchable = lockProvider ? [] : PROVIDER_ORDER;
  const effortValue = efforts.includes(value.effort) ? value.effort : (efforts.includes('high') ? 'high' : efforts[efforts.length - 1]);
  const effortPicker = efforts.length ? <div className="field">
    <label>Thinking effort</label>
    <Segmented value={effortValue} options={efforts.map((effort) => ({ value: effort, label: effort === 'xhigh' ? 'X-High' : effort }))} onChange={(effort) => onChange({ ...value, effort })} />
    <span className="hint">Higher is smarter but slower.</span>
  </div> : null;

  return <>
    {switchable.length > 1 ? <div className="field">
      <span className="field-label">AI</span>
      <div className="provider-grid">
        {switchable.map((provider) => {
          const usable = ready(provider);
          return <button
            type="button"
            key={provider}
            className={`provider-option ${value.provider === provider ? 'on' : ''} ${usable ? '' : 'off'}`}
            onClick={() => {
              if (!usable) { onConnect(); return; }
              onChange({ provider, connectionId: '', model: '', effort: value.effort });
            }}
          >
            <ProviderLogo provider={provider} />
            <span>{PROVIDER_INFO[provider].label}</span>
            {usable ? null : <small>Connect</small>}
          </button>;
        })}
      </div>
    </div> : null}
    {!candidates.length ? <div className="notice warn" style={{ marginBottom: 12 }}>
      <CircleAlert size={16} />
      <div>{PROVIDER_INFO[value.provider].label} isn’t connected yet. <button type="button" className="mention" onClick={onConnect}>Connect it</button></div>
    </div> : <>
      {candidates.length > 1 ? <div className="field">
        <label>Use</label>
        <Select label="Account or key" value={connection?.id ?? ''} options={candidates.map(connectionOption)} onChange={(connectionId) => onChange({ ...value, connectionId, model: '' })} />
      </div> : null}
      <div className="field">
        <label>Model</label>
        {connection?.models.length
          ? <Select label="Model" value={model?.id ?? ''} options={connection.models.map((item) => ({ value: item.id, label: item.label || item.id, detail: item.description }))} onChange={(next) => onChange({ ...value, connectionId: connection.id, model: next })} />
          : <input className="input" value={value.model} placeholder="Model name" onChange={(event) => onChange({ ...value, model: event.target.value })} />}
      </div>
      {effortPicker ?? (model?.reasoningNote ? <p className="sub">{model.reasoningNote}</p> : null)}
    </>}
  </>;
}
