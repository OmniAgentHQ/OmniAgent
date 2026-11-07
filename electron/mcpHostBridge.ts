import http from 'node:http';
import readline from 'node:readline';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

const endpoint = process.env.OMNIAGENT_TOOL_URL ?? '';
const token = process.env.OMNIAGENT_TOOL_TOKEN ?? '';
const sessionId = process.env.OMNIAGENT_TOOL_SESSION ?? '';

function post(pathname: string, body: unknown, timeoutMs: number) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(pathname, endpoint);
    } catch {
      reject(new Error('The OmniAgent tool host address is not usable.'));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
          authorization: `Bearer ${token}`,
          'x-omniagent-session': sessionId
        },
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(raw || '{}') as Record<string, unknown>);
          } catch {
            reject(new Error(raw.slice(0, 400) || 'The OmniAgent tool host returned an unreadable reply.'));
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('The OmniAgent tool host did not answer in time.')));
    request.on('error', (error: Error) => reject(error));
    request.end(payload);
  });
}

function send(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcRequest['id'], result: unknown) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: JsonRpcRequest['id'], code: number, message: string) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(request: JsonRpcRequest) {
  const { id, method } = request;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'omniagent-host', version: '1.0.0' }
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    const listed = await post('/tools', {}, 20_000);
    reply(id, { tools: Array.isArray(listed.tools) ? listed.tools : [] });
    return;
  }
  if (method === 'tools/call') {
    const name = String(request.params?.name ?? '');
    const called = await post('/call', { name, arguments: request.params?.arguments ?? {} }, 0);
    if (called.error) {
      reply(id, {
        content: [{ type: 'text', text: String(called.error) }],
        isError: true
      });
      return;
    }
    reply(id, {
      content: [{ type: 'text', text: typeof called.result === 'string' ? called.result : JSON.stringify(called.result ?? {}) }]
    });
    return;
  }
  fail(id, -32601, `Unsupported method: ${method}`);
}

if (!endpoint || !token) {
  process.stderr.write('The OmniAgent tool host was not configured for this session.\n');
  process.exit(1);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    return;
  }
  void handle(request).catch((error: unknown) => {
    fail(request.id, -32000, error instanceof Error ? error.message : String(error));
  });
});
lines.on('close', () => process.exit(0));
