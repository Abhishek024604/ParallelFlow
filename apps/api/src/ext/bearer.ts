import { type Database, enterUserScope } from '@saras/db';
import { sql } from 'kysely';
import { sha256Hex } from './device.js';

// Bearer tokens of the VS Code extension (ADR-037). The token's SHA-256 is looked up in credential
// scope (only that token's row is visible); the owner's account is then checked in their user scope,
// in the same transaction. Positive results are cached briefly (like AccountCheck), so a revoke or a
// deactivation takes effect within BEARER_CACHE_TTL_MS on this instance. last_used_at is written at
// most once a minute per token. Tokens are never logged.

export const BEARER_CACHE_TTL_MS = 30_000;
const TOUCH_EVERY_MS = 60_000;
const CACHE_MAX = 10_000;

export class BearerTokens {
  private readonly verified = new Map<string, { userId: string; until: number }>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The token owner's user id, or null (unknown, revoked, expired, account deactivated). */
  async verify(token: string): Promise<string | null> {
    const hash = sha256Hex(token);
    const now = this.clock();
    const hit = this.verified.get(hash);
    if (hit && hit.until > now) {
      this.touch(hash, now);
      return hit.userId;
    }
    this.verified.delete(hash);

    const userId = await this.db.withCredential({ credential: hash }, async (tx) => {
      const row = await tx
        .selectFrom('ext_access_tokens')
        .select(['user_id'])
        .where('token_hash', '=', hash)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      if (!row) return null;
      await enterUserScope(tx, { userId: row.user_id });
      const user = await tx
        .selectFrom('users')
        .select(['deactivated_at'])
        .where('id', '=', row.user_id)
        .executeTakeFirst();
      return user && !user.deactivated_at ? row.user_id : null;
    });
    if (!userId) return null;
    if (this.verified.size >= CACHE_MAX) this.verified.clear();
    this.verified.set(hash, { userId, until: now + BEARER_CACHE_TTL_MS });
    this.touch(hash, now);
    return userId;
  }

  /** Forgets a token at once on this instance (after a revoke). */
  forget(): void {
    this.verified.clear();
  }

  private touch(hash: string, now: number): void {
    const last = this.touched.get(hash) ?? 0;
    if (now - last < TOUCH_EVERY_MS) return;
    if (this.touched.size >= CACHE_MAX) this.touched.clear();
    this.touched.set(hash, now);
    // Not awaited: a failed touch never fails the request.
    void this.db
      .withCredential({ credential: hash }, (tx) =>
        tx
          .updateTable('ext_access_tokens')
          .set({ last_used_at: sql<Date>`now()` })
          .where('token_hash', '=', hash)
          .where((eb) =>
            eb.or([
              eb('last_used_at', 'is', null),
              eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
            ]),
          )
          .execute(),
      )
      .catch(() => undefined);
  }
}
