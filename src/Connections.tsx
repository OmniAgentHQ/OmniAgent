import { useEffect, useState } from 'react';
import { CircleAlert, KeyRound, LogIn, LogOut, Trash2 } from 'lucide-react';
import { errorMessage, omni } from './api';
import { ProviderLogo } from './ui';
import { PROVIDER_INFO, type AIConnectionView, type AppSnapshot, type Provider, type RuntimeProgressEvent } from '../electron/shared';
import { Glyph } from './Glyph';

export const RUNTIME_FOR: Record<Provider, keyof AppSnapshot['runtimes']> = {
  OpenAI: 'codex',
  Claude: 'claude'
};

export const RUNTIME_SIZE: Record<string, string> = { codex: '130 MB', claude: '300 MB' };

export const DESCRIPTIONS: Record<Provider, string> = {
  OpenAI: 'Sign in with a ChatGPT account or connect an API key.',
  Claude: 'Sign in with a Claude account or connect an API key.'
};

export function providerState(provider: Provider, connections: AIConnectionView[]) {
  const mine = connections.filter((item) => item.provider === provider);
  if (mine.some((item) => item.status === 'connected')) return 'connected';
  if (mine.some((item) => item.status === 'connecting')) return 'connecting';
  if (mine.some((item) => item.status === 'error')) return 'error';
  return 'disconnected';
}

function useEngineSetup(provider: Provider, snapshot: AppSnapshot) {
  const runtime = RUNTIME_FOR[provider];
  const [progress, setProgress] = useState<RuntimeProgressEvent | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = omni.onRuntimeProgress((event) => {
      if (event.runtime !== runtime) return;
      clearTimeout(timer);
      setProgress(event);
      if (event.percent >= 100) timer = setTimeout(() => setProgress(null), 1500);
    });
    return () => { clearTimeout(timer); stop(); };
  }, [runtime]);
  const ensure = async () => {
    if (snapshot.runtimes[runtime]) return;
    setProgress({ runtime, percent: 0, status: 'Getting ready' });
    try {
      await omni.installRuntime(runtime);
    } finally {
      setProgress(null);
    }
  };
  return { ready: snapshot.runtimes[runtime], progress, ensure };
}

function SetupProgress({ provider, progress }: { provider: Provider; progress: RuntimeProgressEvent }) {
  return <div className="setup-progress">
    <div className="progress"><i style={{ width: `${progress.percent}%` }} /></div>
    <div className="progress-label"><span>Getting {PROVIDER_INFO[provider].label} ready · {progress.status}</span><span>{progress.percent}%</span></div>
  </div>;
}

function AccountSection({ provider, snapshot }: { provider: Provider; snapshot: AppSnapshot }) {
  const account = snapshot.connections.find((item) => item.provider === provider && item.kind === 'account');
  const engine = useEngineSetup(provider, snapshot);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!PROVIDER_INFO[provider].account) return null;
  const status = account?.status ?? 'disconnected';
  const run = (action: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    void action().catch((failure) => setError(errorMessage(failure))).finally(() => setBusy(false));
  };
  return <section className="section">
    <h4><Glyph name="connectAi" size={20} />{PROVIDER_INFO[provider].label} account</h4>
    <p>Use the plan you already pay for. You sign in on {PROVIDER_INFO[provider].vendor}’s own website, and your plan’s usual limits apply.</p>
    {status === 'connected' ? <div className="account-line">
      <ProviderLogo provider={provider} size="large" />
      <div className="grow"><strong>{account?.email || `${PROVIDER_INFO[provider].label} account`}</strong><small>{[account?.plan, `${account?.models.length ?? 0} models`].filter(Boolean).join(' · ')}</small></div>
      <button type="button" className="btn small" disabled={busy} onClick={() => run(() => omni.disconnect(account!.id))}><LogOut size={13} />Sign out</button>
    </div> : status === 'connecting' ? <div className="account-line">
      <span className="spinner" style={{ color: 'var(--blue-2)' }} />
      <div className="grow"><strong>Finish signing in in your browser</strong><small>This page updates as soon as the sign-in completes.</small></div>
      <button type="button" className="btn small" onClick={() => run(() => omni.cancelConnect(provider))}>Cancel</button>
    </div> : engine.progress ? <SetupProgress provider={provider} progress={engine.progress} /> : <div className="section-row">
      <button type="button" className="btn-primary" disabled={busy} onClick={() => run(async () => { await engine.ensure(); await omni.connect(provider); })}><LogIn size={15} />Sign in with {PROVIDER_INFO[provider].label}</button>
    </div>}
    {account?.lastError && status !== 'connected' ? <div className="notice warn" style={{ marginTop: 10 }}><CircleAlert size={15} />{account.lastError}</div> : null}
    {error ? <div className="notice bad" style={{ marginTop: 10 }}><CircleAlert size={15} />{error}</div> : null}
  </section>;
}

function KeysSection({ provider, snapshot }: { provider: Provider; snapshot: AppSnapshot }) {
  const keys = snapshot.connections.filter((item) => item.provider === provider && item.kind === 'apiKey');
  const engine = useEngineSetup(provider, snapshot);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!PROVIDER_INFO[provider].apiKey) return null;
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await omni.addKey(provider, label.trim() || `${PROVIDER_INFO[provider].label} key`, secret.trim());
      setSecret('');
      setLabel('');
      await engine.ensure();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return <section className="section">
    <h4><KeyRound size={16} />API keys <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12.5 }}>· optional</span></h4>
    <p>Prefer pay-as-you-go? Paste a key from {PROVIDER_INFO[provider].vendor}. It is checked, then locked with this computer’s secure storage and only ever sent to {PROVIDER_INFO[provider].vendor}.</p>
    {keys.length ? <div className="key-list">{keys.map((key) => <div className="account-line" key={key.id}>
      <KeyRound size={16} style={{ color: 'var(--muted)' }} />
      <div className="grow"><strong>{key.label}</strong><small className="mono">{key.email} · {key.models.length} models</small></div>
      {key.lastError ? <span className="badge warn" title={key.lastError}>Check key</span> : <span className="badge ok">Verified</span>}
      <button type="button" className="icon-btn small" title="Remove key" onClick={() => void omni.deleteKey(key.id).catch((failure) => setError(errorMessage(failure)))}><Trash2 size={14} /></button>
    </div>)}</div> : null}
    <div className="field-row">
      <input className="input" style={{ maxWidth: 170 }} placeholder="Label (optional)" value={label} onChange={(event) => setLabel(event.target.value)} />
      <input className="input mono" type="password" placeholder={provider === 'Claude' ? 'sk-ant-…' : 'sk-…'} value={secret} onChange={(event) => setSecret(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && secret.trim()) void add(); }} />
      <button type="button" className="btn-primary" disabled={!secret.trim() || busy} onClick={() => void add()}>{busy ? <span className="spinner" /> : null}{busy ? 'Checking' : 'Add'}</button>
    </div>
    {engine.progress && !PROVIDER_INFO[provider].account ? <SetupProgress provider={provider} progress={engine.progress} /> : null}
    {error ? <div className="notice bad" style={{ marginTop: 10 }}><CircleAlert size={15} />{error}</div> : null}
  </section>;
}

export function ProviderPage({ provider, snapshot }: { provider: Provider; snapshot: AppSnapshot }) {
  return <>
    {snapshot.storageWarning ? <div className="notice warn"><CircleAlert size={15} />{snapshot.storageWarning}</div> : null}
    <AccountSection provider={provider} snapshot={snapshot} key={`account-${provider}`} />
    <KeysSection provider={provider} snapshot={snapshot} key={`keys-${provider}`} />
  </>;
}
