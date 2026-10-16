import { WorkOS, type User } from '@workos-inc/node';
import type {
  CodeExchange,
  IdentityProvider,
  IdpUser,
  LoginHints,
  SessionCheck,
  SessionRefresh,
} from './identity-provider.js';

// WorkOS AuthKit (ADR-023) with sealed sessions, @workos-inc/node 10.x:
//   login     userManagement.getAuthorizationUrl({ provider: 'authkit', state, PKCE S256 })
//   callback  userManagement.authenticateWithCode({ code, codeVerifier, session: { sealSession } })
//   requests  loadSealedSession(...).authenticate(): verifies the access token (JWKS) locally
//   refresh   loadSealedSession(...).refresh(): refresh token → new sealed session
//   logout    userManagement.revokeSession({ sessionId })
// The SDK never sees our cookies' envelope; it only gets the sealed session inside it.

export interface WorkosProviderOptions {
  apiKey: string;
  clientId: string;
  cookiePassword: string;
  redirectUri: string;
}

function toIdpUser(user: User): IdpUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    lastName: user.lastName,
  };
}

/** The `sid` claim of a WorkOS access token we just received from WorkOS over TLS. */
function sessionIdOf(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) throw new Error('WorkOS access token is not a JWT');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sid?: unknown;
  };
  if (typeof claims.sid !== 'string') throw new Error('WorkOS access token has no session id');
  return claims.sid;
}

export class WorkosIdentityProvider implements IdentityProvider {
  private readonly workos: WorkOS;

  constructor(private readonly options: WorkosProviderOptions) {
    this.workos = new WorkOS(options.apiKey, { clientId: options.clientId });
  }

  authorizationUrl(input: { state: string; codeChallenge: string } & LoginHints): string {
    // Google goes straight to the OAuth provider; otherwise AuthKit, optionally on a given screen.
    const target =
      input.provider === 'google'
        ? { provider: 'GoogleOAuth' }
        : { provider: 'authkit', ...(input.screen && { screenHint: input.screen }) };
    return this.workos.userManagement.getAuthorizationUrl({
      ...target,
      clientId: this.options.clientId,
      redirectUri: this.options.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: 'S256',
    });
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchange> {
    const response = await this.workos.userManagement.authenticateWithCode({
      clientId: this.options.clientId,
      code: input.code,
      codeVerifier: input.codeVerifier,
      session: { sealSession: true, cookiePassword: this.options.cookiePassword },
    });
    if (!response.sealedSession) throw new Error('WorkOS returned no sealed session');
    return {
      sealedSession: response.sealedSession,
      sessionId: sessionIdOf(response.accessToken),
      user: toIdpUser(response.user),
    };
  }

  async authenticate(sealedSession: string): Promise<SessionCheck> {
    const result = await this.session(sealedSession).authenticate();
    if (result.authenticated) {
      return { status: 'valid', sessionId: result.sessionId, user: toIdpUser(result.user) };
    }
    // invalid_jwt: the access token failed verification, normally because it expired.
    return result.reason === 'invalid_jwt' ? { status: 'expired' } : { status: 'invalid' };
  }

  async refresh(sealedSession: string): Promise<SessionRefresh> {
    const result = await this.session(sealedSession).refresh();
    if (!result.authenticated) {
      return result.retryable ? { status: 'unavailable' } : { status: 'ended' };
    }
    if (!result.sealedSession) return { status: 'ended' };
    return {
      status: 'refreshed',
      sealedSession: result.sealedSession,
      sessionId: result.sessionId,
      user: toIdpUser(result.user),
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.workos.userManagement.revokeSession({ sessionId });
  }

  private session(sealedSession: string) {
    return this.workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.options.cookiePassword,
    });
  }
}
