import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IdempotencyKeySchema } from '@saras/contracts';
import type { Tx } from '@saras/db';
import { sql } from 'kysely';
import { ApiError, validationFailed } from './errors.js';
import { CLOCK, type Clock } from './tokens.js';

// Idempotency-Key (doc 07 §7.1): required on creating and state-transition POSTs, 24 h replay.
//
// Everything runs in the handler's own transaction, so the stored response commits or rolls back
// together with the domain writes:
//   1. pg_try_advisory_xact_lock(user, key): taken → 409 CONFLICT (first request still running);
//   2. an unexpired record for (user, key): same request → replay it; different → 409 REUSED;
//   3. otherwise run the handler and store its 2xx response.
// Errors roll the transaction back, so nothing is stored and a retry runs again. idempotency_keys is
// owner-only under RLS (migration 0004).

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** Response headers worth replaying. Everything else is recomputed per request. */
export const REPLAYED_RESPONSE_HEADERS = ['location', 'etag'] as const;

/** JSON with object keys sorted at every level, so `{a,b}` and `{b,a}` hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Fingerprint of what the client asked for. The body itself is never stored. */
export function requestHash(request: {
  method: string;
  path: string;
  query: unknown;
  body: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        method: request.method.toUpperCase(),
        path: request.path,
        query: request.query ?? {},
        body: request.body ?? null,
      }),
    )
    .digest('hex');
}

export function parseIdempotencyKey(header: string | string[] | undefined): string {
  if (header === undefined) {
    throw validationFailed(
      [{ field: IDEMPOTENCY_HEADER, message: 'Required' }],
      'This request needs an Idempotency-Key header.',
    );
  }
  const result = IdempotencyKeySchema.safeParse(Array.isArray(header) ? undefined : header);
  if (!result.success) {
    throw validationFailed(
      [{ field: IDEMPOTENCY_HEADER, message: '1–128 printable ASCII characters, no spaces' }],
      'The Idempotency-Key header is invalid.',
    );
  }
  return result.data;
}

export interface IdempotentRequest {
  userId: string;
  key: string;
  method: string;
  path: string;
  hash: string;
}

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Returns the stored response to replay, or undefined when the handler should run. */
  async begin(tx: Tx, req: IdempotentRequest): Promise<StoredResponse | undefined> {
    const { rows: lock } = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`idem:${req.userId}:${req.key}`}, 0)) AS locked`.execute(
      tx,
    );
    if (!lock[0]?.locked) {
      throw new ApiError(409, 'CONFLICT', {
        detail: 'A request with this Idempotency-Key is still in progress. Retry shortly.',
      });
    }

    const prior = await tx
      .selectFrom('idempotency_keys')
      .select([
        'method',
        'path',
        'request_hash',
        'response_status',
        'response_headers',
        'response_body',
      ])
      .where('user_id', '=', req.userId)
      .where('key', '=', req.key)
      .where('expires_at', '>', new Date(this.clock()))
      .executeTakeFirst();
    if (!prior) return undefined;

    if (prior.method !== req.method || prior.path !== req.path || prior.request_hash !== req.hash) {
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', {
        detail: 'This Idempotency-Key was already used for a different request.',
      });
    }
    return {
      status: prior.response_status,
      headers: (prior.response_headers ?? {}) as Record<string, string>,
      body: prior.response_body === null ? undefined : (JSON.parse(prior.response_body) as unknown),
    };
  }

  /** Stores a completed 2xx response in the same transaction as the handler's writes. */
  async complete(tx: Tx, req: IdempotentRequest, response: StoredResponse): Promise<void> {
    if (response.status < 200 || response.status > 299) return;
    const now = this.clock();
    // Opportunistic cleanup of this user's expired keys (index on user_id, expires_at). A global
    // sweep for users who stop calling the API is SLICE_DEBT (jobs story).
    await tx
      .deleteFrom('idempotency_keys')
      .where('user_id', '=', req.userId)
      .where('expires_at', '<=', new Date(now))
      .execute();
    const row = {
      user_id: req.userId,
      key: req.key,
      method: req.method,
      path: req.path,
      request_hash: req.hash,
      response_status: response.status,
      response_headers: JSON.stringify(response.headers),
      // Exactly what Express sends (JSON.stringify), so the replay is byte-identical.
      response_body: response.body === undefined ? null : JSON.stringify(response.body),
      created_at: new Date(now),
      expires_at: new Date(now + IDEMPOTENCY_TTL_MS),
    };
    await tx
      .insertInto('idempotency_keys')
      .values(row)
      .onConflict((oc) => oc.columns(['user_id', 'key']).doUpdateSet(row))
      .execute();
  }
}
