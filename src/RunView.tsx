import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Maximize2, Minimize2, Paperclip, ShieldCheck, Square, Wrench } from 'lucide-react';
import logo from './assets/logo.png';
import { omni } from './api';
import { ImageGallery, imageSource, isPreviewImage } from './Images';
import { Markdown } from './Markdown';
import { baseName, clock, elapsed, modelName, ProviderLogo, PROVIDER_LOGOS, StatusPill, useNow } from './ui';
import { PROVIDER_INFO, tagPattern, type AIConnectionView, type AgentRunView, type FinisherRunView, type FollowUpView, type Provider, type PulseView, type RunView, type TeamNote } from '../electron/shared';
import { Glyph } from './Glyph';
import { ToolActivity } from './ToolActivity';

export function HighlightedText({ text, known }: { text: string; known?: Map<string, Provider | null> }) {
  const parts: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  const pattern = tagPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[1].length;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), mention: false });
    parts.push({ text: `@${match[2]}`, mention: true });
    cursor = start + 1 + match[2].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false });
  return <>{parts.map((part, index) => {
    if (!part.mention) return <span key={index}>{part.text}</span>;
    const key = part.text.slice(1).toLowerCase();
    if (!known?.has(key)) return <span className="mention" key={index}>{part.text}</span>;
    return <span className="tagword" key={index}>{part.text}</span>;
  })}</>;
}

function Constellation({ run, pulseKey }: { run: RunView; pulseKey: string }) {
  const agents = run.agents;
  const width = 900;
  const side = Math.ceil(agents.length / 2);
  const perRow = side <= 4 ? Math.max(1, side) : Math.min(10, Math.max(4, Math.ceil(side / 3)));
  const rows = Math.max(1, Math.ceil(side / perRow));
  const spacing = Math.min(120, 330 / perRow);
  const showLabels = spacing >= 60;
  const scale = spacing < 52 ? Math.max(0.55, spacing / 66) : 1;
  const rowGap = showLabels ? 66 : 54 * scale;
  const height = 150 + (rows - 1) * rowGap;
  const cx = width / 2;
  const cy = 64 + (rows - 1) * rowGap / 2;
  const labelChars = Math.max(6, Math.floor(spacing / 7.4) - 1);
  const nodes = agents.map((agent, index) => {
    const left = index % 2 === 0;
    const slot = Math.floor(index / 2);
    const row = Math.floor(slot / perRow);
    const column = slot % perRow;
    const x = left ? cx - 130 - column * spacing : cx + 130 + column * spacing;
    return { agent, x, y: cy + (row - (rows - 1) / 2) * rowGap };
  });
  const finishing = run.finisher?.status === 'working';
  const live = run.status === 'running' || run.status === 'finishing';
  return <svg className="constellation" viewBox={`0 0 ${width} ${height}`} style={{ height: Math.round(152 * height / 150) }} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <defs>
      <linearGradient id="flowGradient" x1="0" x2="1">
        <stop offset="0" stopColor="#0b5cff" />
        <stop offset="1" stopColor="#46d1ff" />
      </linearGradient>
      <radialGradient id="coreGlow">
        <stop offset="0" stopColor="#2f9bff" stopOpacity=".45" />
        <stop offset="1" stopColor="#2f9bff" stopOpacity="0" />
      </radialGradient>
      <clipPath id="nodeClip"><circle r="15" cx="0" cy="0" /></clipPath>
    </defs>
    {nodes.map(({ agent, x, y }) => {
      const mid = (x + cx) / 2;
      const d = `M ${x} ${y} C ${mid} ${y - 34}, ${mid} ${cy - 34}, ${cx} ${cy}`;
      return <path key={`link-${agent.agentId}`} d={d} className={`link ${agent.status === 'working' ? 'flow' : agent.status === 'done' ? 'done' : ''}`} />;
    })}
    <circle cx={cx} cy={cy} r={54} fill="url(#coreGlow)" opacity={live ? 1 : 0.5} />
    <circle cx={cx} cy={cy} r={34} className={`core-ring ${finishing ? 'spin' : ''}`} />
    <circle cx={cx} cy={cy} r={27} className="core-ring" />
    <image href={logo} x={cx - 20} y={cy - 20} width={40} height={40} />
    {pulseKey ? <circle key={pulseKey} cx={cx} cy={cy} r={20} className="pulse-wave" /> : null}
    <text x={cx} y={cy + 56} textAnchor="middle" className="node-label">{finishing ? 'Final check' : run.finisher?.status === 'done' ? 'Checked' : 'OmniAgent'}</text>
    {nodes.map(({ agent, x, y }) => {
      return <g key={agent.agentId} transform={`translate(${x} ${y}) scale(${scale})`}>
        <circle r={23} className={`node-ring ${agent.status}`} />
        <circle r={17} fill="#f4f6fb" />
        <image href={PROVIDER_LOGOS[agent.provider]} x={-11} y={-11} width={22} height={22} />
        {agent.status === 'done' ? <g transform="translate(14 -14)"><circle r={7} fill="#1f7bff" /><path d="M -3 0 L -1 2.5 L 3.5 -2.5" stroke="#ffffff" strokeWidth={1.8} fill="none" strokeLinecap="round" /></g> : null}
        {showLabels ? <text y={40} textAnchor="middle" className="node-label">@{agent.handle.length > labelChars ? `${agent.handle.slice(0, labelChars - 1)}…` : agent.handle}</text> : null}
      </g>;
    })}
  </svg>;
}

function AgentCard({ agent, model, sessionId, runId, live }: { agent: AgentRunView; model: string; sessionId: string; runId: string; live: boolean }) {
  const now = useNow(1_000, agent.status === 'working');
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const messages = agent.final ? agent.messages.filter((message) => message.text !== agent.final) : agent.messages;
  useEffect(() => {
    const body = bodyRef.current;
    if (body && agent.status === 'working') body.scrollTop = body.scrollHeight;
  }, [agent.messages.length, agent.partial, agent.steps.length, agent.status]);
  return <article className={`agent-card ${agent.status} ${expanded ? 'expanded' : ''}`}>
    <header className="agent-head">
      <ProviderLogo provider={agent.provider} size="large" />
      <div className="who">
        <strong>@{agent.handle}</strong>
        <small>{model || PROVIDER_INFO[agent.provider].label}</small>
      </div>
      <StatusPill status={agent.status} />
      {agent.status === 'working' && live ? <button type="button" className="icon-btn small" title={`Stop @${agent.handle}`} onClick={() => void omni.stopAgent(sessionId, agent.agentId)}><Square size={13} /></button> : null}
    </header>
    {agent.assignment ? <p className="assignment"><b>Task</b>{agent.assignment}</p> : null}
    {agent.status === 'working' ? <div className="activity-line"><span className="spinner" /><span className="shimmer">{agent.activity || 'Working'}</span></div> : null}
    <div className="agent-body" ref={bodyRef}>
      <ToolActivity steps={agent.steps} live={agent.status === 'working'} runId={runId} ownerId={agent.agentId} />
      {agent.reasoning && agent.status === 'working' ? <div className="message partial"><small className="field-label">Thinking</small><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{agent.reasoning.slice(-600)}</p></div> : null}
      {messages.map((message, index) => <div className="message" key={`${message.at}-${index}`}><Markdown content={message.text} /></div>)}
      {agent.partial ? <div className="message partial"><Markdown content={agent.partial} /></div> : null}
      {agent.final ? <div className="message final"><div className="final-label"><ShieldCheck size={13} />Result</div><Markdown content={agent.final} /></div> : null}
      {agent.error ? <div className="error-box">{agent.error}</div> : null}
    </div>
    <footer className="agent-foot">
      <span>{agent.startedAt ? elapsed(agent.startedAt, agent.finishedAt, now) : 'Waiting'}</span>
      {agent.turns > 1 ? <span>· {agent.turns} turns</span> : null}
      <span className="grow" />
      <button type="button" className="icon-btn small" title={expanded ? 'Collapse' : 'Expand'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
    </footer>
  </article>;
}

function PulseCard({ pulse }: { pulse: PulseView }) {
  const [all, setAll] = useState(false);
  const limit = 6;
  const reports = all ? pulse.reports : pulse.reports.slice(0, limit);
  const awaiting = all ? pulse.awaiting : pulse.awaiting.slice(0, Math.max(0, limit - reports.length));
  const hidden = pulse.reports.length + pulse.awaiting.length - reports.length - awaiting.length;
  return <section className="pulse-card">
    <div className="pulse-head">
      <Glyph name="analytics" size={30} />
      <div className="who"><strong>Progress update</strong><small>{clock(pulse.at)}</small></div>
    </div>
    {reports.map((report) => <div className="pulse-row" key={report.agentId}>
      <ProviderLogo provider={report.provider} />
      <div className="pulse-body"><span className="who">@{report.handle}{report.source === 'activity' ? <span className="auto-tag" title="It was busy, so this is what it was doing at that moment">busy</span> : null}</span><Markdown content={report.text} /></div>
    </div>)}
    {awaiting.map((handle) => <div className="pulse-row" key={`awaiting-${handle}`}>
      <span className="logo-badge" style={{ background: 'transparent' }} />
      <div className="pulse-body"><span className="who">@{handle}</span><span className="typing"><i /><i /><i /></span></div>
    </div>)}
    {hidden > 0 || (all && pulse.reports.length + pulse.awaiting.length > limit) ? <button type="button" className="show-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${hidden} more`}</button> : null}
  </section>;
}

function NoteRow({ note }: { note: TeamNote }) {
  const from = note.provider === 'Finisher' ? 'Final check' : `@${note.handle}`;
  return <div className={`note-row ${note.to ? 'direct' : ''}`}>
    {note.provider === 'Finisher' ? <img className="plain-logo" src={logo} alt="" width={22} height={22} /> : <ProviderLogo provider={note.provider} />}
    <div className="note-body">
      <div className="note-head"><strong>{from}</strong><span className="note-arrow">→</span><strong>{note.error ? 'you' : note.to ? `@${note.to}` : 'everyone'}</strong><time>{clock(note.at)}</time></div>
      {note.error ? <div className="error-box">{note.text}</div> : <Markdown content={note.text} />}
    </div>
  </div>;
}

function FollowUpRow({ followUp }: { followUp: FollowUpView }) {
  const label = { live: 'got it right away', queued: 'will see it in a moment', 'new-turn': 'started on it' };
  const files = followUp.attachments ?? [];
  return <div className="followup-row">
    <div className="followup-bubble"><HighlightedText text={followUp.text} /></div>
    {files.length ? <div className="brief-attachments followup-attachments">
      <ImageGallery size="medium" images={files.filter((item) => isPreviewImage(item.name)).map((item) => imageSource(item.path, item.name))} />
      {files.filter((item) => !isPreviewImage(item.name)).map((item) => <button type="button" className="file-chip" key={item.path} onClick={() => void omni.openPath(item.path)}><Paperclip size={12} /><span>{item.name}</span></button>)}
    </div> : null}
    <div className="delivery">{followUp.delivered.map((item) => <span key={item.handle}>@{item.handle} · {label[item.how]}</span>)}<span>{clock(followUp.at)}</span></div>
  </div>;
}

function FinisherCard({ finisher, model, runId }: { finisher: FinisherRunView; model: string; runId: string }) {
  const now = useNow(1_000, finisher.status === 'working');
  const verdictLabel = { complete: 'All good', fixed: 'Fixed · all good', incomplete: 'Not done', '': '' }[finisher.verdict];
  return <section className={`finisher-card ${finisher.status}`}>
    <div className="finisher-inner">
      <div className="finisher-head">
        <img className="plain-logo" src={logo} alt="" width={34} height={34} />
        <div className="who">
          <strong>Final check {finisher.rounds > 1 ? <span className="round-tag">check {finisher.round} of {finisher.rounds}</span> : null}</strong>
          <small>{model || PROVIDER_INFO[finisher.provider].label} · {elapsed(finisher.startedAt, finisher.finishedAt, now)}</small>
        </div>
        {finisher.verdict ? <span className={`stamp ${finisher.verdict}`}><Glyph name={finisher.verdict === 'incomplete' ? 'failed' : 'completed'} size={15} />{verdictLabel}</span> : <StatusPill status={finisher.status} label={finisher.status === 'working' ? 'Checking' : undefined} />}
      </div>
      {finisher.status === 'working' ? <div className="activity-line" style={{ margin: '0 0 8px' }}><span className="spinner" /><span className="shimmer">{finisher.activity}</span></div> : null}
      <ToolActivity steps={finisher.steps} live={finisher.status === 'working'} runId={runId} ownerId="finisher" />
      {finisher.fixes.length ? <div className="fix-list">{finisher.fixes.map((fix, index) => <div className="fix-item" key={index}><Wrench size={12} /><span>Sent back to <strong>@{fix.handle}</strong>: {fix.instructions}</span></div>)}</div> : null}
      {finisher.partial && finisher.status === 'working' ? <div className="message partial"><Markdown content={finisher.partial} /></div> : null}
      {finisher.final ? <Markdown content={finisher.final} /> : null}
      {finisher.error ? <div className="error-box">{finisher.error}</div> : null}
    </div>
  </section>;
}

const FILE_MANAGER = window.omni?.platform === 'darwin' ? 'Finder' : window.omni?.platform === 'win32' ? 'File Explorer' : 'your file manager';

function FolderButton({ files, workspace, demo }: { files: number; workspace: string; demo?: boolean }) {
  const [problem, setProblem] = useState('');
  const name = workspace ? baseName(workspace) : 'launch-kit';
  return <div className="folder-cta-wrap">
    <button type="button" className="folder-cta" disabled={demo} onClick={() => {
      setProblem('');
      void omni.openPath(workspace).catch(() => setProblem('That folder is no longer there.'));
    }}>
      <Glyph name="openFolder" size={34} />
      <span className="folder-cta-copy">
        <strong>Open in {FILE_MANAGER}</strong>
        <small>{problem || `${name}${files ? ` · ${files} file${files === 1 ? '' : 's'} made or changed` : ''}`}</small>
      </span>
      <ArrowUpRight size={18} className="folder-cta-arrow" />
    </button>
  </div>;
}

export function RunBlock({ run, workspace, pulseKey, demo, connections = [] }: { run: RunView; workspace: string; pulseKey: string; demo?: boolean; connections?: AIConnectionView[] }) {
  const live = run.status === 'running' || run.status === 'finishing';
  const now = useNow(1_000, live);
  const events = useMemo(() => {
    const items: Array<{ at: string; key: string; node: JSX.Element }> = [];
    for (const pulse of run.pulses) if (pulse.reports.length || pulse.awaiting.length) items.push({ at: pulse.at, key: pulse.id, node: <PulseCard pulse={pulse} key={pulse.id} /> });
    for (const note of run.notes) items.push({ at: note.at, key: note.id, node: <NoteRow note={note} key={note.id} /> });
    for (const followUp of run.followUps) items.push({ at: followUp.at, key: followUp.id, node: <FollowUpRow followUp={followUp} key={followUp.id} /> });
    return items.sort((left, right) => left.at.localeCompare(right.at));
  }, [run.pulses, run.notes, run.followUps]);
  const working = run.agents.filter((agent) => agent.status === 'working').length;
  const statusText = run.status === 'finishing' ? 'Doing a final check of everything'
    : run.status === 'running' ? (working ? `${working} agent${working === 1 ? ' is' : 's are'} working on it` : 'Wrapping up')
      : run.status === 'done' ? 'Done' : run.status === 'stopped' ? 'Stopped' : 'Something went wrong';
  const showPulseBanner = Boolean(pulseKey) && live;
  const [promptOpen, setPromptOpen] = useState(false);
  const longPrompt = run.prompt.length > 600 || run.prompt.split('\n').length > 8;
  const madeImages = useMemo(() => run.files.filter((file) => isPreviewImage(file)).slice(0, 12).map((file) => imageSource(file)), [run.files]);
  const known = new Map<string, Provider | null>([
    ...['all', 'team', 'everyone', 'everybody'].map((word) => [word, null] as [string, null]),
    ...run.agents.flatMap((agent) => [agent.handle.toLowerCase(), ...PROVIDER_INFO[agent.provider].aliases].map((name) => [name, agent.provider] as [string, Provider]))
  ]);
  return <div className="run">
    <div className="brief">
      <div className="brief-meta"><span className="label">You asked</span><span className="label" style={{ color: 'var(--faint)' }}>{clock(run.startedAt)}</span>{run.loopIteration ? <span className="badge muted">loop run {run.loopIteration + 1}</span> : null}</div>
      <div className={`brief-text ${longPrompt && !promptOpen ? 'clamped' : ''}`}><HighlightedText text={run.prompt} known={known} /></div>
      {longPrompt ? <button type="button" className="show-more" onClick={() => setPromptOpen(!promptOpen)}>{promptOpen ? 'Show less' : 'Show the whole message'}</button> : null}
      {run.attachments.length ? <div className="brief-attachments">
        <ImageGallery size="medium" images={run.attachments.filter((item) => isPreviewImage(item.name)).map((item) => imageSource(item.path, item.name))} />
        {run.attachments.filter((item) => !isPreviewImage(item.name)).map((item) => <button type="button" className="file-chip" key={item.path} onClick={() => void omni.openPath(item.path)}><Paperclip size={12} /><span>{item.name}</span></button>)}
      </div> : null}
    </div>
    <section className="stage">
      {showPulseBanner ? <div className="pulse-banner" key={pulseKey}>PROGRESS UPDATE</div> : null}
      <div className="stage-head">
        <span className="status">{live ? <span className="live-dot" /> : <Glyph name={run.status === 'done' ? 'completed' : run.status === 'stopped' ? 'stopped' : 'failed'} size={18} className={run.status === 'stopped' ? 'dim' : ''} />}{statusText}</span>
        <span className="elapsed">{elapsed(run.startedAt, run.finishedAt, now)}</span>
      </div>
      <Constellation run={run} pulseKey={live ? pulseKey : ''} />
      <div className="agents-grid">
        {run.agents.map((agent) => <AgentCard agent={agent} model={modelName(connections, agent.provider, agent.model)} sessionId={run.sessionId} runId={run.id} live={live && !demo} key={agent.agentId} />)}
      </div>
      {events.length ? <div className="events">{events.map((item) => item.node)}</div> : null}
      {run.finisher ? <div className="events"><FinisherCard finisher={run.finisher} model={modelName(connections, run.finisher.provider, run.finisher.model)} runId={run.id} /></div> : null}
      {!live && madeImages.length ? <div className="made-images"><span className="label">Images made</span><ImageGallery images={madeImages} /></div> : null}
      {!live ? <FolderButton files={run.files.length} workspace={workspace} demo={demo} /> : null}
    </section>
  </div>;
}
