import { APP_TOOLS_AUDIENCE, verifyJwt } from '@parallelflow/runtime-client';

// ToolToken verification (RIC ToolToken, minted by @parallelflow/runtime-client mintToolToken). The token is
// the authorisation for every App Tools call (ADR-035): it names one session, one org (nil = Private),
// at most one project, and the agent principal. A token is a secret: never logged.

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARENA_KEY = /^org\/([0-9a-f-]{36})\/project\/([0-9a-f-]{36})\/arena$/;
const PRIVATE_KEY = /^org\/([0-9a-f-]{36})\/user\/([0-9a-f-]{36})\/private\/([0-9a-f-]{36})$/;

export interface ToolPrincipal {
  sessionKey: string;
  /** NIL_UUID for a Private session (ADR-034). */
  orgId: string;
  /** The arena project, or the project a private session is bound to; null when unbound. */
  projectId: string | null;
  agentId: string;
  kind: 'central' | 'personal';
  /** The user a personal agent acts for; null for the central agent. */
  onBehalfOf: string | null;
  scopes: ReadonlySet<string>;
  /** True for a Private session (org is the nil uuid). */
  isPrivate: boolean;
  /** The private chat (from the session key) for a personal agent; null for the central agent. */
  privateSessionId: string | null;
}

export class ToolTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid tool token: ${reason}`);
    this.name = 'ToolTokenError';
  }
}

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Verifies signature, audience, expiry and the claims' shape and consistency. Throws ToolTokenError. */
export function verifyToolToken(
  token: string,
  key: string,
  nowS = Math.floor(Date.now() / 1000),
): ToolPrincipal {
  let claims: Record<string, unknown>;
  try {
    claims = verifyJwt(token, key, APP_TOOLS_AUDIENCE, nowS);
  } catch (err) {
    throw new ToolTokenError(err instanceof Error ? err.message : 'unverifiable');
  }
  const sessionKey = claims['session_key'];
  const orgId = claims['org_id'];
  const projectId = claims['project_id'] ?? null;
  const principal = claims['principal'] as Record<string, unknown> | undefined;
  const scopes = claims['scopes'];
  if (typeof sessionKey !== 'string') throw new ToolTokenError('session_key');
  if (!isUuid(orgId)) throw new ToolTokenError('org_id');
  if (projectId !== null && !isUuid(projectId)) throw new ToolTokenError('project_id');
  if (!principal || principal['type'] !== 'agent' || !isUuid(principal['id'])) {
    throw new ToolTokenError('principal');
  }
  const kind = principal['kind'];
  if (kind !== 'central' && kind !== 'personal') throw new ToolTokenError('principal.kind');
  const onBehalfOf = principal['on_behalf_of'] ?? null;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    throw new ToolTokenError('scopes');
  }
  const isPrivate = orgId === NIL_UUID;
  let privateSessionId: string | null = null;

  if (kind === 'central') {
    // The central agent belongs to one arena: a real org, a project, the arena session key.
    const match = ARENA_KEY.exec(sessionKey);
    if (isPrivate || !projectId || !match || match[1] !== orgId || match[2] !== projectId) {
      throw new ToolTokenError('central scope');
    }
    if (onBehalfOf !== null) throw new ToolTokenError('central on_behalf_of');
  } else {
    // A personal agent acts for one user, in that user's private session.
    if (!isUuid(onBehalfOf) || onBehalfOf === NIL_UUID) throw new ToolTokenError('on_behalf_of');
    const match = PRIVATE_KEY.exec(sessionKey);
    if (!match || match[2] !== onBehalfOf) throw new ToolTokenError('personal scope');
    privateSessionId = match[3] ?? null;
    // Unbound: Private (nil org, no project). Bound: the bound project's org (write-once bind).
    if (isPrivate ? projectId !== null : !projectId) throw new ToolTokenError('personal binding');
  }

  return {
    sessionKey,
    orgId,
    projectId,
    agentId: principal['id'] as string,
    kind,
    onBehalfOf: kind === 'personal' ? (onBehalfOf as string) : null,
    scopes: new Set(scopes as string[]),
    isPrivate,
    privateSessionId,
  };
}
