import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type TeamToolKit = {
  definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  annotate?: () => string | undefined;
};

export type HostToolSession = {
  cwd: string;
  teamTools?: TeamToolKit;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  computer?: unknown;
  userRequest?: string;
  allowScreenshots?: boolean;
  allowBrowserControl?: boolean;
};

export type HostToolRunner = {
  catalogue(session?: HostToolSession): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(session: HostToolSession, name: string, args: unknown): Promise<unknown>;
};

function readBody(request: http.IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) {
        request.destroy();
        reject(new Error('The tool request was too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export class HostToolServer {
  private server?: http.Server;
  private port = 0;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private readonly sessions = new Map<string, HostToolSession>();
  private readonly ambient = new Map<string, string>();

  constructor(private readonly runner: HostToolRunner) {}

  async start() {
    if (this.server) return { port: this.port, token: this.token };
    const server = http.createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return { port: this.port, token: this.token };
  }

  stop() {
    this.sessions.clear();
    this.ambient.clear();
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  openSession(session: HostToolSession) {
    const sessionId = crypto.randomBytes(16).toString('hex');
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  closeSession(sessionId: string) {
    this.sessions.delete(sessionId);
    this.ambient.delete(sessionId);
  }

  openAmbientSession(session: HostToolSession, scope: string) {
    const sessionId = this.openSession(session);
    this.ambient.set(sessionId, scope);
    return sessionId;
  }

  private ambientIn(scope: string) {
    return [...this.ambient.entries()].filter(([, owner]) => owner === scope).map(([sessionId]) => sessionId);
  }

  private resolveAmbient(scope: string) {
    const matching = this.ambientIn(scope);
    if (matching.length !== 1) return undefined;
    return this.sessions.get(matching[0]);
  }

  address() {
    return this.port ? `http://127.0.0.1:${this.port}` : '';
  }

  secret() {
    return this.token;
  }

  private send(response: http.ServerResponse, status: number, body: unknown) {
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.byteLength) });
    response.end(payload);
  }

  private async route(request: http.IncomingMessage, response: http.ServerResponse) {
    const authorized = request.headers.authorization === `Bearer ${this.token}`;
    if (!authorized) {
      this.send(response, 401, { error: 'This tool host rejected an unauthorized caller.' });
      return;
    }
    const sessionId = String(request.headers['x-omniagent-session'] ?? '');
    const ambientScope = sessionId.startsWith('ambient:') ? sessionId.slice('ambient:'.length) : '';
    const session = ambientScope
      ? this.resolveAmbient(ambientScope)
      : this.sessions.get(sessionId);
    if (!session) {
      this.send(response, 409, {
        error: ambientScope && this.ambientIn(ambientScope).length > 1
          ? 'More than one worker is running on this account right now, so OmniAgent cannot tell which one this tool call belongs to. Wait for the other worker to finish and try again.'
          : 'That worker session has already finished, so its tools are closed.'
      });
      return;
    }
    try {
      if (request.url === '/tools') {
        this.send(response, 200, { tools: this.runner.catalogue(session) });
        return;
      }
      if (request.url === '/call') {
        const body = JSON.parse((await readBody(request)) || '{}') as { name?: string; arguments?: unknown };
        const name = String(body.name ?? '');
        if (!name) {
          this.send(response, 200, { error: 'The tool call did not name a tool.' });
          return;
        }
        const result = await this.runner.call(session, name, body.arguments ?? {});
        this.send(response, 200, { result });
        return;
      }
      this.send(response, 404, { error: 'Unknown tool host route.' });
    } catch (error) {
      this.send(response, 200, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
