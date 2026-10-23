import { Controller, Get, Header, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  type AcceptInviteArena,
  type InvitePreview,
  type Me,
  parseInviteToken,
} from '@parallelflow/contracts';
import type { Database, Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { AGENT_TURNS, type AgentTurns } from '../agent/agent-turns.js';
import { joinedNotice } from '../agent/notices.js';
import { loadMe } from '../identity/me.js';
import { Public, type SessionVerifier } from '../pipeline/auth.js';
import { Caller, DbTx, TouchProject, type TouchProjectFn } from '../pipeline/decorators.js';
import { ApiError } from '../pipeline/errors.js';
import { RateLimiter } from '../pipeline/rate-limit.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { DATABASE, SESSION_VERIFIER } from '../pipeline/tokens.js';
import { acceptInvite, inviteGone, previewInvite } from './invites.js';

// /v1/invites/{token} (openapi_v2.yaml getInvite, acceptInvite; ADR-029).
//   GET            public. What the join page shows. Rate-limited per arena. If the viewer happens to
//                  be signed in, the invited email is shown in full to that account only.
//   POST :accept   authenticated + CSRF. Joins the arena; returns your profile and the arena.
// The token is a path parameter: it is never logged (the access log records the route, not the URL).

const ACCEPT_SUFFIX = ':accept';

@Controller('invites')
export class InvitesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AGENT_TURNS) private readonly turns: AgentTurns,
  ) {}

  @Public()
  @Get(':token')
  @Header('Cache-Control', 'no-store')
  async preview(
    @Param('token') raw: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InvitePreview> {
    const token = parseInviteToken(raw);
    if (!token) throw inviteGone();
    const viewerEmail = await this.viewerEmail(req, res);
    const { limit, preview } = await previewInvite(this.db, this.limiter, token, viewerEmail);
    if (limit) this.limiter.apply(res, [limit]);
    if (!preview) throw inviteGone();
    return preview;
  }

  // Express 5 routes cannot put a literal ":accept" right after a parameter, so the suffix is part
  // of the parameter and checked here.
  @Post(':tokenAction')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async accept(
    @Param('tokenAction') raw: string,
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @TouchProject() touch: TouchProjectFn,
  ): Promise<Me & AcceptInviteArena> {
    if (!raw.endsWith(ACCEPT_SUFFIX)) throw new ApiError(404, 'NOT_FOUND');
    const token = parseInviteToken(raw.slice(0, -ACCEPT_SUFFIX.length));
    if (!token) throw inviteGone();
    const account = await tx
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', caller.userId)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    if (!account) throw new ApiError(401, 'UNAUTHENTICATED');

    const joined = await acceptInvite(this.db, token, {
      userId: caller.userId,
      email: account.email,
    });
    touch(joined.projectId); // a new member
    // acceptInvite has committed: the arena's AI hears who joined (never fails the request).
    if (joined.joined) {
      void this.turns.runner.notify({
        orgId: token.orgId,
        projectId: joined.projectId,
        text: joinedNotice(account.display_name ?? 'A teammate'),
      });
    }
    // Read committed: this user-scope transaction now sees the new membership.
    const me = await loadMe(tx, caller.userId);
    if (!me) throw new ApiError(401, 'UNAUTHENTICATED');
    return { ...me, arena: { id: joined.projectId, name: joined.name } };
  }

  /** The signed-in viewer's account email, or null. Never fails the request. */
  private async viewerEmail(req: Request, res: Response): Promise<string | null> {
    try {
      const principal = await this.verifier.verify(req, res);
      if (!principal) return null;
      const user = await this.db.withUser({ userId: principal.userId }, (tx) =>
        tx
          .selectFrom('users')
          .select('email')
          .where('id', '=', principal.userId)
          .where('deactivated_at', 'is', null)
          .executeTakeFirst(),
      );
      return user?.email ?? null;
    } catch {
      return null;
    }
  }
}
