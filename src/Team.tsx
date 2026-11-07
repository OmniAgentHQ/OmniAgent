import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus, Settings2, Trash2, X } from 'lucide-react';
import { ChoiceEditor, connectedFor, modelLabel, Popover, ProviderLogo, resolveChoice, Segmented, Toggle } from './ui';
import { PROVIDER_INFO, PROVIDER_ORDER, type AgentConfig, type AIConnectionView, type LoopSetting, type ModelChoice, type Provider, type TeamConfig } from '../electron/shared';
import { Glyph } from './Glyph';
import logo from './assets/logo.png';

export function newAgent(provider: Provider, team: TeamConfig, connections: AIConnectionView[]): AgentConfig {
  const base = PROVIDER_INFO[provider].handle;
  const taken = new Set(team.agents.map((agent) => agent.handle.toLowerCase()));
  let handle = base;
  for (let index = 2; taken.has(handle.toLowerCase()); index += 1) handle = `${base}${index}`;
  const resolved = resolveChoice(connections, { provider, connectionId: '', model: '', effort: 'high' });
  return {
    id: `agent_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    provider,
    handle,
    connectionId: resolved.connection?.id ?? '',
    model: resolved.modelId ?? '',
    effort: 'high',
    browsing: 'hidden'
  };
}

function useDraft<T>(value: T, commit: (next: T) => void) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(draft);
  const update = (next: T) => {
    setDraft(next);
    latest.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(next), 280);
  };
  const flush = () => {
    window.clearTimeout(timer.current);
    commit(latest.current);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { draft, update, flush };
}

function AgentSettings({ agent, anchor, connections, onSave, onRemove, onClose, onConnect }: {
  agent: AgentConfig;
  anchor: DOMRect;
  connections: AIConnectionView[];
  onSave: (next: AgentConfig) => void;
  onRemove: () => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  const { draft, update, flush } = useDraft(agent, onSave);
  const close = () => { flush(); onClose(); };
  return <Popover anchor={anchor} onClose={close} width={360}>
    <h4><ProviderLogo provider={draft.provider} />@{draft.handle}</h4>
    <p className="sub">Choose which AI model this agent uses and how hard it thinks.</p>
    <div className="field">
      <label>Name you @mention</label>
      <input className="input" value={draft.handle} maxLength={30} onChange={(event) => update({ ...draft, handle: event.target.value.replace(/[^\w.-]/g, '') })} />
      <span className="hint">Type @{draft.handle || PROVIDER_INFO[draft.provider].handle} in your message to give it a task.</span>
    </div>
    <ChoiceEditor
      value={draft}
      connections={connections}
      lockProvider
      onConnect={() => { close(); onConnect(); }}
      onChange={(choice: ModelChoice) => update({ ...draft, ...choice, provider: draft.provider })}
    />
    <div className="toggle-row">
      <div><strong>Show its browser</strong><small>Watch it use websites, or keep that hidden</small></div>
      <Toggle on={draft.browsing === 'visible'} onChange={(on) => update({ ...draft, browsing: on ? 'visible' : 'hidden' })} label="Visible browser" />
    </div>
    <div className="popover-footer">
      <button type="button" className="btn small danger" onClick={() => { onRemove(); onClose(); }}><Trash2 size={13} />Remove</button>
      <button type="button" className="btn small" onClick={close}>Done</button>
    </div>
  </Popover>;
}

const ROUND_PRESETS = ['1', '2', '3', '4', '5'];
const MAX_ROUNDS = 100;

function FinisherSettings({ team, anchor, connections, onSave, onClose, onConnect }: {
  team: TeamConfig;
  anchor: DOMRect;
  connections: AIConnectionView[];
  onSave: (finisher: TeamConfig['finisher']) => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  const fallbackProvider = PROVIDER_ORDER.find((provider) => connectedFor(connections, provider).length) ?? 'Claude';
  const initial = team.finisher ?? { provider: fallbackProvider, connectionId: '', model: '', effort: 'high', enabled: true, rounds: 2 };
  const { draft, update, flush } = useDraft(initial, onSave);
  const [customRounds, setCustomRounds] = useState(!ROUND_PRESETS.includes(String(initial.rounds)));
  const close = () => { flush(); onClose(); };
  return <Popover anchor={anchor} onClose={close} width={360}>
    <h4><img className="plain-logo" src={logo} alt="" width={22} height={22} />Final check</h4>
    <p className="sub">When all your agents are done, one more agent looks over everything, makes sure you got what you asked for, and fixes anything missing.</p>
    <div className="toggle-row">
      <div><strong>Do a final check</strong><small>Recommended</small></div>
      <Toggle on={draft.enabled} onChange={(enabled) => update({ ...draft, enabled })} label="Do a final check" />
    </div>
    {draft.enabled ? <>
      <ChoiceEditor value={draft} connections={connections} onConnect={() => { close(); onConnect(); }} onChange={(choice) => update({ ...draft, ...choice })} />
      <div className="field">
        <label>How many times it can check</label>
        <Segmented value={customRounds ? 'custom' : String(draft.rounds)} options={[...ROUND_PRESETS.map((value) => ({ value, label: value })), { value: 'custom', label: 'Custom' }]} onChange={(value) => {
          if (value === 'custom') {
            setCustomRounds(true);
            if (ROUND_PRESETS.includes(String(draft.rounds))) update({ ...draft, rounds: 10 });
            return;
          }
          setCustomRounds(false);
          update({ ...draft, rounds: Number(value) });
        }} />
        {customRounds ? <input className="input" type="number" min={1} max={MAX_ROUNDS} value={draft.rounds} aria-label="Number of checks" onChange={(event) => update({ ...draft, rounds: Math.max(1, Math.min(MAX_ROUNDS, Math.round(Number(event.target.value) || 1))) })} /> : null}
        <span className="hint">If something is missing, it can send work back to an agent and check again.{customRounds ? ' Big builds can keep going for hours with more checks.' : ''}</span>
      </div>
    </> : null}
    <div className="popover-footer"><span /><button type="button" className="btn small" onClick={close}>Done</button></div>
  </Popover>;
}

function PulseSettings({ value, anchor, onSave, onClose }: { value: number; anchor: DOMRect; onSave: (minutes: number) => void; onClose: () => void }) {
  return <Popover anchor={anchor} onClose={onClose} width={330}>
    <h4><Glyph name="analytics" size={22} />Progress updates</h4>
    <p className="sub">Every few minutes, each agent tells you in one line how far along it is.</p>
    <Segmented value={String(value)} options={[{ value: '0', label: 'Off' }, { value: '1', label: '1m' }, { value: '2', label: '2m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }, { value: '10', label: '10m' }, { value: '15', label: '15m' }]} onChange={(next) => onSave(Number(next))} />
  </Popover>;
}

export function loopSummary(loop: LoopSetting) {
  if (loop.mode === 'none') return 'Repeat: off';
  if (loop.mode === 'immediate') return 'Repeat: nonstop';
  if (loop.mode === 'time-spread') return `Repeat: ${loop.runsPerPeriod}× a ${loop.period}`;
  return `Repeat: ${loop.start}–${loop.end}`;
}

function LoopSettings({ value, anchor, onSave, onClose }: { value: LoopSetting; anchor: DOMRect; onSave: (loop: LoopSetting) => void; onClose: () => void }) {
  const { draft, update, flush } = useDraft<LoopSetting>(value, onSave);
  const close = () => { flush(); onClose(); };
  return <Popover anchor={anchor} onClose={close} width={360}>
    <h4><Glyph name="history" size={22} />Repeat</h4>
    <p className="sub">Run your last message again automatically, on a schedule. Press Stop to end it.</p>
    <div className="field">
      <Segmented value={draft.mode} options={[{ value: 'none', label: 'Off' }, { value: 'immediate', label: 'Nonstop' }, { value: 'time-spread', label: 'X times' }, { value: 'active-window', label: 'Set hours' }]} onChange={(mode) => {
        if (mode === 'none') update({ mode: 'none' });
        if (mode === 'immediate') update({ mode: 'immediate', delaySeconds: 30 });
        if (mode === 'time-spread') update({ mode: 'time-spread', runsPerPeriod: 4, period: 'day' });
        if (mode === 'active-window') update({ mode: 'active-window', start: '09:00', end: '17:00', runMode: 'once' });
      }} />
    </div>
    {draft.mode === 'immediate' ? <div className="field">
      <label>Pause between runs (seconds)</label>
      <input className="input" type="number" min={5} max={86400} value={draft.delaySeconds ?? 30} onChange={(event) => update({ mode: 'immediate', delaySeconds: Math.max(5, Number(event.target.value) || 5) })} />
    </div> : null}
    {draft.mode === 'time-spread' ? <div className="field-row">
      <div className="field" style={{ flex: 1 }}>
        <label>Runs</label>
        <input className="input" type="number" min={1} max={1440} value={draft.runsPerPeriod} onChange={(event) => update({ ...draft, runsPerPeriod: Math.max(1, Number(event.target.value) || 1) })} />
      </div>
      <div className="field" style={{ flex: 1 }}>
        <label>Per</label>
        <Segmented value={draft.period} options={[{ value: 'hour', label: 'Hour' }, { value: 'day', label: 'Day' }]} onChange={(period) => update({ ...draft, period })} />
      </div>
    </div> : null}
    {draft.mode === 'active-window' ? <>
      <div className="field-row">
        <div className="field" style={{ flex: 1 }}>
          <label>From</label>
          <input className="input" type="time" value={draft.start} onChange={(event) => update({ ...draft, start: event.target.value || '09:00' })} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Until</label>
          <input className="input" type="time" value={draft.end} onChange={(event) => update({ ...draft, end: event.target.value || '17:00' })} />
        </div>
      </div>
      <div className="field">
        <label>Within those hours</label>
        <Segmented value={draft.runMode} options={[{ value: 'once', label: 'Once a day' }, { value: 'immediate', label: 'Back to back' }, { value: 'time-spread', label: 'Spread out' }]} onChange={(runMode) => update({ ...draft, runMode, ...(runMode === 'time-spread' ? { runsPerPeriod: draft.runsPerPeriod ?? 4, period: draft.period ?? 'hour' } : {}) })} />
      </div>
      {draft.runMode === 'time-spread' ? <div className="field">
        <label>Runs across the window</label>
        <input className="input" type="number" min={1} max={1440} value={draft.runsPerPeriod ?? 4} onChange={(event) => update({ ...draft, runsPerPeriod: Math.max(1, Number(event.target.value) || 1) })} />
      </div> : null}
    </> : null}
    <div className="popover-footer"><span /><button type="button" className="btn small" onClick={close}>Done</button></div>
  </Popover>;
}

type Open = { kind: 'agent'; id: string; rect: DOMRect } | { kind: 'finisher' | 'pulse' | 'loop' | 'add'; rect: DOMRect } | null;

export type GhostTag = { key: string; provider?: Provider; handle: string; state: 'joins' | 'unconnected' | 'unknown' };

export function useTeamPopovers(team: TeamConfig, connections: AIConnectionView[], onChange: (team: TeamConfig) => void, onConnect: () => void) {
  const [open, setOpen] = useState<Open>(null);
  const removeAgent = (id: string) => onChange({ ...team, agents: team.agents.filter((agent) => agent.id !== id) });
  const agent = open?.kind === 'agent' ? team.agents.find((item) => item.id === open.id) : undefined;
  const element = <>
    {agent && open?.kind === 'agent' ? <AgentSettings
      key={agent.id}
      agent={agent}
      anchor={open.rect}
      connections={connections}
      onConnect={onConnect}
      onClose={() => setOpen(null)}
      onRemove={() => removeAgent(agent.id)}
      onSave={(next) => onChange({ ...team, agents: team.agents.map((item) => item.id === next.id ? next : item) })}
    /> : null}
    {open?.kind === 'finisher' ? <FinisherSettings team={team} anchor={open.rect} connections={connections} onConnect={onConnect} onClose={() => setOpen(null)} onSave={(next) => onChange({ ...team, finisher: next })} /> : null}
    {open?.kind === 'pulse' ? <PulseSettings value={team.pulseMinutes} anchor={open.rect} onClose={() => setOpen(null)} onSave={(pulseMinutes) => { onChange({ ...team, pulseMinutes }); setOpen(null); }} /> : null}
    {open?.kind === 'add' ? <AddAgentMenu team={team} anchor={open.rect} connections={connections} onConnect={onConnect} onClose={() => setOpen(null)} onAdd={(provider) => { onChange({ ...team, agents: [...team.agents, newAgent(provider, team, connections)] }); setOpen(null); }} /> : null}
    {open?.kind === 'loop' ? <LoopSettings value={team.loop} anchor={open.rect} onClose={() => setOpen(null)} onSave={(loop) => onChange({ ...team, loop })} /> : null}
  </>;
  return { open, setOpen, element, removeAgent };
}

function AddAgentMenu({ team, anchor, connections, onAdd, onClose, onConnect }: {
  team: TeamConfig;
  anchor: DOMRect;
  connections: AIConnectionView[];
  onAdd: (provider: Provider) => void;
  onClose: () => void;
  onConnect: () => void;
}) {
  return <Popover anchor={anchor} onClose={onClose} width={300}>
    <h4><Glyph name="agents" size={22} />Add an agent</h4>
    <p className="sub">Pick who joins. You can add the same AI as many times as you like.</p>
    <div className="add-menu">
      {PROVIDER_ORDER.map((provider) => {
        const ready = connectedFor(connections, provider).length > 0;
        const count = team.agents.filter((agent) => agent.provider === provider).length;
        return <button
          type="button"
          key={provider}
          className={`add-option ${ready ? '' : 'off'}`}
          onClick={() => { if (ready) onAdd(provider); else { onClose(); onConnect(); } }}
        >
          <ProviderLogo provider={provider} />
          <span className="grow">{PROVIDER_INFO[provider].label}</span>
          {ready ? count ? <small>{count} on team</small> : <Plus size={15} /> : <small>Connect</small>}
        </button>;
      })}
    </div>
  </Popover>;
}

export function TeamRow({ team, connections, tagged, ghosts, onChange, onConnect, setOpen, removeAgent }: {
  team: TeamConfig;
  connections: AIConnectionView[];
  tagged: Set<string>;
  ghosts: GhostTag[];
  onChange: (team: TeamConfig) => void;
  onConnect: () => void;
  setOpen: (open: Open) => void;
  removeAgent: (id: string) => void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: 0, right: 0 });
  const anyConnected = connections.some((item) => item.status === 'connected');
  const finisher = team.finisher;

  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft;
      const end = start + element.clientWidth;
      const pills = [...element.querySelectorAll<HTMLElement>('.agent-pill')];
      setEdges({
        left: pills.filter((pill) => pill.offsetLeft + pill.offsetWidth / 2 < start).length,
        right: pills.filter((pill) => pill.offsetLeft + pill.offsetWidth / 2 > end).length
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, [team.agents.length, ghosts.length]);

  const openAdd = (event: ReactMouseEvent<HTMLElement>) => {
    if (!anyConnected) { onConnect(); return; }
    setOpen({ kind: 'add', rect: event.currentTarget.getBoundingClientRect() });
  };

  return <div className="team-row">
    <span className="label">Agents</span>
    {edges.left ? <button type="button" className="strip-more" title="Show earlier agents" onClick={() => strip.current?.scrollBy({ left: -strip.current.clientWidth * 0.8, behavior: 'smooth' })}><ChevronLeft size={14} />{edges.left}</button> : null}
    <div
      ref={strip}
      className={`agent-strip ${edges.left ? 'fade-left' : ''} ${edges.right ? 'fade-right' : ''}`}
      onWheel={(event) => { const element = strip.current; if (element && Math.abs(event.deltaY) > Math.abs(event.deltaX) && element.scrollWidth > element.clientWidth) element.scrollLeft += event.deltaY; }}
    >
      {team.agents.map((agent) => {
        const connected = resolveChoice(connections, agent).connected;
        return <div key={agent.id} className={`agent-pill ${tagged.has(agent.id) ? 'tagged' : ''} ${connected ? '' : 'offline'}`} title={connected ? `@${agent.handle} · ${modelLabel(connections, agent)}` : `${PROVIDER_INFO[agent.provider].label} isn’t connected`}>
          <ProviderLogo provider={agent.provider} />
          <span className="handle">@{agent.handle}</span>
          <button type="button" className="pill-btn" title={`@${agent.handle} settings`} onClick={(event) => setOpen({ kind: 'agent', id: agent.id, rect: (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect() })}><Settings2 size={13} /></button>
          <button type="button" className="pill-btn remove" title={`Remove @${agent.handle}`} onClick={() => removeAgent(agent.id)}><X size={13} /></button>
        </div>;
      })}
      {ghosts.map((ghost) => ghost.state === 'joins' && ghost.provider
        ? <div key={ghost.key} className="agent-pill ghost tagged" title="Joins when you send"><ProviderLogo provider={ghost.provider} /><span className="handle">@{ghost.handle}</span></div>
        : <div key={ghost.key} className="agent-pill bad">@{ghost.handle} · {ghost.state === 'unconnected' ? 'not connected yet' : 'not on your team'}</div>)}
      {anyConnected
        ? <button type="button" className={`add-agent ${team.agents.length ? 'compact' : ''}`} title="Add an agent" onClick={openAdd}><Plus size={14} />{team.agents.length ? null : 'Add an agent'}</button>
        : <button type="button" className="link-btn" onClick={onConnect}><Glyph name="connectAi" size={18} />Connect an AI</button>}
    </div>
    {edges.right ? <button type="button" className="strip-more" title="Show more agents" onClick={() => strip.current?.scrollBy({ left: strip.current.clientWidth * 0.8, behavior: 'smooth' })}>+{edges.right}<ChevronRight size={14} /></button> : null}
    <button type="button" className={`finisher-pill ${finisher?.enabled ? '' : 'off'}`} onClick={(event) => setOpen({ kind: 'finisher', rect: event.currentTarget.getBoundingClientRect() })} title={finisher?.enabled ? `Final check · ${modelLabel(connections, finisher)}` : 'Final check is off'}>
      <img className={`plain-logo ${finisher?.enabled ? '' : 'muted'}`} src={logo} alt="" width={18} height={18} />
      <span className="finisher-text">Final check{finisher?.enabled ? null : <span style={{ fontWeight: 400 }}> · off</span>}</span>
    </button>
  </div>;
}

export function PulseLoopPills({ team, loopLabel, setOpen }: { team: TeamConfig; loopLabel: string; setOpen: (open: Open) => void }) {
  return <>
    <button type="button" className={`mini-pill ${team.pulseMinutes ? 'on' : ''}`} title="How often each agent tells you how it is doing" onClick={(event) => setOpen({ kind: 'pulse', rect: event.currentTarget.getBoundingClientRect() })}><Glyph name="analytics" size={16} className={team.pulseMinutes ? '' : 'muted'} /><span className="pill-text">{team.pulseMinutes ? `Updates: every ${team.pulseMinutes} min` : 'Updates: off'}</span></button>
    <button type="button" className={`mini-pill ${team.loop.mode === 'none' ? '' : 'on'}`} title="Run this again automatically" onClick={(event) => setOpen({ kind: 'loop', rect: event.currentTarget.getBoundingClientRect() })}><Glyph name="history" size={16} className={team.loop.mode === 'none' ? 'muted' : ''} /><span className="pill-text">{loopLabel || loopSummary(team.loop)}</span></button>
  </>;
}
