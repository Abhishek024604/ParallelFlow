import { Controller, Get, Header, Inject, Param, Query, Res } from '@nestjs/common';
import type { ArenaRepo } from '@saras/contracts';
import type { Tx } from '@saras/db';
import type { Response } from 'express';
import { hasCapability } from '../arenas/messages.js';
import { ARENA_READ } from '../bridge/bridge.js';
import { Caller, DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { ApiError, notFound } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { ARENA_REPOS } from '../pipeline/tokens.js';
import type { ArenaRepos } from './git.js';

// The arena's git repository (repo/git.ts), read-only, for the Overview panel (cap arena.read).
//   GET /projects/:p/repo                 recent commits and the files at HEAD
//   GET /projects/:p/repo/file?path=…     one file at HEAD, as text/plain (download-safe headers)
// Additive to openapi_v2.yaml (Phase A). Contents are never logged.

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class RepoController {
  constructor(@Inject(ARENA_REPOS) private readonly repos: ArenaRepos) {}

  private async check(tx: Tx, caller: CallerContext, projectId: string): Promise<string> {
    const id = projectId.toLowerCase();
    if (!(await hasCapability(tx, id, caller.userId, ARENA_READ))) {
      throw new ApiError(403, 'FORBIDDEN', { requiredPermission: `cap ${ARENA_READ}` });
    }
    return id;
  }

  @Get('repo')
  @Header('Cache-Control', 'no-store')
  async repo(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<ArenaRepo> {
    const id = await this.check(tx, caller, projectId);
    const { commits, files } = await this.repos.read(id);
    return {
      branch: 'main',
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message,
        author: c.author,
        at: c.at,
      })),
      files,
      remote: null,
    };
  }

  @Get('repo/file')
  async file(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Query('path') path: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const id = await this.check(tx, caller, projectId);
    if (typeof path !== 'string' || !path || path.length > 300) throw notFound();
    const content = await this.repos.show(id, path);
    if (content === null) throw notFound();
    res
      .status(200)
      .set({
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      .send(content);
  }
}
