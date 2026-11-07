import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, FolderSync, Paperclip, Square, Users, X } from 'lucide-react';
import { Glyph } from './Glyph';
import { errorMessage, omni } from './api';
import { ImageGallery, imageSource, isPreviewImage } from './Images';
import { connectedFor, modelLabel, ProviderLogo } from './ui';
import { PulseLoopPills, TeamRow, useTeamPopovers, type GhostTag } from './Team';
import { PROVIDER_INFO, PROVIDER_ORDER, tagPattern, type AgentConfig, type AIConnectionView, type Provider, type TeamConfig } from '../electron/shared';

type Resolved =
  | { kind: 'agent'; agent: AgentConfig; start: number; end: number }
  | { kind: 'all'; start: number; end: number }
  | { kind: 'new'; provider: Provider; start: number; end: number }
  | { kind: 'unconnected'; provider: Provider; start: number; end: number }
  | { kind: 'unknown'; handle: string; start: number; end: number };

const ALL_WORDS = ['all', 'team', 'everyone', 'everybody'];

function resolveMentions(text: string, team: TeamConfig, connections: AIConnectionView[]): Resolved[] {
  const results: Resolved[] = [];
  const pattern = tagPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index + match[1].length;
    const handle = match[2].replace(/[.-]+$/, '');
    const end = start + 1 + handle.length;
    const lowered = handle.toLowerCase();
    if (ALL_WORDS.includes(lowered)) {
      results.push({ kind: 'all', start, end });
      continue;
    }
    const exact = team.agents.find((agent) => agent.handle.toLowerCase() === lowered);
    if (exact) {
      results.push({ kind: 'agent', agent: exact, start, end });
      continue;
    }
    const provider = PROVIDER_ORDER.find((candidate) => PROVIDER_INFO[candidate].aliases.includes(lowered));
    const byProvider = provider ? team.agents.find((agent) => agent.provider === provider) : undefined;
    if (byProvider) results.push({ kind: 'agent', agent: byProvider, start, end });
    else if (provider && connectedFor(connections, provider).length) results.push({ kind: 'new', provider, start, end });
    else if (provider) results.push({ kind: 'unconnected', provider, start, end });
    else results.push({ kind: 'unknown', handle, start, end });
  }
  return results;
}

type Option = { key: string; insert: string; title: string; detail: string; provider?: Provider };

export function Composer({ team, onTeamChange, connections, running, workspace, workspaceMissing, workspaceLocked, onPickWorkspace, onSend, onStop, workingAgents = [], onStopAgent, onOpenConnections, loopLabel, prefill, onPrefillUsed, autoFocus }: {
  team: TeamConfig;
  onTeamChange: (team: TeamConfig) => void;
  connections: AIConnectionView[];
  running: boolean;
  workspace: string;
  workspaceMissing?: boolean;
  workspaceLocked?: boolean;
  onPickWorkspace: () => Promise<void> | void;
  onSend: (text: string, attachments: Array<{ path: string; name: string }>) => Promise<void | boolean>;
  onStop?: () => Promise<void>;
  workingAgents?: Array<{ agentId: string; handle: string; provider: Provider }>;
  onStopAgent?: (agentId: string) => Promise<void>;
  onOpenConnections: () => void;
  loopLabel: string;
  prefill: string;
  onPrefillUsed: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stoppingAgents, setStoppingAgents] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const popovers = useTeamPopovers(team, connections, onTeamChange, onOpenConnections);

  useEffect(() => { if (autoFocus) textareaRef.current?.focus(); }, [autoFocus]);

  useEffect(() => {
    if (!prefill) return;
    setText(prefill);
    setError('');
    onPrefillUsed();
    window.setTimeout(() => {
      const area = textareaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(prefill.length, prefill.length);
      setCaret(prefill.length);
    }, 0);
  }, [prefill, onPrefillUsed]);

  useEffect(() => { if (!running) setStopping(false); }, [running]);

  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(280, Math.max(56, area.scrollHeight))}px`;
    if (mirrorRef.current) mirrorRef.current.scrollTop = area.scrollTop;
  }, [text]);

  const allMentions = useMemo(() => resolveMentions(text, team, connections), [text, team, connections]);
  const mentions = useMemo(() => allMentions.filter((mention) => !(focused && (mention.kind === 'unknown' || mention.kind === 'unconnected') && mention.end === caret)), [allMentions, focused, caret]);

  const tagged = useMemo(() => {
    const ids = new Set<string>();
    for (const mention of mentions) {
      if (mention.kind === 'agent') ids.add(mention.agent.id);
      if (mention.kind === 'all') for (const agent of team.agents) ids.add(agent.id);
    }
    return ids;
  }, [mentions, team.agents]);

  const ghosts = useMemo<GhostTag[]>(() => {
    const seen = new Set<string>();
    const list: GhostTag[] = [];
    for (const mention of mentions) {
      if (mention.kind === 'new' || mention.kind === 'unconnected') {
        const key = `${mention.kind}-${mention.provider}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ key, provider: mention.provider, handle: PROVIDER_INFO[mention.provider].handle, state: mention.kind === 'new' ? 'joins' : 'unconnected' });
      } else if (mention.kind === 'unknown') {
        const key = `unknown-${mention.handle.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ key, handle: mention.handle, state: 'unknown' });
      }
    }
    return list;
  }, [mentions]);

  const query = useMemo(() => {
    const before = text.slice(0, caret);
    const match = before.match(/(^|[^\w@])@([\w.-]{0,40})$/);
    return match ? { value: match[2], start: before.length - match[2].length - 1 } : null;
  }, [text, caret]);

  const options = useMemo<Option[]>(() => {
    if (!query || menuDismissed) return [];
    const lowered = query.value.toLowerCase();
    const list: Option[] = [];
    for (const agent of team.agents) {
      if (!agent.handle.toLowerCase().startsWith(lowered) && !PROVIDER_INFO[agent.provider].aliases.some((alias) => alias.startsWith(lowered))) continue;
      list.push({ key: agent.id, insert: agent.handle, title: `@${agent.handle}`, detail: `${PROVIDER_INFO[agent.provider].label} · ${modelLabel(connections, agent)}`, provider: agent.provider });
    }
    for (const provider of PROVIDER_ORDER) {
      if (team.agents.some((agent) => agent.provider === provider)) continue;
      if (!connectedFor(connections, provider).length) continue;
      const handle = PROVIDER_INFO[provider].handle;
      if (!handle.toLowerCase().startsWith(lowered) && !PROVIDER_INFO[provider].aliases.some((alias) => alias.startsWith(lowered))) continue;
      list.push({ key: `new-${provider}`, insert: handle, title: `@${handle}`, detail: 'will join when you send', provider });
    }
    if (team.agents.length > 1 && 'all'.startsWith(lowered)) list.push({ key: 'all', insert: 'all', title: '@all', detail: 'every agent on your team' });
    return list.slice(0, 8);
  }, [query, team.agents, connections, menuDismissed]);

  useEffect(() => { setMenuIndex(0); }, [query?.value, options.length]);

  const choose = (option: Option) => {
    if (!query) return;
    const next = `${text.slice(0, query.start)}@${option.insert} ${text.slice(caret)}`;
    const position = query.start + option.insert.length + 2;
    setText(next);
    window.setTimeout(() => {
      const area = textareaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(position, position);
      setCaret(position);
    }, 0);
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || sending) return;
    const unconnected = allMentions.find((mention) => mention.kind === 'unconnected');
    if (unconnected && unconnected.kind === 'unconnected') {
      setError(`${PROVIDER_INFO[unconnected.provider].label} isn’t connected yet. Connect it in Settings → AI accounts, then send again.`);
      return;
    }
    const hasTarget = allMentions.some((mention) => mention.kind === 'agent' || mention.kind === 'all' || mention.kind === 'new');
    if (!running && !hasTarget) {
      const unknown = allMentions.find((mention) => mention.kind === 'unknown');
      const example = team.agents[0]?.handle ?? 'ChatGPT';
      setError(unknown && unknown.kind === 'unknown'
        ? `No agent is called @${unknown.handle}. Must tag a model like "Hey @${example} get this done".`
        : `Must tag a model like "Hey @${example} get this done".`);
      return;
    }
    setSending(true);
    setError('');
    try {
      const sent = await onSend(value, attachments);
      if (sent !== false) {
        setText('');
        setAttachments([]);
        setCaret(0);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setMenuIndex((index) => (index + 1) % options.length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setMenuIndex((index) => (index - 1 + options.length) % options.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(options[menuIndex]); return; }
      if (event.key === 'Escape') { event.preventDefault(); setMenuDismissed(true); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const addFiles = (files: Array<{ path: string; name: string }>) => {
    setAttachments((current) => {
      const merged = [...current];
      for (const file of files) if (file.path && !merged.some((item) => item.path === file.path)) merged.push(file);
      return merged.slice(0, 20);
    });
  };

  const mirror = useMemo(() => {
    const parts: JSX.Element[] = [];
    let cursor = 0;
    mentions.forEach((mention, index) => {
      if (mention.start > cursor) parts.push(<span key={`t-${index}`}>{text.slice(cursor, mention.start)}</span>);
      const raw = text.slice(mention.start, mention.end);
      const tone = mention.kind === 'unknown' || mention.kind === 'unconnected' ? 'bad' : '';
      parts.push(<mark key={`m-${mention.start}-${raw}`} className={tone}>
        {raw}
      </mark>);
      cursor = mention.end;
    });
    parts.push(<span key="tail">{text.slice(cursor)}{'​'}</span>);
    return parts;
  }, [mentions, text]);

  const example = team.agents[0]?.handle ?? 'ChatGPT';
  const placeholder = running
    ? 'Send the agents a message while they work — @mention one, or leave it for everyone'
    : `Say what you want and @mention which agent does what — e.g. “@${example} make me a logo”`;
  const folderTail = workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;

  return <div className="capsule-wrap no-drag">
    {error ? <div className="composer-error"><CircleAlert size={16} /><span style={{ flex: 1 }}>{error}</span><button type="button" className="icon-btn small" onClick={() => setError('')}><X size={14} /></button></div> : null}
    <div
      className={`capsule ${focused ? 'focused' : ''} ${running ? 'running' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files].map((file) => ({ path: omni.pathForFile(file), name: file.name })));
      }}
    >
      {options.length && focused ? <div className="mention-menu">
        <span className="label">Choose an agent</span>
        {options.map((option, index) => <button type="button" key={option.key} className={`mention-item ${index === menuIndex ? 'on' : ''}`} onMouseDown={(event) => { event.preventDefault(); choose(option); }} onMouseEnter={() => setMenuIndex(index)}>
          {option.provider ? <ProviderLogo provider={option.provider} /> : <span className="logo-badge" style={{ background: 'var(--mention-bg)' }}><Users size={13} /></span>}
          <span className="who"><strong>{option.title}</strong><small>{option.detail}</small></span>
          {index === menuIndex ? <kbd>↵</kbd> : null}
        </button>)}
      </div> : null}
      <TeamRow team={team} connections={connections} tagged={tagged} ghosts={ghosts} onChange={onTeamChange} onConnect={onOpenConnections} setOpen={popovers.setOpen} removeAgent={popovers.removeAgent} />
      {attachments.length ? <div className="attachments">
        <ImageGallery size="small" images={attachments.filter((file) => isPreviewImage(file.name)).map((file) => imageSource(file.path, file.name))} onRemove={(image) => setAttachments((current) => current.filter((item) => item.path !== image.path))} />
        {attachments.filter((file) => !isPreviewImage(file.name)).map((file) => <span className="attachment" key={file.path}><Paperclip size={12} /><span>{file.name}</span><button type="button" className="icon-btn small" onClick={() => setAttachments((current) => current.filter((item) => item.path !== file.path))}><X size={12} /></button></span>)}
      </div> : null}
      <div className="editor">
        <div className="editor-mirror" ref={mirrorRef} aria-hidden="true">{mirror}</div>
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          placeholder={placeholder}
          onChange={(event) => { setText(event.target.value); setCaret(event.target.selectionStart); setMenuDismissed(false); if (error) setError(''); }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (!files.length) return;
            if (!event.clipboardData.types.includes('text/plain')) event.preventDefault();
            void Promise.all(files.map(async (file) => {
              const existing = omni.pathForFile(file);
              return existing ? { path: existing, name: file.name } : omni.saveClipboardFile(file.name || 'image.png', new Uint8Array(await file.arrayBuffer()));
            })).then(addFiles).catch(() => setError('Couldn’t attach what you pasted. Try dragging the file in instead.'));
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onScroll={(event) => { if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop; }}
          spellCheck
        />
      </div>
      <div className="tool-row">
        <button type="button" className={`ws-chip ${workspace ? '' : 'empty'} ${workspaceMissing ? 'missing' : ''}`} onClick={() => { if (workspace && workspaceLocked) void omni.openPath(workspace).catch(() => undefined); else void onPickWorkspace(); }}>
          <Glyph name="openFolder" size={17} />
          <span>{workspace ? (workspaceMissing ? `${folderTail} (missing)` : folderTail) : 'New project'}</span>
        </button>
        {workspace && workspaceLocked && !running ? <button type="button" className="icon-btn small" title="Use a different folder" onClick={() => void onPickWorkspace()}><FolderSync size={14} /></button> : null}
        <PulseLoopPills team={team} loopLabel={loopLabel} setOpen={popovers.setOpen} />
        <span className="spacer" />
        <button type="button" className="icon-btn" title="Attach files" onClick={() => void omni.chooseFiles().then((files) => addFiles(files.map((file) => ({ path: file.path, name: file.name }))))}><Paperclip size={17} /></button>
        {running && onStop ? <div className="stop-wrap">
          {workingAgents.length && onStopAgent && !stopping ? <div className="stop-menu">
            <span className="label">Stop one agent</span>
            {workingAgents.map((agent) => {
              const busy = stoppingAgents.includes(agent.agentId);
              return <button type="button" className="stop-item" key={agent.agentId} disabled={busy} onClick={() => {
                setStoppingAgents((current) => [...current, agent.agentId]);
                void onStopAgent(agent.agentId).catch((failure) => setError(errorMessage(failure))).finally(() => setStoppingAgents((current) => current.filter((id) => id !== agent.agentId)));
              }}>
                <ProviderLogo provider={agent.provider} />
                <span className="who"><strong>@{agent.handle}</strong><small>{busy ? 'Stopping…' : 'Working'}</small></span>
                <span className="stop-square"><Square size={11} /></span>
              </button>;
            })}
          </div> : null}
          <button type="button" className={`stop-btn ${stopping ? 'stopping' : ''}`} disabled={stopping} title="Stop every agent that is working right now" onClick={() => { setStopping(true); void onStop().finally(() => setStopping(false)); }}>
            <span className="stop-icon"><Glyph name="stopped" size={22} /></span>
            {stopping ? 'Stopping…' : 'Stop all'}
          </button>
        </div> : null}
        <button type="button" className="send-orb" title="Send" disabled={!text.trim() || sending} onClick={() => void submit()}>{sending ? <span className="spinner" /> : <ArrowUp size={19} strokeWidth={2.6} />}</button>
      </div>
      {popovers.element}
    </div>
    <div className="capsule-hint">
      <span>Type <b>@</b> to choose an agent · click <b>⚙</b> to change its model</span>
      <span>{running ? 'Messages without an @ go to every agent that is working' : <><b>Enter</b> to send · <b>Shift + Enter</b> for a new line</>}</span>
    </div>
  </div>;
}
