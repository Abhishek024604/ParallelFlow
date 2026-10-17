import { Body, Controller, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  type ArenaJoinLink,
  type CreateInvites,
  type CreateInvitesResponse,
  CreateInvitesSchema,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { hasCapability } from '../arenas/messages.js';
import { inviteMail, type Mailer } from '../mail/mailer.js';
import {
  AfterCommit,
  type AfterCommitFn,
  Caller,
  DbTx,
  Idempotent,
  ProjectScoped,
} from '../pipeline/decorators.js';
import { ApiError } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { INVITE_KEY, MAILER, WEB_ORIGIN } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import { createEmailInvites, MEMBER_INVITE, resetJoinLink } from './links.js';

// Inviting from inside an arena (cap member.invite; the Owner has it).
//   POST /projects/:projectId/invites    email invites; each invitee is emailed when SMTP_URL is set
//                                        (after commit). Returns the join tokens so links can be
//                                        copied too.
//   POST /projects/:projectId/join-link  a new open join link; the previous one stops working.
// The web app builds links from its own origin; emails use WEB_ORIGIN. Idempotency records never
// store tokens (storeBody). Tokens, emails and bodies are never logged.

const withoutTokens = (body: unknown): unknown => {
  const response = body as Partial<CreateInvitesResponse> & Partial<ArenaJoinLink>;
  if (response.invites) {
    return { ...response, invites: response.invites.map((i) => ({ ...i, token: '' })) };
  }
  return { ...response, token: '' };
};

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class InviteManageController {
  constructor(
    @Inject(INVITE_KEY) private readonly key: Buffer,
    @Inject(WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(MAILER) private readonly mailer: Mailer | null,
  ) {}

  private async scope(tx: Tx, caller: CallerContext, projectId: string) {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    const id = projectId.toLowerCase();
    if (!(await hasCapability(tx, id, caller.userId, MEMBER_INVITE))) {
      throw new ApiError(403, 'FORBIDDEN', { detail: 'You can’t invite people to this arena.' });
    }
    return { orgId: caller.orgId, projectId: id, userId: caller.userId };
  }

  @Post('invites')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent({ storeBody: withoutTokens })
  async invite(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(CreateInvitesSchema)) body: CreateInvites,
  ): Promise<CreateInvitesResponse> {
    const scope = await this.scope(tx, caller, projectId);
    const { invites, alreadyMembers } = await createEmailInvites(tx, this.key, scope, body.emails);
    const mailer = this.mailer;
    if (mailer && invites.length) {
      const names = await tx
        .selectFrom('projects')
        .innerJoin('users', (join) => join.on('users.id', '=', scope.userId))
        .select(['projects.name as arena', 'users.display_name as inviter'])
        .where('projects.id', '=', scope.projectId)
        .executeTakeFirst();
      const arena = names?.arena ?? 'an arena';
      const inviter = names?.inviter ?? 'A teammate';
      afterCommit(() => {
        for (const invite of invites) {
          const link = `${this.webOrigin}/join/${invite.token}`;
          void mailer.send(inviteMail({ to: invite.email, inviter, arena, link }));
        }
      });
    }
    return {
      invites: invites.map((i) => ({ email: i.email, token: i.token, emailed: Boolean(mailer) })),
      already_members: alreadyMembers,
    };
  }

  @Post('join-link')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent({ storeBody: withoutTokens })
  async joinLink(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<ArenaJoinLink> {
    return resetJoinLink(tx, this.key, await this.scope(tx, caller, projectId));
  }
}
