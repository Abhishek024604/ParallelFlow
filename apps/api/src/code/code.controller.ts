import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  type BranchList,
  type CodingEvent,
  CodingEventSchema,
  type CodingPushResult,
  type CodingSession,
  type CreateCodingSession,
  CreateCodingSessionSchema,
  type CreatePullRequest,
  CreatePullRequestSchema,
  type CreateReview,
  CreateReviewSchema,
  type PullRequestDetail,
  type PullRequestList,
  type PullRequestSummary,
  type PullReview,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import type { Response } from 'express';
import { hasCapability } from '../arenas/messages.js';
import { ARENA_READ } from '../bridge/bridge.js';
import { BearerAllowed } from '../pipeline/auth.js';
import { Caller, DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { ApiError, notFound } from '../pipeline/errors.js';
import { isUuid, type CallerContext } from '../pipeline/request-context.js';
import { ARENA_REPOS } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import type { ArenaRepos } from '../repo/git.js';
import {
  addCodingEvent,
  closePullRequest,
  type CodeScope,
  createPullRequest,
  getPullRequest,
  getPullSummary,
  listBranches,
  listPullRequests,
  mainHead,
  mergePullRequest,
  pushCodingSession,
  reviewPullRequest,
  startCodingSession,
} from './pulls.js';

// AI coding sessions, branches and pull requests (ADR-037). Additive to openapi_v2.yaml (Phase A).
// Both controllers are @ProjectScoped: the same membership + tenant pipeline for a web session and
// for an extension bearer token. Reads need arena.read; writes check their capability in pulls.ts.
//
// Extension (bearer or session):          /ext/projects/:p/…
//   GET  repo/bundle                        git bundle of every branch (application/octet-stream)
//   POST coding-sessions                    { title, description } → CodingSession (201)
//   POST coding-sessions/:id/events         { kind, summary } → { message_id }
//   POST coding-sessions/:id/push[?branch=] git bundle body (≤ 50 MB) → CodingPushResult
//   POST pulls                              { coding_session_id, title, description } → summary (201)
//   GET  pulls/:n                           PullRequestSummary
// Web (session):                           /projects/:p/…
//   GET  branches, GET pulls, GET pulls/:n (with commits and diff)
//   POST pulls/:n/reviews { decision, body }, POST pulls/:n/merge, POST pulls/:n/close

async function scope(tx: Tx, caller: CallerContext, projectId: string): Promise<CodeScope> {
  if (!caller.orgId) throw new Error('Project-scoped route without an org');
  const id = projectId.toLowerCase();
  if (!(await hasCapability(tx, id, caller.userId, ARENA_READ))) {
    throw new ApiError(403, 'FORBIDDEN', { requiredPermission: `cap ${ARENA_READ}` });
  }
  return { projectId: id, orgId: caller.orgId, userId: caller.userId };
}

function sessionId(raw: string): string {
  if (!isUuid(raw)) throw notFound();
  return raw.toLowerCase();
}

function prNumber(raw: string): number {
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw notFound();
  return Number(raw);
}

@Controller('ext/projects/:projectId')
@ProjectScoped('projectId')
@BearerAllowed()
export class CodingController {
  constructor(@Inject(ARENA_REPOS) private readonly repos: ArenaRepos) {}

  @Get('repo/bundle')
  async bundle(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Res() res: Response,
  ): Promise<void> {
    const s = await scope(tx, caller, projectId);
    const head = await mainHead(tx, this.repos, s.projectId);
    const bundle = await this.repos.bundle(s.projectId);
    res
      .status(200)
      .set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="arena.bundle"',
        'Cache-Control': 'no-store',
        'X-Saras-Main': head,
      })
      .send(bundle);
  }

  @Post('coding-sessions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async start(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(CreateCodingSessionSchema)) body: CreateCodingSession,
  ): Promise<CodingSession> {
    return startCodingSession(tx, this.repos, await scope(tx, caller, projectId), body);
  }

  @Post('coding-sessions/:sessionId/events')
  @HttpCode(201)
  async event(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('sessionId') id: string,
    @Body(new ZodPipe(CodingEventSchema)) body: CodingEvent,
  ): Promise<{ message_id: string | null }> {
    return addCodingEvent(tx, await scope(tx, caller, projectId), sessionId(id), body);
  }

  @Post('coding-sessions/:sessionId/push')
  async push(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('sessionId') id: string,
    @Query('branch') branch: unknown,
    @Body() body: unknown,
  ): Promise<CodingPushResult> {
    return pushCodingSession(
      tx,
      this.repos,
      await scope(tx, caller, projectId),
      sessionId(id),
      body,
      branch,
    );
  }

  @Post('pulls')
  @HttpCode(201)
  async open(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(CreatePullRequestSchema)) body: CreatePullRequest,
  ): Promise<PullRequestSummary> {
    return createPullRequest(tx, this.repos, await scope(tx, caller, projectId), body);
  }

  @Get('pulls/:number')
  @Header('Cache-Control', 'no-store')
  async summary(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('number') number: string,
  ): Promise<PullRequestSummary> {
    const s = await scope(tx, caller, projectId);
    return getPullSummary(tx, s.projectId, prNumber(number));
  }
}

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class PullsController {
  constructor(@Inject(ARENA_REPOS) private readonly repos: ArenaRepos) {}

  @Get('branches')
  @Header('Cache-Control', 'no-store')
  async branches(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<BranchList> {
    const s = await scope(tx, caller, projectId);
    return { items: await listBranches(tx, this.repos, s.projectId) };
  }

  @Get('pulls')
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<PullRequestList> {
    const s = await scope(tx, caller, projectId);
    return { items: await listPullRequests(tx, s.projectId) };
  }

  @Get('pulls/:number')
  @Header('Cache-Control', 'no-store')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('number') number: string,
  ): Promise<PullRequestDetail> {
    return getPullRequest(tx, this.repos, await scope(tx, caller, projectId), prNumber(number));
  }

  @Post('pulls/:number/reviews')
  @HttpCode(201)
  async review(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('number') number: string,
    @Body(new ZodPipe(CreateReviewSchema)) body: CreateReview,
  ): Promise<PullReview> {
    return reviewPullRequest(tx, await scope(tx, caller, projectId), prNumber(number), body);
  }

  @Post('pulls/:number/merge')
  @HttpCode(200)
  async merge(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('number') number: string,
  ): Promise<PullRequestSummary> {
    return mergePullRequest(tx, this.repos, await scope(tx, caller, projectId), prNumber(number));
  }

  @Post('pulls/:number/close')
  @HttpCode(200)
  async close(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('number') number: string,
  ): Promise<PullRequestSummary> {
    return closePullRequest(tx, await scope(tx, caller, projectId), prNumber(number));
  }
}
