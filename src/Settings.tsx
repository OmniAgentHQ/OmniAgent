import { useEffect, useState } from 'react';
import { ChevronDown, Download, Keyboard, RefreshCw, X } from 'lucide-react';
import { errorMessage, omni, type RuntimeId } from './api';
import { DESCRIPTIONS, ProviderPage, providerState, RUNTIME_SIZE } from './Connections';
import { Glyph } from './Glyph';
import { MacPermissions } from './MacPermissions';
import { runtimeLabels, runtimeSummary, runtimeUpdates, useRuntimeUpdates } from './runtimeUpdates';
import { IS_MAC, SHORTCUT_GROUPS } from './shortcuts';
import { ProviderLogo, Toggle } from './ui';
import { PROVIDER_INFO, PROVIDER_ORDER, type AppSnapshot, type Provider, type RuntimeProgressEvent } from '../electron/shared';

export type SettingsPage = 'general' | 'shortcuts' | Provider;

const RUNTIME_PROVIDER: Record<RuntimeId, Provider> = { codex: 'OpenAI', claude: 'Claude' };
const RUNTIME_ORDER: RuntimeId[] = ['codex', 'claude'];

export function EnginesSection({ snapshot }: { snapshot: AppSnapshot }) {
  const { runtimes, checking, download, error, notice } = useRuntimeUpdates();
  const [installing, setInstalling] = useState<RuntimeProgressEvent | null>(null);
  const [installError, setInstallError] = useState('');
  const summary = runtimeSummary(runtimes);
  const busy = checking || Boolean(download) || Boolean(installing);

  useEffect(() => { void runtimeUpdates.check(true); }, []);
  useEffect(() => omni.onRuntimeProgress((event) => setInstalling((current) => current && current.runtime === event.runtime ? event : current)), []);

  const install = async (runtime: RuntimeId) => {
    setInstallError('');
    setInstalling({ runtime, percent: 0, status: 'Getting ready' });
    try {
      await omni.installRuntime(runtime);
      await runtimeUpdates.check(false);
    } catch (failure) {
      setInstallError(errorMessage(failure));
    } finally {
      setInstalling(null);
    }
  };

  const progress = installing
    ? { label: runtimeLabels[installing.runtime as RuntimeId], percent: installing.percent, status: installing.status, cancel: null }
    : download ? { label: runtimeLabels[download.runtime], percent: download.percent, status: download.cancelling ? 'Cancelling…' : `${download.status}${download.total > 1 ? ` · ${download.index + 1} of ${download.total}` : ''}`, cancel: download.cancelling || download.currentPercent >= 97 ? null : () => void runtimeUpdates.cancel() } : null;

  return <section className="settings-group">
    <span className="label">AI engines</span>
    <div className="settings-row">
      <div>
        <strong>{checking ? 'Checking for updates…' : progress ? `Working on ${progress.label}…` : summary.label}</strong>
        <small>Each AI runs through its official engine. When ChatGPT, Claude or another AI ships new models, update here to get them along with their thinking levels.</small>
      </div>
      <span className="row-actions">
        {summary.updates.length > 1 && !busy ? <button type="button" className="btn-primary small" onClick={() => void runtimeUpdates.update()}><Download size={13} />Update all</button> : null}
        <button type="button" className="btn small" disabled={busy} onClick={() => void runtimeUpdates.check(true)}><RefreshCw size={13} className={checking ? 'spin' : ''} />Check</button>
      </span>
    </div>
    <div className="engine-list">
      {RUNTIME_ORDER.map((id) => {
        const runtime = runtimes.find((item) => item.runtime === id);
        const installed = runtime?.installed ?? snapshot.runtimes[id];
        const mine = installing?.runtime === id || download?.runtime === id;
        const version = runtime?.version ? `v${runtime.version}` : installed ? 'Installed' : `Not installed · ${RUNTIME_SIZE[id]}`;
        const detail = runtime?.override ? `${version} · custom install, update it yourself` : installed && runtime?.updateAvailable && runtime.latestVersion ? `${version} → v${runtime.latestVersion}` : version;
        return <div className="engine-row" key={id}>
          <ProviderLogo provider={RUNTIME_PROVIDER[id]} />
          <div className="grow">
            <strong>{runtimeLabels[id]}</strong>
            <small className="mono">{detail}</small>
          </div>
          {mine && progress ? <span className="engine-percent">{progress.percent}%</span>
            : !installed ? <button type="button" className="btn small" disabled={busy} onClick={() => void install(id)}><Download size={12} />Download</button>
              : runtime?.updateAvailable && runtime.latestVersion && !runtime.override ? <button type="button" className="btn small" disabled={busy} onClick={() => void runtimeUpdates.update(id)}><Download size={12} />Update</button>
                : runtime?.latestVersion && !runtime.error ? <span className="badge ok">Up to date</span> : null}
        </div>;
      })}
    </div>
    {progress ? <div>
      <div className="progress"><i style={{ width: `${progress.percent}%` }} /></div>
      <div className="progress-label">
        <span>{progress.label} · {progress.status}</span>
        <span>{progress.percent}%{progress.cancel ? <> <button type="button" className="mention" onClick={progress.cancel}>Cancel</button></> : null}</span>
      </div>
    </div> : null}
    {error || installError ? <div className="notice bad">{installError || error}</div> : null}
    {notice ? <div className="notice">{notice}</div> : null}
  </section>;
}

function EditionSection() {
  return <section className="settings-group">
    <span className="label">Edition</span>
    <div className="settings-row">
      <div><strong>OmniAgent <b className="edition-name core">Core</b></strong><small>ChatGPT and Claude. OmniAgent Pro adds Gemini, Grok, Muse, DeepSeek, Mistral, Kimi, Qwen and free local models.</small></div>
    </div>
  </section>;
}

function GeneralPage({ snapshot }: { snapshot: AppSnapshot }) {
  return <>
    <EditionSection />
    <section className="settings-group">
      <span className="label">Appearance</span>
      <div className="settings-row">
        <div><strong>Dark mode</strong><small>Black and blue instead of white and blue</small></div>
        <Toggle on={snapshot.theme === 'dark'} onChange={(on) => void omni.setTheme(on ? 'dark' : 'light')} label="Dark mode" />
      </div>
    </section>
    {IS_MAC ? <section className="settings-group"><MacPermissions /></section> : null}
    <EnginesSection snapshot={snapshot} />
  </>;
}

function ShortcutsPage() {
  const [open, setOpen] = useState(SHORTCUT_GROUPS[0].title);
  return <div className="shortcut-groups">
    {SHORTCUT_GROUPS.map((group) => {
      const expanded = open === group.title;
      return <section className={`shortcut-group ${expanded ? 'open' : ''}`} key={group.title}>
        <button type="button" className="shortcut-group-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? '' : group.title)}>
          <span>{group.title}</span>
          <small>{group.items.length}</small>
          <ChevronDown size={15} />
        </button>
        {expanded ? <div className="shortcut-list">
          {group.items.map((shortcut) => <div className="shortcut" key={shortcut.label}>
            <span>{shortcut.label}</span>
            <span className="keys">{shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
          </div>)}
        </div> : null}
      </section>;
    })}
  </div>;
}

export function SettingsModal({ snapshot, page: initialPage, onClose }: { snapshot: AppSnapshot; page: SettingsPage; onClose: () => void }) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [refreshing, setRefreshing] = useState(false);
  const { runtimes } = useRuntimeUpdates();
  const updates = runtimeSummary(runtimes).updates.length;

  useEffect(() => setPage(initialPage), [initialPage]);
  useEffect(() => runtimeUpdates.checkIfStale(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const provider = PROVIDER_ORDER.includes(page as Provider) ? page as Provider : null;
  const refresh = () => {
    setRefreshing(true);
    void omni.refreshConnections(true).catch(() => undefined).finally(() => setRefreshing(false));
  };
  const head = provider
    ? { icon: <ProviderLogo provider={provider} size="xl" />, title: PROVIDER_INFO[provider].label, text: DESCRIPTIONS[provider] }
    : page === 'shortcuts' ? { icon: <Keyboard size={26} />, title: 'Keyboard shortcuts', text: 'Do more without the mouse.' }
      : { icon: <Glyph name="settings" size={30} />, title: 'General', text: 'How OmniAgent looks, and the engines your agents run on.' };

  return <div className="modal-backdrop no-drag" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-label="Settings">
      <nav className="modal-side">
        <span className="label">Settings</span>
        <button type="button" className={`provider-tab ${page === 'general' ? 'on' : ''}`} onClick={() => setPage('general')}><Glyph name="settings" size={20} /><span className="grow">General</span>{updates ? <span className="count-badge" title={`${updates} update${updates === 1 ? '' : 's'} available`}>{updates}</span> : null}</button>
        <button type="button" className={`provider-tab ${page === 'shortcuts' ? 'on' : ''}`} onClick={() => setPage('shortcuts')}><Keyboard size={18} className="nav-icon" /><span className="grow">Keyboard shortcuts</span></button>
        <span className="label side-label">AI accounts</span>
        {PROVIDER_ORDER.map((item) => {
          const state = providerState(item, snapshot.connections);
          return <button type="button" key={item} className={`provider-tab ${page === item ? 'on' : ''}`} onClick={() => setPage(item)}>
            <ProviderLogo provider={item} />
            <span className="grow">{PROVIDER_INFO[item].label}<small>{state === 'connected' ? 'Connected' : state === 'connecting' ? 'Signing in…' : 'Not connected'}</small></span>
            <span className={`state-dot ${state}`} />
          </button>;
        })}
      </nav>
      <div className="modal-main">
        <header className="modal-head">
          {head.icon}
          <div className="grow"><h2>{head.title}</h2><p>{head.text}</p></div>
          {provider ? <button type="button" className="btn small" disabled={refreshing} title="Get the latest model list" onClick={refresh}><RefreshCw size={13} className={refreshing ? 'spin' : ''} />{refreshing ? 'Refreshing' : 'Refresh'}</button> : null}
          <button type="button" className="icon-btn" title="Close" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="modal-body">
          {provider ? <ProviderPage provider={provider} snapshot={snapshot} key={provider} />
            : page === 'shortcuts' ? <ShortcutsPage />
              : <GeneralPage snapshot={snapshot} />}
        </div>
      </div>
    </div>
  </div>;
}
