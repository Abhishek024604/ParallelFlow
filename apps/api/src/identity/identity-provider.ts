// The identity provider behind login (ADR-023: WorkOS AuthKit). Only workos-provider.ts imports the
// WorkOS SDK; everything else, and every test, works against this interface.

export interface IdpUser {
  /** The provider's user id. Not stored yet (SLICE_DEBT): accounts are matched by verified email. */
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
}

export interface IdpSession {
  /** The provider's session id (WorkOS `sid`). Used to revoke the session at logout. */
  sessionId: string;
  user: IdpUser;
}

export interface CodeExchange extends IdpSession {
  /** Opaque, encrypted session for the cookie (WorkOS sealed session). */
  sealedSession: string;
}

export type SessionCheck =
  | ({ status: 'valid' } & IdpSession)
  /** The access token expired: try `refresh`. */
  | { status: 'expired' }
  | { status: 'invalid' };

export type SessionRefresh =
  | ({ status: 'refreshed'; sealedSession: string } & IdpSession)
  /** The session is over (revoked, refresh token invalid): sign in again. */
  | { status: 'ended' }
  /** The provider could not be reached; the session may still be valid. */
  | { status: 'unavailable' };

export interface IdentityProvider {
  /** Hosted login page (AuthKit) with our state and PKCE challenge. */
  authorizationUrl(input: { state: string; codeChallenge: string }): string;
  /** Exchanges the callback code. Throws if the code is invalid, used or expired. */
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchange>;
  /** Verifies a sealed session locally (signature, expiry). Throws only for infrastructure errors. */
  authenticate(sealedSession: string): Promise<SessionCheck>;
  /** Gets a new access token with the refresh token in the sealed session. */
  refresh(sealedSession: string): Promise<SessionRefresh>;
  /** Ends the session at the provider, so its refresh token stops working. */
  revoke(sessionId: string): Promise<void>;
}
