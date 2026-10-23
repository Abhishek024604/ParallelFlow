// Request-scoped database context (doc 05 §5.5, ADR-031). Every query runs inside a transaction that
// first sets these with set_config(..., is_local = true), so they vanish at COMMIT/ROLLBACK and never
// leak to the next user of a pooled connection. Every context sets every key, so nothing is inherited.
//
//   tenant    one org, as a user                     → all schema_v2 policies
//   system    one org, as a worker (no user)         → tenant + system_job bypass of visibility rules
//   user      no org (nil), as a user                → only the user's own rows, across orgs (ADR-031)
//   identity  no org, no user, a verified email      → only that email's account (sign-up / login)
//   credential no org, maybe a user, a secret's hash → only that credential's rows (ADR-037:
//              extension device codes and access tokens)

export interface TenantContext {
  orgId: string;
  userId: string;
}

export interface SystemJobContext {
  orgId: string;
}

export interface UserContext {
  userId: string;
}

export interface IdentityContext {
  /** An email the identity provider has verified. Never a value typed by the user. */
  email: string;
}

export interface CredentialContext {
  /**
   * SHA-256 (hex) of a secret the client sent (device code, access token), or a typed device user
   * code (8 characters). Never the secret itself.
   */
  credential: string;
  /** The signed-in person, when there is one (approving a device; issuing its token). */
  userId?: string;
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Workers act for no user. The schema_v2 policies cast app.user_id to uuid, so it must always be a
 * valid uuid; the nil uuid matches no row in `users`.
 */
export const SYSTEM_USER_ID = NIL_UUID;

const SEARCH_PATH = 'saras, public';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Settings = Record<
  | 'search_path'
  | 'app.org_id'
  | 'app.user_id'
  | 'app.user_email'
  | 'app.system_job'
  | 'app.credential',
  string
>;

export function requireId(value: string, field: string): string {
  if (!UUID.test(value) || value === NIL_UUID) {
    throw new Error(`Invalid database context: ${field} must be a non-nil uuid`);
  }
  return value.toLowerCase();
}

export function tenantSettings(ctx: TenantContext): Settings {
  return {
    search_path: SEARCH_PATH,
    'app.org_id': requireId(ctx.orgId, 'orgId'),
    'app.user_id': requireId(ctx.userId, 'userId'),
    'app.user_email': '',
    'app.system_job': 'off',
    'app.credential': '',
  };
}

export function systemJobSettings(ctx: SystemJobContext): Settings {
  return {
    search_path: SEARCH_PATH,
    'app.org_id': requireId(ctx.orgId, 'orgId'),
    'app.user_id': SYSTEM_USER_ID,
    'app.user_email': '',
    'app.system_job': 'on',
    'app.credential': '',
  };
}

export function userScopeSettings(ctx: UserContext): Settings {
  return {
    search_path: SEARCH_PATH,
    'app.org_id': NIL_UUID,
    'app.user_id': requireId(ctx.userId, 'userId'),
    'app.user_email': '',
    'app.system_job': 'off',
    'app.credential': '',
  };
}

export function identitySettings(ctx: IdentityContext): Settings {
  const email = ctx.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 320) {
    throw new Error('Invalid database context: email must be a verified email address');
  }
  return {
    search_path: SEARCH_PATH,
    'app.org_id': NIL_UUID,
    'app.user_id': NIL_UUID,
    'app.user_email': email,
    'app.system_job': 'off',
    'app.credential': '',
  };
}

const CREDENTIAL = /^(?:[0-9a-f]{64}|[BCDFGHJKLMNPQRSTVWXZ23456789]{8})$/;

/**
 * Credential scope (ADR-037): no org, the signed-in user if any, and the credential. Only rows whose
 * hash (or pending user code) equals it are visible, besides the user's own rows.
 */
export function credentialSettings(ctx: CredentialContext): Settings {
  if (!CREDENTIAL.test(ctx.credential)) {
    throw new Error(
      'Invalid database context: credential must be a sha256 hex digest or user code',
    );
  }
  return {
    search_path: SEARCH_PATH,
    'app.org_id': NIL_UUID,
    'app.user_id': ctx.userId === undefined ? NIL_UUID : requireId(ctx.userId, 'userId'),
    'app.user_email': '',
    'app.system_job': 'off',
    'app.credential': ctx.credential,
  };
}
