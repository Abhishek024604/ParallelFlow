import { serviceToken } from './jwt.js';
import { parseSse } from './sse.js';
import {
  type CreateSessionRequest,
  type CreateTurnRequest,
  type RicError,
  type RuntimeEvent,
  type Session,
  TERMINAL_EVENTS,
  type Turn,
} from './types.js';

// Typed client for the Runtime Integration Contract v0.2. Every call carries a fresh 60 s service
// JWT. Request and response bodies (prompts, agent text) and tokens are never logged or put into
// error messages: errors carry the contract's error code and HTTP status only.

export interface StreamOptions {
  /** Resume after this event id (sent as Last-Event-ID). */
  lastEventId?: string;
  signal?: AbortSignal;
}

/** What the app needs from a runtime. Tests use a fake. */
export interface RuntimeClient {
  /** Idempotent on session_key (201 created, 200 existing). */
  createSession(request: CreateSessionRequest): Promise<Session>;
  /** Idempotent on turn_id (202 accepted, 200 duplicate). */
  createTurn(sessionId: string, request: CreateTurnRequest): Promise<Turn>;
  /** The turn's events until a terminal one; reconnects with Last-Event-ID on a dropped stream. */
  streamTurnEvents(
    sessionId: string,
    turnId: string,
    options?: StreamOptions,
  ): AsyncIterable<RuntimeEvent>;
  cancelTurn(sessionId: string, turnId: string): Promise<void>;
}

/** A failed runtime call. `code` is the contract's error code, or NETWORK / BAD_RESPONSE. */
export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(`Runtime call failed: ${code} (${status})`);
    this.name = 'RuntimeError';
  }
}

export interface HttpRuntimeClientOptions {
  /** Base URL including the version path, e.g. http://localhost:7070/v1. */
  baseUrl: string;
  /** RUNTIME_JWT_KEY (HS256, ≥ 32 chars). */
  jwtKey: string;
  fetch?: typeof fetch;
  clock?: () => number;
  /** Reconnects of a dropped event stream before giving up (reset whenever an event arrives). */
  maxReconnects?: number;
  /** Delay before reconnect n is n × this. */
  reconnectDelayMs?: number;
  /** Per-call timeout for non-streaming calls. */
  timeoutMs?: number;
}

const seg = encodeURIComponent;

export class HttpRuntimeClient implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly options: HttpRuntimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    // Fail at startup, not on the first call.
    serviceToken(options.jwtKey, this.clock());
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${serviceToken(this.options.jwtKey, this.clock())}`,
      accept: 'application/json',
      ...extra,
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new RuntimeError('NETWORK', 0, true);
    }
    if (!res.ok) throw await errorOf(res);
    if (res.status === 202 || res.status === 204) {
      const text = await res.text().catch(() => '');
      return text ? (JSON.parse(text) as T) : undefined;
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new RuntimeError('BAD_RESPONSE', res.status);
    }
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    const session = await this.call<Session>('POST', '/sessions', request);
    if (!session?.session_id) throw new RuntimeError('BAD_RESPONSE', 200);
    return session;
  }

  async createTurn(sessionId: string, request: CreateTurnRequest): Promise<Turn> {
    const turn = await this.call<Turn>('POST', `/sessions/${seg(sessionId)}/turns`, request);
    return turn ?? { turn_id: request.turn_id, status: 'queued' };
  }

  async cancelTurn(sessionId: string, turnId: string): Promise<void> {
    await this.call('POST', `/sessions/${seg(sessionId)}/turns/${seg(turnId)}:cancel`);
  }

  async *streamTurnEvents(
    sessionId: string,
    turnId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<RuntimeEvent> {
    const url = `${this.baseUrl}/sessions/${seg(sessionId)}/turns/${seg(turnId)}/events`;
    const maxReconnects = this.options.maxReconnects ?? 5;
    const delayMs = this.options.reconnectDelayMs ?? 500;
    let lastEventId = options.lastEventId;
    let attempt = 0;

    for (;;) {
      if (options.signal?.aborted) return;
      let res: Response | undefined;
      try {
        res = await this.fetchFn(url, {
          headers: this.headers({
            accept: 'text/event-stream',
            ...(lastEventId !== undefined && { 'last-event-id': lastEventId }),
          }),
          ...(options.signal && { signal: options.signal }),
        });
      } catch {
        res = undefined;
      }
      if (res && !res.ok) throw await errorOf(res);

      if (res?.body) {
        try {
          for await (const frame of parseSse(res.body)) {
            if (!frame.data) continue;
            let event: RuntimeEvent;
            try {
              event = JSON.parse(frame.data) as RuntimeEvent;
            } catch {
              continue;
            }
            lastEventId = frame.id ?? String(event.seq);
            attempt = 0;
            yield event;
            if (TERMINAL_EVENTS.has(event.type)) return;
          }
        } catch {
          // Dropped mid-stream: reconnect below.
        }
      }
      if (options.signal?.aborted) return;
      attempt += 1;
      if (attempt > maxReconnects) throw new RuntimeError('NETWORK', 0, true);
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function errorOf(res: Response): Promise<RuntimeError> {
  const body = (await res.json().catch(() => null)) as Partial<RicError> | null;
  return new RuntimeError(
    typeof body?.code === 'string' ? body.code : `HTTP_${res.status}`,
    res.status,
    body?.retryable ?? res.status >= 500,
    body?.retry_after_ms,
  );
}
