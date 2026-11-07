import { useEffect, useRef, useState } from 'react';
import { Plus, Repeat, Trash2 } from 'lucide-react';
import logo from './assets/logo.png';
import { omni } from './api';
import { Glyph } from './Glyph';
import { relativeDay } from './ui';
import type { SessionView } from '../electron/shared';

function ProjectRow({ session, active, onOpen, onDelete }: { session: SessionView; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const row = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (active) row.current?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const commit = () => {
    setEditing(false);
    const value = title.trim();
    if (value && value !== session.title) void omni.updateSession({ id: session.id, title: value });
    else setTitle(session.title);
  };
  return <div
    ref={row}
    role="button"
    tabIndex={0}
    className={`project ${active ? 'active' : ''}`}
    onClick={onOpen}
    onDoubleClick={() => { setTitle(session.title); setEditing(true); }}
    onKeyDown={(event) => { if (event.key === 'Enter' && !editing) onOpen(); }}
  >
    <span className="project-main">
      {editing
        ? <input className="project-rename" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commit} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') { setTitle(session.title); setEditing(false); } }} />
        : <span className="project-title">{session.running ? <i className="live-dot" /> : session.nextLoopAt ? <Repeat size={11} className="loop-mark" /> : null}<span className="project-name">{session.title}</span></span>}
      {(() => {
        const folder = session.workspace.split(/[\\/]/).filter(Boolean).pop() ?? '';
        const meta = session.running ? 'Agents working' : session.loopLabel || (folder.toLowerCase() === session.title.toLowerCase() ? '' : folder);
        return meta ? <span className="project-meta">{meta}</span> : null;
      })()}
    </span>
    <span className="project-time">{relativeDay(session.updatedAt)}</span>
    <button type="button" className="icon-btn small project-delete" title="Delete project" onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
  </div>;
}

export function Sidebar({ open, sessions, activeId, onOpen, onNew, onDelete, onHome, onSettings }: {
  open: boolean;
  sessions: SessionView[];
  activeId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (session: SessionView) => void;
  onHome: () => void;
  onSettings: () => void;
}) {
  const working = sessions.filter((session) => session.running);
  const rest = sessions.filter((session) => !session.running);
  const row = (session: SessionView) => <ProjectRow key={session.id} session={session} active={session.id === activeId} onOpen={() => onOpen(session.id)} onDelete={() => onDelete(session)} />;

  return <aside className={`sidebar ${open ? '' : 'collapsed'}`} aria-hidden={!open}>
    <div className="sidebar-inner">
      <button type="button" className="sidebar-brand" title="Start screen" onClick={onHome}><img src={logo} alt="" /><span>OmniAgent <b className="edition-name core">Core</b></span></button>
      <button type="button" className="sidebar-new" onClick={onNew}><Plus size={16} />New project</button>
      <nav className="projects">
        {working.length ? <><span className="label">Working now</span>{working.map(row)}</> : null}
        {rest.length ? <><span className="label">Projects</span>{rest.map(row)}</> : null}
        {!sessions.length ? <p className="projects-empty">Your projects show up here. Each one works inside one folder on your computer.</p> : null}
      </nav>
      <button type="button" className="sidebar-settings" onClick={onSettings}><Glyph name="settings" size={20} />Settings</button>
    </div>
  </aside>;
}
