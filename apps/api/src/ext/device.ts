import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  type DeviceLookup,
  type DeviceTokenError,
  type DeviceTokenResponse,
  EXT_TOKEN_PREFIX,
  EXT_TOKEN_TTL_DAYS,
  type ExtToken,
} from '@parallelflow/contracts';
import { type Database, enterCredential, enterUserScope, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';

// Device sign-in for the VS Code extension (ADR-037, RFC 8628 style):
//   1. the extension asks for a code (public): a random device code (kept by the extension) and a
//      short user code (typed or opened by the person); only the device code's SHA-256 is stored
//   2. the person opens /device signed in and approves or denies the user code
//   3. the extension polls with the device code (public) until it gets its access token, once
// All reads and writes run in credential scope: a row is visible only by its hash or user code.
// Secrets are never logged or stored in the clear.

/** No vowels (no words), no 0/O or 1/I/L look-alikes. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const USER_CODE_LENGTH = 8;
/** A poll sooner than this after the previous one is told to slow down (interval minus slack). */
const MIN_POLL_GAP_MS = (DEVICE_POLL_INTERVAL_S - 1) * 1000;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

export function newAccessToken(): string {
  return `${EXT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function newUserCode(random: (max: number) => number = randomInt): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    code += USER_CODE_ALPHABET[random(USER_CODE_ALPHABET.length)];
  }
  return code;
}

/** XXXX-XXXX for display. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What the person typed → the stored form, or null when it cannot be a user code. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]+/g, '');
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** `Authorization: Bearer parallelflow_ext_…` → the token, or null (absent, another scheme, malformed). */
export function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  if (!token?.startsWith(EXT_TOKEN_PREFIX)) return null;
  const rest = token.slice(EXT_TOKEN_PREFIX.length);
  return /^[A-Za-z0-9_-]{32,64}$/.test(rest) ? token : null;
}

/** True when the request carries any Bearer credential (even a malformed one). */
export function hasBearer(header: string | string[] | undefined): boolean {
  return typeof header === 'string' && /^\s*Bearer\s/i.test(header);
}

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'used';

export interface DeviceState {
  status: DeviceStatus;
  expiresAt: Date;
  lastPolledAt: Date | null;
}

export type PollOutcome =
  { kind: 'error'; error: DeviceTokenError; markExpired?: boolean } | { kind: 'issue' };

/** The token endpoint's state machine (pure). `null` = no such device code. */
export function pollOutcome(row: DeviceState | null, now: Date): PollOutcome {
  if (!row || row.status === 'used') return { kind: 'error', error: 'invalid_grant' };
  if (row.status === 'expired') return { kind: 'error', error: 'expired_token' };
  if (row.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'error', error: 'expired_token', markExpired: row.status !== 'denied' };
  }
  if (row.status === 'denied') return { kind: 'error', error: 'access_denied' };
  if (row.status === 'approved') return { kind: 'issue' };
  if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < MIN_POLL_GAP_MS) {
    return { kind: 'error', error: 'slow_down' };
  }
  return { kind: 'error', error: 'authorization_pending' };
}

// ---------------------------------------------------------------- database steps

/** Step 1. Retries a user code that is already pending (rare). */
export async function createDeviceCode(
  db: Database,
  clientName: string,
): Promise<{ deviceCode: string; userCode: string }> {
  for (let attempt = 0; ; attempt += 1) {
    const deviceCode = newDeviceCode();
    const userCode = newUserCode();
    const hash = sha256Hex(deviceCode);
    try {
      await db.withCredential({ credential: hash }, (tx) =>
        tx
          .insertInto('ext_device_codes')
          .values({
            device_code_hash: hash,
            user_code: userCode,
            client_name: clientName,
            expires_at: sql<Date>`now() + make_interval(secs => ${DEVICE_CODE_TTL_S})`,
          })
          .execute(),
      );
      return { deviceCode, userCode };
    } catch (err) {
      const unique = (err as { code?: string }).code === '23505';
      if (!unique || attempt >= 3) throw err;
    }
  }
}

/** Step 2a: what the person is about to allow (pending, not expired), from their user scope tx. */
export async function lookupDevice(
  tx: Tx,
  userId: string,
  userCode: string,
): Promise<DeviceLookup | null> {
  await enterCredential(tx, { credential: userCode, userId });
  try {
    const row = await tx
      .selectFrom('ext_device_codes')
      .select(['client_name', 'expires_at'])
      .where('user_code', '=', userCode)
      .where('status', '=', 'pending')
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return row
      ? {
          user_code: formatUserCode(userCode),
          client_name: row.client_name,
          expires_at: new Date(row.expires_at).toISOString(),
        }
      : null;
  } finally {
    await enterUserScope(tx, { userId });
  }
}

/** Step 2b: approve or deny. False when the code is unknown, used or expired. */
export async function decideDevice(
  tx: Tx,
  userId: string,
  userCode: string,
  decision: 'approve' | 'deny',
): Promise<boolean> {
  await enterCredential(tx, { credential: userCode, userId });
  try {
    const result = await tx
      .updateTable('ext_device_codes')
      .set({ status: decision === 'approve' ? 'approved' : 'denied', user_id: userId })
      .where('user_code', '=', userCode)
      .where('status', '=', 'pending')
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  } finally {
    await enterUserScope(tx, { userId });
  }
}

export type TokenExchange =
  { ok: true; response: DeviceTokenResponse } | { ok: false; error: DeviceTokenError };

/** Step 3: one poll. Issues the access token once, in the same transaction that uses up the code. */
export async function exchangeDeviceCode(db: Database, deviceCode: string): Promise<TokenExchange> {
  const hash = sha256Hex(deviceCode);
  return db.withCredential({ credential: hash }, async (tx) => {
    const row = await tx
      .selectFrom('ext_device_codes')
      .select(['id', 'status', 'expires_at', 'last_polled_at', 'user_id', 'client_name'])
      .where('device_code_hash', '=', hash)
      .forUpdate()
      .executeTakeFirst();
    const now = new Date();
    const outcome = pollOutcome(
      row
        ? {
            status: row.status as DeviceStatus,
            expiresAt: new Date(row.expires_at),
            lastPolledAt: row.last_polled_at ? new Date(row.last_polled_at) : null,
          }
        : null,
      now,
    );
    if (!row) return { ok: false, error: 'invalid_grant' };
    if (outcome.kind === 'error') {
      await tx
        .updateTable('ext_device_codes')
        .set({
          last_polled_at: now,
          ...(outcome.markExpired && { status: 'expired' }),
        })
        .where('id', '=', row.id)
        .execute();
      return { ok: false, error: outcome.error };
    }
    const userId = row.user_id;
    if (!userId) return { ok: false, error: 'invalid_grant' };
    await tx
      .updateTable('ext_device_codes')
      .set({ status: 'used', last_polled_at: now })
      .where('id', '=', row.id)
      .execute();

    const token = newAccessToken();
    const tokenHash = sha256Hex(token);
    await enterCredential(tx, { credential: tokenHash, userId });
    const user = await tx
      .selectFrom('users')
      .select(['id', 'display_name', 'email', 'deactivated_at'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user || user.deactivated_at) return { ok: false, error: 'access_denied' };
    await tx
      .insertInto('ext_access_tokens')
      .values({
        user_id: userId,
        token_hash: tokenHash,
        name: row.client_name,
        expires_at: sql<Date>`now() + make_interval(days => ${EXT_TOKEN_TTL_DAYS})`,
      })
      .execute();
    return {
      ok: true,
      response: {
        access_token: token,
        token_type: 'Bearer',
        expires_in: EXT_TOKEN_TTL_DAYS * 86_400,
        user: { id: user.id, display_name: user.display_name, email: user.email },
      },
    };
  });
}

// ---------------------------------------------------------------- connected apps (user scope)

export async function listTokens(tx: Tx, userId: string): Promise<ExtToken[]> {
  const rows = await tx
    .selectFrom('ext_access_tokens')
    .select(['id', 'name', 'created_at', 'last_used_at', 'expires_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();
  const iso = (d: Date | string) => new Date(d).toISOString();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    created_at: iso(r.created_at),
    last_used_at: r.last_used_at ? iso(r.last_used_at) : null,
    expires_at: iso(r.expires_at),
  }));
}

export async function revokeToken(tx: Tx, userId: string, id: string): Promise<boolean> {
  const result = await tx
    .updateTable('ext_access_tokens')
    .set({ revoked_at: sql<Date>`now()` })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}
