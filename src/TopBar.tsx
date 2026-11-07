import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, PanelLeft, Plus, Repeat, X } from 'lucide-react';
import { IS_MAC, MOD } from './shortcuts';
import { baseName, Popover } from './ui';
import type { SessionView } from '../electron/shared';

function TabMark({ session }: { session: SessionView }) {
  return session.running ? <i className="live-dot" /> : session.nextLoopAt ? <Repeat size={11} className="loop-mark" /> : null;
}

export function TopBar({ tabs, activeId, sidebarOpen, canBack, canForward, onToggleSidebar, onBack, onForward, onSelect, onClose, onNew }: {
  tabs: SessionView[];
  activeId: string;
  sidebarOpen: boolean;
  canBack: boolean;
  canForward: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const strip = useRef<HTMLElement | null>(null);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  const [menu, setMenu] = useState<DOMRect | null>(null);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft;
      const end = start + element.clientWidth;
      const items = [...element.querySelectorAll<HTMLElement>('.tab')];
      setHidden({
        left: items.filter((item) => item.offsetLeft + item.offsetWidth / 2 < start).length,
        right: items.filter((item) => item.offsetLeft + item.offsetWidth / 2 > end).length
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const item of element.querySelectorAll('.tab')) observer.observe(item);
    element.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', measure); };
  }, [tabs]);
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);
  const back = IS_MAC ? '⌘←' : 'Alt+←';
  const forward = IS_MAC ? '⌘→' : 'Alt+→';
  const page = (direction: 1 | -1) => strip.current?.scrollBy({ left: direction * strip.current.clientWidth * 0.8, behavior: 'smooth' });
  const overflow = hidden.left + hidden.right > 0;
  return <header className="topbar drag">
    <div className="nav-cluster no-drag">
      <button type="button" className={`icon-btn ${sidebarOpen ? 'on' : ''}`} title={`${sidebarOpen ? 'Hide' : 'Show'} projects (${MOD}+B)`} onClick={onToggleSidebar}><PanelLeft size={17} strokeWidth={1.75} /></button>
      <button type="button" className="icon-btn" title={`Back (${back})`} disabled={!canBack} onClick={onBack}><ArrowLeft size={17} /></button>
      <button type="button" className="icon-btn" title={`Forward (${forward})`} disabled={!canForward} onClick={onForward}><ArrowRight size={17} /></button>
    </div>
    <button type="button" className="new-tab no-drag" title={`New project (${MOD}+N)`} onClick={onNew}><Plus size={16} /></button>
    {hidden.left ? <button type="button" className="tab-more no-drag" aria-label={`Show ${hidden.left} earlier tab${hidden.left === 1 ? '' : 's'}`} onClick={() => page(-1)}><ChevronLeft size={14} />{hidden.left}</button> : null}
    <nav ref={strip} className={`tabs ${hidden.left ? 'fade-left' : ''} ${hidden.right ? 'fade-right' : ''}`} role="tablist" onWheel={(event) => { const element = strip.current; if (element && Math.abs(event.deltaY) > Math.abs(event.deltaX)) element.scrollLeft += event.deltaY; }}>
      {tabs.map((session) => <div
        key={session.id}
        role="tab"
        aria-selected={session.id === activeId}
        className={`tab no-drag ${session.id === activeId ? 'active' : ''}`}
        onClick={() => onSelect(session.id)}
        onMouseDown={(event) => { if (event.button === 1) { event.preventDefault(); onClose(session.id); } }}
      >
        <TabMark session={session} />
        <span className="tab-title">{session.title}</span>
        <button type="button" className="close" aria-label={`Close ${session.title}`} onClick={(event) => { event.stopPropagation(); onClose(session.id); }}><X size={12} /></button>
      </div>)}
    </nav>
    {hidden.right ? <button type="button" className="tab-more no-drag" aria-label={`Show ${hidden.right} more tab${hidden.right === 1 ? '' : 's'}`} onClick={() => page(1)}>{hidden.right}<ChevronRight size={14} /></button> : null}
    {overflow ? <button type="button" className={`tab-list-btn no-drag ${menu ? 'open' : ''}`} aria-label="All open projects" onClick={(event) => setMenu(menu ? null : event.currentTarget.getBoundingClientRect())}><span>{tabs.length}</span><ChevronDown size={14} /></button> : null}
    {menu ? <Popover anchor={menu} width={300} onClose={() => setMenu(null)}>
      <div className="tab-menu-head"><strong>Open projects</strong><small>{tabs.length}</small></div>
      <div className="tab-menu">
        {tabs.map((session) => <div
          key={session.id}
          role="button"
          tabIndex={0}
          className={`tab-menu-row ${session.id === activeId ? 'active' : ''}`}
          onClick={() => { onSelect(session.id); setMenu(null); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { onSelect(session.id); setMenu(null); } }}
        >
          <span className="tab-menu-mark"><TabMark session={session} /></span>
          <span className="grow"><strong>{session.title}</strong>{baseName(session.workspace).toLowerCase() === session.title.toLowerCase() ? null : <small>{baseName(session.workspace)}</small>}</span>
          <button type="button" className="close" aria-label={`Close ${session.title}`} onClick={(event) => { event.stopPropagation(); onClose(session.id); if (tabs.length <= 1) setMenu(null); }}><X size={12} /></button>
        </div>)}
      </div>
    </Popover> : null}
  </header>;
}
