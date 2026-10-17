import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Tx } from '@saras/db';
import type { Request } from 'express';
import { projectTag } from './read-cache.js';
import { getState, type CallerContext } from './request-context.js';

// Route decorators for the pipeline (doc 05 §5.5). Handlers never pick a database context
// themselves: the route says how the tenant is resolved, and the handler receives the transaction.

export const SCOPE = 'saras:scope';
export const IDEMPOTENT = 'saras:idempotent';

export interface ScopeSpec {
  kind: 'project' | 'org';
  /** Path parameter holding the id. */
  param: string;
}

/**
 * Tenant = the project's org, after checking an active project + org membership
 * (db.withProjectMember, ADR-031). Non-member or unknown id → 404; inactive membership → 403.
 */
export const ProjectScoped = (param = 'projectId') =>
  SetMetadata(SCOPE, { kind: 'project', param } satisfies ScopeSpec);

/** Tenant = the org, after checking an active org membership (db.withOrgMember, ADR-031). */
export const OrgScoped = (param = 'orgId') =>
  SetMetadata(SCOPE, { kind: 'org', param } satisfies ScopeSpec);

export interface IdempotentOptions {
  /**
   * What to store for replay instead of the response body. For responses that carry a one-time secret
   * (invite links): the secret must never be stored, so a replay returns the redacted body.
   */
  storeBody?: (body: unknown) => unknown;
}

/** Requires an Idempotency-Key and replays the stored response (doc 07 §7.1). */
export const Idempotent = (options: IdempotentOptions = {}) => SetMetadata(IDEMPOTENT, options);

function requestOf(ctx: ExecutionContext): Request {
  return ctx.switchToHttp().getRequest<Request>();
}

/** The transaction the pipeline opened for this handler (user scope or verified tenant). */
export const DbTx = createParamDecorator((_: unknown, ctx: ExecutionContext): Tx => {
  const tx = getState(requestOf(ctx)).tx;
  if (!tx) throw new Error('No transaction: @DbTx() is not available on @Public() routes');
  return tx;
});

/** Request id, user and (on scoped routes) org of the caller. */
export const Caller = createParamDecorator((_: unknown, ctx: ExecutionContext): CallerContext => {
  const state = getState(requestOf(ctx));
  if (!state.principal)
    throw new Error('No principal: @Caller() is not available on @Public() routes');
  return {
    requestId: state.requestId,
    userId: state.principal.userId,
    ...(state.orgId && { orgId: state.orgId }),
  };
});

/**
 * Marks a project whose cached reads this mutation changes (read-cache.ts) when the route is not
 * scoped to it, e.g. a Push from Private or joining by invite. Invalidated once the request is over.
 */
export type TouchProjectFn = (projectId: string) => void;

export const TouchProject = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TouchProjectFn => {
    const state = getState(requestOf(ctx));
    return (projectId) => {
      (state.touched ??= []).push(projectTag(projectId.toLowerCase()));
    };
  },
);

/** Registers work to start after the handler's transaction commits (not on rollback or replay). */
export type AfterCommitFn = (hook: () => void) => void;

export const AfterCommit = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AfterCommitFn => {
    const state = getState(requestOf(ctx));
    return (hook) => {
      (state.afterCommit ??= []).push(hook);
    };
  },
);
