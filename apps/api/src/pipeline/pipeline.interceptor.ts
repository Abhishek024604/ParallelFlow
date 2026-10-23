import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Database, MembershipInactiveError, NotVisibleError, type Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { PUBLIC_ROUTE } from './auth.js';
import { IDEMPOTENT, type IdempotentOptions, SCOPE, type ScopeSpec } from './decorators.js';
import { ApiError, notFound } from './errors.js';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyStore,
  parseIdempotencyKey,
  REPLAYED_HEADER,
  REPLAYED_RESPONSE_HEADERS,
  requestHash,
  type IdempotentRequest,
} from './idempotency.js';
import { RateLimiter } from './rate-limit.js';
import { CACHED_READ, projectTag, READ_CACHE, type ReadCache, userTag } from './read-cache.js';
import { getState, isUuid, type RequestState } from './request-context.js';
import { DATABASE } from './tokens.js';

// Steps 3–8 of the request lifecycle (doc 05 §5.5), after the request id (middleware) and auth
// (AuthGuard):
//   3+4. handler transaction      user scope, or withProjectMember / withOrgMember (ADR-031):
//                                 membership verified once, inside this transaction (404 / 403)
//   5. rate limits                own one-round-trip transaction (Database.countRequest), committed
//                                 before the handler: user (unscoped: started in parallel) or user
//                                 + org (scoped, after the membership check; on a denial, the user)
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
    @Inject(READ_CACHE) private readonly cache: ReadCache,
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
    const cacheable =
      req.method === 'GET' &&
      Boolean(this.reflector.getAllAndOverride<boolean | undefined>(CACHED_READ, targets));
    return from(this.cached(req, res, getState(req), scope, idempotent, cacheable, next));
  }

  /**
   * The read cache (read-cache.ts) around run(): a cacheable GET is answered from memory when this
   * user made the same request under RLS within the TTL and nothing invalidated it since. Every
   * mutation invalidates the caller's user tag (and the project's, on project routes) once it is over.
   */
  private async cached(
    req: Request,
    res: Response,
    state: RequestState,
    scope: ScopeSpec | undefined,
    idempotent: IdempotentOptions | undefined,
    cacheable: boolean,
    next: CallHandler,
  ): Promise<unknown> {
    const userId = state.principal?.userId;
    if (!userId || !this.cache.enabled) {
      return this.run(req, res, state, scope, idempotent, next);
    }
    const projectId =
      scope?.kind === 'project' && isUuid(req.params[scope.param])
        ? String(req.params[scope.param]).toLowerCase()
        : undefined;
    const tags = [userTag(userId), ...(projectId ? [projectTag(projectId)] : [])];

    if (!cacheable) {
      try {
        return await this.run(req, res, state, scope, idempotent, next);
      } finally {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          this.cache.invalidate(...tags, ...(state.touched ?? []));
        }
      }
    }
    const key = `${userId} ${req.originalUrl}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.limiter.apply(res, this.limiter.countLocal(userId));
      res.setHeader('X-ParallelFlow-Cache', 'hit');
      return hit.body;
    }
    const snapshot = this.cache.snapshot(tags);
    const body = await this.run(req, res, state, scope, idempotent, next);
    this.cache.set(key, body, snapshot);
    return body;
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

    // 3. Unscoped: the user count runs on its own connection while the handler transaction opens.
    const userCount = scope ? undefined : this.limiter.count(this.db, { userId });
    userCount?.catch(() => undefined); // awaited below; never an unhandled rejection meanwhile

    // 4 + 5. The handler transaction, in user scope or in the tenant of a verified membership (ids
    // come from the path, never from the body). The membership is checked in the same transaction as
    // the handler's reads and writes, so a membership revoked meanwhile cannot slip through.
    let entered = false;
    const result = await this.countDenied(
      scope,
      res,
      userId,
      () => entered,
      () =>
        this.contextFor(
          scope,
          req,
          userId,
        )(async (tx, orgId) => {
          entered = true;
          if (userCount) {
            this.limiter.apply(res, await userCount);
          } else {
            // Scoped: membership verified in this transaction; count the user and the org together.
            if (!orgId) throw new Error('Scoped context without an org');
            state.orgId = orgId;
            this.limiter.apply(res, await this.limiter.count(this.db, { userId, orgId }));
          }
          // 6. Key format is checked before anything else runs in the handler transaction.
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
          state.tx = tx;
          try {
            if (idem) {
              const stored = await this.idempotency.begin(tx, idem);
              if (stored) {
                res.status(stored.status);
                for (const [name, value] of Object.entries(stored.headers))
                  res.setHeader(name, value);
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
        }),
    );
    // Committed: start work the handler deferred (AfterCommit), e.g. an AI turn. Never awaited, and a
    // replayed idempotent response registers none.
    const hooks = state.afterCommit ?? [];
    state.afterCommit = undefined;
    for (const hook of hooks) hook();
    return result;
  }

  /**
   * A scoped request turned away before its membership was verified (bad id, 404, 403) is still
   * counted for the user, so probing unknown ids is rate limited too; over the limit it is a 429.
   */
  private async countDenied<T>(
    scope: ScopeSpec | undefined,
    res: Response,
    userId: string,
    entered: () => boolean,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const denied =
        err instanceof NotVisibleError ||
        err instanceof MembershipInactiveError ||
        (err instanceof ApiError && err.status === 404);
      if (scope && !entered() && denied) {
        this.limiter.apply(res, await this.limiter.count(this.db, { userId }));
      }
      throw err;
    }
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
