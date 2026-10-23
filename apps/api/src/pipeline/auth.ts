import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import type { BearerTokens } from '../ext/bearer.js';
import { hasBearer, parseBearer } from '../ext/device.js';
import { ApiError } from './errors.js';
import { getState, isUuid, type Principal } from './request-context.js';
import { BEARER_TOKENS, SESSION_VERIFIER } from './tokens.js';

// Authentication (doc 05 §5.5 step 2). Every route is authenticated unless marked @Public().
//
// The verifier is pluggable. F01-01 implements it with WorkOS AuthKit (identity/session-verifier.ts:
// `parallelflow_session` cookie plus CSRF on mutations). Extension bearer tokens (ADR-037) are accepted only
// on routes marked @BearerAllowed() / @BearerOnly(); a bearer anywhere else is a 401. Bearer requests
// need no CSRF token (no cookie is involved). Without WorkOS
// configuration no verifier is set and every authenticated route answers 401. There is deliberately
// no development backdoor.

export interface SessionVerifier {
  /**
   * The principal for a valid session, or null (→ 401). May set or clear cookies on `res` and may
   * throw an ApiError (e.g. 403 for a failed CSRF check). Other throws are infrastructure failures.
   */
  verify(req: Request, res: Response): Promise<Principal | null>;
}

/** The default: nobody is signed in. */
export class NoSessionVerifier implements SessionVerifier {
  async verify(): Promise<null> {
    return null;
  }
}

export const PUBLIC_ROUTE = 'parallelflow:public';

/** Opt a route (or controller) out of authentication. Public routes get no database context. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

export const BEARER_ROUTE = 'parallelflow:bearer';
export type BearerMode = 'allowed' | 'only';

/** The route also accepts an extension bearer token (ADR-037), besides the web session. */
export const BearerAllowed = () => SetMetadata(BEARER_ROUTE, 'allowed' satisfies BearerMode);
/** The route accepts only an extension bearer token (the LLM proxy). */
export const BearerOnly = () => SetMetadata(BEARER_ROUTE, 'only' satisfies BearerMode);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
    @Inject(BEARER_TOKENS) private readonly bearer: BearerTokens,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const mode = this.reflector.getAllAndOverride<BearerMode | undefined>(BEARER_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const authorization = req.headers.authorization;
    if (hasBearer(authorization)) {
      if (!mode) {
        throw new ApiError(401, 'UNAUTHENTICATED', {
          detail: 'This request needs a signed-in browser session.',
        });
      }
      const token = parseBearer(authorization);
      const userId = token ? await this.bearer.verify(token) : null;
      if (!userId) {
        throw new ApiError(401, 'UNAUTHENTICATED', {
          detail: 'The extension token is not valid. Sign in again.',
        });
      }
      getState(req).principal = { userId: userId.toLowerCase(), via: 'bearer' };
      return true;
    }
    if (mode === 'only') throw new ApiError(401, 'UNAUTHENTICATED');
    const principal = await this.verifier.verify(req, http.getResponse<Response>());
    if (!principal || !isUuid(principal.userId)) throw new ApiError(401, 'UNAUTHENTICATED');
    getState(req).principal = {
      userId: principal.userId.toLowerCase(),
      ...(principal.sessionId && { sessionId: principal.sessionId }),
    };
    return true;
  }
}
