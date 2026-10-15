import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiError } from './errors.js';
import { getState, isUuid, type Principal } from './request-context.js';
import { SESSION_VERIFIER } from './tokens.js';

// Authentication (doc 05 §5.5 step 2). Every route is authenticated unless marked @Public().
//
// The verifier is pluggable: F01-01 implements it with WorkOS AuthKit (sealed `saras_session` cookie,
// plus CSRF on mutations; Bearer tokens later). Until then no verifier is configured and every
// authenticated route answers 401. There is deliberately no development backdoor.

export interface SessionVerifier {
  /** The principal for a valid session, or null. Throws only for infrastructure failures. */
  verify(req: Request): Promise<Principal | null>;
}

/** The default: nobody is signed in. */
export class NoSessionVerifier implements SessionVerifier {
  async verify(): Promise<null> {
    return null;
  }
}

export const PUBLIC_ROUTE = 'saras:public';

/** Opt a route (or controller) out of authentication. Public routes get no database context. */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = await this.verifier.verify(req);
    if (!principal || !isUuid(principal.userId)) throw new ApiError(401, 'UNAUTHENTICATED');
    getState(req).principal = { userId: principal.userId.toLowerCase() };
    return true;
  }
}
