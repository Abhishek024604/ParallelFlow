import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Logger } from '@saras/observability';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../pipeline/auth.js';
import { getState } from '../pipeline/request-context.js';
import { LOGGER } from '../pipeline/tokens.js';
import { signInAccount } from './accounts.js';
import {
  clearLoginStateCookie,
  clearSessionCookies,
  LOGIN_STATE_COOKIE,
  LOGIN_STATE_TTL_MS,
  readCookie,
  setLoginStateCookie,
  setSessionCookies,
} from './cookies.js';
import { decrypt, encrypt, pkcePair, randomToken, safeEqual } from './crypto.js';
import type { CodeExchange, LoginHints } from './identity-provider.js';
import { safeReturnTo, webRoot } from './return-to.js';
import { encodeSession } from './session.js';
import type { WebSessionDeps } from './web-session.js';

// /v1/auth/* (openapi_v2.yaml: login, authCallback, logout; doc 07 §7.1, doc 10 §10.3).
//
// login     302 to AuthKit (optional `screen=sign-up|sign-in`, or `provider=google` to go straight to
//           Google). A random `state` and the PKCE verifier go into `saras_login` (encrypted,
//           HttpOnly, 10 min, Path=/v1/auth). `return_to` must be on WEB_ORIGIN, else it is ignored.
// callback  Checks state (constant time), exchanges the code (with PKCE), requires a verified email,
//           finds or creates the account by that email, sets `saras_session` + `saras_csrf`, and
//           302s to return_to. Every failure 302s to WEB_ORIGIN/?auth_error=<reason> without a
//           session; the code, state and tokens are never echoed or logged.
// logout    Authenticated + CSRF. Revokes the WorkOS session, clears the cookies, 204.

export const WEB_SESSION = Symbol('WEB_SESSION');

export type AuthErrorReason =
  | 'denied'
  | 'invalid_state'
  | 'invalid_code'
  | 'email_unverified'
  | 'account_deactivated'
  | 'failed';

const LoginStateSchema = z
  .object({ state: z.string(), verifier: z.string(), returnTo: z.string(), exp: z.number() })
  .strict();

const NO_STORE = 'no-store';

/** `screen` and `provider` query values. Anything else is ignored (plain AuthKit). */
export function loginHints(screen: unknown, provider: unknown): LoginHints {
  return {
    ...((screen === 'sign-up' || screen === 'sign-in') && { screen }),
    ...(provider === 'google' && { provider }),
  };
}

/** Query values: a single string of bounded length, else undefined. */
function single(value: unknown, max = 2048): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(WEB_SESSION) private readonly deps: WebSessionDeps,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Public()
  @Get('login')
  login(
    @Query('return_to') returnTo: unknown,
    @Query('screen') screen: unknown,
    @Query('provider') idp: unknown,
    @Res() res: Response,
  ): void {
    const { keys, cookies, clock, provider, webOrigin } = this.deps;
    const state = randomToken(32);
    const { verifier, challenge } = pkcePair();
    setLoginStateCookie(
      res,
      cookies,
      encrypt(keys.loginState, {
        state,
        verifier,
        returnTo: safeReturnTo(returnTo, webOrigin),
        exp: clock() + LOGIN_STATE_TTL_MS,
      }),
    );
    res.setHeader('Cache-Control', NO_STORE);
    res.redirect(
      302,
      provider.authorizationUrl({
        state,
        codeChallenge: challenge,
        ...loginHints(screen, idp),
      }),
    );
  }

  @Public()
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { keys, cookies, clock, webOrigin } = this.deps;
    res.setHeader('Cache-Control', NO_STORE);
    // A failed callback leaves any existing session alone, so a forged callback cannot sign you out.
    const fail = (reason: AuthErrorReason): void => {
      const url = new URL(webRoot(webOrigin));
      url.searchParams.set('auth_error', reason);
      res.redirect(302, url.toString());
    };

    // The login state is single-use: cleared whatever happens next.
    const rawState = readCookie(req, LOGIN_STATE_COOKIE);
    clearLoginStateCookie(res, cookies);
    if (req.query.error !== undefined) return fail('denied');

    const parsed = LoginStateSchema.safeParse(
      rawState ? decrypt(keys.loginState, rawState) : undefined,
    );
    const state = single(req.query.state, 256);
    if (!parsed.success || !state || parsed.data.exp <= clock()) return fail('invalid_state');
    if (!safeEqual(state, parsed.data.state)) return fail('invalid_state');
    const code = single(req.query.code, 512);
    if (!code) return fail('invalid_code');

    let exchange: CodeExchange;
    try {
      exchange = await this.deps.provider.exchangeCode({
        code,
        codeVerifier: parsed.data.verifier,
      });
    } catch (err) {
      // Class name only: provider error messages can quote the request.
      this.logger.warn(
        { request_id: getState(req).requestId, err_name: errorName(err) },
        'auth code exchange failed',
      );
      return fail('invalid_code');
    }

    if (!exchange.user.emailVerified) {
      await this.revokeQuietly(req, exchange.sessionId);
      return fail('email_unverified');
    }
    const account = await signInAccount(this.deps.db, exchange.user, new Date(clock()));
    if (account.status === 'deactivated') {
      await this.revokeQuietly(req, exchange.sessionId);
      return fail('account_deactivated');
    }

    const now = clock();
    const csrf = randomToken(32);
    setSessionCookies(res, cookies, {
      value: encodeSession(
        keys.sessionMac,
        { uid: account.userId, iat: now, seen: now, csrf },
        exchange.sealedSession,
      ),
      csrf,
      maxAgeMs: this.deps.limits.absoluteMs,
    });
    getState(req).principal = { userId: account.userId };
    res.redirect(302, parsed.data.returnTo);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const { cookies, clock, revoked } = this.deps;
    res.setHeader('Cache-Control', NO_STORE);
    const sessionId = getState(req).principal?.sessionId;
    if (sessionId) {
      // Rejected here at once; at WorkOS the refresh token stops working.
      revoked.add(sessionId, clock());
      await this.revokeQuietly(req, sessionId);
    }
    clearSessionCookies(res, cookies);
  }

  /** Best effort: the cookies are cleared either way; a failure is logged without details. */
  private async revokeQuietly(req: Request, sessionId: string): Promise<void> {
    try {
      await this.deps.provider.revoke(sessionId);
    } catch (err) {
      this.logger.warn(
        { request_id: getState(req).requestId, err_name: errorName(err) },
        'session revoke failed',
      );
    }
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}
