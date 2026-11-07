import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, FileText, FolderOpen, Globe, ListChecks, LoaderCircle, Monitor, Search, SquareTerminal, Users } from 'lucide-react';
import { omni } from './api';
import { CodeBox } from './Markdown';
import { baseName } from './ui';
import type { ToolStep, ToolStepDetail } from '../electron/shared';

type Kind = 'command' | 'browse' | 'write' | 'read' | 'search' | 'screen' | 'team' | 'mixed';

const KIND_PATTERNS: Array<[Kind, RegExp]> = [
  ['command', /^(?:bash|powershell|shell|run_command|command|commandexecution|exec_command|local_shell|run_shell_command)$/i],
  ['browse', /^(?:open_page|open_url|open_search_in_browser|browser_\w+|webfetch|fetch_url|http_request)$/i],
  ['write', /^(?:write|edit|multiedit|notebookedit|write_file|write_document|edit_file|make_directory|move_file|copy_file|delete_file|download_file|create_archive|extract_archive|filechange|apply_patch|replace)$/i],
  ['read', /^(?:read|glob|grep|ls|read_file|list_files|glob_search|grep_search|read_many_files)$/i],
  ['search', /^(?:websearch|web_search|google_web_search)$/i],
  ['screen', /^(?:read_screen|click_element|type_text|press_key|scroll_page|take_screenshot|check_screen|list_windows|focus_window|open_app)$/i],
  ['team', /^(?:team_board|team_post|message_teammate|progress_report|assign_fix)$/i]
];

function bareName(name: string) {
  return name.replace(/^mcp__.+?__/, '');
}

function kindOf(name: string): Kind {
  const bare = bareName(name);
  return KIND_PATTERNS.find(([, pattern]) => pattern.test(bare))?.[0] ?? 'mixed';
}

function summary(steps: ToolStep[]): { kind: Kind; phrase: string } {
  const counts = new Map<Kind, number>();
  for (const step of steps) counts.set(kindOf(step.name), (counts.get(kindOf(step.name)) ?? 0) + 1);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const phrases: Record<Kind, (n: number) => string> = {
    command: (n) => `Ran ${plural(n, 'command', 'commands')}`,
    browse: () => 'Used the browser',
    write: (n) => `Worked on ${plural(n, 'file', 'files')}`,
    read: () => 'Looked through files',
    search: () => 'Searched the web',
    screen: () => 'Used the screen',
    team: () => 'Talked with the team',
    mixed: (n) => `Ran ${plural(n, 'step', 'steps')}`
  };
  const [best] = [...counts.entries()].filter(([kind]) => kind !== 'mixed').sort((left, right) => right[1] - left[1]);
  if (best && best[1] >= Math.ceil(steps.length * 0.6)) return { kind: best[0], phrase: phrases[best[0]](best[1]) };
  return { kind: 'mixed', phrase: phrases.mixed(steps.length) };
}

function KindIcon({ kind, size = 13 }: { kind: Kind; size?: number }) {
  if (kind === 'command') return <SquareTerminal size={size} />;
  if (kind === 'browse') return <Globe size={size} />;
  if (kind === 'write') return <FileText size={size} />;
  if (kind === 'read') return <FolderOpen size={size} />;
  if (kind === 'search') return <Search size={size} />;
  if (kind === 'screen') return <Monitor size={size} />;
  if (kind === 'team') return <Users size={size} />;
  return <ListChecks size={size} />;
}

function seconds(ms?: number) {
  if (!ms) return '';
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

const LANGUAGES: Record<string, string> = { ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python', json: 'json', css: 'css', html: 'html', htm: 'html', md: 'markdown', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', sql: 'sql', svg: 'svg', xml: 'xml', toml: 'toml' };

function languageFor(file: string) {
  return LANGUAGES[file.split('.').pop()?.toLowerCase() ?? ''] ?? '';
}

function pretty(raw: string) {
  const text = raw.trim();
  if (!/^[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type Shown = { title: string; body: string; language?: string; prompt?: string };

function inputBlocks(name: string, raw: string): Shown[] {
  const text = raw.trim();
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [{ title: kindOf(name) === 'command' ? 'Command' : 'Input', body: text, prompt: kindOf(name) === 'command' ? '$' : undefined }];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ title: 'Input', body: pretty(text) }];
  const args = value as Record<string, unknown>;
  const read = (...keys: string[]) => {
    for (const key of keys) if (typeof args[key] === 'string' && String(args[key]).trim()) return String(args[key]);
    return '';
  };
  const command = read('command', 'cmd', 'script') || (Array.isArray(args.command) ? (args.command as unknown[]).map(String).join(' ') : '');
  const file = read('file_path', 'path', 'filePath', 'target', 'notebook_path');
  if (command) return [{ title: /powershell/i.test(name) ? 'PowerShell' : 'Command', body: command, prompt: /powershell/i.test(name) ? 'PS>' : '$' }];
  const code = read('expression', 'code', 'function', 'js', 'javascript');
  if (code) return [{ title: 'Code', body: code, language: /browser_|evaluate/i.test(name) ? 'javascript' : read('language') }];
  const oldText = read('old_string', 'oldText', 'old_str', 'search');
  const newText = read('new_string', 'newText', 'new_str', 'replace');
  if (oldText || newText) return [
    ...(oldText ? [{ title: `Replaced in ${baseName(file) || 'file'}`, body: oldText, language: languageFor(file) }] : []),
    ...(newText ? [{ title: 'With', body: newText, language: languageFor(file) }] : [])
  ];
  const content = read('content', 'contents', 'text', 'markdown', 'html');
  if (content && file) return [{ title: baseName(file), body: content, language: languageFor(file) }];
  const query = read('query', 'q', 'url');
  if (query && Object.keys(args).length <= 3) return [{ title: /url/i.test(Object.keys(args).join(' ')) && !read('query', 'q') ? 'Address' : 'Search', body: query }];
  return [{ title: 'Input', body: JSON.stringify(args, null, 2), language: 'json' }];
}

function StepDetail({ runId, ownerId, step }: { runId: string; ownerId: string; step: ToolStep }) {
  const [detail, setDetail] = useState<ToolStepDetail | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void omni.stepDetail(runId, ownerId, step.id).then((value) => { if (alive) setDetail(value); }).catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [runId, ownerId, step.id, step.status]);
  if (detail === undefined) return <div className="step-detail loading"><LoaderCircle size={13} className="spin" />Loading</div>;
  if (!detail) return <div className="step-detail empty">Nothing was recorded for this step.</div>;
  const blocks = inputBlocks(step.name, detail.args);
  const output = pretty(detail.result);
  return <div className="step-detail">
    {blocks.map((block, index) => <CodeBox key={index} title={block.title} code={block.body} language={block.language} prompt={block.prompt} limit={4_000} />)}
    {output ? <CodeBox title={step.status === 'error' ? 'Error' : 'Output'} code={output} limit={2_400} /> : step.status === 'running' ? <div className="step-detail empty">Still running…</div> : null}
  </div>;
}

export function ToolActivity({ steps, live, runId, ownerId }: { steps: ToolStep[]; live: boolean; runId: string; ownerId: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!steps.length) return null;
  const settled = live ? steps : steps.map((step) => step.status === 'running' ? { ...step, status: 'ok' as const } : step);
  const running = settled.filter((step) => step.status === 'running');
  const failed = settled.filter((step) => step.status === 'error').length;
  const total = settled.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const shape = summary(settled);
  const visible = open ? settled : live ? settled.slice(-3) : [];
  const toggle = (id: string) => setExpanded((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <div className={`activity ${open ? 'open' : ''} ${running.length ? 'live' : ''}`}>
    <button type="button" className="activity-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="activity-kind">{running.length ? <LoaderCircle size={13} className="spin" /> : <KindIcon kind={shape.kind} />}</span>
      <span className="activity-phrase">{shape.phrase}</span>
      {shape.kind !== 'mixed' ? <span className="activity-chip">{settled.length} step{settled.length === 1 ? '' : 's'}</span> : null}
      {failed ? <span className="activity-chip bad">{failed} failed</span> : null}
      {!running.length && total ? <span className="activity-time">{seconds(total)}</span> : null}
      <ChevronDown size={14} className="activity-caret" />
    </button>
    {visible.length ? <ol className="activity-list">
      {!open && settled.length > visible.length ? <li className="activity-earlier"><button type="button" onClick={() => setOpen(true)}>{settled.length - visible.length} earlier step{settled.length - visible.length === 1 ? '' : 's'}</button></li> : null}
      {visible.map((step) => {
        const isOpen = expanded.includes(step.id);
        return <li className={`activity-step ${step.status} ${isOpen ? 'expanded' : ''}`} key={step.id}>
          <button type="button" className="activity-row" disabled={!step.detail} aria-expanded={isOpen} onClick={() => toggle(step.id)}>
            <span className="activity-node">{step.status === 'running' ? <LoaderCircle size={11} className="spin" /> : step.status === 'error' ? <CircleAlert size={11} /> : <Check size={11} />}</span>
            <span className="activity-label">{step.label || bareName(step.name)}</span>
            <code className="activity-tool"><KindIcon kind={kindOf(step.name)} size={10} />{bareName(step.name)}</code>
            {step.durationMs ? <span className="activity-time">{seconds(step.durationMs)}</span> : null}
            {step.detail ? <ChevronRight size={13} className="activity-chevron" /> : null}
          </button>
          {isOpen ? <StepDetail runId={runId} ownerId={ownerId} step={step} /> : null}
        </li>;
      })}
    </ol> : null}
  </div>;
}
