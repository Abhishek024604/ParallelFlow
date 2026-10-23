import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ToolToken } from './types.js';

// HS256 JWTs for the runtime boundary (RIC v0.2): the short-lived service JWT on every call to the
// runtime (aud=parallelflow-runtime), and the session-scoped ToolToken the runtime presents to App Tools.
// Tokens are secrets: nothing here logs them.

export const RUNTIME_AUDIENCE = 'parallelflow-runtime';
export const APP_TOOLS_AUDIENCE = 'parallelflow-app-tools';
export const APP_ISSUER = 'parallelflow-app';
export const SERVICE_TOKEN_TTL_S = 60;
export const TOOL_TOKEN_MAX_TTL_S = 60 * 60;

export type JwtClaims = Record<string, unknown>;

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function hmac(key: string, input: string): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

function requireKey(key: string, name: string): void {
  if (key.length < 32) throw new Error(`${name} must be at least 32 characters`);
}

export function signJwt(claims: JwtClaims, key: string): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64(JSON.stringify(claims));
  return `${header}.${payload}.${b64(hmac(key, `${header}.${payload}`))}`;
}

/** Verifies signature, `aud` and `exp`. Returns the claims or throws. */
export function verifyJwt(
  token: string,
  key: string,
  audience: string,
  nowS = Math.floor(Date.now() / 1000),
): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [header, payload, signature] = parts as [string, string, string];
  const expected = hmac(key, `${header}.${payload}`);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('Bad signature');
  }
  const head = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: string };
  if (head.alg !== 'HS256') throw new Error('Unexpected alg');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtClaims;
  if (claims['aud'] !== audience) throw new Error('Wrong audience');
  if (typeof claims['exp'] !== 'number' || claims['exp'] <= nowS) throw new Error('Expired');
  return claims;
}

/** Service JWT for one call to the runtime (aud=parallelflow-runtime, 60 s). */
export function serviceToken(key: string, nowMs = Date.now()): string {
  requireKey(key, 'RUNTIME_JWT_KEY');
  const iat = Math.floor(nowMs / 1000);
  return signJwt(
    {
      iss: APP_ISSUER,
      aud: RUNTIME_AUDIENCE,
      sub: 'parallelflow-api',
      iat,
      exp: iat + SERVICE_TOKEN_TTL_S,
      jti: randomUUID(),
    },
    key,
  );
}

export interface ToolTokenInput {
  sessionKey: string;
  orgId: string;
  projectId: string | null;
  principal: { type: 'agent'; id: string; kind: 'central' | 'personal'; on_behalf_of?: string };
  scopes: readonly string[];
  /** Capped at 60 min (contract). Default 60 min. */
  ttlS?: number;
}

/** A session-scoped ToolToken (RIC ToolToken: claims session_key, org_id, project_id, principal, scopes, exp ≤ 60 min). */
export function mintToolToken(
  input: ToolTokenInput,
  key: string,
  mcpUrl: string,
  nowMs = Date.now(),
): ToolToken {
  requireKey(key, 'TOOL_TOKEN_KEY');
  const iat = Math.floor(nowMs / 1000);
  const ttl = Math.min(Math.max(1, input.ttlS ?? TOOL_TOKEN_MAX_TTL_S), TOOL_TOKEN_MAX_TTL_S);
  const exp = iat + ttl;
  const token = signJwt(
    {
      iss: APP_ISSUER,
      aud: APP_TOOLS_AUDIENCE,
      session_key: input.sessionKey,
      org_id: input.orgId,
      project_id: input.projectId,
      principal: input.principal,
      scopes: [...input.scopes],
      iat,
      exp,
      jti: randomUUID(),
    },
    key,
  );
  return { token, expires_at: new Date(exp * 1000).toISOString(), mcp_url: mcpUrl };
}
