import type { Tx } from '@saras/db';
import type { Request } from 'express';

/** Who is calling, once the session is verified. */
export interface Principal {
  userId: string;
  /** Identity-provider session id (WorkOS `sid`) of a cookie session. Used by logout; never logged. */
  sessionId?: string;
  /** Set when the caller used an extension bearer token (ADR-037) instead of the web session. */
  via?: 'bearer';
}

/** What the pipeline knows about one request. Kept off the Request object's public surface. */
export interface RequestState {
  requestId: string;
  startedAt: number;
  principal?: Principal;
  /** Org of the verified membership on scoped routes. */
  orgId?: string;
  /** The handler's transaction, only while the handler runs. */
  tx?: Tx;
  /** Run (not awaited) once the handler's transaction has committed. Hooks must not throw. */
  afterCommit?: (() => void)[];
  /** Read-cache tags (read-cache.ts) a mutation changed besides the caller's own and the route's. */
  touched?: string[];
  /** Problem code of an error response, for the access log. */
  code?: string;
  /** Class name / SQLSTATE of an unexpected error, for the access log. */
  errName?: string;
  errCode?: string;
}

const states = new WeakMap<Request, RequestState>();

export function initState(req: Request, requestId: string, startedAt: number): RequestState {
  const state: RequestState = { requestId, startedAt };
  states.set(req, state);
  return state;
}

export function getState(req: Request): RequestState {
  const state = states.get(req);
  if (!state) throw new Error('Request state missing: the request-id middleware did not run');
  return state;
}

export function findState(req: Request): RequestState | undefined {
  return states.get(req);
}

/** What a handler gets besides its transaction. */
export interface CallerContext {
  requestId: string;
  userId: string;
  /** Set on @ProjectScoped / @OrgScoped routes. */
  orgId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL = '00000000-0000-0000-0000-000000000000';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value) && value !== NIL;
}
