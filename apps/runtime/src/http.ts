import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@parallelflow/observability';
import { RUNTIME_AUDIENCE, verifyJwt } from '@parallelflow/runtime-client';
import { parseLastEventId, sseFrame } from './event-log.js';
import { RicHttpError, type RuntimeService } from './service.js';

// RIC v0.2 over HTTP (base path /v1). Every route except GET /v1/health needs the app's service JWT
// (HS256, RUNTIME_JWT_KEY, aud=parallelflow-runtime, unexpired); errors use the RIC Error schema. Request
// bodies (prompts, tokens) are never logged.

export interface RuntimeHttpOptions {
  service: RuntimeService;
  jwtKey: string;
  logger: Logger;
  health: () => { status: 'ok' | 'degraded'; checks: Record<string, string> };
  capabilities: () => unknown;
  clock?: () => number;
  /** SSE heartbeat interval. */
  heartbeatMs?: number;
}

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: RicHttpError): void {
  send(res, err.status, err.body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RicHttpError(413, 'INVALID_INPUT', 'Body too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RicHttpError(400, 'INVALID_INPUT', 'Body is not JSON');
  }
}

/** Verifies `Authorization: Bearer <service JWT>`. */
export function authorised(req: IncomingMessage, key: string, nowS: number): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match?.[1]) return false;
  try {
    verifyJwt(match[1], key, RUNTIME_AUDIENCE, nowS);
    return true;
  } catch {
    return false;
  }
}

type Route =
  | { op: 'health' | 'capabilities' | 'createSession' }
  | { op: 'session' | 'bind' | 'token' | 'compact' | 'turns'; sessionId: string }
  | { op: 'turn' | 'events' | 'cancel'; sessionId: string; turnId: string }
  | { op: 'approval'; sessionId: string; approvalId: string };

/** Matches /v1/... paths (ids are path segments; "{id}:bind" style actions per the contract). */
export function route(pathname: string): Route | null {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeURIComponent);
  if (parts[0] !== 'v1') return null;
  const [, a, b, c, d, e] = parts;
  if (a === 'health' && parts.length === 2) return { op: 'health' };
  if (a === 'capabilities' && parts.length === 2) return { op: 'capabilities' };
  if (a !== 'sessions') return null;
  if (parts.length === 2) return { op: 'createSession' };
  if (!b) return null;
  if (parts.length === 3) {
    if (b.endsWith(':bind')) return { op: 'bind', sessionId: b.slice(0, -5) };
    if (b.endsWith(':compact')) return { op: 'compact', sessionId: b.slice(0, -8) };
    return { op: 'session', sessionId: b };
  }
  if (c === 'token' && parts.length === 4) return { op: 'token', sessionId: b };
  if (c === 'turns' && parts.length === 4) return { op: 'turns', sessionId: b };
  if (c === 'approvals' && d && parts.length === 5) {
    return { op: 'approval', sessionId: b, approvalId: d };
  }
  if (c === 'turns' && d) {
    if (parts.length === 5) {
      if (d.endsWith(':cancel')) return { op: 'cancel', sessionId: b, turnId: d.slice(0, -7) };
      return { op: 'turn', sessionId: b, turnId: d };
    }
    if (e === 'events' && parts.length === 6) return { op: 'events', sessionId: b, turnId: d };
  }
  return null;
}

const METHODS: Record<Route['op'], string> = {
  health: 'GET',
  capabilities: 'GET',
  createSession: 'POST',
  session: 'GET|DELETE',
  bind: 'POST',
  token: 'PUT',
  compact: 'POST',
  turns: 'POST',
  turn: 'GET',
  events: 'GET',
  cancel: 'POST',
  approval: 'POST',
};

export function createRuntimeHandler(
  options: RuntimeHttpOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { service } = options;
  const clock = options.clock ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  function stream(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    turnId: string,
  ): void {
    const log = service.events(sessionId, turnId);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of log.since(parseLastEventId(req.headers['last-event-id']))) {
      res.write(sseFrame(event));
    }
    if (log.finished) {
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    const stop = log.subscribe((event) => {
      res.write(sseFrame(event));
      if (log.finished) {
        cleanup();
        res.end();
      }
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      stop();
    };
    req.on('close', cleanup);
  }

  return async (req, res) => {
    const started = clock();
    const url = new URL(req.url ?? '/', 'http://runtime');
    const r = route(url.pathname);
    try {
      if (!r) throw new RicHttpError(404, 'NOT_FOUND', 'No such route');
      if (!METHODS[r.op].split('|').includes(req.method ?? '')) {
        throw new RicHttpError(405, 'INVALID_INPUT', 'Method not allowed');
      }
      if (r.op === 'health') {
        const health = options.health();
        send(res, health.status === 'ok' ? 200 : 503, { ...health, runtime: 'tau' });
        return;
      }
      if (!authorised(req, options.jwtKey, Math.floor(clock() / 1000))) {
        throw new RicHttpError(401, 'UNAUTHENTICATED', 'A valid service token is required');
      }
      switch (r.op) {
        case 'capabilities':
          send(res, 200, options.capabilities());
          return;
        case 'createSession': {
          const { status, session } = service.createSession(await readJson(req));
          send(res, status, session);
          return;
        }
        case 'session':
          if (req.method === 'DELETE') {
            service.archiveSession(r.sessionId);
            send(res, 204);
          } else {
            send(res, 200, service.getSession(r.sessionId));
          }
          return;
        case 'bind':
          send(res, 200, service.bind(r.sessionId, await readJson(req)));
          return;
        case 'token':
          service.rotateToken(r.sessionId, await readJson(req));
          send(res, 204);
          return;
        case 'compact':
          service.compact(r.sessionId);
          send(res, 202);
          return;
        case 'turns': {
          const { status, turn } = service.createTurn(r.sessionId, await readJson(req));
          send(res, status, turn);
          return;
        }
        case 'turn':
          send(res, 200, service.getTurn(r.sessionId, r.turnId));
          return;
        case 'events':
          stream(req, res, r.sessionId, r.turnId);
          return;
        case 'cancel':
          service.cancelTurn(r.sessionId, r.turnId);
          send(res, 202);
          return;
        case 'approval':
          service.resolveApproval(r.sessionId, r.approvalId, await readJson(req));
          send(res, 204);
          return;
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof RicHttpError) {
        sendError(res, err);
      } else {
        options.logger.error({ op: r?.op }, 'runtime request failed');
        sendError(res, new RicHttpError(500, 'INTERNAL', 'Internal error', true));
      }
    } finally {
      if (r?.op !== 'events' && r?.op !== 'health') {
        options.logger.debug(
          { op: r?.op, status: res.statusCode, ms: clock() - started },
          'ric call',
        );
      }
    }
  };
}
