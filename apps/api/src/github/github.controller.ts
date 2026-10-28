import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  type GithubConnectRepo,
  GithubConnectRepoSchema,
  type GithubConnectStart,
  type GithubRepoChoice,
  type GithubStatus,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { requireActiveArena, requireArenaOwner } from '../arenas/arena-admin.js';
import { hasCapability } from '../arenas/messages.js';
import { ARENA_READ } from '../bridge/bridge.js';
import { Public } from '../pipeline/auth.js';
import {
  AfterCommit,
  type AfterCommitFn,
  Caller,
  DbTx,
  ProjectScoped,
} from '../pipeline/decorators.js';
import { ApiError } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { GITHUB } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import type { GithubService } from './github.js';

// An arena's GitHub repository (ADR-040). Additive to openapi_v2.yaml (Phase A); the flow is in
// github.ts.
//   GET    /projects/:p/github                 cap arena.read → GithubStatus
//   POST   /projects/:p/github/connect         owner → GithubConnectStart
//   GET    /projects/:p/github/choices?grant=  owner → { items: GithubRepoChoice[] }
//   POST   /projects/:p/github/repo            owner, { grant, repo_id } → GithubStatus
//   POST   /projects/:p/github/sync            owner → 202
//   DELETE /projects/:p/github                 owner → 204
//   GET    /github/setup                       session; GitHub's Setup URL → 302
//   GET    /github/callback                    session; GitHub's Callback URL → 302
//   POST   /github/webhook                     public, X-Hub-Signature-256 → 202 | 200 | 4xx

function scope(caller: CallerContext, projectId: string) {
  if (!caller.orgId) throw new Error('Project-scoped route without an org');
  return { orgId: caller.orgId, projectId: projectId.toLowerCase() };
}

@Controller('projects/:projectId/github')
@ProjectScoped('projectId')
export class ArenaGithubController {
  constructor(@Inject(GITHUB) private readonly github: GithubService) {}

  private async owner(tx: Tx, caller: CallerContext, projectId: string, action: string) {
    const s = scope(caller, projectId);
    await requireArenaOwner(tx, s.projectId, caller.userId, action);
    return s;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async status(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<GithubStatus> {
    const s = scope(caller, projectId);
    if (!(await hasCapability(tx, s.projectId, caller.userId, ARENA_READ))) {
      throw new ApiError(403, 'FORBIDDEN', { requiredPermission: `cap ${ARENA_READ}` });
    }
    return this.github.status(tx, s.projectId, caller.userId);
  }

  @Post('connect')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async connect(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<GithubConnectStart> {
    const s = await this.owner(tx, caller, projectId, 'connect GitHub');
    await requireActiveArena(tx, s.projectId);
    return { url: this.github.startUrl(s.projectId, caller.userId) };
  }

  @Get('choices')
  @Header('Cache-Control', 'no-store')
  async choices(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Query('grant') grant: unknown,
  ): Promise<{ items: GithubRepoChoice[] }> {
    const s = await this.owner(tx, caller, projectId, 'connect GitHub');
    return { items: await this.github.choices(s.projectId, caller.userId, grant) };
  }

  @Post('repo')
  @HttpCode(200)
  async repo(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(GithubConnectRepoSchema)) body: GithubConnectRepo,
  ): Promise<GithubStatus> {
    const s = await this.owner(tx, caller, projectId, 'connect GitHub');
    await requireActiveArena(tx, s.projectId);
    const result = await this.github.connect(tx, s, caller.userId, body);
    afterCommit(result.afterCommit);
    return result.status;
  }

  @Post('sync')
  @HttpCode(202)
  async sync(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    const s = await this.owner(tx, caller, projectId, 'sync with GitHub');
    this.github.syncNow(s);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    const s = await this.owner(tx, caller, projectId, 'disconnect GitHub');
    afterCommit(await this.github.disconnect(tx, s.projectId));
  }
}

@Controller('github')
export class GithubAppController {
  constructor(@Inject(GITHUB) private readonly github: GithubService) {}

  @Get('setup')
  setup(@Caller() caller: CallerContext, @Req() req: Request, @Res() res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, this.github.setupRedirect(req.query, caller.userId));
  }

  @Get('callback')
  async callback(
    @Caller() caller: CallerContext,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, await this.github.callbackRedirect(req.query, caller.userId));
  }

  @Public()
  @Post('webhook')
  async webhook(@Req() req: Request, @Res() res: Response): Promise<void> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const status = await this.github.webhook(req.headers, body);
    res.status(status).end();
  }
}
