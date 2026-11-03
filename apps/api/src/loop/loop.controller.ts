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
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { AGENT_TURNS, type AgentTurns } from '../agent/agent-turns.js';
import {
  displayName,
  gateAdvancedNotice,
  gateRejectedNotice,
  gateRequestedNotice,
  sentBackNotice,
} from '../agent/notices.js';
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
import { ACTIVITY_JOBS, type ActivityJobs } from '../progress/activity-jobs.js';
import { PROGRESS_JOBS, type ProgressJobs } from '../progress/progress-jobs.js';
import { recordGateProgress } from '../progress/progress-store.js';
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
// A vote that passes a gate also commits the arena's approved state to its git repo (repo/), and
// every gate decision re-renders PROGRESS.md at once (the activity log, ADR-044).
// Each move is also told to the arena's AI once it commits (TurnRunner.notify).

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
  constructor(
    @Inject(ARENA_REPOS) private readonly repos: ArenaRepos,
    @Inject(PROGRESS_JOBS) private readonly progress: ProgressJobs,
    @Inject(AGENT_TURNS) private readonly turns: AgentTurns,
    @Inject(ACTIVITY_JOBS) private readonly activity: ActivityJobs,
  ) {}

  /** After the commit: the arena's AI hears what happened (never fails the request). */
  private tell(
    afterCommit: AfterCommitFn,
    ctx: { orgId: string; projectId: string },
    text: string,
  ) {
    afterCommit(() => void this.turns.runner.notify({ ...ctx, text }));
  }

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
  async request(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Param('cycleId') cycleId: string,
    @Body(new ZodPipe(GateRequestSchema)) body: GateRequest,
  ): Promise<LoopActionResult> {
    const ctx = scope(caller, projectId);
    const result = await requestGate(tx, ctx, pathId(cycleId), body);
    const name = await displayName(tx, ctx.userId);
    this.tell(afterCommit, ctx, gateRequestedNotice(name, result, body.summary));
    return result;
  }

  @Post('cycles/:cycleId\\:send-back')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async sendBack(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Param('cycleId') cycleId: string,
    @Body(new ZodPipe(SendBackSchema)) body: SendBack,
  ): Promise<LoopActionResult> {
    const ctx = scope(caller, projectId);
    const result = await sendBack(tx, ctx, pathId(cycleId), body);
    const name = await displayName(tx, ctx.userId);
    this.tell(afterCommit, ctx, sentBackNotice(name, result, body.reason));
    return result;
  }

  @Post('approvals/:approvalId/votes')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async vote(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Param('approvalId') approvalId: string,
    @Body(new ZodPipe(VoteSchema)) body: Vote,
  ): Promise<LoopActionResult> {
    const ctx = scope(caller, projectId);
    // A passed gate: PROGRESS.md and STATE.md entries (facts now, the AI's summary shortly after),
    // and the arena's approved state goes into its git repo once the vote commits.
    const result = await voteOnGate(tx, ctx, pathId(approvalId), body, async (advance) => {
      await recordGateProgress(tx, {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        approvalId: advance.approvalId,
      });
      const me = await tx
        .selectFrom('users')
        .select(['display_name', 'email'])
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      this.tell(afterCommit, ctx, gateAdvancedNotice(me?.display_name ?? 'A teammate', advance));
      const snapshot = await buildSnapshot(tx, {
        projectId: ctx.projectId,
        approver: {
          name: me?.display_name ?? 'A teammate',
          email: me?.email ?? 'noreply@parallelflow.app',
        },
        ...advance,
      });
      afterCommit(() => {
        void this.repos.commit(ctx.projectId, snapshot, ctx.orgId);
        this.progress.request({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          trigger: 'gate',
          approvalId: advance.approvalId,
        });
      });
    });
    // A gate decision is in the activity log at once, not after the quiet period (ADR-044).
    if (result.approval_status !== 'pending') {
      afterCommit(() => this.activity.flush({ orgId: ctx.orgId, projectId: ctx.projectId }));
    }
    if (body.decision === 'reject' && result.approval_status === 'rejected') {
      const name = await displayName(tx, ctx.userId);
      this.tell(afterCommit, ctx, gateRejectedNotice(name, result, body.reason));
    }
    return result;
  }
}
