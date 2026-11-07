export const APP_NAME = 'OmniAgent Core';

export type Provider = 'OpenAI' | 'Claude';

export const PROVIDER_ORDER: Provider[] = ['OpenAI', 'Claude'];

export const PROVIDER_INFO: Record<Provider, { label: string; handle: string; vendor: string; aliases: string[]; account: boolean; apiKey: boolean; liveInput: boolean }> = {
  OpenAI: { label: 'ChatGPT', handle: 'ChatGPT', vendor: 'OpenAI', aliases: ['chatgpt', 'gpt', 'openai', 'codex'], account: true, apiKey: true, liveInput: true },
  Claude: { label: 'Claude', handle: 'Claude', vendor: 'Anthropic', aliases: ['claude', 'anthropic'], account: true, apiKey: true, liveInput: true }
};

export type AIModelView = {
  id: string;
  label: string;
  description?: string;
  reasoningEfforts: string[];
  reasoningNote?: string;
  contextWindow?: number;
  vision?: boolean;
  thinking?: boolean;
  bytesPerContextToken?: number;
  baseBytes?: number;
};

export type AIConnectionView = {
  id: string;
  provider: Provider;
  kind: 'account' | 'apiKey';
  label: string;
  email?: string;
  plan?: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  models: AIModelView[];
  lastError?: string;
  updatedAt: string;
};

export type ModelChoice = {
  provider: Provider;
  connectionId: string;
  model: string;
  effort: string;
};

export type AgentConfig = ModelChoice & {
  id: string;
  handle: string;
  browsing: 'visible' | 'hidden';
};

export type LoopSetting =
  | { mode: 'none' }
  | { mode: 'immediate'; delaySeconds?: number }
  | { mode: 'time-spread'; runsPerPeriod: number; period: 'hour' | 'day' }
  | { mode: 'active-window'; start: string; end: string; runMode: 'once' | 'immediate' | 'time-spread'; runsPerPeriod?: number; period?: 'hour' | 'day' };

export type TeamConfig = {
  agents: AgentConfig[];
  finisher: (ModelChoice & { enabled: boolean; rounds: number }) | null;
  pulseMinutes: number;
  loop: LoopSetting;
};

export type ToolStep = {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'ok' | 'error';
  durationMs?: number;
  at: string;
  detail?: boolean;
};

export type ToolStepDetail = {
  args: string;
  result: string;
};

export type AgentStatus = 'queued' | 'working' | 'done' | 'failed' | 'stopped';

export type AgentRunView = {
  agentId: string;
  handle: string;
  provider: Provider;
  model: string;
  assignment: string;
  status: AgentStatus;
  activity: string;
  reasoning: string;
  steps: ToolStep[];
  messages: Array<{ text: string; at: string }>;
  partial: string;
  final: string;
  error: string;
  turns: number;
  startedAt: string;
  finishedAt: string;
};

export type PulseReport = {
  agentId: string;
  handle: string;
  provider: Provider;
  text: string;
  source: 'agent' | 'activity';
  at: string;
};

export type PulseView = {
  id: string;
  at: string;
  reports: PulseReport[];
  awaiting: string[];
};

export type TeamNote = {
  id: string;
  handle: string;
  provider: Provider | 'Finisher';
  to?: string;
  text: string;
  at: string;
  error?: boolean;
};

export type FollowUpView = {
  id: string;
  at: string;
  text: string;
  attachments?: Array<{ name: string; path: string }>;
  delivered: Array<{ handle: string; how: 'live' | 'queued' | 'new-turn' }>;
};

export type FinisherRunView = {
  provider: Provider;
  model: string;
  round: number;
  rounds: number;
  status: AgentStatus;
  activity: string;
  steps: ToolStep[];
  partial: string;
  final: string;
  verdict: 'complete' | 'fixed' | 'incomplete' | '';
  fixes: Array<{ handle: string; instructions: string; round: number }>;
  error: string;
  startedAt: string;
  finishedAt: string;
};

export type RunView = {
  id: string;
  sessionId: string;
  prompt: string;
  attachments: Array<{ name: string; path: string }>;
  tags: string[];
  status: 'running' | 'finishing' | 'done' | 'stopped' | 'failed';
  agents: AgentRunView[];
  pulses: PulseView[];
  notes: TeamNote[];
  followUps: FollowUpView[];
  finisher: FinisherRunView | null;
  files: string[];
  loopIteration: number;
  startedAt: string;
  finishedAt: string;
};

export type SessionView = {
  id: string;
  title: string;
  workspace: string;
  team: TeamConfig;
  running: boolean;
  nextLoopAt: string;
  loopLabel: string;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeStatus = Record<'claude' | 'codex', boolean>;

export type AppSnapshot = {
  connections: AIConnectionView[];
  sessions: SessionView[];
  runtimes: RuntimeStatus;
  theme: 'dark' | 'light';
  defaultTeam: TeamConfig;
  storageWarning: string;
  platform: string;
  desktopReady: boolean;
  onboarded: boolean;
};

export type RuntimeProgressEvent = {
  runtime: string;
  percent: number;
  status: string;
  receivedBytes?: number;
  totalBytes?: number;
};

export function tagPattern() {
  return /(^|[^\w@])@([A-Za-z][\w.-]{0,40})/g;
}
