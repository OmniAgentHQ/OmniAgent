import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { errorMessage, omni } from './api';
import { Home, type ProjectRequest } from './Home';
import { ImageViewer } from './Images';
import { NewProjectDialog } from './NewProject';
import { Onboarding } from './Onboarding';
import { SessionView } from './SessionView';
import { SettingsModal, type SettingsPage } from './Settings';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { focusPrompt, IS_MAC } from './shortcuts';
import { PROVIDER_ORDER, type AppSnapshot, type SessionView as Session, type TeamConfig } from '../electron/shared';

type Toast = { id: number; message: string; bad: boolean };
type History = { stack: string[]; index: number };

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { }
}

const NARROW = '(max-width: 900px)';

function accountsPage(snapshot: AppSnapshot): SettingsPage {
  return PROVIDER_ORDER.find((provider) => snapshot.connections.some((item) => item.provider === provider && item.status === 'connected')) ?? 'OpenAI';
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [history, setHistory] = useState<History>(() => ({ stack: [stored('omniagent.view', '')], index: 0 }));
  const [tabs, setTabs] = useState<string[]>(() => stored('omniagent.tabs', []));
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => stored('omniagent.sidebar', true));
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const panelOpen = narrow ? overlayOpen : sidebarOpen;
  const togglePanel = useCallback(() => { if (window.matchMedia(NARROW).matches) setOverlayOpen((open) => !open); else setSidebarOpen((open) => !open); }, []);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<Session | null>(null);
  const [startupError, setStartupError] = useState('');
  const [projectDialog, setProjectDialog] = useState<{ suggestion: string; team?: TeamConfig; resolve: (id: string | null) => void } | null>(null);
  const current = history.stack[history.index] ?? '';

  const notify = useCallback((message: string, bad = false) => {
    const id = Date.now() + Math.random();
    setToasts((items) => [...items.slice(-3), { id, message, bad }]);
    window.setTimeout(() => setToasts((items) => items.filter((toast) => toast.id !== id)), 5_500);
  }, []);

  useEffect(() => {
    void omni.snapshot().then(setSnapshot).catch((failure) => setStartupError(errorMessage(failure)));
    const offSnapshot = omni.onSnapshot(setSnapshot);
    const offNotice = omni.onNotice(({ message }) => notify(message, true));
    return () => { offSnapshot(); offNotice(); };
  }, [notify]);

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.theme ?? (omni.initialTheme === 'dark' ? 'dark' : 'light');
  }, [snapshot?.theme]);

  useEffect(() => store('omniagent.view', current), [current]);
  useEffect(() => store('omniagent.tabs', tabs), [tabs]);
  useEffect(() => store('omniagent.sidebar', sidebarOpen), [sidebarOpen]);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = () => { setNarrow(query.matches); setOverlayOpen(false); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => setOverlayOpen(false), [current]);

  const sessionIds = useMemo(() => new Set(snapshot?.sessions.map((session) => session.id) ?? []), [snapshot?.sessions]);

  useEffect(() => {
    if (!snapshot) return;
    setTabs((items) => {
      const kept = items.filter((id) => sessionIds.has(id));
      return kept.length === items.length ? items : kept;
    });
    setHistory((state) => {
      if (state.stack.every((view) => !view || sessionIds.has(view))) return state;
      const stack: string[] = [];
      let index = 0;
      state.stack.forEach((view, position) => {
        const valid = !view || sessionIds.has(view) ? view : '';
        if (!stack.length || stack[stack.length - 1] !== valid) stack.push(valid);
        if (position <= state.index) index = stack.length - 1;
      });
      return { stack, index };
    });
  }, [snapshot, sessionIds]);

  const navigate = useCallback((view: string) => {
    if (view) setTabs((items) => (items.includes(view) ? items : [...items, view]));
    setHistory((state) => {
      if (state.stack[state.index] === view) return state;
      const stack = [...state.stack.slice(0, state.index + 1), view].slice(-100);
      return { stack, index: stack.length - 1 };
    });
  }, []);

  const goBack = useCallback(() => setHistory((state) => (state.index > 0 ? { ...state, index: state.index - 1 } : state)), []);
  const goForward = useCallback(() => setHistory((state) => (state.index < state.stack.length - 1 ? { ...state, index: state.index + 1 } : state)), []);

  useEffect(() => {
    const view = history.stack[history.index];
    if (view) setTabs((items) => (items.includes(view) ? items : [...items, view]));
  }, [history]);

  const requestProject = useCallback<ProjectRequest>((options) => new Promise((resolve) => {
    setProjectDialog({ suggestion: options.suggestion ?? '', team: options.team, resolve });
  }), []);

  const newProject = useCallback(() => {
    void requestProject({}).then((id) => {
      if (!id) return;
      navigate(id);
      focusPrompt();
    });
  }, [requestProject, navigate]);

  const closeTab = useCallback((id: string) => {
    const index = tabs.indexOf(id);
    const next = tabs.filter((item) => item !== id);
    setTabs(next);
    if (id !== current) return;
    const neighbour = next[Math.min(index, next.length - 1)] ?? '';
    setHistory((state) => {
      const stack = [...state.stack.slice(0, state.index + 1), neighbour];
      return { stack, index: stack.length - 1 };
    });
  }, [tabs, current]);

  const openTabs = useMemo(() => tabs.map((id) => snapshot?.sessions.find((session) => session.id === id)).filter((session): session is Session => Boolean(session)), [tabs, snapshot?.sessions]);
  const active = snapshot?.sessions.find((session) => session.id === current) ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!snapshot?.onboarded) return;
      const key = event.key.toLowerCase();
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      const navModifier = IS_MAC ? event.metaKey : event.altKey;
      const handled = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.ctrlKey && event.key === 'Tab') {
        if (!openTabs.length) return;
        handled();
        const position = openTabs.findIndex((session) => session.id === current);
        const step = event.shiftKey ? -1 : 1;
        const next = openTabs[(position + step + openTabs.length) % openTabs.length] ?? openTabs[0];
        navigate(next.id);
        return;
      }
      if (navModifier && !event.shiftKey && event.key === 'ArrowLeft' && !(event.target instanceof HTMLTextAreaElement && IS_MAC)) { handled(); goBack(); return; }
      if (navModifier && !event.shiftKey && event.key === 'ArrowRight' && !(event.target instanceof HTMLTextAreaElement && IS_MAC)) { handled(); goForward(); return; }
      if (!mod) return;
      if (!event.shiftKey && key === 'n') { handled(); newProject(); return; }
      if (!event.shiftKey && key === 'k') { handled(); focusPrompt(); return; }
      if (!event.shiftKey && key === 'b') { handled(); togglePanel(); return; }
      if (!event.shiftKey && key === 'w') { if (active) { handled(); closeTab(active.id); } return; }
      if (!event.shiftKey && key === 'o') { if (active) { handled(); void omni.openPath(active.workspace).catch((failure) => notify(errorMessage(failure), true)); } return; }
      if (key === '.') { if (active?.running) { handled(); void omni.stop(active.id); } return; }
      if (key === ',') { handled(); setSettingsPage('general'); return; }
      if (event.shiftKey && key === 'a') { handled(); setSettingsPage(accountsPage(snapshot)); return; }
      if (event.shiftKey && key === 'd') { handled(); void omni.setTheme(snapshot.theme === 'dark' ? 'light' : 'dark'); return; }
      if (/^[1-9]$/.test(event.key)) {
        const target = openTabs[Number(event.key) - 1];
        if (target) { handled(); navigate(target.id); }
      }
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) { event.preventDefault(); goBack(); }
      if (event.button === 4) { event.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [snapshot, openTabs, current, active, navigate, goBack, goForward, closeTab, notify, newProject, togglePanel]);

  if (startupError) return <div className="starter"><div className="notice bad"><CircleAlert size={16} />{startupError}</div></div>;
  if (!snapshot) return null;
  if (!snapshot.onboarded) return <Onboarding snapshot={snapshot} />;

  const openConnections = () => setSettingsPage(accountsPage(snapshot));

  return <div className={`app ${IS_MAC ? 'mac' : ''}`}>
    <TopBar
      tabs={openTabs}
      activeId={active?.id ?? ''}
      sidebarOpen={panelOpen}
      canBack={history.index > 0}
      canForward={history.index < history.stack.length - 1}
      onToggleSidebar={togglePanel}
      onBack={goBack}
      onForward={goForward}
      onSelect={navigate}
      onClose={closeTab}
      onNew={newProject}
    />
    <div className="body">
      <Sidebar
        open={panelOpen}
        sessions={snapshot.sessions}
        activeId={active?.id ?? ''}
        onOpen={navigate}
        onNew={() => { setOverlayOpen(false); newProject(); }}
        onDelete={setConfirmDelete}
        onHome={() => navigate('')}
        onSettings={() => { setOverlayOpen(false); setSettingsPage('general'); }}
      />
      {narrow && overlayOpen ? <div className="sidebar-scrim" onMouseDown={() => setOverlayOpen(false)} /> : null}
      <main className="page">
        {active
          ? <SessionView key={active.id} session={active} connections={snapshot.connections} onNotify={notify} onOpenConnections={openConnections} />
          : <Home snapshot={snapshot} requestProject={requestProject} onStarted={navigate} onOpenConnections={openConnections} onNotify={notify} />}
      </main>
    </div>
    {projectDialog ? <NewProjectDialog
      suggestion={projectDialog.suggestion}
      onCancel={() => { projectDialog.resolve(null); setProjectDialog(null); }}
      onCreate={async ({ name, folder }) => {
        const session = await omni.createSession(folder, projectDialog.team, name);
        projectDialog.resolve(session.id);
        setProjectDialog(null);
      }}
    /> : null}
    {settingsPage ? <SettingsModal snapshot={snapshot} page={settingsPage} onClose={() => setSettingsPage(null)} /> : null}
    {confirmDelete ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmDelete(null); }}>
      <div className="confirm">
        <h3>Delete “{confirmDelete.title}”?</h3>
        <p>This project is removed from OmniAgent. Files your agents made in {confirmDelete.workspace} stay where they are.</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
          <button type="button" className="btn danger" onClick={() => {
            const target = confirmDelete;
            setConfirmDelete(null);
            if (target.id === current) closeTab(target.id);
            setTabs((items) => items.filter((id) => id !== target.id));
            void omni.deleteSession(target.id).catch((failure) => notify(errorMessage(failure), true));
          }}>Delete</button>
        </div>
      </div>
    </div> : null}
    <ImageViewer />
    <div className="toast-stack">{toasts.map((toast) => <div className={`toast ${toast.bad ? 'bad' : ''}`} key={toast.id}>{toast.bad ? <CircleAlert size={16} style={{ color: 'var(--bad)', flex: 'none' }} /> : null}{toast.message}</div>)}</div>
  </div>;
}
