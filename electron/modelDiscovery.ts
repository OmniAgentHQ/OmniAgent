import type { AIModelView } from './contracts';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function discoverCodexModels(request: Request): Promise<AIModelView[]> {
  const models = new Map<string, AIModelView>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await request('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }) as {
      data?: Array<Record<string, unknown>>;
      models?: Array<Record<string, unknown>>;
      nextCursor?: string | null;
    };
    const rows = result.data ?? result.models;
    if (!Array.isArray(rows)) throw new Error('Codex returned an invalid model catalogue.');
    for (const row of rows) {
      const id = String(row.model ?? row.id ?? row.slug ?? '').trim();
      if (!id || row.hidden === true) continue;
      if (models.has(id)) continue;
      const efforts = Array.isArray(row.supportedReasoningEfforts)
        ? row.supportedReasoningEfforts.map(effort => typeof effort === 'string'
          ? effort : String((effort as Record<string, unknown>)?.reasoningEffort ?? '')).filter(Boolean)
        : [];
      models.set(id, {
        id, label: String(row.displayName ?? row.name ?? id),
        description: String(row.description ?? ''), reasoningEfforts: efforts
      });
    }
    cursor = result.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a model catalogue page.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (!models.size) throw new Error('Codex returned no available models.');
  return [...models.values()];
}

export const MODEL_REFRESH_ERROR = 'Could not refresh models. Your previous model list has been kept. Try Refresh again, or update the provider runtime.';

function parseClaudeModels(rows: unknown): AIModelView[] {
  if (!Array.isArray(rows)) throw new Error('Claude did not return a model catalogue.');
  const models = rows.map((row: Record<string, unknown>) => ({
    id: String(row.value ?? row.id ?? '').trim(),
    label: String(row.displayName ?? row.display_name ?? row.value ?? row.id ?? ''),
    description: String(row.description ?? ''),
    reasoningEfforts: Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.map(String) : []
  })).filter(model => model.id);
  if (!models.length) throw new Error('Claude returned no available models.');
  return models;
}

export async function discoverClaudeModels(executable: string, home: string, onSpawn?: (child: ChildProcess) => void): Promise<AIModelView[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], {
      cwd: home, env: { ...process.env, CLAUDE_CONFIG_DIR: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    onSpawn?.(child);
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error?: Error, models?: AIModelView[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); lines.close(); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(models!);
    };
    const timer = setTimeout(() => finish(new Error('Claude model discovery timed out.')), 30_000);
    child.stderr.resume();
    child.once('error', () => finish(new Error('Claude model discovery could not start.')));
    child.stdin.on('error', () => finish(new Error('Claude closed the discovery connection.')));
    child.once('exit', () => finish(new Error('Claude stopped before returning models.')));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== 'control_response' || message.response?.request_id !== 'omniagent-models') return;
      try {
        if (message.response.subtype === 'error') throw new Error('Claude rejected model discovery.');
        finish(undefined, parseClaudeModels(message.response.response?.models));
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Claude model response.')); }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'omniagent-models', request: { subtype: 'initialize', hooks: {} } }) + '\n');
  });
}
