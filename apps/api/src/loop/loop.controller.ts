import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  type GateRequest,
  GateRequestSchema,
  type LoopActionResult,
  type LoopState,
  type SendBack,
  SendBackSchema,
  type Vote,
  VoteSchema,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import {
  AfterCommit,
  type AfterCommitFn,
  Caller,
  DbTx,
  Idempotent,
  ProjectScoped,
} from '../pipeline/decorators.js';
import { notFound } from '../pipeline/errors.js';
import { CachedRead } from '../pipeline/read-cache.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ARENA_REPOS } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildSnapshot } from '../repo/snapshot.js';
import { getLoopState, requestGate, sendBack, voteOnGate } from './loop.js';

// The SDLC loop (build step 7). openapi_v2.yaml getCycle, requestGate, sendBack and vote, with the
// project in the path (ADR-036) so the pipeline verifies the membership and opens the tenant
// transaction before the handler runs. Every write is one transaction (CSRF + Idempotency-Key), and
// the pipeline drops this project's cached reads (state, messages, arena) once it commits.
//   GET  /projects/:p/cycles/current                    stage strip + gate cards (one query)
//   POST /projects/:p/cycles/:cycleId/gate-requests     cap stage.request_gate; posts the gate card
//   POST /projects/:p/cycles/:cycleId:send-back         a gate approver; reason; to an earlier stage
//   POST /projects/:p/approvals/:approvalId/votes       people only; approve, or reject with a reason
// A vote that passes a gate also commits the arena's approved state to its git repo (repo/).

function pathId(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

function scope(caller: CallerContext, projectId: string) {
  if (!caller.orgId) throw new Error('Project-scoped route without an org');
  return { projectId: projectId.toLowerCase(), orgId: caller.orgId, userId: caller.userId };
}

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class LoopController {
  constructor(@Inject(ARENA_REPOS) private readonly repos: ArenaRepos) {}

  @CachedRead()
  @Get('cycles/current')
  @Header('Cache-Control', 'no-store')
  state(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<LoopState> {
    return getLoopState(tx, projectId.toLowerCase(), caller.userId);
  }

  @Post('cycles/:cycleId/gate-requests')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  request(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('cycleId') cycleId: string,
    @Body(new ZodPipe(GateRequestSchema)) body: GateRequest,
  ): Promise<LoopActionResult> {
    return requestGate(tx, scope(caller, projectId), pathId(cycleId), body);
  }

  @Post('cycles/:cycleId\\:send-back')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  sendBack(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('cycleId') cycleId: string,
    @Body(new ZodPipe(SendBackSchema)) body: SendBack,
  ): Promise<LoopActionResult> {
    return sendBack(tx, scope(caller, projectId), pathId(cycleId), body);
  }

  @Post('approvals/:approvalId/votes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  vote(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Param('approvalId') approvalId: string,
    @Body(new ZodPipe(VoteSchema)) body: Vote,
  ): Promise<LoopActionResult> {
    const ctx = scope(caller, projectId);
    // A passed gate: the arena's approved state goes into its git repo once the vote commits.
    return voteOnGate(tx, ctx, pathId(approvalId), body, async (advance) => {
      const me = await tx
        .selectFrom('users')
        .select(['display_name', 'email'])
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      const snapshot = await buildSnapshot(tx, {
        projectId: ctx.projectId,
        approver: {
          name: me?.display_name ?? 'A teammate',
          email: me?.email ?? 'noreply@saras.app',
        },
        ...advance,
      });
      afterCommit(() => void this.repos.commit(ctx.projectId, snapshot));
    });
  }
}
