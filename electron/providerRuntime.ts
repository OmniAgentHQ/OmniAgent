export { plainTextFromXlsx, plainTextFromPptx, writeSimpleXlsx } from './simpleDocuments';
import { readRange, readTextRange, readResponse, saveResponse, copyPath, removePath, abortDelay } from './streamingIo';
import { extractZip, createZip } from './streamingArchive';
import { heavyTask } from './heavyTask';
import { terminateOwnedProcess } from './ownedProcess';
import { EventEmitter } from 'node:events';
import { LiveChatInput, followUpPrompt } from './liveChatInput';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import os from 'node:os';
import { shellCommand } from './platform/posixShell';
import { openTerminal as macOpenTerminal, openWith as macOpenWith } from './platform/macos/shell';
import { openTerminal as linuxOpenTerminal, openWith as linuxOpenWith } from './platform/linux/shell';
import { clipboard, shell } from 'electron';
import { DocumentEngine } from './documentEngine';
import { TOOL_NAME_PATTERN_SOURCE } from './toolVocabulary';
import { HostToolServer, type HostToolSession, type TeamToolKit } from './hostToolServer';
import { inspectImage } from './artifactInspection';
import { pdfTextOrGuidance } from './pdfText';
import { providerTraits } from './contracts';
import type { AIModelView, Provider } from './contracts';
import { discoverCodexModels, discoverClaudeModels, MODEL_REFRESH_ERROR } from './modelDiscovery';
import { managedRuntimePath, isExecutableFile } from './providerUpdates';

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type RuntimeAttachment = {
  path: string;
  name: string;
  mimeType: string;
};

export type ProviderAccountState = {
  provider: Provider;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  email?: string;
  plan?: string;
  models: AIModelView[];
  error?: string;
  modelsStale?: boolean;
};

export type ProviderToolEvent = {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'ok' | 'error';
  args?: string;
  result?: string;
  durationMs?: number;
};

export type ProviderTurnInput = {
  provider: Provider;
  model: string;
  reasoningEffort: string;
  agentName?: string;
  agentRole?: string;
  workerId?: string;
  timeoutMs?: number;
  cwd: string;
  prompt: string;
  userRequest?: string;
  toolMode?: 'auto' | 'none' | 'required';
  browsingVisible?: boolean;
  allowBrowserControl?: boolean;

  structured?: 'json' | 'text';
  attachments?: RuntimeAttachment[];
  liveInput?: LiveChatInput;
  sessionId?: string;
  teamTools?: TeamToolKit;

  apiKey?: string;
  signal?: AbortSignal;
  onActivity?: (summary: string) => void;
  onToolEvent?: (event: ProviderToolEvent) => void;
  onMessage?: (message: string) => void;
  onPartialMessage?: (message: string) => void;

  openUrl?: (url: string) => Promise<void>;

  computer?: {

    browserOpen(url: string): Promise<{ url: string; title: string }>;

    readForeground(): Promise<{
      window: string;
      text: string;
      controls: Array<{ name: string; type: string; value?: string }>;
    }>;
    checkScreen(assertion: string): Promise<{ passed: boolean; observation: string }>;
    clickByName(name: string): Promise<{ clicked: string }>;
    typeByName(text: string, into?: string): Promise<{ typed: string; into?: string }>;
    pressKey(key: string): Promise<{ pressed: string }>;
    scrollForeground(delta: number): Promise<{ scrolled: number }>;
    screenshot(destination: string): Promise<{ path: string; bytes: number; width: number; height: number }>;
    listWindows(): Promise<Array<{ title: string; process?: string }>>;
    focusWindow(title: string): Promise<{ focused: string }>;
    launchApp(fileName: string, args?: string): Promise<{ launched: string; processId?: number }>;
    pageAvailable(): Promise<boolean>;
    downloadState?(name: string): Promise<'completed' | 'cancelled' | 'pending' | 'unknown'>;
    pageOpen(url: string): Promise<{ url: string; title: string }>;
    pageOpenNewTab(url: string): Promise<{ url: string; title: string }>;
    pageRead(): Promise<Record<string, unknown>>;
    pageText(maxCharacters?: number): Promise<unknown>;
    pageScreenshot(destination: string): Promise<unknown>;
    pageFind(query: string): Promise<unknown>;
    pageClick(ref: string): Promise<unknown>;
    pageFill(ref: string, value: string): Promise<unknown>;
    pagePress(key: string, ref?: string): Promise<unknown>;
    pageScroll(delta: number): Promise<unknown>;
    pageBack(): Promise<unknown>;
    pageWaitFor(text: string): Promise<unknown>;
    pageTabs(): Promise<unknown>;
    pageSwitchTab(tabId: string): Promise<unknown>;
    pageCloseTab(tabId: string): Promise<unknown>;
    pageEvaluate(expression: string, resultId?: string, offset?: number, destination?: string): Promise<unknown>;
    pageConsole(options: { level?: 'all' | 'error'; limit?: number }): Promise<unknown>;
    pageNetwork(options: { failedOnly?: boolean; urlPattern?: string; limit?: number }): Promise<unknown>;
    pageHover(ref: string): Promise<unknown>;
    pageClickWith(ref: string, options: { button?: 'left' | 'right'; clickCount?: number }): Promise<unknown>;
    pageDrag(fromRef: string, toRef: string): Promise<unknown>;
    pageResize(width: number, height: number, mobile: boolean): Promise<unknown>;
    pageSavePdf(destination: string): Promise<unknown>;
    pageUpload(ref: string, filePath: string): Promise<unknown>;
    pageExtract(rowSelector: string, fields: Record<string, string>): Promise<unknown>;
    pageWaitForIdle(quietMillis: number, timeoutMs: number): Promise<unknown>;
    pageClickAndWait(ref: string, waitFor: { text?: string; urlChanges?: boolean; idle?: boolean }): Promise<unknown>;
    pageFillForm(fields: Array<{ ref: string; value: string }>): Promise<unknown>;
    pageExtensions(): Promise<unknown>;
    pageFocusExtension(viewId: string): Promise<unknown>;
  };
};

type ProviderTurnResult = {
  answer: string;
  sessionId: string;
};

type HostToolBinding = {
  sessionId: string;
  followUp: (text: string) => void;
  env: Record<string, string>;
  close: () => void;
} | null;

type StreamAgent = {
  provider: Provider;
  executable: string;
  args: string[];
  stdin: string;
  keepStdinOpen: boolean;
  env: Record<string, string>;
  streamMessage: (text: string) => string;
};

const CODEX_THREAD_SANDBOX = 'danger-full-access';

class ProviderProcessError extends Error {
  constructor(public readonly raw: string, public readonly exitCode: number | null) {
    super('The provider could not complete this request.');
    this.name = 'ProviderProcessError';
  }
}

type ProviderFailureKind = 'contextLimit' | 'usageLimit' | 'auth' | 'model' | 'offline' | 'busy' | 'timeout' | 'unknown';

const PROVIDER_FAILURE_PATTERNS: Array<[ProviderFailureKind, RegExp]> = [

  ['contextLimit', /\bcontext[\s_-]?(?:length|window|limit|size)\b|\bcontext_length_exceeded\b|\bprompt is too long\b|\bmaximum context\b|\btoo many tokens\b|\binput (?:is )?too long\b|\breduce the length of the (?:messages|prompt|conversation)\b|\bexceeds? the (?:model'?s )?(?:maximum |max )?(?:input |token )?(?:length|size)\b/i],
  ['usageLimit', /\b(?:usage|rate|token|message|weekly|monthly|daily)[\s_-]?limit(?:s)?\b|\blimit reached\b|\brate[\s_-]?limit(?:ed|_error|_exceeded)?\b|\binsufficient[\s_-]?quota\b|\bquota\b|\bexceeded your current\b|\bcredit balance is too low\b|\binsufficient credit\b|\bbilling\b|\btoo many requests\b|(?:^|\D)429(?:\D|$)|\bresets? (?:at|on|in)\b|\bupgrade (?:your plan|to)\b/i],
  ['auth', /\b(?:not authenticated|unauthenticated|not logged[\s_-]?in|login required|invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?(?:failed|error)|unauthorized|session (?:expired|invalid))\b|(?:^|\D)401(?:\D|$)|(?:^|\D)403(?:\D|$)/i],
  ['model', /\b(?:model[\s_-]?not[\s_-]?found|unknown model|unsupported model|does not (?:support|have access to)|no access to (?:the )?model)\b/i],
  ['offline', /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network (?:error|unreachable)|offline|getaddrinfo|failed to fetch|connection (?:refused|reset))\b/i],
  ['busy', /\b(?:overloaded|service unavailable|server (?:is )?busy|temporarily unavailable)\b|(?:^|\D)(?:502|503|529)(?:\D|$)/i],
  ['timeout', /\b(?:timed out|timeout|ETIMEDOUT|deadline exceeded)\b/i]
];

function providerFailureText(error: unknown): string {
  if (error instanceof ProviderProcessError) return error.raw;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause ? providerFailureText(cause) : '';
    return causeText && causeText !== error.message ? `${error.message}: ${causeText}` : error.message;
  }
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  return String(error ?? '');
}

function classifyProviderFailure(raw: unknown): ProviderFailureKind {
  const text = providerFailureText(raw);
  if (!text.trim()) return 'unknown';
  for (const [kind, pattern] of PROVIDER_FAILURE_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'unknown';
}

const PROVIDER_ACCOUNT_LABEL: Record<Provider, string> = {
  Claude: 'Claude',
  OpenAI: 'ChatGPT'
};

type ProviderSource = 'account' | 'apiKey';

const API_CONSOLE_URL: Record<Provider, string> = {
  OpenAI: 'platform.openai.com',
  Claude: 'platform.claude.com'
};

function unwrapJsonErrorEnvelope(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const inner = typeof parsed.error === 'string' ? parsed.error
      : typeof parsed.message === 'string' ? parsed.message
      : '';
    return inner.trim() || text;
  } catch {
    return text;
  }
}

function safeFailureDetail(raw: unknown) {
  if (raw instanceof ProviderProcessError) return '';
  const firstLine = unwrapJsonErrorEnvelope(providerFailureText(raw)).split('\n')[0] ?? '';
  const withoutFrames = firstLine.split(/\s+at\s+\S+\s*\(/)[0] ?? firstLine;
  const scrubbed = withoutFrames
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!scrubbed) return '';
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed;
}

function limitResetHint(raw: unknown) {
  const text = providerFailureText(raw);
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return ` It resets ${new Date(Number(epoch[1]) * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.`;
  const phrase = text.match(/\bresets?\s+((?:at|on|in)\s+)?([^.\n|·"]{2,48})/i);
  return phrase ? ` It resets ${phrase[1] ?? ''}${phrase[2].trim()}.` : '';
}

function describeProviderFailure(provider: Provider, raw: unknown, fallback?: string, source: ProviderSource = 'account') {
  const kind = classifyProviderFailure(raw);
  const account = PROVIDER_ACCOUNT_LABEL[provider] ?? 'AI';

  if (source === 'apiKey') {
    const vendor = providerTraits(provider).vendor;
    const console_ = API_CONSOLE_URL[provider];
    if (kind === 'usageLimit') {
      return `This ${vendor} API key has reached its rate or spend limit. Check the key's usage and billing at ${console_}, then try again once it resets or the limit is raised.`;
    }
    if (kind === 'auth') {
      return `${vendor} rejected this API key. It may have been revoked or rotated. Add a replacement key in AI Connections, then point the worker at it.`;
    }
    if (kind === 'model') {
      return `This ${vendor} API key cannot use that model. Keys are limited by the account's spend tier — choose another model in Worker Settings.`;
    }
  }

  if (kind === 'contextLimit') {
    return `This conversation is now too long for the model to read in one go. Copy anything you still need, then use the bin icon at the top of this chat to delete it and start fresh.`;
  }
  if (kind === 'usageLimit') {
    const where = provider === 'Claude'
      ? 'Check your plan usage in the Claude app or at claude.ai under Settings, and see when it resets.'
      : provider === 'OpenAI'
        ? 'Check your plan usage and billing in the ChatGPT app or at chatgpt.com under Settings.'
        : `Check the usage and billing on your ${providerTraits(provider).vendor} account.`;
    return `Your ${account} account has reached its usage limit, so this request was refused.${limitResetHint(raw)} ${where} The connection itself is fine — reconnecting will not restore it.`;
  }
  if (kind === 'auth') return `This ${account} account needs to be signed in again. Reconnect it in AI Connections, then try again.`;
  if (kind === 'model') return 'That model is not available on this account. Choose a different model in Worker Settings.';
  if (kind === 'offline') return 'OmniAgent could not reach the provider. Check this computer\'s internet connection, then try again.';
  if (kind === 'busy') return `${account} is temporarily overloaded. Wait a moment and try again.`;
  if (kind === 'timeout') {
    const why = safeFailureDetail(raw);
    return why
      ? `The provider took too long to respond: ${why}`
      : 'The provider took too long to respond. Try the request again.';
  }
  const detail = safeFailureDetail(raw);
  if (fallback) return fallback;
  if (!detail) return 'The provider could not complete this request. Please try again.';
  return `The provider could not complete this request: ${detail}`;
}

function providerTurnError(provider: Provider, error: unknown, source: ProviderSource = 'account') {

  if (error instanceof Error && error.name === 'AbortError') return error;
  const kind = classifyProviderFailure(error);

  if (kind !== 'unknown') return new Error(describeProviderFailure(provider, error, undefined, source));
  if (error instanceof ProviderProcessError) return new Error(describeProviderFailure(provider, error, undefined, source));
  if (error instanceof Error && error.constructor === Error) return error;
  return new Error(describeProviderFailure(provider, error, undefined, source));
}

export function publicProviderConnectionError(provider: Provider) {
  return `The ${provider === 'OpenAI' ? 'OpenAI' : 'Anthropic'} provider is unavailable. Restart OmniAgent and try again.`;
}

function defaultModels(provider: Provider): AIModelView[] {
  if (provider === 'OpenAI') {
    return [
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Highest-capability Codex model',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6 Terra',
        description: 'Balanced speed and capability',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        description: 'Fast, high-volume work',
        reasoningEfforts: ['low', 'medium', 'high']
      }
    ];
  }
  if (provider === 'Claude') {
    return [
      { id: 'sonnet', label: 'Claude Sonnet', description: 'Recommended everyday model', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'opus', label: 'Claude Opus', description: 'Deep reasoning and complex work', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'haiku', label: 'Claude Haiku', description: 'Fast lightweight work', reasoningEfforts: ['low', 'medium', 'high'] }
    ];
  }
  return [];
}

const OS_TERMS = process.platform === 'darwin'
  ? {
    osName: 'macOS',
    fileManager: 'Finder',
    terminalName: 'Terminal',
    shellName: 'shell',
    shellLanguage: 'shell',
    programNoun: 'application',
    exampleProgram: 'TextEdit',
    examplePrograms: 'TextEdit, Preview, or Numbers',
    exampleLaunchable: 'TextEdit, Calculator, or the full path to an .app',
    shortcutExample: 'Cmd+S'
  }
  : process.platform === 'linux'
  ? {
    osName: 'Linux',
    fileManager: 'the file manager',
    terminalName: 'the terminal',
    shellName: 'shell',
    shellLanguage: 'shell',
    programNoun: 'application',
    exampleProgram: 'Text Editor',
    examplePrograms: 'Text Editor, Image Viewer, or Document Viewer',
    exampleLaunchable: 'Text Editor, Calculator, or the full path to an executable',
    shortcutExample: 'Ctrl+S'
  }
  : {
    osName: 'Windows',
    fileManager: 'File Explorer',
    terminalName: 'PowerShell',
    shellName: 'PowerShell',
    shellLanguage: 'powershell',
    programNoun: 'program',
    exampleProgram: 'notepad',
    examplePrograms: 'notepad, mspaint, or wordpad',
    exampleLaunchable: 'notepad, calc, or the full path to an .exe',
    shortcutExample: 'Ctrl+S'
  };

const sourceModulesRoot = path.resolve(__dirname, '..', 'node_modules');

function executableCandidates(provider: Provider, userData: string) {
  const unpackedRoot = process.resourcesPath;
  const isMac = process.platform === 'darwin';
  const isLinux = process.platform === 'linux';
  const exe = (name: string) => (isMac || isLinux ? name : `${name}.exe`);
  const linuxArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const linuxTriple = process.arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl';
  const linuxSharedRoot = '/opt/OmniAgent/providers';
  const sharedRoot = '/Library/Application Support/OmniAgent/providers';
  const windowsSharedRoots = process.platform === 'win32'
    ? [...new Set([process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean) as string[])]
      .map((root) => path.join(root, 'OmniAgent', 'resources', 'providers'))
    : [];
  const codexVendor = isMac
    ? ['@openai', 'codex-darwin-x64', 'vendor', 'x86_64-apple-darwin', 'bin', 'codex']
    : isLinux
      ? ['@openai', `codex-linux-${linuxArch}`, 'vendor', linuxTriple, 'bin', 'codex']
      : ['@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];

  if (provider === 'OpenAI') {
    return [
      process.env.OMNIAGENT_CODEX_PATH,
      managedRuntimePath(path.join(userData, 'providers'), 'codex'),
      path.join(unpackedRoot, 'providers', 'codex', 'bin', exe('codex')),
      path.join(userData, 'providers', 'codex', 'bin', exe('codex')),
      path.join(sourceModulesRoot, ...codexVendor),
      path.join(userData, 'providers', exe('codex')),
      ...(isMac ? [path.join(sharedRoot, 'codex', 'bin', 'codex'), '/usr/local/bin/codex', '/opt/homebrew/bin/codex'] : []),
      ...(isLinux ? [path.join(linuxSharedRoot, 'codex', 'bin', 'codex'), '/usr/local/bin/codex', '/usr/bin/codex'] : []),
      ...windowsSharedRoots.map((root) => path.join(root, 'codex', 'bin', exe('codex'))),
      'codex'
    ].filter(Boolean) as string[];
  }
  return [
    process.env.OMNIAGENT_CLAUDE_PATH,
    managedRuntimePath(path.join(userData, 'providers'), 'claude'),
    path.join(unpackedRoot, 'providers', 'claude', exe('claude')),
    path.join(userData, 'providers', 'claude', exe('claude')),
    ...(isLinux ? [] : [path.join(sourceModulesRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]),
    ...(isMac
      ? [path.join(sourceModulesRoot, '@anthropic-ai', `claude-code-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'claude')]
      : []),
    ...(isLinux
      ? [path.join(sourceModulesRoot, '@anthropic-ai', `claude-code-linux-${linuxArch}`, 'claude')]
      : []),
    path.join(userData, 'providers', exe('claude')),
    ...(isMac ? [path.join(sharedRoot, 'claude', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'] : []),
    ...(isLinux ? [path.join(linuxSharedRoot, 'claude', 'claude'), '/usr/local/bin/claude', '/usr/bin/claude'] : []),
    ...windowsSharedRoots.map((root) => path.join(root, 'claude', exe('claude'))),
    'claude'
  ].filter(Boolean) as string[];
}

function anthropicCompatibleEnv(input: { apiKey?: string }): Record<string, string> {
  return input.apiKey ? { ANTHROPIC_API_KEY: input.apiKey } : {};
}

function providerRuntimeInstalled(provider: Provider, userData: string) {
  return isExecutableFile(firstAvailableExecutable(provider, userData));
}

export function firstAvailableExecutable(provider: Provider, userData: string) {
  const candidates = executableCandidates(provider, userData);
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return candidate;
    if (['codex', 'claude'].includes(candidate)) {
      for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
        const executable = path.join(directory, candidate + (process.platform === 'win32' ? '.exe' : ''));
        if (isExecutableFile(executable)) return executable;
      }
    }
  }
  return candidates[candidates.length - 1];
}

export function stripHiddenModelReasoning(value: unknown) {
  let text = String(value ?? '')
    .replace(/<(?:analysis|thinking|think)\b[^>]*>[\s\S]*?<\/(?:analysis|thinking|think)>/gi, '');
  const unclosedReasoning = text.search(/<(?:analysis|thinking|think)\b[^>]*>/i);
  if (unclosedReasoning >= 0) text = text.slice(0, unclosedReasoning);
  return text
    .replace(/<\/?(?:analysis|thinking|think)\b[^>]*>/gi, '')
    .trim();
}

const OMNIAGENT_TOOL_NAME = TOOL_NAME_PATTERN_SOURCE;

const userDirectedToolInstruction = new RegExp(String.raw`\byou\s+(?:can|could|should|shall|may|might|must|will|would|need\s+to|have\s+to)\s+(?:then\s+)?(?:call|invoke|use|run|execute|try)\b[^.!?]*?\b(?:tool\b|${OMNIAGENT_TOOL_NAME})`, 'i');

const TOOL_PLAIN_WORDS: Array<[RegExp, string]> = [
  [/\bthe\s+tool\s+(?:response|result|output|call|transcript|schema)\b/gi, 'the result'],
  [/\bweb_search\b/gi, 'the web search'],
  [/\bfetch_url\b/gi, 'the page'],
  [/\bopen_search_in_browser\b/gi, 'the browser search'],
  [/\b(?:open_page|open_url)\b/gi, 'the page'],
  [/\bwrite_document\b/gi, 'the document'],
  [/\b(?:write_file|edit_file|read_file)\b/gi, 'the file'],
  [/\bdownload_file\b/gi, 'the download'],
  [/\b(?:list_files|glob_search|grep_search)\b/gi, 'the search'],
  [/\btake_screenshot\b/gi, 'the screenshot'],
  [/\bcheck_screen\b/gi, 'the screen check'],
  [/\bget_datetime\b/gi, 'the clock'],
  [/\bbrowser_[a-z_]+\b/gi, 'the page'],
  [/\blist_windows\b/gi, 'the window list'],
  [/\bfocus_window\b/gi, 'the window focus'],
  [/\bread_screen\b/gi, 'the screen reader'],
  [/\bclick_element\b/gi, 'the click'],
  [/\btype_text\b/gi, 'the keyboard'],
  [/\bpress_key\b/gi, 'the keyboard'],
  [/\bscroll_page\b/gi, 'the scroll'],
  [/\b(?:open_app|open_with)\b/gi, 'the application launcher'],
  [/\bopen_terminal\b/gi, 'the terminal'],
  [/\bopen_folder\b/gi, 'the folder'],
  [/\brun_command\b/gi, 'the command'],
  [/\b(?:clipboard_read|clipboard_write)\b/gi, 'the clipboard'],
  [/\b(?:copy_file|move_file|delete_file|make_directory)\b/gi, 'the file'],
  [/\b(?:create_archive|extract_archive)\b/gi, 'the archive'],
  [/\bhttp_request\b/gi, 'the request'],
  [/\bupload_file\b/gi, 'the upload'],
  [/\bwait_for_download\b/gi, 'the download'],
  [/\bverify_image\b/gi, 'the image check'],
  [new RegExp(String.raw`\b${OMNIAGENT_TOOL_NAME}\b`, 'gi'), 'the tool']
];

function redactToolVocabulary(sentence: string) {
  let text = sentence;
  for (const [pattern, plain] of TOOL_PLAIN_WORDS) text = text.replace(pattern, plain);
  return text.replace(/\bthe\s+the\b/gi, 'the').replace(/\s{2,}/g, ' ');
}

function mentionsToolVocabulary(sentence: string) {
  return new RegExp(String.raw`\b${OMNIAGENT_TOOL_NAME}\b`, 'i').test(sentence)
    || /\btool\s+(?:response|result|output|call|transcript|schema)\b/i.test(sentence);
}

const NEWLINE = '\n';
const PARAGRAPH_BREAK = '\n\n';
const BLANK_RUN = /\n{3,}/g;

export function stripToolPlanningNarration(value: string) {
  const segments = String(value ?? '').split(/(```[\s\S]*?(?:```|$))/);
  const cleaned = segments.map((segment, index) => {
    if (index % 2 === 1) return segment;
    return segment
      .split(NEWLINE)
      .map((line) => {
        if (!userDirectedToolInstruction.test(line) && !mentionsToolVocabulary(line)) return line;
        return (line.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [line])
          .filter((sentence) => sentence.trim() && !userDirectedToolInstruction.test(sentence))
          .map((sentence) => mentionsToolVocabulary(sentence) ? redactToolVocabulary(sentence) : sentence)
          .join('')
          .trim();
      })
      .filter((line, position, lines) => line.trim() || (position > 0 && lines[position - 1].trim()))
      .join(NEWLINE);
  }).join('');
  const result = cleaned.replace(BLANK_RUN, PARAGRAPH_BREAK).trim();
  if (result) return result;
  if (userDirectedToolInstruction.test(String(value ?? ''))) return '';
  return redactToolVocabulary(String(value ?? '')).trim();
}

function looksLikeRawToolOutput(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^"?Error:/i.test(trimmed)) return true;
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {

    return /"(?:results|query|snippet|url|title|error)"\s*:/.test(trimmed);
  }
}

function cleanPublicAnswer(value: unknown, structured?: 'json' | 'text') {
  let text = stripHiddenModelReasoning(value);
  const markdownWrapper = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  if (markdownWrapper) text = markdownWrapper[1].trim();

  if (structured === 'json') return text;
  if (looksLikeRawToolOutput(text)) {
    return 'I could not turn what the tools returned into an answer. This model is weak at using tools — try a stronger local model, or switch this worker to Claude or ChatGPT.';
  }
  return text || EMPTY_PROVIDER_ANSWER;
}

const EMPTY_PROVIDER_ANSWER = 'I completed the request, but the provider returned an empty final response.';

const HOST_TOOL_ACTIVITY: Record<string, string> = {
  write_file: 'Writing requested files',
  edit_file: 'Editing requested files',
  read_file: 'Inspecting requested files',
  list_files: 'Inspecting requested files',
  glob_search: 'Looking through your files',
  grep_search: 'Searching inside your files',
  copy_file: 'Copying requested files',
  move_file: 'Moving requested files',
  delete_file: 'Removing requested files',
  make_directory: 'Creating the requested folder',
  extract_archive: 'Extracting the requested archive',
  create_archive: 'Creating the requested archive',
  open_folder: 'Opening the requested folder',
  open_terminal: 'Opening the requested terminal',
  web_search: 'Searching the web',
  fetch_url: 'Reading the page',
  browser_text: 'Reading the page',
  browser_screenshot: 'Taking a picture of the page',
  open_url: 'Opening the site in your browser',
  open_page: 'Opening the site in your browser',
  open_search_in_browser: 'Searching in your browser',
  run_command: 'Running the requested command',
  read_screen: 'Reading what is on screen',
  click_element: 'Clicking on the page',
  type_text: 'Typing on the page',
  press_key: 'Typing on the page',
  scroll_page: 'Scrolling the page',
  take_screenshot: 'Taking a screenshot',
  check_screen: 'Checking the screen',
  list_windows: 'Looking at your open windows',
  focus_window: 'Looking at your open windows',
  open_app: 'Starting the requested program',
  download_file: 'Downloading the requested file',
  write_document: 'Writing the requested document',
  get_datetime: 'Checking the date and time'
};

function minimumAcceptableWords(requested: number | undefined) {
  if (!requested || requested <= 0) return 0;
  return Math.max(1, requested - Math.max(Math.ceil(requested * 0.2), 10));
}

function htmlToText(html: string) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

    .replace(/&(nbsp|amp|lt|gt|quot|apos|deg|mdash|ndash|hellip|rsquo|lsquo|ldquo|rdquo|middot|bull|times|eacute|copy|reg|trade|pound|euro|frac12);/gi, (_match, name: string) => ({
      nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", deg: '°',
      mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“',
      rdquo: '”', middot: '·', bull: '•', times: '×', eacute: 'é', copy: '©',
      reg: '®', trade: '™', pound: '£', euro: '€', frac12: '½'
    } as Record<string, string>)[name.toLowerCase()] ?? _match)
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchPageHtml(url: string, signal?: AbortSignal) {

  const timeout = AbortSignal.timeout(20_000);
  const combined = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
  const response = await fetch(url, {
    signal: combined,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.text();
}

type SearchResult = { title: string; url: string; snippet: string };

function parseSearxResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const article of html.matchAll(/<article[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const body = article[1];
    const link = body.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*url_header[^"]*"/i)
      ?? body.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!link) continue;
    const url = link[1].replace(/&amp;/g, '&');
    if (/^https?:\/\/web\.archive\.org/i.test(url)) continue;
    const heading = body.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = htmlToText(heading?.[1] ?? '').slice(0, 200);
    if (!title) continue;
    const snippet = body.match(/<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    results.push({ title, url, snippet: htmlToText(snippet?.[1] ?? '').slice(0, 500) });
    if (results.length >= 10) break;
  }
  return results;
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const titleLink = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(titleLink)];
  for (const [index, match] of anchors.entries()) {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < anchors.length ? anchors[index + 1].index ?? html.length : html.length;
    const body = html.slice(start, end);
    const snippet = body.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    let url = match[1].replace(/&amp;/g, '&');

    const direct = url.match(/[?&]uddg=([^&]+)/);
    if (direct) url = decodeURIComponent(direct[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    const title = htmlToText(match[2]).slice(0, 200);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet: snippet ? htmlToText(snippet[1]).slice(0, 500) : '' });
    if (results.length >= 10) break;
  }
  return results;
}

const SEARCH_MIRRORS: Array<{ url: string; parse: (html: string) => SearchResult[] }> = [
  { url: 'https://html.duckduckgo.com/html/?q=', parse: parseDuckDuckGoResults },
  { url: 'https://lite.duckduckgo.com/lite/?q=', parse: parseDuckDuckGoResults },
  { url: 'https://searxng.site/search?q=', parse: parseSearxResults },
  { url: 'https://search.inetol.net/search?q=', parse: parseSearxResults },
  { url: 'https://searx.perennialte.ch/search?q=', parse: parseSearxResults },
  { url: 'https://duckduckgo.com/html/?q=', parse: parseDuckDuckGoResults }
];

async function fetchSearchResults(query: string, signal?: AbortSignal) {
  let lastError: unknown = new Error('No search endpoint answered.');
  let unreachable = 0;
  for (const mirror of SEARCH_MIRRORS) {
    if (signal?.aborted) throw new DOMException('The task was cancelled by the user.', 'AbortError');
    try {
      const results = mirror.parse(await fetchPageHtml(`${mirror.url}${encodeURIComponent(query)}`, signal));
      if (results.length) return results;
      lastError = new Error('The search returned no results.');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (/timeout|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i.test(providerFailureText(error))) unreachable += 1;
      lastError = error;
    }
  }
  if (unreachable === SEARCH_MIRRORS.length) {
    throw new Error('No search engine could be reached from this computer, so nothing could be looked up.'
      + ' Every one timed out. This is a network problem rather than anything about the worker —'
      + ' check the connection, a VPN, or whatever filters traffic here.');
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const BROWSER_SEARCH_ENGINES = [
  { url: 'https://duckduckgo.com/?q=', host: 'duckduckgo.com' },
  { url: 'https://search.brave.com/search?q=', host: 'brave.com' }
];

function browserSearchExtractor(engineHost: string) {
  return `(() => {
    const skip = ${JSON.stringify(engineHost)};
    const seen = new Set();
    const out = [];
    for (const anchor of document.querySelectorAll('a[href^="http"]')) {
      const url = anchor.href;
      let host = '';
      try { host = new URL(url).hostname.replace(/^www\\./, ''); } catch (error) { continue; }
      if (!host || host === skip || host.endsWith('.' + skip) || seen.has(url)) continue;
      const title = (anchor.innerText || anchor.textContent || '').replace(/\\s+/g, ' ').trim();
      if (title.length < 12 || /^https?:/i.test(title) || title.includes(' › ')) continue;
      seen.add(url);
      const box = anchor.closest('article, li, [class*="result"]') || anchor.parentElement;
      const text = box ? (box.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      out.push({ title: title.slice(0, 200), url, snippet: text.replace(title, '').trim().slice(0, 500) });
      if (out.length >= 10) break;
    }
    return out;
  })()`;
}

function readExtractedSearchRows(value: unknown): SearchResult[] {
  const payload = value && typeof value === 'object' ? (value as { result?: unknown }).result : undefined;
  const rows = Array.isArray(payload) ? payload : Array.isArray(value) ? value : [];
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as { title?: unknown; url?: unknown; snippet?: unknown };
    const title = String(entry.title ?? '').trim();
    const url = String(entry.url ?? '').trim();
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, snippet: String(entry.snippet ?? '').trim() });
  }
  return results;
}

async function browserSearchResults(
  query: string,
  computer: ProviderTurnInput['computer'],
  signal?: AbortSignal
): Promise<SearchResult[]> {
  if (!computer) return [];
  if (!await computer.pageAvailable().catch(() => false)) return [];
  for (const engine of BROWSER_SEARCH_ENGINES) {
    if (signal?.aborted) throw new DOMException('The task was cancelled by the user.', 'AbortError');
    try {
      await computer.pageOpen(`${engine.url}${encodeURIComponent(query)}`);
      const results = readExtractedSearchRows(await computer.pageEvaluate(browserSearchExtractor(engine.host)));
      if (results.length) return results;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
    }
  }
  return [];
}

async function fetchReadableText(url: string, signal?: AbortSignal) {
  const html = await fetchPageHtml(url, signal);
  const title = htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 200);
  const main = html.match(/<(?:main|article)\b[\s\S]*?<\/(?:main|article)>/i)?.[0]
    ?? html.match(/<body\b[\s\S]*?<\/body>/i)?.[0]
    ?? html;
  return { title, text: htmlToText(main) };
}

const ARTEFACT_WORDS = /\b(?:file|folder|directory|document|project|website|web\s*app|application|repository|repo|csv|json|html|css|javascript|typescript|jsx|tsx|pdf|docx|xlsx|spreadsheet|presentation|pptx|page|site|script|nav\s*bar|navbar|header|footer|section|button|image|picture|photo|logo|screenshot)\b/i;

const RESEARCH_MARKERS = /\b(?:weather|forecast|temperature|news|headline|today|tonight|tomorrow|yesterday|right now|currently|current|latest|recent|live|upcoming|score|prices?|cost of|stock|exchange rate|who won|what happened|this (?:week|month|year)|opening hours|open now|near me)\b/i;

const RESEARCH_INTENT = /\b(?:research(?:ing|ed)?|look(?:ing|ed)? up|look up|search(?:ing|ed)? (?:for|the web|online|the internet)|google|find out|cheapest|most expensive|best (?:price|deal|option)s?|lowest price|availability|in stock|release dates?|specs?|specifications?|reviews?|benchmarks?|compare (?:the )?(?:prices|models|options|specs))\b/i;

const SELF_QUESTION = /\b(?:who are you|what(?:'s| is| are) your (?:name|role|job|purpose|task|duties)|what do you do|introduce yourself)\b/i;

function withoutFileNames(value: string) {
  return value.replace(/\b[\w()-]+\.[A-Za-z][A-Za-z0-9]{0,4}\b/g, ' ');
}

const BROWSER_CONTROL_TOOLS = new Set([
  'open_page', 'open_url', 'open_search_in_browser', 'read_screen', 'click_element', 'type_text',
  'press_key', 'scroll_page', 'take_screenshot', 'check_screen', 'list_windows', 'focus_window', 'open_app',
  'browser_read', 'browser_find', 'browser_click', 'browser_fill', 'browser_press',
  'browser_scroll', 'browser_back', 'browser_wait_for', 'browser_tabs', 'browser_open_tab',
  'browser_switch_tab', 'browser_close_tab', 'browser_evaluate', 'browser_console',
  'browser_network', 'browser_hover', 'browser_click_special', 'browser_drag', 'browser_resize',
  'browser_text', 'browser_screenshot'
]);

function requestNeedsResearch(value: string) {
  if (SELF_QUESTION.test(value)) return false;
  const text = withoutFileNames(value);
  return RESEARCH_MARKERS.test(text) || RESEARCH_INTENT.test(text);
}

function isBinaryDocument(filePath: string) {
  return ['.docx', '.xlsx', '.pptx', '.pdf'].includes(path.extname(filePath).toLowerCase());
}

function repairLostSeparators(target: string, workerRoot: string) {
  const flatten = (value: string) => value.replace(/[\\/]+/g, '').toLowerCase();
  const rootFlat = flatten(workerRoot);
  const targetFlat = flatten(target);
  if (targetFlat === rootFlat) return workerRoot;
  if (!targetFlat.startsWith(rootFlat)) return '';
  let tail = targetFlat.slice(rootFlat.length);
  let current = workerRoot;
  while (tail) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return ''; }

    const match = entries
      .map((entry) => entry.name)
      .sort((left, right) => right.length - left.length)
      .find((entryName) => tail.startsWith(flatten(entryName)));
    if (!match) return '';
    current = path.join(current, match);
    tail = tail.slice(flatten(match).length);
  }
  return current;
}

const HOST_TOOL_BUDGET = 16;
const EXTENDED_HOST_TOOL_BUDGET = 34;

const ESSENTIAL_HOST_TOOLS = [
  'web_search', 'fetch_url', 'open_page', 'browser_read', 'browser_find', 'browser_click',
  'list_files', 'read_file', 'write_file', 'get_datetime'
];

const HOST_TOOL_PRIORITY = [
  'browser_text', 'browser_fill', 'browser_press', 'browser_scroll', 'browser_extract',
  'browser_tabs', 'browser_open_tab', 'browser_switch_tab', 'browser_back', 'browser_wait_for',
  'edit_file', 'make_directory', 'glob_search', 'grep_search', 'move_file', 'copy_file',
  'download_file', 'write_document', 'open_url', 'http_request', 'delete_file',
  'take_screenshot', 'read_screen', 'open_folder', 'run_command'
];

function hostToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and folders at a local path.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file, or a Word .docx document, from the computer and return its text.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' },
          offset: { type: 'number', description: 'Byte offset for text, character offset for documents; use to continue reading a large file.' },
          length: { type: 'number', description: 'Amount to read, up to 250000.' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or overwrite a UTF-8 text file. Parent folders are created automatically.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Change part of an existing text file by replacing an exact snippet. Always use this instead of write_file when the file already exists, so the rest of the file is preserved.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string', description: 'The exact text to replace, copied from the file including its indentation.' },
            new_string: { type: 'string', description: 'The replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'copy_file',
        description: 'Copy a file or folder, leaving the original in place. Use this to bring an attached image or document into a project folder.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            destination: { type: 'string' }
          },
          required: ['source', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'grep_search',
        description: 'Search the text inside files for a regular expression and return the matching lines with their file and line number.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Folder to search. Defaults to the working folder.' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'glob_search',
        description: 'Find files by name pattern such as *.html or **/*.css, searching subfolders.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            path: { type: 'string', description: 'Folder to search. Defaults to the working folder.' }
          },
          required: ['pattern']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'make_directory',
        description: 'Create a local folder and its parents.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Permanently delete a local file or folder. This cannot be undone, so only use it when the user asked for the item to be removed.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'move_file',
        description: 'Move or rename a local file or folder.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            destination: { type: 'string' }
          },
          required: ['source', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'extract_archive',
        description: 'Extract a ZIP archive into a local destination folder and verify the extracted files.',
        parameters: {
          type: 'object',
          properties: {
            archive: { type: 'string' },
            destination: { type: 'string' }
          },
          required: ['archive', 'destination']
        }
      }
    },
    {
      type: 'function',
      function: {

        name: 'create_archive',
        description: 'Put a folder or a file into a new ZIP archive.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The folder or file to compress.' },
            archive: { type: 'string', description: 'The .zip file to create.' }
          },
          required: ['source', 'archive']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_folder',
        description: `Open a local folder in ${OS_TERMS.fileManager}.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_terminal',
        description: `Open an interactive ${OS_TERMS.terminalName} window in a local working folder.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web and read the results. Returns titles, links and snippets as text, so use this to answer anything you do not already know: current events, weather, prices, or facts newer than your training data.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fetch_url',
        description: 'Download one HTTPS page and return its readable text. Use it after web_search when a result looks worth reading in full.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'verify_image',
        description: 'Check that a saved image file is a real photograph or picture, not a placeholder, an icon, or a drawing the model produced itself. Call this after saving an image you were told to download, before reporting the step done.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Full path to the image file.' },
            minimumWidth: { type: 'number', description: 'Smallest acceptable width in pixels. Defaults to 200.' },
            minimumHeight: { type: 'number', description: 'Smallest acceptable height in pixels. Defaults to 200.' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'http_request',
        description: 'Send an HTTP request to an API and get the response body back. Use this for a real API — GET with query parameters, or POST with a JSON body and headers. For reading an ordinary web page as text, use fetch_url instead.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The complete https URL.' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Defaults to GET.' },
            headers: { type: 'object', description: 'Header name to value, for example { "Content-Type": "application/json" }.' },
            body: { type: 'string', description: 'Request body as a string. For JSON, pass the serialised JSON.' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_with',
        description: `Open a file in a named ${OS_TERMS.programNoun} rather than whatever ${OS_TERMS.osName} opens it with by default, for example opening an .html file in ${OS_TERMS.exampleProgram} instead of a browser.`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Full path to the file to open.' },
            program: { type: 'string', description: `${OS_TERMS.programNoun === 'application' ? 'Application' : 'Program'} name or full path, for example ${OS_TERMS.examplePrograms}.` }
          },
          required: ['path', 'program']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clipboard_write',
        description: `Put text on the ${OS_TERMS.osName} clipboard so it can be pasted into another ${OS_TERMS.programNoun}.`,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The text to copy.' } },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clipboard_read',
        description: `Read whatever text is currently on the ${OS_TERMS.osName} clipboard. Useful for getting a value out of a ${OS_TERMS.programNoun} that offers a Copy button but no file export.`,
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_save_pdf',
        description: 'Save the page currently open in the browser as a PDF file. Use this for an invoice, receipt, confirmation or ticket that only exists as a web page.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Where to save it, ending in .pdf.' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'wait_for_download',
        description: 'Wait until a file that a page started downloading has finished arriving, and return its path. Call this straight after clicking a download link, instead of guessing that the file is ready.',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder the download lands in. Defaults to your output folder.' },
            timeoutSeconds: { type: 'number', description: 'Optional user-requested deadline. Omit to wait until complete or stopped.' },
            nameContains: { type: 'string', description: 'Only accept a file whose name contains this text.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'upload_file',
        description: 'Attach a local file to a file-upload control on the current page, the same as choosing it in the file picker. Read the page first to get the id of the upload field.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element id of the file input, from browser_read.' },
            path: { type: 'string', description: 'Full path to the file to attach.' }
          },
          required: ['ref', 'path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_datetime',

        description: 'Get the current date and time. Pass an IANA time zone such as America/New_York or Europe/London to get the time in that place; omit it for this computer\'s local time.',
        parameters: {
          type: 'object',
          properties: { timeZone: { type: 'string' } }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_search_in_browser',
        description: `Open a web search in the ${OS_TERMS.osName} default browser for the user to look at. This does not return results to you; use web_search when you need the answer yourself.`,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: `Run a ${OS_TERMS.shellName} command with full local permissions in the requested working folder.`,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_url',
        description: `Open an HTTPS URL in the ${OS_TERMS.osName} default browser.`,
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    },

    {
      type: 'function',
      function: {
        name: 'open_page',
        description: 'Open a web page in this worker\'s browser and bring it to the front, so you can then read it, click it, or type into it. Use this instead of open_url whenever you need to do something on the page rather than just show it to the user.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_read',
        description: 'Read the current web page as structured data: its text plus every clickable and typable element with a short id. This is the fast, exact way to see a page. Always prefer it over screenshots for anything in a browser.',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_text',
        description: 'Read only the words on the current page, with no clickable element list. Use this when you just need to read an article, a result or a description and are not going to click anything, because it costs a fraction of what browser_read does on a long page.',
        parameters: {
          type: 'object',
          properties: { maxCharacters: { type: 'number', description: 'Stop after this many characters. Defaults to 40000.' } },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_screenshot',
        description: 'Save a picture of the page currently open in the browser. Use this to show someone what a page looks like, or to check a layout. To read a page, use browser_text or browser_read instead — they are faster and exact.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Where to save it, ending in .png.' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_find',
        description: 'Find elements on the current page whose text, label or placeholder contains a phrase. Returns their ids so you can click or fill them.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Words to look for, for example "Send" or "Search mail".' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description: 'Click an element on the page by the id browser_read gave it. Exact, no coordinates, no guessing.',
        parameters: {
          type: 'object',
          properties: { ref: { type: 'string', description: 'Element id such as e12.' } },
          required: ['ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill',
        description: 'Type an exact value into a text box, textarea or dropdown by its element id.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element id such as e8.' },
            value: { type: 'string', description: 'Exact text to put in.' }
          },
          required: ['ref', 'value']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_press',
        description: 'Press a key such as Enter, Tab or Escape, optionally after focusing an element id.',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Enter, Tab, Escape, ArrowDown, PageDown, and similar.' },
            ref: { type: 'string', description: 'Optional element id to focus first.' }
          },
          required: ['key']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_scroll',
        description: 'Scroll the current page by a number of pixels. Positive scrolls down.',
        parameters: {
          type: 'object',
          properties: { delta: { type: 'number', description: 'Pixels to scroll, for example 800 or -800.' } },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_back',
        description: 'Go back to the previous page in this browser tab.',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_wait_for',
        description: 'Wait until a phrase appears on the page, for slow pages and apps that load after navigation.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Words that should appear.' } },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_tabs',
        description: 'List the open browser tabs with their ids, titles and URLs.',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_open_tab',
        description: 'Open one HTTPS page in a new browser tab and switch to it. Use this only for a small set of separate items that must be compared, such as the top 3–5 results from a ranked list.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The complete HTTPS URL to open.' } },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_switch_tab',
        description: 'Switch to one of the open tabs by its id.',
        parameters: {
          type: 'object',
          properties: { tabId: { type: 'string', description: 'Tab id from browser_tabs.' } },
          required: ['tabId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_extensions',
        description: 'List the browser extension windows that are currently open — a wallet asking to confirm, a VPN choosing a location, any extension popup — and the extensions installed in this browser. Call this when a task involves an extension, or when a page seems to be waiting on one.',
        parameters: { type: 'object', properties: {}, required: [] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_focus_extension',
        description: 'Switch to an open extension window so you can read and click inside it with the ordinary page tools. Use this to press Confirm, Approve, Sign, Connect or similar inside an extension. Switch back to the page afterwards with browser_switch_tab.',
        parameters: {
          type: 'object',
          properties: { viewId: { type: 'string', description: 'The viewId from browser_extensions. Omit it when only one extension window is open.' } },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_extract',
        description: 'Pull a repeating list off the page as rows of data in one call: search results, table rows, product cards, listings. Give the CSS selector for one repeating item and a map of field name to selector. Add @href or @src to take an attribute instead of the text. Far faster than reading and scrolling.',
        parameters: {
          type: 'object',
          properties: {
            rowSelector: { type: 'string', description: 'CSS selector matching one repeating item, for example "article.listing" or "table tbody tr".' },
            fields: {
              type: 'object',
              description: 'Field name to selector within the row. Example: { "title": "h2", "price": ".price", "link": "a@href" }. Use "" to take the row text itself.'
            }
          },
          required: ['rowSelector', 'fields']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_wait_for_idle',
        description: 'Wait until the page has finished loading and its network traffic has gone quiet. Call this after navigating or clicking something slow, instead of reading the page over and over to see whether it is ready.',
        parameters: {
          type: 'object',
          properties: {
            quietMillis: { type: 'number', description: 'How long the network must stay quiet. Default 700.' },
            timeoutSeconds: { type: 'number', description: 'Optional user-requested deadline in seconds. Omit to wait until ready or stopped.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_click_and_wait',
        description: 'Click something and wait for what it was meant to cause, in one call: a new page, or some text appearing. Use this instead of clicking and then reading the page repeatedly to see whether it worked.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element id from browser_read.' },
            waitForText: { type: 'string', description: 'Wait until this text appears on the page.' },
            waitForNewPage: { type: 'boolean', description: 'Wait until the address changes.' }
          },
          required: ['ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_fill_form',
        description: 'Fill several fields on the page in one call, then optionally press a button. Use this for a login or any form rather than filling one field per call.',
        parameters: {
          type: 'object',
          properties: {
            fields: {
              type: 'array',
              description: 'The fields to fill, in order.',
              items: {
                type: 'object',
                properties: {
                  ref: { type: 'string', description: 'Element id from browser_read.' },
                  value: { type: 'string', description: 'What to type into it.' }
                },
                required: ['ref', 'value']
              }
            },
            submitRef: { type: 'string', description: 'Element id of the button to click once the fields are filled.' }
          },
          required: ['fields']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_evaluate',
        description: 'Run a JavaScript expression inside the current page and get its value back. The fastest way to pull structured data out of a page: one call can return every row of a table or every listing on a results page as JSON, instead of reading and scrolling many times. The expression is evaluated in the page, so document, window and querySelectorAll are all available. For large extractions (hundreds of rows, long text, anything meant to end up in a file) pass saveTo: the complete result is written straight to that file and only its path, size and item count come back, so you never have to read the data in chunks and retype it with write_file.',
        parameters: {
          type: 'object',
          properties: {
            resultId: { type: 'string', description: 'Temporary result ID returned by an earlier evaluation; set expression to an empty string when continuing.' },
            offset: { type: 'number', description: 'nextOffset returned by the previous result chunk.' },
            saveTo: { type: 'string', description: 'File path relative to your working folder, for example data/rows.json. The complete result is written there instead of being returned: a string as-is, anything else as JSON. Works with resultId too, to save a result you already started reading in chunks.' },
            expression: {
              type: 'string',
              description: 'A JavaScript expression. Example: [...document.querySelectorAll("article")].map(a => ({ title: a.querySelector("h2")?.innerText, href: a.querySelector("a")?.href }))'
            }
          },
          required: ['expression']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_console',
        description: 'Read the browser console for the current page: script errors, warnings and log output. Use this when a page looks broken, half-loaded, or does not respond the way the page text suggests it should.',
        parameters: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['all', 'error'], description: 'Use "error" for only errors and warnings.' },
            limit: { type: 'number', description: 'How many of the most recent messages to return. Default 50.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_network',
        description: 'List the network requests the current page made, with method, URL and status. Use it to find a blocked or failing request, or to spot the underlying data API a page calls, which is often quicker to read than the rendered page.',
        parameters: {
          type: 'object',
          properties: {
            failedOnly: { type: 'boolean', description: 'Only requests that failed or returned status 400 or above.' },
            urlPattern: { type: 'string', description: 'Only requests whose URL contains this text.' },
            limit: { type: 'number', description: 'How many of the most recent requests to return. Default 50.' }
          },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_hover',
        description: 'Move the pointer onto an element without clicking, to open a hover menu or reveal a tooltip. Read the page afterwards to see what appeared.',
        parameters: {
          type: 'object',
          properties: { ref: { type: 'string', description: 'Element id from browser_read.' } },
          required: ['ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_click_special',
        description: 'Click an element with the right mouse button, or double-click it. Use this for context menus and for lists where opening an item needs a double click. An ordinary single left click is browser_click.',
        parameters: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element id from browser_read.' },
            button: { type: 'string', enum: ['left', 'right'], description: 'Which mouse button. Default left.' },
            clickCount: { type: 'number', description: 'Use 2 for a double click. Default 1.' }
          },
          required: ['ref']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_drag',
        description: 'Drag one element onto another: reordering a list, moving a card between columns, or setting a slider.',
        parameters: {
          type: 'object',
          properties: {
            fromRef: { type: 'string', description: 'Element id to drag, from browser_read.' },
            toRef: { type: 'string', description: 'Element id to drop it onto, from browser_read.' }
          },
          required: ['fromRef', 'toRef']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_resize',
        description: 'Set the size of the page viewport, optionally emulating a mobile device. Useful for checking a mobile layout, and for making a page narrow enough that its content needs less scrolling.',
        parameters: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'Viewport width in pixels, 320 to 3840.' },
            height: { type: 'number', description: 'Viewport height in pixels, 320 to 2160.' },
            mobile: { type: 'boolean', description: 'Emulate a touch mobile device at that size.' }
          },
          required: ['width', 'height']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'browser_close_tab',
        description: 'Close one tab you opened, by its id. Use this to tidy up the extra tabs you opened before you give your final answer. Never close a tab that was already open before you started.',
        parameters: {
          type: 'object',
          properties: { tabId: { type: 'string', description: 'Tab id from browser_tabs.' } },
          required: ['tabId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_screen',
        description: 'Read the window that is in front — the open web page or app — and return its visible text and the buttons, links and fields you can act on. Call this before clicking or typing so you know what is really there.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'click_element',
        description: 'Click a button, link, checkbox or menu item in the window in front, found by the text you can see on it.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The visible text of the thing to click, copied from read_screen.' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'type_text',
        description: 'Type text into the window in front. Pass into with a field name from read_screen to fill that field, or leave it out to type wherever the cursor already is.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            into: { type: 'string', description: 'The name or label of the field to type into.' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'press_key',
        description: `Press one key in the window in front, such as Enter, Tab, Escape, PageDown, or a combination like ${OS_TERMS.shortcutExample}.`,
        parameters: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'scroll_page',
        description: 'Scroll the window in front up or down to bring more content into view.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: 'up or down' },
            amount: { type: 'number', description: 'How many notches to scroll. Defaults to 3.' }
          },
          required: ['direction']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'take_screenshot',
        description: 'Save a PNG picture of the screen to a local file, so the user can see what is on it.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Where to save the .png file.' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'check_screen',
        description: 'Look at the screen and answer one yes/no question about it, for confirming a result you cannot read any other way. Returns a verdict and what was seen. Saves no file.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'One thing to confirm, e.g. "does the calculator show 64".' }
          },
          required: ['question']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_windows',
        description: 'List the application windows that are open on this computer.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'focus_window',
        description: 'Bring an open window to the front by its title, so read_screen and click_element act on that app.',
        parameters: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'open_app',
        description: `Start a ${OS_TERMS.osName} ${OS_TERMS.programNoun}, such as ${OS_TERMS.exampleLaunchable}.`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: `The ${OS_TERMS.programNoun} to start, for example ${OS_TERMS.exampleProgram}.` },
            arguments: { type: 'string', description: 'Optional command-line arguments.' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'download_file',
        description: 'Download a file from an http(s) URL and save it to a local path. Use this for a real file — a PDF, an image, an archive — not for reading a page as text.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            path: { type: 'string', description: 'Where to save it, including the file name and extension.' }
          },
          required: ['url', 'path']
        }
      }
    },
    {
      type: 'function',
      function: {

        name: 'write_document',
        description: 'Create a proper Word .docx, .pdf or Excel .xlsx file from content you write. Use this whenever the user asks for a Word document, a PDF, a report, a letter or a spreadsheet. You do not need Microsoft Office; OmniAgent builds the file itself.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The output file, ending in .docx, .pdf or .xlsx.' },
            title: { type: 'string' },
            content: { type: 'string', description: 'For .docx and .pdf, the complete body text; start a line with # for a heading or - for a bullet. In a .pdf you can also place a picture you have already downloaded by putting its full path on its own line as ![](C:\folder\picture.png) - use that to put each image beside the text about it. For .xlsx, comma-separated rows one per line, header row first.' }
          },
          required: ['path', 'content']
        }
      }
    }
  ];
}

function hostToolsForRequest(
  request: string,
  config: {
    fullCatalogue?: boolean;
    extendedCatalogue?: boolean;
    hostControlAvailable?: boolean;
    deliberate?: boolean;
  } = {}
) {
  const hostControlled = new Set([
    'open_page', 'read_screen', 'click_element', 'type_text', 'press_key',
    'scroll_page', 'take_screenshot', 'check_screen', 'list_windows', 'focus_window', 'open_app',
    'browser_read', 'browser_find', 'browser_click', 'browser_fill', 'browser_press',
    'browser_scroll', 'browser_back', 'browser_wait_for', 'browser_tabs', 'browser_open_tab', 'browser_switch_tab',
    'browser_close_tab', 'browser_evaluate', 'browser_console', 'browser_network', 'browser_hover',
    'browser_click_special', 'browser_drag', 'browser_resize', 'browser_save_pdf', 'upload_file',
    'browser_extract', 'browser_wait_for_idle', 'browser_click_and_wait', 'browser_fill_form',
    'browser_extensions', 'browser_focus_extension', 'browser_text', 'browser_screenshot'
  ]);
  const all = hostToolDefinitions()
    .filter((tool) => config.hostControlAvailable || !hostControlled.has(tool.function.name));
  const text = request.toLowerCase();

  const wanted = new Map<string, number>();
  const want = (rank: number, ...names: string[]) => {
    for (const name of names) wanted.set(name, Math.min(rank, wanted.get(name) ?? rank));
  };

  if (config.deliberate
    || requestNeedsResearch(request)
    || /\b(?:search|look up|google|news)\b|^\s*(?:who|what) is\b/.test(withoutFileNames(text))) {
    want(2, 'web_search', 'fetch_url', 'get_datetime');
  }
  if (/\b(?:time|date|today|tomorrow|now|clock)\b/.test(text)) want(1, 'get_datetime');

  if (/\b[\w()-]+\.(?:txt|md|csv|json|html?|css|jsx?|tsx?|py|docx|pdf|xlsx|zip|png|jpe?g|svg)\b/i.test(request)) {
    want(2, 'read_file', 'write_file', 'edit_file', 'list_files');
  }

  if (ARTEFACT_WORDS.test(request) || /\b(?:save|write|creat|mak|build|generat|folder|project)\w*/i.test(text)) {
    want(4, 'write_file', 'read_file', 'edit_file', 'make_directory', 'list_files');
  }
  if (/\b(?:delete|remove|get rid of)\b/.test(text)) want(1, 'delete_file');
  if (/\b(?:move|rename)\b/.test(text)) want(1, 'move_file');
  if (/\b(?:copy|duplicate|attach)\w*/.test(text)) want(2, 'copy_file');

  if (/\b(?:unzip|unpack|extract)\w*/.test(text)) want(1, 'extract_archive');
  if (/\b(?:zip|compress|archive)\w*/.test(text)) {
    want(1, /\b(?:unzip|unpack|extract)\w*/.test(text) ? 'extract_archive' : 'create_archive');
    want(3, 'list_files');
  }
  if (/\b(?:find|locate|search)\b/.test(text) && ARTEFACT_WORDS.test(request)) {
    want(2, 'grep_search', 'glob_search');
  }
  if (/\bfile explorer\b|\bopen the folder\b/.test(text)) want(1, 'open_folder');
  if (/\b(?:terminal|powershell|command prompt)\b/.test(text)) want(1, 'open_terminal');
  if (/\bopen\b[\s\S]{0,80}(?:\b(?:website|site|url|link|browser)\b|https?:\/\/)/.test(text)) {
    want(1, 'open_url', 'open_page');
    want(2, 'browser_read', 'browser_text', 'browser_click', 'browser_find');
  }
  if (/\b(?:search|google)\b[\s\S]{0,30}\bbrowser\b|\bopen a search\b/.test(text)) want(1, 'open_search_in_browser');
  if (/\b(?:run|execute)\b[\s\S]{0,30}\b(?:command|script|powershell)\b/.test(text)) want(1, 'run_command');
  if (/\bdownload\b/.test(text)) want(1, 'download_file');
  if (/\b(?:docx|word document|word doc|pdf|report|letter|memo|essay|cover letter|xlsx|spreadsheet|excel|workbook)\b/.test(text)) {
    want(1, 'write_document');
    want(3, 'read_file');
  }

  if (/\b(?:convert|turn .{0,20}into|export|save .{0,20}as)\b/.test(text)) {
    want(2, 'read_file', 'write_document', 'write_file', 'list_files');
  }

  const wantsPageControl = /\b(?:click|press|button|link|log ?in|sign ?in|fill in|type in|search box|form|checkbox|dropdown|navigate|browse|scroll)\b/.test(text)
    || (/\b(?:screenshot|screen ?shot|capture)\b/.test(text) && /\b(?:page|site|website|browser|screen|window)\b/.test(text))
    || (/\b(?:read|check|look at|see|what(?:'s| is) on)\b/.test(text) && /\b(?:page|website|site|browser|screen|window)\b/.test(text))
    || (browserInteractionRequest(request) && /\b(?:visit|identify|inspect|read|check|review|collect|select|compare|find|follow)\b/.test(text))
    || (browserInteractionRequest(request) && /\b(?:sort|filter|rank|inspect|check|read|review|collect|find)\b/.test(text));
  if (wantsPageControl) {

    want(1, 'open_page', 'browser_read', 'browser_click', 'browser_find');
    want(3, 'browser_text');
    want(2, 'read_screen', 'click_element');
    want(2, 'type_text', 'press_key', 'scroll_page');
    want(4, 'check_screen');

    wanted.delete('open_url');
  }
  if (/\bgo back\b|\bprevious page\b|\bback button\b/.test(text)) want(1, 'browser_back', 'browser_read');
  if (/\btabs?\b/.test(text)) want(1, 'browser_tabs', 'browser_switch_tab', 'browser_read');
  if (/\b(?:top|first|best)\s+(?:[2-9]|ten|five|four|three|two)\b|\b(?:[2-9]|ten|five|four|three|two)\s+(?:distinct\s+)?(?:threads?|links?|pages?|posts?|items?|results?|coins?)\b|\b(?:compare|each|all)\b[\s\S]{0,40}\b(?:results?|coins?|items?|pages?|posts?|threads?)\b/i.test(text)) {
    want(1, 'browser_open_tab', 'browser_tabs', 'browser_switch_tab', 'browser_close_tab', 'browser_read');
  }
  if (/\bwait\b[\s\S]{0,40}\b(?:load|loads|appear|appears|finish|until|ready)\b/.test(text)) want(1, 'browser_wait_for', 'browser_read');
  if (/\b(?:fill|type)\b[\s\S]{0,40}\b(?:field|box|form|input|search|reply|message|body)\b/.test(text)) want(1, 'browser_fill', 'browser_read');
  if (/\bscroll\b/.test(text)) want(1, 'browser_scroll', 'scroll_page', 'browser_read');
  if (/\bpress\b[\s\S]{0,20}\b(?:enter|tab|escape|key)\b/.test(text)) want(1, 'browser_press', 'browser_read');
  if (/\b(?:verify|confirm|double[- ]?check)\b|\bcheck\b[\s\S]{0,40}\b(?:result|answer|total|value|screen|shows?|says?)\b|\bwhat\b[\s\S]{0,20}\bit\b[\s\S]{0,10}\b(?:say|says|show|shows)\b|\b(?:tell|read)\b[\s\S]{0,20}\bthe\b[\s\S]{0,10}\b(?:result|answer|total)\b/.test(text)) {
    want(2, 'read_screen', 'check_screen');
  }
  if (/\b(?:screenshot|screen ?shot)\b/.test(text)) {
    want(1, 'take_screenshot');
    want(2, 'browser_screenshot');
  }

  if (/\b(?:photo|photograph|image|picture|jpg|jpeg|png)\b/.test(text) && /\b(?:download|save|grab|collect)\w*/.test(text)) {
    want(1, 'download_file', 'verify_image');
  }
  if (/\b(?:api|endpoint|post request|get request|webhook|rest|json api)\b/.test(text)) want(1, 'http_request');
  if (/\bopen\b[\s\S]{0,20}\b(?:in|with)\b[\s\S]{0,10}\b(?:notepad|paint|wordpad|word|excel)\b|\bopen with\b/.test(text)) want(1, 'open_with');
  if (/\b(?:clipboard|paste)\b/.test(text)) want(1, 'clipboard_read', 'clipboard_write');
  if (/\b(?:invoice|receipt|confirmation|ticket|boarding pass)\b/.test(text)) want(2, 'browser_save_pdf');
  if (/\bdownload\w*/.test(text)) want(2, 'wait_for_download');
  if (/\b(?:upload|attach|choose file|file picker)\b/.test(text)) want(1, 'upload_file', 'browser_read');

  if (/\b(?:extension|wallet|metamask|phantom|vpn|confirm the transaction|approve|sign the|connect wallet)\b/.test(text)) {
    want(1, 'browser_extensions', 'browser_focus_extension', 'browser_read', 'browser_click');
  }
  if (/\b(?:every|all|each|list of|extract|collect|scrape)\b/.test(text)) want(2, 'browser_extract');
  if (/\b(?:wait|loading|slow|until .{0,20}(?:load|ready|appear))\b/.test(text)) want(2, 'browser_wait_for_idle');
  if (/\b(?:log ?in|sign ?in|form|username|password|credentials)\b/.test(text)) {
    want(1, 'browser_fill_form', 'browser_click_and_wait', 'browser_read');
  }
  if (/\b(?:every|all|each|list of|extract|collect|gather|scrape|harvest)\b[\s\S]{0,40}\b(?:rows?|items?|links?|prices?|titles?|cards?|listings?|products?|results?|entries|records?)\b/.test(text)
    || /\b(?:extract|scrape)\b/.test(text)) {
    want(1, 'browser_evaluate', 'browser_read');
  }
  if (/\b(?:console|javascript error|js error|script error|not working|broken|blank page|nothing happens)\b/.test(text)) {
    want(1, 'browser_console', 'browser_read');
  }
  if (/\b(?:network|request|requests|api|xhr|fetch|failed to load|404|500|status code)\b/.test(text)) {
    want(1, 'browser_network', 'browser_read');
  }
  if (/\b(?:hover|hover over|mouse over|tooltip|dropdown menu|flyout)\b/.test(text)) {
    want(1, 'browser_hover', 'browser_read');
  }
  if (/\b(?:right[- ]?click|context menu|double[- ]?click)\b/.test(text)) {
    want(1, 'browser_click_special', 'browser_read');
  }
  if (/\b(?:drag|drop|reorder|move .{0,20}(?:onto|into|to the)|slider)\b/.test(text)) {
    want(1, 'browser_drag', 'browser_read');
  }
  if (/\b(?:mobile|phone|tablet|responsive|viewport|window size|resize|narrow|widescreen)\b/.test(text)) {
    want(1, 'browser_resize', 'browser_read');
  }

  if (/\b(?:window|windows|app|apps|application|program|notepad|calculator|paint|word|excel)\b/.test(text)
    && /\b(?:open|start|launch|focus|switch|bring|list|show|use|close)\b/.test(text)
    && !/\bfile explorer\b/.test(text)) {
    want(1, 'list_windows', 'focus_window', 'open_app');
    want(2, 'read_screen', 'type_text', 'press_key');
  }

  if (!wanted.size) {
    want(1, 'web_search', 'get_datetime', 'read_file', 'write_file', 'list_files');
  }
  const order = all.map((tool) => tool.function.name);
  const ranked = [...wanted.keys()]
    .sort((left, right) => (wanted.get(left)! - wanted.get(right)!) || (order.indexOf(left) - order.indexOf(right)));
  if (config.fullCatalogue) return all;
  const available = new Set(order);
  const essential = ESSENTIAL_HOST_TOOLS.filter((name) => available.has(name));
  const padding = config.extendedCatalogue
    ? [...HOST_TOOL_PRIORITY, ...order].filter((name) => available.has(name))
    : [];
  const affordable = new Set([...new Set([...ranked, ...essential, ...padding])]
    .slice(0, config.extendedCatalogue ? EXTENDED_HOST_TOOL_BUDGET : HOST_TOOL_BUDGET));
  const selected = all.filter((tool) => affordable.has(tool.function.name));
  return selected.length ? selected : all;
}

function parseClaudeAuthStatus(value: string) {
  try {
    const parsed = JSON.parse(value.trim() || '{}') as Record<string, unknown>;
    return {
      loggedIn: parsed.loggedIn === true,
      email: String(parsed.email ?? parsed.accountEmail ?? '').trim() || undefined,
      plan: String(parsed.subscriptionType ?? parsed.plan ?? '').trim() || undefined
    };
  } catch {
    return undefined;
  }
}

class CodexAppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private initialized?: Promise<void>;
  private closing = false;
  private stderrTail = '';

  constructor(
    private executable: string,
    private codexHome: string,
    private hostToolConfig: { command: string; args: string[]; env: Record<string, string> } | null = null,

    private apiKey?: string
  ) {
    super();
  }

  setExecutable(executable: string) {
    this.executable = executable;
  }

  async refreshModels() {
    await this.stopCurrentProcess(true);
    await fs.promises.rm(path.join(this.codexHome, 'models_cache.json'), { force: true });
  }

  async useExecutable(executable: string) {
    if (this.executable === executable) return;
    await this.stopCurrentProcess(true);
    this.executable = executable;
  }

  async restartForHostTools() {
    if (!this.initialized) return;
    if (this.hostToolsApplied === JSON.stringify(this.hostToolConfig)) return;
    await this.stopCurrentProcess(true);
  }

  async start() {
    this.closing = false;
    this.hostToolsApplied = JSON.stringify(this.hostToolConfig);
    if (this.initialized) return this.initialized;
    this.initialized = this.startProcess();
    try {
      await this.initialized;
    } catch (error) {
      this.initialized = undefined;
      throw error;
    }
  }

  private hostToolsApplied = '';

  setHostTools(config: { command: string; args: string[]; env: Record<string, string> } | null) {
    this.hostToolConfig = config;
  }

  private clearLegacyHostToolConfig() {
    const configPath = path.join(this.codexHome, 'config.toml');
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const marker = '[mcp_servers.omniagent]';
    const kept = existing.split(marker)[0].trimEnd();
    if (kept !== existing.trimEnd()) fs.writeFileSync(configPath, kept ? `${kept}\n` : '', 'utf8');
  }

  private hostToolArguments() {
    if (!this.hostToolConfig) return [];
    const override = (key: string, value: unknown) => ['-c', `${key}=${JSON.stringify(value)}`];
    return [
      ...override('mcp_servers.omniagent.command', this.hostToolConfig.command),
      ...override('mcp_servers.omniagent.args', this.hostToolConfig.args),
      ...Object.entries(this.hostToolConfig.env).flatMap(([key, value]) =>
        override(`mcp_servers.omniagent.env.${key}`, value)
      )
    ];
  }

  private async startProcess() {
    fs.mkdirSync(this.codexHome, { recursive: true });
    this.clearLegacyHostToolConfig();
    this.stderrTail = '';
    const child = spawn(this.executable, ['app-server', ...this.hostToolArguments(), '--listen', 'stdio://'], {
      cwd: this.codexHome,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
        LOG_FORMAT: 'json',
        ...(this.apiKey ? { OPENAI_API_KEY: this.apiKey } : {})
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code) => this.failAll(new Error([
      `Codex app-server stopped${code === null ? '' : ` with exit code ${code}`}.`,
      this.stderrTail.trim()
    ].filter(Boolean).join(' '))));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch {

      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'omniagent', title: 'OmniAgent', version: '1.0.0' },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/reasoning/summaryTextDelta',
          'item/reasoning/textDelta',
          'thread/tokenUsage/updated'
        ]
      }
    });
    this.notify('initialized', {});
  }

  private handleMessage(message: JsonRpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const method = message.method;
      if (method === 'mcpServer/elicitation/request') {
        const params = message.params ?? {};
        const metadata = params._meta as Record<string, unknown> | undefined;
        const internalToolApproval = String(params.serverName ?? '') === 'omniagent'
          && String(metadata?.codex_approval_kind ?? '') === 'mcp_tool_call';
        this.respond(message.id, internalToolApproval
          ? { action: 'accept', content: {}, _meta: null }
          : { action: 'cancel', content: null, _meta: null });
      } else if (/requestApproval$/i.test(method)) {
        this.respond(message.id, { decision: 'accept' });
      } else if (/requestUserInput$/i.test(method)) {
        this.respond(message.id, { answers: {} });
      } else {
        this.respondError(message.id, -32601, `OmniAgent does not handle ${method}.`);
      }
      return;
    }
    if (message.method) this.emit('notification', message.method, message.params ?? {});
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.child = undefined;
    this.initialized = undefined;
    if (!this.closing) this.emit('exit', error);
  }

  request(method: string, params: Record<string, unknown>) {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('Codex app-server is not running.'));
    const requestId = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.child!.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  async readChatGptCredentials() {
    await this.start();
    await this.request('account/read', { refreshToken: true });
    const authPath = path.join(this.codexHome, 'auth.json');
    let auth: {
      tokens?: {
        access_token?: unknown;
        account_id?: unknown;
      };
    };
    try {
      auth = JSON.parse(fs.readFileSync(authPath, 'utf8')) as typeof auth;
    } catch {
      throw new Error('Connect ChatGPT again before using voice input.');
    }
    const accessToken = String(auth.tokens?.access_token ?? '').trim();
    if (!accessToken) throw new Error('Connect ChatGPT before using voice input.');
    let accountId = String(auth.tokens?.account_id ?? '').trim();
    if (!accountId) {
      try {
        const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
          'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
        };
        accountId = String(payload['https://api.openai.com/auth']?.chatgpt_account_id ?? '').trim();
      } catch {

      }
    }
    return { accessToken, accountId };
  }

  notify(method: string, params: Record<string, unknown>) {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respond(requestId: number | string, result: unknown) {
    this.child?.stdin.write(`${JSON.stringify({ id: requestId, result })}\n`);
  }

  private respondError(requestId: number | string, code: number, message: string) {
    this.child?.stdin.write(`${JSON.stringify({ id: requestId, error: { code, message } })}\n`);
  }

  close() {
    void this.stopCurrentProcess(false);
  }

  private async stopCurrentProcess(waitForExit: boolean) {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    this.initialized = undefined;
    for (const pending of this.pending.values()) pending.reject(new DOMException('The provider runtime is closing.', 'AbortError'));
    this.pending.clear();
    child?.removeAllListeners('error');
    child?.removeAllListeners('exit');
    if (!child || child.exitCode !== null || child.killed) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    if (waitForExit) {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 4_000))
      ]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000))
        ]);
      }
    }
  }
}

function compactActivityText(value: unknown) {
  return String(value ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function activityFileName(item: Record<string, unknown>) {
  const candidate = item.path ?? item.filePath ?? item.filename ?? item.name;
  const value = String(candidate ?? '').trim();
  return value ? path.basename(value) : '';
}

function bareToolName(tool: string) {
  return String(tool ?? '')
    .toLowerCase()
    .replace(/^(?:mcp|omniagent)[_:.-]+/, '')
    .replace(/^(?:omniagent|mcp)[_:.-]+/, '')
    .replace(/^__?[a-z0-9]+__/, '')
    .trim();
}

function mcpResultText(value: unknown): string | null {
  const content = (value as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => typeof part === 'string' ? part : String((part as { text?: unknown } | null)?.text ?? ''))
    .filter(Boolean)
    .join('\n');
  return text || null;
}

function codexToolEvent(
  item: Record<string, unknown> | undefined,
  phase: 'started' | 'completed'
): ProviderToolEvent | null {
  if (!item) return null;
  const type = String(item.type ?? '');
  if (!type || type === 'agentMessage') return null;
  const label = activitySummary(item);
  if (!label) return null;

  const id = String(item.id ?? '');
  if (!id) return null;

  const { id: _id, type: _type, status: _status, result: _result, output: _output,
    server: _server, appContext: _appContext, pluginId: _pluginId, ...rest } = item;
  const named = item.arguments ?? item.input ?? item.params;
  const argumentSource = named === undefined || named === null ? rest : named;
  const args = typeof argumentSource === 'string'
    ? argumentSource
    : JSON.stringify(argumentSource, null, 2) ?? '';

  const raw = item.output ?? item.result ?? item.stdout ?? item.aggregatedOutput ?? item.content ?? '';
  const output = (mcpResultText(raw) ?? (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2) ?? '')).trim();
  const failed = /fail|error/i.test(String(item.status ?? ''));

  const toolName = String(item.tool ?? item.name ?? '').trim() || type;

  return {
    id,
    name: toolName,
    label,
    status: phase === 'started' ? 'running' : failed ? 'error' : 'ok',
    args,
    ...(phase === 'completed' && output ? { result: output } : {})
  };
}

export function activitySummary(item: Record<string, unknown> | undefined) {
  if (!item) return '';
  const type = String(item.type ?? '');
  if (type === 'agentMessage') return '';
  if (type === 'webSearch') {
    const query = compactActivityText(item.query ?? item.searchQuery);
    return query ? `Searching for ${query}`.slice(0, 120) : 'Searching the web';
  }
  if (type === 'fileChange') {
    const fileName = activityFileName(item);
    return fileName ? `Updating ${fileName}` : 'Updating requested files';
  }
  if (type === 'commandExecution') {
    const command = String(item.command ?? '').trim();
    const executable = command.match(/^\s*(?:&\s*)?["']?([^"' \t]+)/)?.[1] ?? '';
    const executableName = path.basename(executable).replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
    if (/\bStart-Process\b/i.test(command) && /https?:\/\//i.test(command)) return 'Opening the site in your browser';
    if (/\b(?:npm|pnpm|yarn)\b[\s\S]*\b(?:test|build|lint|check)\b/i.test(command)) return 'Checking the work';
    if (/\b(?:rg|findstr|Get-Content|Get-ChildItem)\b/i.test(command)) return 'Inspecting the requested files';
    return executableName ? `Running ${executableName}` : 'Running the requested command';
  }
  if (type === 'mcpToolCall') {
    const tool = String(item.tool ?? item.name ?? '').trim().toLowerCase();
    const friendly: Record<string, string> = {
      open_page: 'Opening the page', open_url: 'Opening the page', browser_read: 'Reading the page',
      browser_find: 'Finding the requested information', browser_click: 'Selecting an item',
      browser_fill: 'Entering information', browser_press: 'Continuing on the page',
      browser_scroll: 'Reading more of the page', browser_back: 'Returning to the previous page',
      browser_wait_for: 'Waiting for the page to finish', browser_tabs: 'Checking open pages',
      browser_open_tab: 'Opening another item', browser_switch_tab: 'Reviewing another item',
      browser_close_tab: 'Closing a finished page',
      browser_evaluate: 'Reading data from the page', browser_console: 'Checking the page for errors',
      browser_network: 'Checking the page requests', browser_hover: 'Opening a menu',
      browser_click_special: 'Selecting an item', browser_drag: 'Moving an item',
      browser_resize: 'Resizing the page', browser_save_pdf: 'Saving the page as PDF',
      upload_file: 'Attaching a file', wait_for_download: 'Waiting for the download',
      verify_image: 'Checking the saved image', http_request: 'Calling the API',
      clipboard_read: 'Reading the clipboard', clipboard_write: 'Copying to the clipboard',
      open_with: 'Opening the file', browser_extract: 'Reading data from the page',
      browser_wait_for_idle: 'Waiting for the page', browser_click_and_wait: 'Selecting an item',
      browser_fill_form: 'Filling in the form', browser_extensions: 'Checking browser extensions',
      browser_focus_extension: 'Opening the extension',
      read_screen: 'Reading the page', click_element: 'Selecting an item', type_text: 'Entering information',
      press_key: 'Continuing on the page', scroll_page: 'Reading more of the page'
    };
    if (/approval|elicitation|request approved|omniagent mcp|mcp[_:\s-]*server/.test(tool)) return 'Continuing the task';
    return friendly[tool]
      ?? friendly[bareToolName(tool)]
      ?? HOST_TOOL_ACTIVITY[tool]
      ?? HOST_TOOL_ACTIVITY[bareToolName(tool)]
      ?? 'Continuing the task';
  }
  return '';
}

function claudeToolEvents(event: Record<string, unknown>): ProviderToolEvent[] {
  const message = event.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];

  if (event.type === 'assistant') {
    return content.filter((item) => item.type === 'tool_use').map((item) => ({
      id: String(item.id ?? ''),
      name: String(item.name ?? 'tool'),
      label: claudeActivitySummary({ type: 'assistant', message: { content: [item] } }) || 'Working on the request',
      status: 'running' as const,
      args: JSON.stringify(item.input ?? {}, null, 2)
    })).filter((item) => item.id);
  }

  if (event.type === 'user') {
    return content.filter((item) => item.type === 'tool_result').map((item) => {
      const raw = item.content;
      const text = typeof raw === 'string'
        ? raw
        : Array.isArray(raw)
          ? raw.map((part) => typeof part === 'string' ? part : String((part as Record<string, unknown>)?.text ?? '')).join('\n')
          : raw === undefined || raw === null ? '' : JSON.stringify(raw, null, 2);
      return {
        id: String(item.tool_use_id ?? ''),
        name: '',
        label: '',
        status: (item.is_error ? 'error' : 'ok') as 'error' | 'ok',
        result: text
      };
    }).filter((item) => item.id);
  }

  return [];
}

function claudeActivitySummary(event: Record<string, unknown>) {
  if (event.type !== 'assistant') return '';
  const message = event.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
  const toolUse = content.find((item) => item.type === 'tool_use');
  if (toolUse) {
    const name = String(toolUse.name ?? '');
    const input = toolUse.input as Record<string, unknown> | undefined;
    if (name === 'Bash') return activitySummary({ type: 'commandExecution', command: input?.command });
    if (name === 'WebSearch') return activitySummary({ type: 'webSearch', query: input?.query });
    if (['Write', 'Edit', 'NotebookEdit'].includes(name)) {
      return activitySummary({ type: 'fileChange', path: input?.file_path ?? input?.notebook_path });
    }
    if (/approval|elicitation/i.test(name)) return 'Continuing the task';
    if (/^mcp|omniagent/i.test(name)) return activitySummary({ type: 'mcpToolCall', tool: name });
    const readableName = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_:]+/g, ' ').trim();
    return readableName ? `Working on the request` : '';
  }
  return '';
}

function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;

    stdin?: string;
    keepStdinOpen?: boolean;
    onSpawn?: (child: ChildProcess) => void;
    onStdoutLine?: (line: string) => void;
  }
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {

      });
      if (options.keepStdinOpen) child.stdin.write(options.stdin);
      else child.stdin.end(options.stdin);
    }
    options.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    const budgetMs = options.timeoutMs ?? 0;
    const timeout = budgetMs > 0
      ? setTimeout(() => {
        terminateOwnedProcess(child, true);
        reject(new Error('The provider operation timed out.'));
      }, budgetMs)
      : undefined;
    const abort = () => {
      terminateOwnedProcess(child, true);
      reject(new DOMException('The provider operation was stopped.', 'AbortError'));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-2_000_000);
      if (options.onStdoutLine) {
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) options.onStdoutLine(line);
      }
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-200_000); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      if (stdoutLineBuffer.trim()) options.onStdoutLine?.(stdoutLineBuffer);
      if (code === 0) resolve({ stdout, stderr });

      else reject(new ProviderProcessError(stderr.trim() || stdout.trim(), code));
    });
  });
}

function scratchScreenshotDirectory() {
  const directory = path.join(os.tmpdir(), 'omniagent-screens');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function clearScratchScreenshots(maxAgeMs = 0) {
  const directory = path.join(os.tmpdir(), 'omniagent-screens');
  if (!fs.existsSync(directory)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(directory)) {
    const target = path.join(directory, entry);
    try {
      if (maxAgeMs > 0 && Date.now() - fs.statSync(target).mtimeMs < maxAgeMs) continue;
      fs.rmSync(target, { force: true });
      removed += 1;
    } catch {

    }
  }
  return removed;
}

function explicitlyRequestsScreenshot(text: string) {
  const request = String(text ?? '');
  return /\b(?:take|capture|save|create|make|export|deliver|attach|include)\b[\s\S]{0,50}\b(?:screen\s*shot|screen capture)\b/i.test(request)
    || /\b(?:screen\s*shot|screen capture)\b[\s\S]{0,50}\b(?:file|png|image|attachment|deliverable)\b/i.test(request);
}

function browserInteractionRequest(text: string) {
  return /\b(?:browser|web ?page|website|site|tab|inbox|wikipedia|github|youtube|https?:\/\/)\b|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|app)\b/i.test(String(text ?? ''));
}

function explicitlyRequestsDeletion(text: string) {
  return /\b(?:delete|remove|get rid of|erase|trash)\b/i.test(String(text ?? ''));
}

export function explicitlyRequestsBrowserClose(text: string) {
  const request = String(text ?? '');
  return /\b(?:close|shut|quit|exit)\b[\s\S]{0,40}\b(?:browser|browsers|browser window|chrome|brave|edge|chromium|vivaldi|opera)\b/i.test(request)
    || /\b(?:browser|browser window)\b[\s\S]{0,25}\b(?:close|closed|shut|quit)\b/i.test(request)
    || /\b(?:close|shut)\b[\s\S]{0,30}\b(?:tab|tabs|page|pages)\b/i.test(request)
    || /\b(?:tab|tabs|page|pages)\b[\s\S]{0,20}\b(?:close|closed)\b/i.test(request);
}

function claudeNativeToolsForRequest(text: string) {
  if (browserInteractionRequest(text)) return claudeNativeTools;
  return claudeNativeTools;
}

const claudeNativeTools = [
  'WebFetch', 'WebSearch', 'TodoWrite'
];

export class ProviderRuntimeManager extends EventEmitter {
  private codex: CodexAppServer;
  private claudeExecutable: string;
  private claudeHome: string;
  private activeProviderChildren = new Set<ChildProcess>();
  private pendingLogins = new Map<Provider, ChildProcess>();
  private pendingLoginIds = new Map<Provider, string>();
  private codexWorkers = new Map<string, CodexAppServer>();
  private codexExecutable: string;
  private codexKeyHomeRoot: string;
  private openAIRecovery?: Promise<void>;
  private hostTools = new HostToolServer({
    catalogue: (session) => this.hostToolCatalogue(session),
    call: (session, name, args) => this.runHostTool({
      name,
      arguments: args,
      cwd: session.cwd,
      signal: session.signal,
      openUrl: session.openUrl,
      userRequest: session.userRequest,
      computer: session.computer as ProviderTurnInput['computer'],
      teamTools: session.teamTools
    })
  });

  private hostBridgeScript() {
    const packed = path.join(__dirname, 'mcpHostBridge.js');
    const unpacked = packed.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    return unpacked !== packed && fs.existsSync(unpacked) ? unpacked : packed;
  }

  private async hostToolSession(input: ProviderTurnInput, mode: 'exact' | 'ambient' = 'exact') {
    if (!input.computer || input.toolMode === 'none') return null;
    if (!fs.existsSync(this.hostBridgeScript())) return null;
    const { port, token } = await this.hostTools.start();
    const detail = {
      cwd: input.cwd,
      signal: input.signal,
      openUrl: input.openUrl,
      computer: input.computer,
      userRequest: input.userRequest,
      allowScreenshots: explicitlyRequestsScreenshot(input.userRequest ?? ''),
      allowBrowserControl: input.allowBrowserControl !== false,
      teamTools: input.teamTools
    };
    const sessionId = mode === 'ambient'
      ? this.hostTools.openAmbientSession(detail, input.provider)
      : this.hostTools.openSession(detail);
    return {
      sessionId,
      followUp: (text: string) => {
        detail.userRequest = `${detail.userRequest ?? ''}\n\n${text}`;
        detail.allowScreenshots = explicitlyRequestsScreenshot(detail.userRequest);
      },
      env: {
        OMNIAGENT_TOOL_URL: `http://127.0.0.1:${port}`,
        OMNIAGENT_TOOL_TOKEN: token,
        OMNIAGENT_TOOL_SESSION: mode === 'ambient' ? `ambient:${input.provider}` : sessionId,
        ELECTRON_RUN_AS_NODE: '1'
      },
      close: () => this.hostTools.closeSession(sessionId)
    };
  }

  refreshRuntimePaths() {
    this.codexExecutable = firstAvailableExecutable('OpenAI', this.userData);
    this.claudeExecutable = firstAvailableExecutable('Claude', this.userData);
    this.codex.setExecutable(this.codexExecutable);
    this.claudeModelCache = undefined;
  }

  runtimeInstalled(provider: Provider) {
    return providerRuntimeInstalled(provider, this.userData);
  }

  constructor(private userData: string) {
    super();
    const codexExecutable = firstAvailableExecutable('OpenAI', userData);
    this.codexExecutable = codexExecutable;

    this.codexKeyHomeRoot = path.join(userData, 'ai', 'openai-keys');
    this.claudeExecutable = firstAvailableExecutable('Claude', userData);
    this.claudeHome = path.join(userData, 'ai', 'claude');
    this.codex = new CodexAppServer(codexExecutable, path.join(userData, 'ai', 'openai'));
    this.codex.on('notification', (method: string, params: Record<string, unknown>) => {
      this.emit('notification', 'OpenAI', method, params);
    });
    this.codex.on('exit', (error: Error) => {
      this.emit('state', {
        provider: 'OpenAI',
        status: 'error',
        models: defaultModels('OpenAI'),
        error: error.message
      } satisfies ProviderAccountState);
      this.scheduleOpenAIRecovery();
    });
  }

  private scheduleOpenAIRecovery() {
    if (this.openAIRecovery) return;
    this.openAIRecovery = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.readAccount('OpenAI')
          .then((state) => this.emit('state', state))
          .finally(resolve);
      }, 750);
      timer.unref?.();
    }).finally(() => {
      this.openAIRecovery = undefined;
    });
  }

  private trackProviderChild(child: ChildProcess) {
    this.activeProviderChildren.add(child);
    const release = () => this.activeProviderChildren.delete(child);
    child.once('exit', release);
    child.once('error', release);
  }

  private accountReads = new Map<Provider, Promise<ProviderAccountState>>();
  private claudeModelCache?: { models: AIModelView[]; at: number; account?: string };

  readAccount(provider: Provider, refreshModels = false): Promise<ProviderAccountState> {
    const previous = this.accountReads.get(provider);
    if (previous && !refreshModels) return previous;
    const job = (previous ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.readAccountExclusive(provider, refreshModels));
    this.accountReads.set(provider, job);
    void job.finally(() => { if (this.accountReads.get(provider) === job) this.accountReads.delete(provider); }).catch(() => undefined);
    return job;
  }

  private async readAccountExclusive(provider: Provider, refreshModels = false): Promise<ProviderAccountState> {
    if (provider === 'OpenAI') {
      try {
        if (refreshModels) await this.codex.refreshModels();
        await this.codex.start();
        const result = await this.codex.request('account/read', { refreshToken: false }) as {
          account?: { email?: string | null; planType?: string | null; type?: string };
        };
        if (!result.account || result.account.type !== 'chatgpt') {
          return { provider, status: 'disconnected', models: defaultModels(provider) };
        }
        let models: AIModelView[] = [];
        let modelsStale = false;
        try { models = await this.openAIModels(); } catch { modelsStale = true; }
        return {
          provider,
          status: 'connected',
          email: result.account.email ?? undefined,
          plan: result.account.planType ?? undefined,
          models,
          modelsStale,
          error: modelsStale ? MODEL_REFRESH_ERROR : undefined
        };
      } catch {
        return {
          provider,
          status: 'error',
          models: defaultModels(provider),
          error: publicProviderConnectionError(provider)
        };
      }
    }

    fs.mkdirSync(this.claudeHome, { recursive: true });
    try {
      const result = await runProcess(this.claudeExecutable, ['auth', 'status'], {
        cwd: this.claudeHome,
        env: { CLAUDE_CONFIG_DIR: this.claudeHome },
        timeoutMs: 30_000,
        onSpawn: (child) => this.trackProviderChild(child)
      });
      const parsed = parseClaudeAuthStatus(result.stdout);
      if (!parsed?.loggedIn) return { provider, status: 'disconnected', models: defaultModels(provider) };
      try {
        if (refreshModels || !this.claudeModelCache || this.claudeModelCache.account !== parsed.email || Date.now() - this.claudeModelCache.at > 300_000) {
          this.claudeModelCache = { models: await discoverClaudeModels(this.claudeExecutable, this.claudeHome, child => this.trackProviderChild(child)), at: Date.now(), account: parsed.email };
        }
        return { provider, status: 'connected', email: parsed.email, plan: parsed.plan, models: this.claudeModelCache.models };
      } catch {
        return { provider, status: 'connected', email: parsed.email, plan: parsed.plan, models: [], modelsStale: true, error: MODEL_REFRESH_ERROR };
      }
    } catch (error) {

      const message = providerFailureText(error);
      const parsed = parseClaudeAuthStatus(message);
      if (parsed && !parsed.loggedIn) {
        return { provider, status: 'disconnected', models: defaultModels(provider) };
      }
      if (/not logged|not authenticated|login required|no credentials|sign in|exit code 1/i.test(message)) {
        return { provider, status: 'disconnected', models: defaultModels(provider) };
      }

      if (error instanceof ProviderProcessError && error.exitCode !== null) {
        return { provider, status: 'disconnected', models: defaultModels(provider) };
      }
      return { provider, status: 'disconnected', models: defaultModels(provider), error: publicProviderConnectionError(provider) };
    }
  }

  async connect(provider: Provider) {
    if (provider === 'OpenAI') {
      await this.codex.start();
      const result = await this.codex.request('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt'
      }) as { authUrl?: string; loginId?: string };
      if (!result.authUrl) throw new Error('Codex did not return a browser sign-in URL.');
      if (result.loginId) this.pendingLoginIds.set('OpenAI', result.loginId);
      return { authUrl: result.authUrl, loginId: result.loginId };
    }
    fs.mkdirSync(this.claudeHome, { recursive: true });
    const child = spawn(this.claudeExecutable, ['auth', 'login'], {
      cwd: this.claudeHome,
      env: { ...process.env, CLAUDE_CONFIG_DIR: this.claudeHome },
      windowsHide: true,
      detached: false,
      stdio: 'ignore'
    });
    this.trackProviderChild(child);
    this.pendingLogins.set('Claude', child);
    child.once('exit', () => {
      this.pendingLogins.delete('Claude');
      void this.readAccount('Claude').then((state) => this.emit('state', state));
    });
    child.once('error', () => {
      this.emit('state', {
        provider: 'Claude',
        status: 'error',
        models: defaultModels('Claude'),
        error: publicProviderConnectionError('Claude')
      } satisfies ProviderAccountState);
    });
    return {};
  }

  async cancelConnect(provider: Provider) {
    const pending = this.pendingLogins.get(provider);
    if (pending) {
      this.pendingLogins.delete(provider);
      try {
        pending.kill();
      } catch {
      }
    }
    const loginId = this.pendingLoginIds.get(provider);
    if (loginId) {
      this.pendingLoginIds.delete(provider);
      await this.codex.request('account/login/cancel', { loginId }).catch(() => undefined);
    }
    return this.readAccount(provider);
  }

  async disconnect(provider: Provider) {
    if (provider === 'OpenAI') {
      await this.codex.start();
      await this.codex.request('account/logout', {});
      return;
    }
    await runProcess(this.claudeExecutable, ['auth', 'logout'], {
      cwd: this.claudeHome,
      env: { CLAUDE_CONFIG_DIR: this.claudeHome },
      timeoutMs: 30_000,
      onSpawn: (child) => this.trackProviderChild(child)
    });
  }

  private async openAIModels() {
    return discoverCodexModels((method, params) => this.codex.request(method, params));
  }

  private codexForTurn(input: ProviderTurnInput) {
    const accountKey = input.apiKey
      ? crypto.createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16)
      : 'chatgpt-account';
    const scopeKey = crypto.createHash('sha256')
      .update(input.workerId ? `worker:${input.workerId}` : `cwd:${path.resolve(input.cwd)}`)
      .digest('hex').slice(0, 16);
    const key = `${accountKey}:${scopeKey}`;
    const existing = this.codexWorkers.get(key);
    if (existing) return existing;
    const home = input.apiKey
      ? path.join(this.codexKeyHomeRoot, accountKey)
      : path.join(this.userData, 'ai', 'openai');
    const server = new CodexAppServer(
      this.codexExecutable,
      home,
      null,
      input.apiKey
    );
    server.on('notification', (method: string, params: Record<string, unknown>) => {
      this.emit('notification', 'OpenAI', method, params);
    });
    server.on('exit', (error: Error) => {
      this.emit('state', {
        provider: 'OpenAI',
        status: 'error',
        models: defaultModels('OpenAI'),
        error: error.message
      } satisfies ProviderAccountState);
      this.scheduleOpenAIRecovery();
    });
    this.codexWorkers.set(key, server);
    return server;
  }

  async runTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    try {
      let current = input;
      for (;;) {
        const result = current.provider === 'OpenAI' ? await this.runCodexTurn(current) : await this.runClaudeTurn(current);
        if (!input.liveInput) return result;
        await input.liveInput.settle();
        const pending = input.liveInput.takePending();
        if (!pending.length) {
          input.liveInput.seal();
          return result;
        }
        current = { ...input, sessionId: result.sessionId,
          prompt: followUpPrompt(pending), userRequest: pending.map(m => m.text).join('\n\n'),
          allowBrowserControl: true,
          attachments: pending.flatMap(m => m.attachments) };
      }
    } catch (error) {
      throw providerTurnError(input.provider, error, input.apiKey ? 'apiKey' : 'account');
    } finally {
      input.liveInput?.seal();
    }
  }

  private async runCodexTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    input.signal?.throwIfAborted();
    return this.runCodexTurnExclusive(input, this.codexForTurn(input));
  }

  private async runCodexTurnExclusive(input: ProviderTurnInput, codex: CodexAppServer): Promise<ProviderTurnResult> {
    await codex.useExecutable(this.codexExecutable);
    const host = await this.hostToolSession(input, 'exact');
    try {
      if (host) {
        codex.setHostTools({ command: process.execPath, args: [this.hostBridgeScript()], env: host.env });
        await codex.restartForHostTools();
      }
      try {
        await codex.start();
      } catch (error) {
        if (input.signal?.aborted || !/app-server stopped|exit code|pipe|closed/i.test(providerFailureText(error))) throw error;
        await abortDelay(500, input.signal);
        await codex.start();
      }
      const startThread = () => codex.request('thread/start', {
        model: input.model || undefined,
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: CODEX_THREAD_SANDBOX,
        personality: 'friendly',
        serviceName: 'omniagent'
      });

      let threadResult: unknown;
      if (input.sessionId) {
        try {
          threadResult = await codex.request('thread/resume', {
            threadId: input.sessionId,
            model: input.model || undefined,
            cwd: input.cwd,
            approvalPolicy: 'never',
            sandbox: CODEX_THREAD_SANDBOX,
            personality: 'friendly'
          });
        } catch (error) {
          if (input.signal?.aborted) throw error;
          threadResult = await startThread();
        }
      } else {
        threadResult = await startThread();
      }
      const thread = (threadResult as { thread?: { id?: string } }).thread;
      const threadId = thread?.id;
      if (!threadId) throw new Error('Codex did not return a worker thread.');

      const providerInputs: Array<Record<string, unknown>> = [
        { type: 'text', text: input.prompt },
        ...(input.attachments ?? []).map((attachment) => attachment.mimeType.startsWith('image/')
          ? { type: 'localImage', path: attachment.path }
          : { type: 'text', text: `Attached file "${attachment.name}" is available at: ${attachment.path}` })
      ];
      let finalAnswer = '';
      let activeTurnId = '';
      let turnComplete = false;
      const codexToolStarts = new Map<string, number>();
      let streamedMessage = '';
      let removeCompletionListener = () => {};
      const completed = new Promise<void>((resolve, reject) => {
      const listener = (method: string, params: Record<string, unknown>) => {
        if (String(params.threadId ?? '') !== threadId) return;
        if (method === 'item/started' || method === 'item/completed') {
          const item = params.item as Record<string, unknown> | undefined;
          const summary = activitySummary(item);
          if (summary) input.onActivity?.(summary);
          const toolEvent = codexToolEvent(item, method === 'item/started' ? 'started' : 'completed');
          if (toolEvent) {
            if (toolEvent.status === 'running') {
              codexToolStarts.set(toolEvent.id, Date.now());
            } else {
              const startedAt = codexToolStarts.get(toolEvent.id);
              if (startedAt) {
                toolEvent.durationMs = Date.now() - startedAt;
                codexToolStarts.delete(toolEvent.id);
              }
            }
            input.onToolEvent?.(toolEvent);
          }
        }
        if (method === 'item/completed') {
          const item = params.item as Record<string, unknown> | undefined;
          if (item?.type === 'agentMessage' && item.text) {
            finalAnswer = String(item.text);
            streamedMessage = '';
            input.onMessage?.(finalAnswer);
          }
        }
        if (method === 'item/agentMessage/delta') {
          const delta = String(params.delta ?? '');
          if (delta) {
            streamedMessage += delta;
            input.onPartialMessage?.(streamedMessage);
          }
        }
        if (method === 'turn/completed') {
          turnComplete = true;
          input.liveInput?.unbind();
          removeCompletionListener();
          const turn = params.turn as Record<string, unknown> | undefined;
          const status = String(turn?.status ?? '');
          if (status === 'failed') reject(new Error(String((turn?.error as Record<string, unknown> | undefined)?.message ?? 'Codex could not complete the request.')));
          else resolve();
        }
      };
      codex.on('notification', listener);
      removeCompletionListener = () => codex.off('notification', listener);
      });
      let started: { turn?: { id?: string } };
      try {
        input.onActivity?.('Working on your request');
        started = await codex.request('turn/start', {
          threadId,
          input: providerInputs,
          cwd: input.cwd,
          model: input.model || undefined,
          effort: input.reasoningEffort || 'high',
          summary: 'concise',
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'dangerFullAccess' }
        }) as { turn?: { id?: string } };
      } catch (error) {
        removeCompletionListener();
        throw error;
      }
      activeTurnId = started.turn?.id ?? '';
      if (!turnComplete && activeTurnId) input.liveInput?.bind(async (message) => {
        if (turnComplete || input.signal?.aborted) return false;
        if (input.allowBrowserControl === false) return false;
        const additionalInput = [
          { type: 'text', text: message.text },
          ...message.attachments.map(file => file.mimeType.startsWith('image/')
            ? { type: 'localImage', path: file.path }
            : { type: 'text', text: `Attached file "${file.name}" is available at: ${file.path}` })
        ];
        host?.followUp(message.text);
        try {
          await codex.request('turn/steer', { threadId, expectedTurnId: activeTurnId, input: additionalInput });
          return true;
        } catch (error) {
          if (turnComplete || /no active turn|not.*in.progress|expected.*turn|turn.*(?:finished|completed)/i.test(providerFailureText(error))) return false;
          throw error;
        }
      });
      const abort = () => {
        if (activeTurnId) void codex.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => undefined);
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      try {
        if (input.signal?.aborted) { abort(); input.signal.throwIfAborted(); }
        await completed;
      } finally {
        removeCompletionListener();
        input.signal?.removeEventListener('abort', abort);
      }
      return { answer: cleanPublicAnswer(finalAnswer, input.structured), sessionId: threadId };
    } finally {
      host?.close();
      input.liveInput?.unbind();
    }
  }

  hostToolCatalogue(session?: HostToolSession) {
    return [
      ...hostToolsForRequest(session?.userRequest ?? '', { hostControlAvailable: true, fullCatalogue: true })
        .filter((tool) => session?.allowScreenshots !== false || tool.function.name !== 'take_screenshot')
        .filter((tool) => session?.allowBrowserControl !== false || !BROWSER_CONTROL_TOOLS.has(tool.function.name))
        .map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: tool.function.parameters as Record<string, unknown>
        })),
      ...(session?.teamTools?.definitions ?? [])
    ];
  }

  async runHostTool(input: {
    name: string;
    arguments: unknown;
    cwd: string;
    signal?: AbortSignal;
    openUrl?: (url: string) => Promise<void>;
    userRequest?: string;
    computer?: ProviderTurnInput['computer'];
    teamTools?: TeamToolKit;
  }) {
    const notice = (result: unknown) => {
      const note = input.teamTools?.annotate?.();
      if (!note) return result;
      return `${typeof result === 'string' ? result : JSON.stringify(result ?? {})}

${note}`;
    };
    if (input.teamTools?.definitions.some((tool) => tool.name === input.name)) {
      const args = typeof input.arguments === 'string'
        ? JSON.parse(input.arguments || '{}') as Record<string, unknown>
        : (input.arguments ?? {}) as Record<string, unknown>;
      return notice(await input.teamTools.call(input.name, args));
    }
    return notice(await this.executeHostTool(
      input.name,
      input.arguments,
      input.cwd,
      input.signal,
      { userRequest: input.userRequest },
      input.openUrl,
      input.computer
    ));
  }

  private async executeHostTool(
    name: string,
    rawArguments: unknown,
    cwd: string,
    signal?: AbortSignal,
    requirements?: { minimumWords?: number; userRequest?: string },
    openUrl?: (url: string) => Promise<void>,
    computer?: ProviderTurnInput['computer']
  ) {
    signal?.throwIfAborted();
    const openInBrowser = openUrl ?? (async (url: string) => { await shell.openExternal(url); });

    const host = () => {
      if (!computer) throw new Error(`${name} is not available in this session. Use web_search and fetch_url to read a site, or open_url to show it to the user.`);
      return computer;
    };
    const args = typeof rawArguments === 'string'
      ? JSON.parse(rawArguments || '{}') as Record<string, unknown>
      : (rawArguments ?? {}) as Record<string, unknown>;
    const workerRoot = path.resolve(cwd);
    const within = (root: string, target: string) => {
      const relative = path.relative(root, target);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    };

    const confineWrite = (target: string) => {
      if (within(workerRoot, target)) return target;
      const parentName = path.basename(path.dirname(target));
      const tail = parentName && parentName !== path.parse(target).root
        ? path.join(parentName, path.basename(target))
        : path.basename(target);
      return path.join(workerRoot, tail);
    };

    const repair = (target: string) => repairLostSeparators(target, workerRoot);
    const resolvePath = (value: unknown, mode: 'read' | 'write' = 'read') => {
      const requested = String(value ?? '').trim();
      if (!requested) throw new Error('A path is required.');
      const target = path.resolve(path.isAbsolute(requested) ? requested : path.join(workerRoot, requested));
      if (mode === 'read') return fs.existsSync(target) ? target : (repair(target) || target);

      if (!fs.existsSync(path.dirname(target))) {
        const repairedParent = repair(path.dirname(target));
        if (repairedParent) return confineWrite(path.join(repairedParent, path.basename(target)));
      }
      return confineWrite(target);
    };
    if (name === 'list_files') {
      const target = resolvePath(args.path);
      const entries = fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'file',
        ...(entry.isFile() ? { size: fs.statSync(path.join(target, entry.name)).size } : {})
      }));
      return JSON.stringify({ path: target, entries }, null, 2).slice(0, 100_000);
    }
    if (name === 'wait_for_download') {
      const folder = args.folder ? resolvePath(args.folder) : String(cwd);
      const timeoutMs = Math.max(0, Number(args.timeoutSeconds) || 0) * 1000;
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
      const wanted = String(args.nameContains ?? '').toLowerCase();
      const partialNames = new Set<string>();
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const names = await fs.promises.readdir(folder);
        for (const name of names) {
          if (/\.(?:crdownload|part|partial|download)$/i.test(name)) partialNames.add(name.replace(/\.(?:crdownload|part|partial|download)$/i, ''));
        }
        const candidates = names.filter(file => !/\.(?:crdownload|part|partial|download|tmp)$/i.test(file) && (!wanted || file.toLowerCase().includes(wanted)));
        let unobservable = false;
        for (const file of candidates) {
          const stat = await fs.promises.stat(path.join(folder, file)).catch(() => null);
          if (!stat?.isFile()) continue;
          const status = await computer?.downloadState?.(file) ?? 'unknown';
          if (status === 'cancelled') throw new Error(`The download of ${file} was cancelled or interrupted.`);
          const partial = names.some(name => name.startsWith(file + '.') && /\.(?:crdownload|part|partial|download)$/i.test(name));
          if (status === 'completed' || (partialNames.has(file) && !partial && status !== 'pending')) {
            return JSON.stringify({ downloaded: path.join(folder, file), bytes: stat.size });
          }
          if (status === 'unknown' && !partial && wanted) unobservable = true;
        }
        if (unobservable && partialNames.size === 0) return JSON.stringify({ ready: false, observationRequired: true,
          reason: 'A matching file exists, but no download-completion event or final partial-file rename was observed. Verify completion in the browser or app; file size stability alone is insufficient.' });
        await abortDelay(500, signal);
      }
      throw new Error('The download did not complete before the requested deadline.');
    }
    if (name === 'verify_image') {
      const target = resolvePath(args.path);
      if (!fs.existsSync(target)) throw new Error(`There is no file at ${target}.`);
      const minimumWidth = Math.max(1, Number(args.minimumWidth ?? 200));
      const minimumHeight = Math.max(1, Number(args.minimumHeight ?? 200));
      const bytes = fs.statSync(target).size;
      const inspection = await inspectImage(target, signal);
      const problems: string[] = [];
      if (!['png', 'jpeg', 'gif'].includes(inspection.format)) {
        problems.push(`it is ${inspection.format === 'unknown' ? 'not a raster image at all' : `a ${inspection.format}`}, not a photograph`);
      }
      if (inspection.width && inspection.width < minimumWidth) problems.push(`it is only ${inspection.width}px wide`);
      if (inspection.height && inspection.height < minimumHeight) problems.push(`it is only ${inspection.height}px tall`);
      if (bytes < 8_000) problems.push(`it is only ${bytes} bytes, too small to be a real photograph`);
      if (problems.length) {
        throw new Error(`${path.basename(target)} is not a real downloaded image: ${problems.join(', ')}. Download the actual picture from the page instead of producing one.`);
      }
      return JSON.stringify({
        verified: path.basename(target), format: inspection.format,
        width: inspection.width, height: inspection.height, bytes
      });
    }
    if (name === 'http_request') {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('http_request needs a complete http or https URL.');
      const method = String(args.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`Unsupported method ${method}.`);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((args.headers ?? {}) as Record<string, unknown>)) {
        headers[String(key)] = String(value);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: method === 'GET' || method === 'DELETE' ? undefined : String(args.body ?? ''),
          signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
        });
        const text = (await readResponse(response, 200_000, signal, true)).toString('utf8');
        return JSON.stringify({ status: response.status, ok: response.ok, body: text });
      } finally {
        clearTimeout(timer);
      }
    }
    if (name === 'open_with') {
      const target = resolvePath(args.path);
      if (!fs.existsSync(target)) throw new Error(`There is no file at ${target}.`);
      const program = String(args.program ?? '').trim();
      if (!program) throw new Error('Name the program to open it with.');
      if (/[&|;<>^]/.test(program)) throw new Error('That program name is not allowed.');
      if (process.platform === 'darwin') {
        await macOpenWith(program, target);
        return JSON.stringify({ opened: path.basename(target), program });
      }
      if (process.platform === 'linux') {
        await linuxOpenWith(program, target);
        return JSON.stringify({ opened: path.basename(target), program });
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(program, [target], { detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      return JSON.stringify({ opened: path.basename(target), program });
    }
    if (name === 'clipboard_write') {
      clipboard.writeText(String(args.text ?? ''));
      return JSON.stringify({ copied: String(args.text ?? '').length });
    }
    if (name === 'clipboard_read') {
      const text = clipboard.readText();
      return text ? text.slice(0, 200_000) : 'The clipboard is empty.';
    }
    if (name === 'read_file') {
      const target = resolvePath(args.path);
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const limit = Math.max(1, Math.min(250_000, Math.floor(Number(args.length) || 250_000)));
      const extension = path.extname(target).toLowerCase();
      if (['.docx', '.xlsx', '.pptx'].includes(extension)) return heavyTask<string>('officeText', [target, limit, offset], signal);
      const head = await readRange(target, 5, 0, signal);
      if (head.toString('latin1') === '%PDF-') return pdfTextOrGuidance(target, limit, signal, offset);
      if (head.subarray(0, 2).toString('latin1') === 'PK') throw new Error('This is a ZIP archive. Use extract_archive, then read its files.');
      const { text, nextOffset } = await readTextRange(target, limit, offset, signal);
      const size = (await fs.promises.stat(target)).size;
      return nextOffset < size ? text + '\n[More content available: call read_file with offset ' + nextOffset + '.]' : text;
    }
    if (name === 'write_file') {
      const target = resolvePath(args.path, 'write');
      const content = String(args.content ?? '');
      const extension = path.extname(target).toLowerCase();

      if (['.pdf', '.xlsx'].includes(extension)) {
        throw new Error(`write_file cannot make a ${extension.slice(1).toUpperCase()}. Call write_document with the same path and content instead; it builds a real one.`);
      }
      if (extension === '.pptx') {
        throw new Error('PowerPoint files cannot be created here. Write the slide content as a .md or .docx file instead, one heading per slide, and tell the user that is what you produced.');
      }
      const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
      if (
        requirements?.minimumWords
        && ['.txt', '.md', '.rtf', '.docx'].includes(extension)
        && wordCount < minimumAcceptableWords(requirements.minimumWords)
      ) {
        throw new Error(`The content has ${wordCount} words, but the user requested about ${requirements.minimumWords}. Generate the complete content before writing the file.`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (extension === '.docx') await heavyTask('simpleDocument', [target, content], signal);
      else fs.writeFileSync(target, content, 'utf8');
      return JSON.stringify({
        written: target,
        bytes: fs.statSync(target).size,
        words: wordCount,
        verified: fs.existsSync(target)
      });
    }
    if (name === 'make_directory') {
      const target = resolvePath(args.path, 'write');
      fs.mkdirSync(target, { recursive: true });
      return JSON.stringify({ created: target });
    }
    if (name === 'edit_file') {

      const target = resolvePath(args.path ?? args.file, 'write');
      const oldString = String(args.old_string ?? args.oldString ?? args.old_text ?? args.oldText ?? args.search ?? args.find ?? '');
      const newString = String(args.new_string ?? args.newString ?? args.new_text ?? args.newText ?? args.replace ?? args.replacement ?? '');
      if (!oldString) throw new Error('edit_file needs old_string: the exact text to replace. Read the file first and copy the snippet.');
      if (!fs.existsSync(target)) throw new Error(`There is no file at ${target} to edit. Use write_file to create it.`);

      if (isBinaryDocument(target)) {
        throw new Error(`${path.basename(target)} cannot be edited a snippet at a time. Call read_file on it, make the change in the text you get back, then call write_document with the complete updated content.`);
      }
      return JSON.stringify(await heavyTask('editText', [target, oldString, newString, args.replace_all === true || args.replaceAll === true], signal));
    }
    if (name === 'copy_file') {

      const source = resolvePath(args.source ?? args.from ?? args.src ?? args.path);
      const destination = resolvePath(args.destination ?? args.to ?? args.dest ?? args.target, 'write');
      if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
      if (path.resolve(source) === path.resolve(destination)) throw new Error('The source and the destination are the same path.');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await copyPath(source, destination, signal);
      if (!fs.existsSync(destination)) throw new Error(`The copy did not produce ${destination}.`);
      return JSON.stringify({
        copied: source,
        destination,
        bytes: fs.statSync(destination).isFile() ? fs.statSync(destination).size : undefined,
        verified: true
      });
    }
    if (name === 'grep_search' || name === 'glob_search') {
      const root = resolvePath(args.path ?? args.directory ?? args.folder ?? workerRoot);
      const rawPattern = String(args.pattern ?? args.glob ?? args.regex ?? args.query ?? '').trim();
      if (!rawPattern) throw new Error('A search pattern is required.');
      if (!fs.existsSync(root)) throw new Error(`Folder not found: ${root}`);
      return JSON.stringify(await heavyTask('search', [root, rawPattern, name === 'glob_search'], signal), null, 2);
    }
    if (name === 'delete_file') {

      const target = resolvePath(args.path ?? args.file ?? args.target);
      if (!explicitlyRequestsDeletion(requirements?.userRequest ?? '')) {
        throw new Error('Permanent deletion is only available when the user explicitly asks to delete something in this step.');
      }
      if (!within(workerRoot, target)) {
        throw new Error('Permanent deletion is limited to this worker output folder.');
      }
      if (!fs.existsSync(target)) throw new Error(`Nothing to delete at ${target}.`);
      await removePath(target, signal);
      if (fs.existsSync(target)) throw new Error(`${target} could not be removed.`);
      return JSON.stringify({ deleted: target, permanent: true });
    }
    if (name === 'move_file') {

      const pick = (...keys: string[]) => {
        for (const key of keys) {
          const value = (args as Record<string, unknown>)[key];
          if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
      };
      const rawSource = pick('source', 'from', 'path', 'src', 'oldPath', 'old_path', 'file');
      const rawDestination = pick('destination', 'to', 'dest', 'newPath', 'new_path', 'newName', 'new_name', 'target');
      if (!rawSource || !rawDestination) throw new Error('move_file needs a source path and a destination path.');
      const source = resolvePath(rawSource);
      if (!within(workerRoot, source)) throw new Error('Moving files is limited to this worker output folder. Copy external input into the output folder instead.');
      const destination = resolvePath(rawDestination, 'write');
      if (source === destination) throw new Error('The source and the destination are the same path; give the new name as the destination.');
      if (!fs.existsSync(source)) throw new Error(`Source not found: ${source}`);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(source, destination);
      if (!fs.existsSync(destination)) throw new Error(`The move did not produce ${destination}.`);
      return JSON.stringify({ moved: source, destination });
    }
    if (name === 'extract_archive') {
      const archive = resolvePath(args.archive);
      const destination = resolvePath(args.destination, 'write');
      if (path.extname(archive).toLowerCase() !== '.zip') throw new Error('Only ZIP archives are supported.');
      if (!fs.existsSync(archive)) throw new Error(`Archive not found: ${archive}`);
      return JSON.stringify(await extractZip(archive, destination, signal));
    }
    if (name === 'create_archive') {
      const source = resolvePath(args.source ?? args.path ?? args.folder ?? args.from);
      let archive = resolvePath(args.archive ?? args.destination ?? args.output ?? args.to, 'write');
      if (path.extname(archive).toLowerCase() !== '.zip') archive = `${archive.replace(/\.[^.\\/]*$/, '')}.zip`;
      if (!fs.existsSync(source)) throw new Error(`There is nothing at ${source} to compress. Call list_files first and use a path it returns.`);
      if (path.resolve(source) === path.resolve(archive)) throw new Error('The archive cannot be the folder it is compressing. Give the .zip a different name.');
      return JSON.stringify(await createZip(source, archive, signal));
    }
    if (name === 'open_folder') {
      const target = resolvePath(args.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Folder not found: ${target}`);
      const failure = await shell.openPath(target);
      if (failure) throw new Error(failure);
      return JSON.stringify({ opened: target });
    }
    if (name === 'open_terminal') {
      const target = resolvePath(args.path);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Folder not found: ${target}`);
      if (process.platform === 'darwin') {
        const opened = await macOpenTerminal(target);
        return JSON.stringify({ opened, cwd: target });
      }
      if (process.platform === 'linux') {
        const opened = await linuxOpenTerminal(target);
        return JSON.stringify({ opened, cwd: target });
      }
      const child = spawn('powershell.exe', ['-NoExit'], {
        cwd: target,
        detached: true,
        windowsHide: false,
        stdio: 'ignore'
      });
      child.unref();
      return JSON.stringify({ opened: 'PowerShell', cwd: target });
    }
    if (name === 'open_search_in_browser') {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('A web search query is required.');
      const url = /^https:\/\//i.test(query)
        ? query
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await openInBrowser(url);
      return JSON.stringify({ searched: query, opened: url });
    }
    if (name === 'web_search') {

      const query = String(args.query ?? args.q ?? args.search ?? '').trim();
      if (!query) throw new Error('A web search query is required.');
      let results: SearchResult[] = [];
      let directFailure: unknown;
      try {
        results = await fetchSearchResults(query, signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        directFailure = error;
      }
      let viaBrowser = false;
      if (!results.length) {
        results = await browserSearchResults(query, computer, signal);
        viaBrowser = results.length > 0;
      }
      if (!results.length) {
        throw directFailure instanceof Error && /could be reached/i.test(directFailure.message)
          ? directFailure
          : new Error(`Nothing would answer a search for "${query}" from this computer, neither a direct request nor this worker's own browser.`
            + ' Open a specific page with open_page if you already know a good source.');
      }
      return JSON.stringify({
        query,
        results: results.slice(0, 8),
        note: viaBrowser
          ? 'Direct search was blocked, so these came from a search page read in the worker browser. Answer from them, or use open_page on a link for the full page.'
          : 'Answer from these snippets. Use fetch_url on a link if you need the full page.'
      }, null, 2);
    }
    if (name === 'fetch_url') {
      const url = String(args.url ?? args.link ?? args.address ?? '').trim();

      if (!/^https?:\/\//i.test(url)) {
        throw new Error(url
          ? `"${url}" is not a full http(s) URL. Call web_search first and pass one of the URLs it returns.`
          : 'fetch_url needs a full http(s) URL from a web_search result. Call web_search first, then fetch_url on one of its URLs.');
      }
      const { title, text } = await fetchReadableText(url, signal);
      if (!text.trim()) throw new Error(`${url} returned no readable text.`);
      return JSON.stringify({ url, title, characters: text.length, text: text.slice(0, 40_000) });
    }
    if (name === 'get_datetime') {
      const now = new Date();
      const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const requestedZone = String(args.timeZone ?? args.timezone ?? args.zone ?? '').trim();

      let zone = machineZone;
      let zoneError: string | undefined;
      if (requestedZone) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: requestedZone }).format(now);
          zone = requestedZone;
        } catch {
          zoneError = `"${requestedZone}" is not a valid IANA time zone, so this is ${machineZone} instead. Retry with a name like America/New_York.`;
        }
      }
      return JSON.stringify({
        iso: now.toISOString(),
        timeZone: zone,
        date: now.toLocaleDateString('en-US', { timeZone: zone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        time: now.toLocaleTimeString('en-US', { timeZone: zone }),
        local: now.toLocaleString('en-US', { timeZone: zone }),
        ...(zoneError ? { warning: zoneError } : {})
      });
    }
    if (name === 'run_command') {
      const commandCwd = args.cwd ? resolvePath(args.cwd) : cwd;
      const command = String(args.command ?? '');
      const isMacHost = process.platform === 'darwin';
      const isLinuxHost = process.platform === 'linux';
      const isPosixHost = isMacHost || isLinuxHost;
      const shellName = isPosixHost ? 'the shell' : 'PowerShell';
      const sleepOrClipboard = isMacHost
        ? /\b(?:sleep|pbcopy|pbpaste)\b/i
        : isLinuxHost
          ? /\b(?:sleep|xclip|xsel|wl-copy|wl-paste)\b/i
          : /\b(?:Start-Sleep|Get-Clipboard|Set-Clipboard)\b/i;
      const launchesBrowser = isMacHost
        ? /\b(?:Google Chrome|Chrome|Brave|Safari|Firefox|Microsoft Edge)\b|\bopen\b[\s\S]{0,80}\bhttps?:\/\//i
        : isLinuxHost
          ? /\b(?:google-chrome|chromium|chrome|brave-browser|brave|firefox|opera|vivaldi)\b|\b(?:xdg-open|gio)\b[\s\S]{0,80}\bhttps?:\/\//i
          : /\b(?:chrome|msedge|brave|firefox|opera|vivaldi)(?:\.exe)?\b|\bStart-Process\b[\s\S]{0,80}\bhttps?:\/\//i;
      if (browserInteractionRequest(requirements?.userRequest ?? '') && sleepOrClipboard.test(command)) {
        throw new Error(`Do not use ${shellName} sleeps or the clipboard to inspect a browser. Use browser_wait_for or browser_read in a worker profile, and read_screen in the user browser.`);
      }
      if (browserInteractionRequest(requirements?.userRequest ?? '') && launchesBrowser.test(command)) {
        throw new Error(`Do not launch another browser from ${shellName}. Use open_page so OmniAgent can reuse and control the current tab.`);
      }
      const invocation = isPosixHost
        ? shellCommand(command)
        : { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
      const result = await runProcess(invocation.executable, invocation.args, {
        cwd: commandCwd,
        signal,
        timeoutMs: 0
      });
      return JSON.stringify({
        stdout: result.stdout.slice(-80_000),
        stderr: result.stderr.slice(-20_000)
      });
    }
    if (name === 'open_url') {
      const url = String(args.url ?? '');

      if (!/^https:\/\//i.test(url)) {
        throw new Error(/^http:\/\//i.test(url)
          ? `open_url only opens https:// addresses. For ${url}, call open_page instead — it opens the page and lets you read it.`
          : 'open_url needs a full https:// address. Retry with the complete URL.');
      }
      if (computer && await computer.pageAvailable()) {
        const opened = await computer.pageOpen(url);
        return JSON.stringify({ opened, note: 'Opened in this worker’s own browser. Call browser_read to see the page.' });
      }
      await openInBrowser(url);
      return JSON.stringify({ opened: url });
    }
    if (name === 'open_page' && await host().pageAvailable()) {
      const url = String(args.url ?? args.address ?? '').trim();
      const opened = await host().pageOpen(url);
      const snapshot = await host().pageRead();
      return JSON.stringify({ opened, page: snapshot });
    }
    if (name === 'open_page') {
      const url = String(args.url ?? args.link ?? args.address ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(url
          ? `"${url}" is not a full http(s) URL. Retry open_page with the whole address, starting with https://.`
          : 'open_page needs a full http(s) URL such as https://example.com. Retry with the complete address.');
      }
      const page = await host().browserOpen(url);
      return JSON.stringify({
        opened: page.url,
        title: page.title,
        next: 'Call read_screen to see what is on this page before clicking or typing.'
      });
    }
    if (name === 'read_screen') {
      const screen = await host().readForeground();
      return JSON.stringify({
        window: screen.window,
        text: screen.text.slice(0, 30_000),
        controls: screen.controls.slice(0, 120)
      }, null, 2);
    }
    if (name === 'click_element') {
      const target = String(args.name ?? args.text ?? args.element ?? args.label ?? args.target ?? args.selector ?? '').trim();
      if (!target) throw new Error('click_element needs name: the visible text of the button or link. Call read_screen and copy one of the control names it lists.');
      return JSON.stringify(await host().clickByName(target));
    }
    if (name === 'type_text') {
      const text = String(args.text ?? args.value ?? args.content ?? '');
      if (!text) throw new Error('type_text needs text: what to type.');
      const into = String(args.into ?? args.field ?? args.name ?? args.target ?? '').trim();
      return JSON.stringify(await host().typeByName(text, into || undefined));
    }
    if (name === 'press_key') {
      const key = String(args.key ?? args.keys ?? args.name ?? '').trim();
      if (!key) throw new Error(`press_key needs key, for example Enter or ${OS_TERMS.shortcutExample}.`);
      return JSON.stringify(await host().pressKey(key));
    }
    if (name === 'scroll_page') {
      const direction = String(args.direction ?? args.dir ?? 'down').trim().toLowerCase();
      const amount = Math.max(1, Math.min(20, Math.round(Number(args.amount ?? args.notches ?? 3)) || 3));
      const delta = /up|back|top|previous/.test(direction) ? -amount : amount;
      return JSON.stringify(await host().scrollForeground(delta));
    }
    if (name.startsWith('browser_')) {
      const page = host();
      if (!(await page.pageAvailable())) {
        throw new Error('Fast page control is not available for this worker. It needs the "Its own profile" browser setting and a Chromium browser (Brave, Chrome or Edge) as the Windows default. Use read_screen and click_element instead.');
      }
      if (name === 'browser_read') return JSON.stringify(await page.pageRead());
      if (name === 'browser_text') {
        const limit = Math.max(500, Math.min(200_000, Number(args.maxCharacters ?? 40_000) || 40_000));
        return JSON.stringify(await page.pageText(limit));
      }
      if (name === 'browser_screenshot') {
        let target = resolvePath(String(args.path ?? args.destination ?? '').trim() || `page-${Date.now()}.png`, 'write');
        if (path.extname(target).toLowerCase() !== '.png') target = `${target.replace(/\.[^.\\/]*$/, '')}.png`;
        return JSON.stringify(await page.pageScreenshot(target));
      }
      if (name === 'browser_find') return JSON.stringify(await page.pageFind(String(args.query ?? '')));
      if (name === 'browser_click') return JSON.stringify(await page.pageClick(String(args.ref ?? '')));
      if (name === 'browser_fill') return JSON.stringify(await page.pageFill(String(args.ref ?? ''), String(args.value ?? '')));
      if (name === 'browser_press') return JSON.stringify(await page.pagePress(String(args.key ?? ''), args.ref ? String(args.ref) : undefined));
      if (name === 'browser_scroll') return JSON.stringify(await page.pageScroll(Number(args.delta ?? 800)));
      if (name === 'browser_back') return JSON.stringify(await page.pageBack());
      if (name === 'browser_wait_for') return JSON.stringify(await page.pageWaitFor(String(args.text ?? '')));
      if (name === 'browser_tabs') return JSON.stringify(await page.pageTabs());
      if (name === 'browser_open_tab') {
        const url = String(args.url ?? '');
        if (!/^https:\/\//i.test(url)) throw new Error('Open another tab only with a complete HTTPS URL.');
        return JSON.stringify(await page.pageOpenNewTab(url));
      }
      if (name === 'browser_switch_tab') return JSON.stringify(await page.pageSwitchTab(String(args.tabId ?? '')));
      if (name === 'browser_close_tab') return JSON.stringify(await page.pageCloseTab(String(args.tabId ?? '')));
      if (name === 'browser_evaluate') {
        const saveTo = typeof args.saveTo === 'string' ? args.saveTo.trim() : '';
        const destination = saveTo ? path.resolve(workerRoot, saveTo) : undefined;
        if (destination && (!within(workerRoot, destination) || destination === workerRoot)) {
          throw new Error(`saveTo must be a file path inside this worker folder (${workerRoot}), for example data/rows.json.`);
        }
        return JSON.stringify(await page.pageEvaluate(String(args.expression ?? ''), typeof args.resultId === 'string' ? args.resultId : undefined, Number(args.offset) || 0, destination));
      }
      if (name === 'browser_extensions') return JSON.stringify(await page.pageExtensions());
      if (name === 'browser_focus_extension') {
        return JSON.stringify(await page.pageFocusExtension(String(args.viewId ?? '')));
      }
      if (name === 'browser_extract') {
        return JSON.stringify(await page.pageExtract(
          String(args.rowSelector ?? ''),
          (args.fields ?? {}) as Record<string, string>
        ));
      }
      if (name === 'browser_wait_for_idle') {
        return JSON.stringify(await page.pageWaitForIdle(
          Number(args.quietMillis ?? 700),
          Math.round(Number(args.timeoutSeconds ?? 0) * 1000)
        ));
      }
      if (name === 'browser_click_and_wait') {
        return JSON.stringify(await page.pageClickAndWait(String(args.ref ?? ''), {
          text: args.waitForText ? String(args.waitForText) : undefined,
          urlChanges: Boolean(args.waitForNewPage)
        }));
      }
      if (name === 'browser_fill_form') {
        const fields = Array.isArray(args.fields)
          ? (args.fields as Array<Record<string, unknown>>).map((field) => ({
            ref: String(field.ref ?? ''), value: String(field.value ?? '')
          }))
          : [];
        if (!fields.length) throw new Error('browser_fill_form needs at least one field.');
        const filled = await page.pageFillForm(fields);
        if (args.submitRef) {
          const submitted = await page.pageClickAndWait(String(args.submitRef), { idle: true });
          return JSON.stringify({ ...(filled as Record<string, unknown>), submitted });
        }
        return JSON.stringify(filled);
      }
      if (name === 'browser_console') {
        return JSON.stringify(await page.pageConsole({
          level: args.level === 'error' ? 'error' : 'all',
          limit: Number(args.limit ?? 50)
        }));
      }
      if (name === 'browser_network') {
        return JSON.stringify(await page.pageNetwork({
          failedOnly: Boolean(args.failedOnly),
          urlPattern: args.urlPattern ? String(args.urlPattern) : undefined,
          limit: Number(args.limit ?? 50)
        }));
      }
      if (name === 'browser_hover') return JSON.stringify(await page.pageHover(String(args.ref ?? '')));
      if (name === 'browser_click_special') {
        return JSON.stringify(await page.pageClickWith(String(args.ref ?? ''), {
          button: args.button === 'right' ? 'right' : 'left',
          clickCount: Number(args.clickCount ?? 1)
        }));
      }
      if (name === 'browser_drag') {
        return JSON.stringify(await page.pageDrag(String(args.fromRef ?? ''), String(args.toRef ?? '')));
      }
      if (name === 'browser_save_pdf') {
        return JSON.stringify(await page.pageSavePdf(String(args.path ?? '')));
      }
      if (name === 'upload_file') {
        return JSON.stringify(await page.pageUpload(String(args.ref ?? ''), String(args.path ?? '')));
      }
      if (name === 'browser_resize') {
        return JSON.stringify(await page.pageResize(Number(args.width ?? 1280), Number(args.height ?? 800), Boolean(args.mobile)));
      }
    }
    if (name === 'check_screen') {
      const question = String(args.question ?? args.assertion ?? args.check ?? args.text ?? '').trim();
      if (!question) throw new Error('check_screen needs question: the one thing to confirm on screen, e.g. "does the calculator show 64".');
      const verdict = await host().checkScreen(question);
      return JSON.stringify(verdict);
    }
    if (name === 'take_screenshot') {
      const requested = String(args.path ?? args.destination ?? args.file ?? '').trim();
      const deliverable = explicitlyRequestsScreenshot(requirements?.userRequest ?? '')
        && requested
        && !/^(?:screen|shot|capture|temp|tmp)/i.test(path.basename(requested));
      let target = deliverable
        ? resolvePath(requested, 'write')
        : path.join(scratchScreenshotDirectory(), `screen-${Date.now()}.png`);
      if (path.extname(target).toLowerCase() !== '.png') target = `${target.replace(/\.[^.\\/]*$/, '')}.png`;
      clearScratchScreenshots(120_000);
      const shot = await host().screenshot(target);
      const kept = deliverable;
      return JSON.stringify({
        saved: shot.path,
        bytes: shot.bytes,
        pixels: `${shot.width}x${shot.height}`,
        verified: fs.existsSync(shot.path),
        temporary: !kept,
        note: kept
          ? 'Saved as a deliverable in the output folder.'
          : 'Temporary capture for you to look at now. It is deleted automatically and is not part of the user output folder.'
      });
    }
    if (name === 'list_windows') {
      const windows = await host().listWindows();
      if (!windows.length) throw new Error('No application windows were readable. Use open_app to start the program you need, then try again.');
      return JSON.stringify({ windowCount: windows.length, windows: windows.slice(0, 60) }, null, 2);
    }
    if (name === 'focus_window') {
      const title = String(args.title ?? args.name ?? args.window ?? '').trim();
      if (!title) throw new Error('focus_window needs title. Call list_windows first and copy one of the titles it returns.');
      return JSON.stringify(await host().focusWindow(title));
    }
    if (name === 'open_app') {
      const program = String(args.name ?? args.app ?? args.program ?? args.fileName ?? args.path ?? '').trim();
      if (!program) throw new Error('open_app needs name, for example notepad.');
      const launched = await host().launchApp(program, String(args.arguments ?? args.args ?? '').trim() || undefined);
      return JSON.stringify({ ...launched, next: 'Call read_screen to see the window that opened.' });
    }
    if (name === 'download_file') {
      const url = String(args.url ?? args.link ?? args.address ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(url
          ? `"${url}" is not a full http(s) URL. Call web_search first and pass one of the URLs it returns.`
          : 'download_file needs a full http(s) URL. Call web_search first if you do not have one.');
      }
      const destination = resolvePath(args.path ?? args.destination ?? args.file ?? args.output, 'write');
      const response = await fetch(url, { redirect: 'follow', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Download returned HTTP ${response.status}.`); }
      const saved = await saveResponse(response, destination, signal);
      return JSON.stringify({ downloaded: url, saved: destination, ...saved,
        mimeType: response.headers.get('content-type')?.split(';')[0] ?? '', verified: true });
    }
    if (name === 'write_document') {
      const requestedPath = String(args.path ?? args.destination ?? args.file ?? '').trim();
      if (!requestedPath) throw new Error('write_document needs path: the full file name to create, ending in .docx, .pdf or .xlsx. Retry with one.');
      let target = resolvePath(requestedPath, 'write');
      let extension = path.extname(target).toLowerCase();

      if (!['.docx', '.pdf', '.xlsx'].includes(extension)) {
        target = `${target.replace(/\.[^.\\/]*$/, '')}.docx`;
        extension = '.docx';
      }
      const content = String(args.content ?? args.text ?? args.body ?? args.rows ?? '').trim();
      if (!content) throw new Error('write_document needs content: the complete text of the document. Write it out in full, then call this again.');
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      if (requirements?.minimumWords && wordCount < minimumAcceptableWords(requirements.minimumWords)) {
        throw new Error(`The content has ${wordCount} words, but the user requested about ${requirements.minimumWords}. Write the complete text and call write_document again.`);
      }
      if (extension === '.xlsx') {

        if (!content.includes(',')) {
          throw new Error('A spreadsheet needs comma-separated rows, one per line, starting with the header row — for example "month,units". Write the rows and call write_document again.');
        }
        await heavyTask('simpleDocument', [target, content], signal);
        const rowCount = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim()).length;
        return JSON.stringify({
          written: target,
          format: 'xlsx',
          rows: rowCount,
          bytes: fs.statSync(target).size,
          verified: (await heavyTask<string>('officeText', [target, 1000, 0], signal)).length > 0
        });
      }
      const result = await new DocumentEngine().execute('createDocument', {
        destination: target,
        title: String(args.title ?? '').trim()
      }, content, signal) as Record<string, unknown>;
      return JSON.stringify({
        written: target,
        format: path.extname(target).slice(1),
        words: wordCount,
        bytes: fs.existsSync(target) ? fs.statSync(target).size : 0,
        verified: result.reopenable !== false && fs.existsSync(target)
      });
    }
    throw new Error(`Unsupported tool: ${name}`);
  }

  private async runClaudeTurn(input: ProviderTurnInput): Promise<ProviderTurnResult> {
    try {
      return await this.runClaudeProcess(input, input.sessionId);
    } catch (error) {

      const raw = providerFailureText(error);
      if (
        input.sessionId
        && !input.signal?.aborted
        && /resume|session|no conversation|not found|does not exist/i.test(raw)

        && classifyProviderFailure(error) !== 'usageLimit'
      ) {
        return this.runClaudeProcess(input, undefined);
      }
      throw providerTurnError('Claude', error, input.apiKey ? 'apiKey' : 'account');
    }
  }

  private async runClaudeProcess(input: ProviderTurnInput, sessionId?: string): Promise<ProviderTurnResult> {
    fs.mkdirSync(this.claudeHome, { recursive: true });
    const attachmentPrompt = (input.attachments ?? []).length
      ? `\n\nAttachments available locally:\n${input.attachments!.map((item) => `- ${item.name}: ${item.path}`).join('\n')}\nRead and use these attachments when answering.`
      : '';

    const streamMessage = (text: string) => JSON.stringify({
      type: 'user', message: { role: 'user', content: text },
      session_id: sessionId ?? '', parent_tool_use_id: null, uuid: crypto.randomUUID()
    }) + '\n';
    const stdin = input.liveInput ? streamMessage(`${input.prompt}${attachmentPrompt}`) : `${input.prompt}${attachmentPrompt}`;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--no-chrome',
      '--model',
      input.model || 'sonnet',
      '--effort',
      input.reasoningEffort === 'ultra' ? 'xhigh' : input.reasoningEffort || 'high',
      '--add-dir',
      this.userData
    ];

    if (input.liveInput) args.push('--input-format', 'stream-json');
    if (input.toolMode === 'none') args.push('--tools', '');
    if (sessionId) args.push('--resume', sessionId);
    else if (input.toolMode === 'none') args.push('--no-session-persistence');
    else args.push('--name', `omniagent-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);

    const host = await this.hostToolSession(input);
    if (host) {
      args.push('--mcp-config', JSON.stringify({
        mcpServers: {
          omniagent: {
            command: process.execPath,
            args: [this.hostBridgeScript()],
            env: host.env
          }
        }
      }));
      args.push('--allowed-tools', `${claudeNativeToolsForRequest(input.userRequest ?? input.prompt).join(',')},mcp__omniagent`);
    }

    return this.runStreamAgent(input, sessionId, {
      provider: input.provider,
      executable: this.claudeExecutable,
      args,
      stdin,
      keepStdinOpen: Boolean(input.liveInput),
      streamMessage,
      env: input.apiKey
        ? {
            CLAUDE_CONFIG_DIR: path.join(this.claudeHome, '..', 'claude-keys', crypto.createHash('sha256').update(input.apiKey).digest('hex').slice(0, 16)),
            ...anthropicCompatibleEnv(input)
          }
        : { CLAUDE_CONFIG_DIR: this.claudeHome }
    }, host);
  }

  private async runStreamAgent(input: ProviderTurnInput, sessionId: string | undefined, agent: StreamAgent, host: HostToolBinding): Promise<ProviderTurnResult> {
    const streamEvents: Array<Record<string, unknown>> = [];
    const claudeToolNames = new Map<string, string>();
    const claudeToolLabels = new Map<string, string>();
    let lastAssistantMessage = '';
    let providerChild: ChildProcess | undefined;
    let pendingResults = 1;
    let closingInput = false;
    let settleTimer: NodeJS.Timeout | undefined;
    const closeInput = () => {
      if (closingInput) return;
      closingInput = true;
      input.liveInput?.unbind();
      providerChild?.stdin?.end();
    };
    let result: Awaited<ReturnType<typeof runProcess>>;
    try {
      result = await runProcess(agent.executable, agent.args, {
      timeoutMs: input.timeoutMs,
      cwd: input.cwd,
      env: agent.env,
      signal: input.signal,
      stdin: agent.stdin,
      keepStdinOpen: agent.keepStdinOpen,
      onSpawn: (child) => {
        providerChild = child;
        this.trackProviderChild(child);
        input.liveInput?.bind(async (message) => {
          if (closingInput || child.killed || child.stdin?.destroyed || input.signal?.aborted) return false;
          if (input.allowBrowserControl === false) return false;
          host?.followUp(message.text);
          pendingResults++;
          return new Promise<boolean>((resolve, reject) => {
            child.stdin!.write(agent.streamMessage(followUpPrompt([message])), (error) => {
              if (error) { pendingResults--; reject(error); }
              else resolve(true);
            });
          });
        });
      },
      onStdoutLine: (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          streamEvents.push(event);
          if (settleTimer && (event.type === 'assistant' || event.type === 'user' || (event.type === 'system' && event.subtype === 'init'))) {
            clearTimeout(settleTimer);
            settleTimer = undefined;
          }
          if (input.liveInput && event.type === 'result') {
            pendingResults--;
            if (settleTimer) clearTimeout(settleTimer);
            if (pendingResults <= 0 || event.is_error === true || String(event.subtype ?? '').startsWith('error')) closeInput();
            else settleTimer = setTimeout(closeInput, 20_000);
          }
          const summary = claudeActivitySummary(event);
          if (summary) input.onActivity?.(summary);
          if (input.onToolEvent) {
            for (const toolEvent of claudeToolEvents(event)) {
              input.onToolEvent(toolEvent.name
                ? toolEvent
                : { ...toolEvent, name: claudeToolNames.get(toolEvent.id) ?? 'tool', label: claudeToolLabels.get(toolEvent.id) ?? '' });
              if (toolEvent.status === 'running') {
                claudeToolNames.set(toolEvent.id, toolEvent.name);
                claudeToolLabels.set(toolEvent.id, toolEvent.label);
              }
            }
          }
          if (event.type === 'assistant') {
            const message = event.message as Record<string, unknown> | undefined;
            const content = Array.isArray(message?.content) ? message.content as Array<Record<string, unknown>> : [];
            const assistantText = content
              .filter((item) => item.type === 'text')
              .map((item) => String(item.text ?? ''))
              .join('\n')
              .trim();
            if (assistantText && assistantText !== lastAssistantMessage) {
              lastAssistantMessage = assistantText;
              input.onPartialMessage?.(assistantText);
              input.onMessage?.(assistantText);
            }
          }
        } catch {

        }
      }
      });
    } finally {
      if (settleTimer) clearTimeout(settleTimer);
      host?.close();
    }
    input.liveInput?.unbind();
    const parsed = [...streamEvents].reverse().find((event) => event.type === 'result')
      ?? JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || '{}') as Record<string, unknown>;

    if (parsed.is_error === true || String(parsed.subtype ?? '').startsWith('error')) {
      const detail = String(parsed.result ?? parsed.error ?? parsed.message ?? '');
      throw providerTurnError(agent.provider, new ProviderProcessError(detail, 0), input.apiKey ? 'apiKey' : 'account');
    }
    const answer = cleanPublicAnswer(parsed.result ?? parsed.message ?? parsed.content, input.structured);
    const nextSessionId = String(parsed.session_id ?? parsed.sessionId ?? sessionId ?? '');
    if (!nextSessionId) throw new Error(`${providerTraits(agent.provider).label} completed the request without returning a resumable session ID.`);
    return { answer, sessionId: nextSessionId };
  }

  close() {
    this.removeAllListeners();
    this.stopProcesses();
    this.hostTools.stop();
  }

  stopProcesses() {
    this.codex.close();
    for (const codex of this.codexWorkers.values()) codex.close();
    this.codexWorkers.clear();
    for (const child of this.activeProviderChildren) {
      if (child.exitCode !== null || child.killed) continue;
      terminateOwnedProcess(child, true);
    }
    this.activeProviderChildren.clear();
  }
}

export { defaultModels };
