import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@saras/db';
import { sql } from 'kysely';
import type { Response } from 'express';
import { ApiError } from './errors.js';
import { CLOCK, type Clock, RATE_LIMITS } from './tokens.js';

// Rate limits (doc 07 §7.1): fixed one-minute windows per user and per org, counted in Postgres
// (rate_limit_counters, migration 0004) until Redis lands (SLICE_DEBT.md). Each count is its own
// short transaction, committed before the handler runs, so failed requests still count and no row
// lock is held while a handler works.

export type Bucket = 'user' | 'org';

export interface RateLimitOptions {
  userPerWindow: number;
  orgPerWindow: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitOptions = {
  userPerWindow: 600,
  orgPerWindow: 6000,
  windowMs: 60_000,
};

export interface RateLimitResult {
  limit: number;
  remaining: number;
  /** Whole seconds until the window resets (≥ 1). */
  resetSeconds: number;
  exceeded: boolean;
}

export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function evaluate(
  hits: number,
  limit: number,
  nowMs: number,
  windowMs: number,
): RateLimitResult {
  const end = windowStart(nowMs, windowMs) + windowMs;
  return {
    limit,
    remaining: Math.max(0, limit - hits),
    resetSeconds: Math.max(1, Math.ceil((end - nowMs) / 1000)),
    exceeded: hits > limit,
  };
}

/** The limit to report: an exceeded one first, else the one with the fewest requests left. */
export function tightest(results: readonly RateLimitResult[]): RateLimitResult | undefined {
  return [...results].sort(
    (a, b) =>
      Number(b.exceeded) - Number(a.exceeded) ||
      a.remaining - b.remaining ||
      b.resetSeconds - a.resetSeconds,
  )[0];
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(result.resetSeconds),
  };
}

@Injectable()
export class RateLimiter {
  constructor(
    @Inject(RATE_LIMITS) private readonly options: RateLimitOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one request. `tx` must be in a context whose RLS admits the bucket: user scope or tenant
   * for `user`, the org's tenant context (verified membership) for `org`.
   */
  async hit(tx: Tx, bucket: Bucket, subjectId: string): Promise<RateLimitResult> {
    const now = this.clock();
    const { windowMs } = this.options;
    const start = new Date(windowStart(now, windowMs));
    const { rows } = await sql<{ hits: number }>`
      INSERT INTO rate_limit_counters (bucket, subject_id, window_start, hits)
      VALUES (${bucket}, ${subjectId}, ${start}, 1)
      ON CONFLICT (bucket, subject_id, window_start)
      DO UPDATE SET hits = rate_limit_counters.hits + 1
      RETURNING hits`.execute(tx);
    const hits = rows[0]?.hits;
    if (hits === undefined) throw new Error('Rate-limit upsert returned no row');
    if (hits === 1) {
      // First request of a new window: drop this subject's old windows. Keeps the table at about one
      // row per active user and org without a sweeper job.
      await sql`DELETE FROM rate_limit_counters
                WHERE bucket = ${bucket} AND subject_id = ${subjectId} AND window_start < ${start}`.execute(
        tx,
      );
    }
    const limit = bucket === 'user' ? this.options.userPerWindow : this.options.orgPerWindow;
    return evaluate(hits, limit, now, windowMs);
  }

  /** Sets RateLimit-* for the tightest limit; throws 429 RATE_LIMITED if any is exceeded. */
  apply(res: Response, results: readonly RateLimitResult[]): void {
    const result = tightest(results);
    if (!result) return;
    const headers = rateLimitHeaders(result);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (result.exceeded) {
      throw new ApiError(429, 'RATE_LIMITED', {
        detail: `Too many requests. Try again in ${result.resetSeconds} s.`,
        headers: { ...headers, 'Retry-After': String(result.resetSeconds) },
      });
    }
  }
}
