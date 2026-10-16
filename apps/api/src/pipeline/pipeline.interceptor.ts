import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Database, Tx } from '@saras/db';
import type { Request, Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { PUBLIC_ROUTE } from './auth.js';
import { IDEMPOTENT, type IdempotentOptions, SCOPE, type ScopeSpec } from './decorators.js';
import { notFound } from './errors.js';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyStore,
  parseIdempotencyKey,
  REPLAYED_HEADER,
  REPLAYED_RESPONSE_HEADERS,
  requestHash,
  type IdempotentRequest,
} from './idempotency.js';
import { RateLimiter, type RateLimitResult } from './rate-limit.js';
import { getState, isUuid, type RequestState } from './request-context.js';
import { DATABASE } from './tokens.js';

// Steps 3–8 of the request lifecycle (doc 05 §5.5), after the request id (middleware) and auth
// (AuthGuard):
//   3. user rate limit            own short transaction, user scope
//   4. tenant resolution          withProjectMember / withOrgMember (ADR-031): 404 or 403
//      + org rate limit           in that same short transaction
//   5. handler transaction        user scope, or the verified tenant again
//      6. idempotency             inside the handler transaction
//      7. Zod validation          pipes, run by Nest when the handler is invoked
//      8. handler                 gets the transaction via @DbTx()
// Errors go to ProblemFilter (step 9). Rolling back the handler transaction also drops the
// idempotency record, so only committed responses are ever replayed.

type Enter = <T>(fn: (tx: Tx, orgId: string | undefined) => Promise<T>) => Promise<T>;

@Injectable()
export class PipelineInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(IdempotencyStore) private readonly idempotency: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, targets)) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const scope = this.reflector.getAllAndOverride<ScopeSpec | undefined>(SCOPE, targets);
    const idempotent = this.reflector.getAllAndOverride<IdempotentOptions | undefined>(
      IDEMPOTENT,
      targets,
    );
    return from(this.run(req, res, getState(req), scope, idempotent, next));
  }

  private async run(
    req: Request,
    res: Response,
    state: RequestState,
    scope: ScopeSpec | undefined,
    idempotent: IdempotentOptions | undefined,
    next: CallHandler,
  ): Promise<unknown> {
    const userId = state.principal?.userId;
    if (!userId) throw new Error('PipelineInterceptor ran without a principal');
    const limits: RateLimitResult[] = [];

    // 3. Per-user limit first, so probing unknown ids is limited too.
    limits.push(await this.db.withUser({ userId }, (tx) => this.limiter.hit(tx, 'user', userId)));
    this.limiter.apply(res, limits);

    // 4. Tenant from a verified membership only; ids come from the path, never from the body.
    const enter = this.contextFor(scope, req, userId);
    if (scope) {
      const { orgId, limit } = await enter(async (tx, orgId) => {
        if (!orgId) throw new Error('Scoped context without an org');
        return { orgId, limit: await this.limiter.hit(tx, 'org', orgId) };
      });
      state.orgId = orgId;
      limits.push(limit);
      this.limiter.apply(res, limits);
    }

    // 6. Key format is checked before opening the handler transaction.
    const idem: IdempotentRequest | undefined = idempotent
      ? {
          userId,
          key: parseIdempotencyKey(req.headers[IDEMPOTENCY_HEADER.toLowerCase()]),
          method: req.method,
          path: req.path,
          hash: requestHash({
            method: req.method,
            path: req.path,
            query: req.query,
            body: req.body,
          }),
        }
      : undefined;

    // 5. The handler transaction. Membership is checked again here, in the same transaction as the
    // handler's reads and writes, so a membership revoked meanwhile cannot slip through.
    return enter(async (tx) => {
      state.tx = tx;
      try {
        if (idem) {
          const stored = await this.idempotency.begin(tx, idem);
          if (stored) {
            res.status(stored.status);
            for (const [name, value] of Object.entries(stored.headers)) res.setHeader(name, value);
            res.setHeader(REPLAYED_HEADER, 'true');
            return stored.body;
          }
        }
        const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
        if (idem) {
          const headers: Record<string, string> = {};
          for (const name of REPLAYED_RESPONSE_HEADERS) {
            const value = res.getHeader(name);
            if (typeof value === 'string') headers[name] = value;
          }
          const replayBody = idempotent?.storeBody ? idempotent.storeBody(body) : body;
          await this.idempotency.complete(tx, idem, {
            status: res.statusCode,
            headers,
            body: replayBody,
          });
        }
        return body;
      } finally {
        state.tx = undefined;
      }
    });
  }

  private contextFor(scope: ScopeSpec | undefined, req: Request, userId: string): Enter {
    if (!scope) return (fn) => this.db.withUser({ userId }, (tx) => fn(tx, undefined));
    const id: unknown = req.params[scope.param];
    if (!isUuid(id)) throw notFound();
    return scope.kind === 'project'
      ? (fn) => this.db.withProjectMember({ userId, projectId: id }, (tx, m) => fn(tx, m.orgId))
      : (fn) => this.db.withOrgMember({ userId, orgId: id }, (tx, m) => fn(tx, m.orgId));
  }
}
