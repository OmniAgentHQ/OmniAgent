import type Database from 'better-sqlite3';
import { safeStorage, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { accountLabel, providerTraits, REFRESHABLE_PROVIDERS, type Provider } from './contracts';
import type { AIConnectionView, AIModelView } from './shared';
import { MODEL_REFRESH_ERROR } from './modelDiscovery';
import {
  defaultModels,
  firstAvailableExecutable,
  ProviderRuntimeManager,
  publicProviderConnectionError,
  type ProviderAccountState
} from './providerRuntime';
import { ProviderRuntimeInstaller, RUNTIME_OWNER, type ProviderRuntimeId, type RuntimeProgress } from './providerInstaller';
import { ProviderRuntimeUpdates } from './providerUpdates';
import { writeSetting } from './database';

const OPENAI_NON_CHAT = /(?:embedding|whisper|tts|audio|moderation|dall-e|image|realtime|transcribe|search|similarity|edit|davinci|babbage|ada|curie|instruct|codex-mini)/i;

function credentialModels(provider: Provider, rows: Array<Record<string, unknown>>): AIModelView[] {
  if (provider === 'Claude') {
    return rows
      .map((row) => ({
        id: String(row.id ?? ''),
        label: String(row.display_name ?? row.id ?? ''),
        description: 'Anthropic API',
        reasoningEfforts: ['low', 'medium', 'high'],
        contextWindow: 200_000
      }))
      .filter((model) => model.id);
  }
  return rows
    .map((row) => String(row.id ?? ''))
    .filter((id) => id && !OPENAI_NON_CHAT.test(id))
    .filter((id) => /^(?:gpt-|o\d|chatgpt-)/i.test(id))
    .sort((left, right) => right.localeCompare(left))
    .map((id) => ({
      id,
      label: id,
      description: 'OpenAI API',
      reasoningEfforts: /^gpt-6-astra(?:$|-)/i.test(id) ? ['low', 'medium', 'high', 'xhigh', 'max']
        : /^(?:o\d|gpt-(?:[5-9]|\d{2,}))/i.test(id) ? ['low', 'medium', 'high'] : [],
      contextWindow: undefined
    }));
}

function credentialRejectionMessage(provider: Provider, status: number) {
  const name = providerTraits(provider).vendor;
  if (status === 400 || status === 401 || status === 403) return `${name} rejected that key. Check that you copied the whole key and that it has not been revoked.`;
  if (status === 429) return `That ${name} key has hit its rate or spend limit. Check the account's usage and billing, then try again.`;
  if (status >= 500) return `${name} could not be reached right now. Wait a moment and try again.`;
  return `${name} could not verify that key (error ${status}).`;
}

export function insecureStorageWarning() {
  if (process.platform !== 'linux') return '';
  let backend = '';
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch {
    return '';
  }
  if (backend !== 'basic_text') return '';
  return (
    'This computer has no keyring, so OmniAgent cannot encrypt saved API keys — they are stored '
    + 'obscured rather than protected. Install gnome-keyring (or another Secret Service provider) '
    + 'and restart OmniAgent to secure them.'
  );
}

function decryptSavedSecret(encrypted: Buffer) {
  try {
    return safeStorage.decryptString(encrypted);
  } catch {
    throw new Error(
      'This saved key was encrypted by a different computer or operating system, so it cannot be '
      + 'read here. Open Connections and enter the key again to reconnect this account.'
    );
  }
}

export function providerDefaultModel(provider: Provider) {
  return provider === 'OpenAI' ? 'gpt-5.6-sol' : 'sonnet';
}

function providerDisplayName(provider: Provider) {
  if (provider === 'OpenAI') return 'ChatGPT';
  return provider;
}

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class ConnectionService extends EventEmitter {
  private stopped = false;
  private connectionRefresh?: Promise<void>;
  private refreshTimer?: NodeJS.Timeout;
  readonly runtimeInstaller: ProviderRuntimeInstaller;
  readonly runtimeUpdates: ProviderRuntimeUpdates;

  private readonly claudeSignIn: string;

  constructor(private db: Database.Database, readonly providerRuntime: ProviderRuntimeManager, userData: string) {
    super();
    this.claudeSignIn = path.join(userData, 'ai', 'claude', '.credentials.json');
    this.runtimeInstaller = new ProviderRuntimeInstaller(path.join(userData, 'providers'));
    this.runtimeUpdates = new ProviderRuntimeUpdates(path.join(userData, 'providers'), runtime =>
      firstAvailableExecutable(RUNTIME_OWNER[runtime], userData));
    this.providerRuntime.on('state', (state: ProviderAccountState) => {
      if (this.stopped) return;
      this.storeConnectionState(state);
    });
    this.providerRuntime.on('notification', (provider: Provider, method: string) => {
      if (this.stopped) return;
      if (provider === 'OpenAI' && ['account/login/completed', 'account/updated'].includes(method)) {
        void this.refreshProviderConnection(provider);
      }
    });
  }

  initialize() {
    this.refreshTimer = setInterval(() => {
      if (!this.stopped) void this.refreshProviderConnections().catch(() => undefined);
    }, 6 * 60 * 60_000);
    this.refreshTimer.unref();
    queueMicrotask(() => { void this.refreshProviderConnections().catch(() => undefined); });
  }

  close() {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private changed() {
    if (!this.stopped) this.emit('changed');
  }

  private credentialConnections(): AIConnectionView[] {
    return (this.db.prepare(`
      SELECT id, provider, label, masked_value, models_json, last_error, verified_at
      FROM provider_credentials ORDER BY provider, created_at
    `).all() as Array<Record<string, unknown>>).map((row) => {
      let models: AIModelView[] = [];
      try { models = JSON.parse(String(row.models_json || '[]')) as AIModelView[]; } catch { models = []; }
      return {
        id: String(row.id),
        provider: String(row.provider) as Provider,
        kind: 'apiKey' as const,
        label: String(row.label),
        email: String(row.masked_value),
        plan: 'API key',
        status: 'connected' as const,
        models,
        lastError: row.last_error ? String(row.last_error) : undefined,
        updatedAt: String(row.verified_at)
      };
    });
  }

  connectionApiKey(connectionId: string | null | undefined) {
    if (!connectionId) return undefined;
    const row = this.db.prepare(`
      SELECT encrypted_secret FROM provider_credentials WHERE id=?
    `).get(connectionId) as { encrypted_secret: Buffer } | undefined;
    if (!row) return undefined;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('This computer’s secure storage is unavailable, so the saved API key cannot be read.');
    }
    return decryptSavedSecret(row.encrypted_secret);
  }

  openAIKey() {
    const row = this.db.prepare(`SELECT id FROM provider_credentials WHERE provider='OpenAI' ORDER BY is_primary DESC, created_at LIMIT 1`).get() as { id: string } | undefined;
    if (!row) return undefined;
    try {
      return this.connectionApiKey(row.id);
    } catch {
      return undefined;
    }
  }

  async addCredential(provider: Provider, label: string, secret: string) {
    const models = await this.verifyCredential(provider, secret);
    if (!models.length) {
      throw new Error(`That key is valid, but ${providerDisplayName(provider)} does not list any chat models for it. Check the account's model access, then try again.`);
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer’s secure storage is unavailable. The API key was not saved.');
    const credentialId = id('credential');
    const encrypted = safeStorage.encryptString(secret);
    const masked = `${secret.slice(0, providerTraits(provider).maskLead)}••••${secret.slice(-4)}`;
    const hasPrimary = (this.db.prepare(`SELECT COUNT(*) AS count FROM provider_credentials WHERE provider=? AND is_primary=1`).get(provider) as { count: number }).count > 0;
    const existingLabels = new Set((this.db.prepare(`SELECT label FROM provider_credentials WHERE provider=?`).all(provider) as Array<{ label: string }>).map((row) => row.label));
    let uniqueLabel = label.trim() || `${providerTraits(provider).label} key`;
    for (let index = 2; existingLabels.has(uniqueLabel); index += 1) uniqueLabel = `${label.trim() || `${providerTraits(provider).label} key`} ${index}`;
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO provider_credentials (id, provider, label, encrypted_secret, masked_value, is_primary, verified_at, created_at, models_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(credentialId, provider, uniqueLabel, encrypted, masked, hasPrimary ? 0 : 1, timestamp, timestamp, JSON.stringify(models));
    this.changed();
    return credentialId;
  }

  deleteCredential(credentialId: string) {
    const credential = this.db.prepare(`SELECT * FROM provider_credentials WHERE id=?`).get(credentialId) as Record<string, unknown> | undefined;
    if (!credential) throw new Error('Credential not found.');
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM provider_credentials WHERE id=?`).run(credentialId);
      if (credential.is_primary) {
        const replacement = this.db.prepare(`SELECT id FROM provider_credentials WHERE provider=? ORDER BY created_at LIMIT 1`).get(credential.provider) as { id: string } | undefined;
        if (replacement) this.db.prepare(`UPDATE provider_credentials SET is_primary=1 WHERE id=?`).run(replacement.id);
      }
    })();
    this.changed();
  }

  listConnections(): AIConnectionView[] {
    return [...this.listAccountConnections(), ...this.credentialConnections()];
  }

  private listAccountConnections(): AIConnectionView[] {
    return (this.db.prepare(`
      SELECT id, provider, label, account_email, plan_type, status, models_json, last_error, updated_at
      FROM ai_connections ORDER BY provider, created_at
    `).all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      provider: String(row.provider) as Provider,
      kind: 'account' as const,
      label: String(row.label),
      email: row.account_email ? String(row.account_email) : undefined,
      plan: row.plan_type ? String(row.plan_type) : undefined,
      status: String(row.status) as AIConnectionView['status'],
      models: JSON.parse(String(row.models_json || '[]')) as AIConnectionView['models'],
      lastError: row.last_error === MODEL_REFRESH_ERROR ? MODEL_REFRESH_ERROR
        : row.last_error ? publicProviderConnectionError(String(row.provider) as Provider) : undefined,
      updatedAt: String(row.updated_at)
    }));
  }

  private storeConnectionState(state: ProviderAccountState) {
    if (this.stopped || !this.db.open) return;
    const existing = this.db.prepare(`SELECT id, created_at, account_email, status, models_json FROM ai_connections WHERE provider=?`).get(state.provider) as {
      id: string;
      created_at: string;
      account_email: string | null;
      status: string;
      models_json: string;
    } | undefined;
    const timestamp = now();
    const connectionId = existing?.id ?? id('connection');
    const changedAccount = Boolean(existing?.account_email && state.email
      && existing.account_email.toLowerCase() !== state.email.toLowerCase());
    const models = state.modelsStale || state.status === 'error'
      ? (!changedAccount && existing ? JSON.parse(existing.models_json || '[]') as AIModelView[] : [])
      : state.models;
    this.db.prepare(`
      INSERT INTO ai_connections
      (id, provider, label, account_email, plan_type, status, models_json, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        account_email=excluded.account_email,
        plan_type=excluded.plan_type,
        status=excluded.status,
        models_json=excluded.models_json,
        last_error=excluded.last_error,
        updated_at=excluded.updated_at
    `).run(
      connectionId,
      state.provider,
      accountLabel(state.provider) || `${providerDisplayName(state.provider)} account`,
      state.email ?? null,
      state.plan ?? null,
      state.status,
      JSON.stringify(models),
      state.modelsStale ? MODEL_REFRESH_ERROR : state.error ? publicProviderConnectionError(state.provider) : null,
      existing?.created_at ?? timestamp,
      timestamp
    );
    if (changedAccount) this.emit('account-changed', connectionId);
    this.changed();
  }

  private async refreshProviderConnection(provider: Provider, refreshModels = false) {
    const state = await this.providerRuntime.readAccount(provider, refreshModels);
    if (!this.stopped) this.storeConnectionState(state);
    return state;
  }

  async refreshProviderConnections(refreshModels = false) {
    if (this.connectionRefresh) {
      if (!refreshModels) return this.connectionRefresh;
      await this.connectionRefresh;
    }
    const job = (async () => {
      await Promise.all(REFRESHABLE_PROVIDERS.map(provider => this.refreshProviderConnection(provider, refreshModels).catch(() => undefined)));
      if (refreshModels) {
        const credentials = this.db.prepare('SELECT id, provider, encrypted_secret FROM provider_credentials').all() as Array<{ id: string; provider: Provider; encrypted_secret: Buffer }>;
        await Promise.all(credentials.map(async credential => {
          try {
            const models = await this.verifyCredential(credential.provider, decryptSavedSecret(credential.encrypted_secret));
            if (!models.length) throw new Error('No models were returned.');
            if (!this.stopped) this.db.prepare('UPDATE provider_credentials SET models_json=?, last_error=NULL, verified_at=? WHERE id=?')
              .run(JSON.stringify(models), now(), credential.id);
          } catch {
            if (!this.stopped) this.db.prepare('UPDATE provider_credentials SET last_error=? WHERE id=?').run(MODEL_REFRESH_ERROR, credential.id);
          }
        }));
        this.changed();
      }
    })();
    this.connectionRefresh = job;
    try { await job; }
    finally { if (this.connectionRefresh === job) this.connectionRefresh = undefined; }
  }

  async connectProvider(provider: Provider) {
    this.storeConnectionState({ provider, status: 'connecting', models: defaultModels(provider) });
    try {
      const started = await this.providerRuntime.connect(provider);
      if ('authUrl' in started && started.authUrl) await shell.openExternal(started.authUrl);
    } catch {
      const message = publicProviderConnectionError(provider);
      this.storeConnectionState({
        provider,
        status: 'error',
        models: defaultModels(provider),
        error: message
      });
      throw new Error(message);
    }
  }

  async cancelProviderConnect(provider: Provider) {
    const state = await this.providerRuntime.cancelConnect(provider).catch(() => undefined);
    this.storeConnectionState(state?.status === 'connected'
      ? state
      : { provider, status: 'disconnected', models: defaultModels(provider) });
  }

  async disconnectProvider(connectionId: string) {
    const connection = this.db.prepare(`SELECT provider FROM ai_connections WHERE id=?`).get(connectionId) as { provider: Provider } | undefined;
    if (!connection) throw new Error('AI connection not found.');
    await this.providerRuntime.disconnect(connection.provider);
    this.db.prepare(`
      UPDATE ai_connections SET account_email=NULL, plan_type=NULL, status='disconnected',
        last_error=NULL, updated_at=? WHERE id=?
    `).run(now(), connectionId);
    this.emit('account-changed', connectionId);
    this.changed();
  }

  providerRuntimeStatus(): Record<ProviderRuntimeId, boolean> {
    const status = {} as Record<ProviderRuntimeId, boolean>;
    for (const [runtime, provider] of Object.entries(RUNTIME_OWNER) as Array<[ProviderRuntimeId, Provider]>) {
      status[runtime] = this.providerRuntime.runtimeInstalled(provider);
    }
    return status;
  }

  providerRuntimeDetails(checkLatest = false) {
    return this.runtimeUpdates.details(checkLatest);
  }

  cancelRuntimeUpdate(runtime: ProviderRuntimeId) { this.runtimeUpdates.cancel(runtime); }

  async updateProviderRuntime(runtime: ProviderRuntimeId, onProgress?: (progress: RuntimeProgress) => void) {
    const keptSignIn = runtime === 'claude' && this.signedIn('Claude') ? this.readClaudeSignIn() : undefined;
    await this.runtimeUpdates.update(runtime, onProgress);
    this.providerRuntime.refreshRuntimePaths();
    onProgress?.({ runtime, percent: 100, status: 'Refreshing model lists' });
    await this.refreshProviderConnections(true);
    if (keptSignIn && !this.signedIn('Claude')) {
      fs.writeFileSync(this.claudeSignIn, keptSignIn);
      await this.refreshProviderConnection('Claude', true).catch(() => undefined);
    }
    return { runtimes: await this.runtimeUpdates.details() };
  }

  private signedIn(provider: Provider) {
    const row = this.db.prepare(`SELECT status FROM ai_connections WHERE provider=?`).get(provider) as { status: string } | undefined;
    return row?.status === 'connected';
  }

  private readClaudeSignIn() {
    try {
      return fs.readFileSync(this.claudeSignIn, 'utf8');
    } catch {
      return undefined;
    }
  }

  async installProviderRuntime(
    runtime: ProviderRuntimeId,
    onProgress?: (progress: RuntimeProgress) => void
  ) {
    await this.runtimeInstaller.install(runtime, onProgress);
    this.providerRuntime.refreshRuntimePaths();
    const provider: Provider = RUNTIME_OWNER[runtime];
    await this.refreshProviderConnection(provider).catch(() => undefined);
    this.changed();
    return this.providerRuntimeStatus();
  }

  private async verifyCredential(provider: Provider, secret: string): Promise<AIModelView[]> {
    const catalogue = provider === 'OpenAI'
      ? { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${secret}` } as Record<string, string> }
      : { url: 'https://api.anthropic.com/v1/models?limit=100', headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } as Record<string, string> };
    const endpoint = catalogue.url;
    const headers = catalogue.headers;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const rows: Array<Record<string, unknown>> = [];
      const cursors = new Set<string>();
      let next: string | undefined = endpoint;
      while (next) {
        const response = await fetch(next, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(credentialRejectionMessage(provider, response.status));
        const payload = await response.json() as { data?: Array<Record<string, unknown>>; has_more?: boolean; last_id?: string };
        if (!Array.isArray(payload.data)) throw new Error('The provider returned an invalid model list.');
        rows.push(...payload.data);
        next = undefined;
        if (provider === 'Claude' && payload.has_more) {
          if (!payload.last_id || cursors.has(payload.last_id)) throw new Error('The provider repeated a model list page.');
          cursors.add(payload.last_id);
          next = `${endpoint}&after_id=${encodeURIComponent(payload.last_id)}`;
        }
      }
      return credentialModels(provider, rows);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OmniAgent could not reach ${providerDisplayName(provider)} to check that key. Check this computer's internet connection, then try again.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
