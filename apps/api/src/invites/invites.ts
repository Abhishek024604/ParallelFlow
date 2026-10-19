import { type InvitePreview, type InviteToken, OPEN_INVITE_EMAIL } from '@saras/contracts';
import { type Database, emit, notify, type Tx } from '@saras/db';
import { sql } from 'kysely';
import { initials, inviteSecretHash, maskEmail } from '../arenas/naming.js';
import { ApiError } from '../pipeline/errors.js';
import type { RateLimiter, RateLimitResult } from '../pipeline/rate-limit.js';

// Invite links (ADR-029): `<org id>.<secret>`, 7 days, single use, for one email.
//
// Whoever opens a link is not a member of the arena yet, so there is no membership to verify. Both
// reads and the accept run in withSystemJob for the org named by the link (the only other way into
// a tenant without a membership). That is why this file is in TENANT_CREATION_ALLOWLIST
// (eslint.config.mjs). The org id is never trusted on its own: every query is also keyed by
// SHA-256(secret), and RLS keeps the transaction inside that one org. Only invitations, the arena's
// name and description, member initials and the inviter's name are read; never arena content.
//
// An open join link (email = OPEN_INVITE_EMAIL, links.ts) skips the email check and stays pending:
// many people can use it until it expires or is reset.
//
// Unknown, expired, revoked and used links all get the same answer (410 INVITE_EXPIRED), so a link
// cannot be probed. Tokens are never logged.

export const INVITE_GONE_DETAIL = 'This invitation link has expired or was already used.';

export const inviteGone = () => new ApiError(410, 'INVITE_EXPIRED', { detail: INVITE_GONE_DETAIL });

interface InviteRow {
  id: string;
  email: string;
  status: string;
  expires_at: Date;
  project_id: string | null;
  project_role_ids: string[];
  invited_by: string;
}

async function findInvite(tx: Tx, secret: string, lock: boolean): Promise<InviteRow | undefined> {
  let query = tx
    .selectFrom('invitations')
    .select(['id', 'email', 'status', 'expires_at', 'project_id', 'project_role_ids', 'invited_by'])
    .where('token_hash', '=', inviteSecretHash(secret))
    .where('scope', '=', 'project');
  if (lock) query = query.forUpdate();
  return query.executeTakeFirst();
}

function usable(
  invite: InviteRow | undefined,
  now: Date,
): invite is InviteRow & { project_id: string } {
  return Boolean(
    invite &&
    invite.status === 'pending' &&
    invite.expires_at.getTime() > now.getTime() &&
    invite.project_id,
  );
}

export interface PreviewResult {
  /** Rate-limit count for the link's arena, applied by the controller. Unset for unknown arenas. */
  limit?: RateLimitResult;
  preview?: InvitePreview;
}

/**
 * GET /invites/{token}. `viewerEmail` is the signed-in viewer's account email, if any: the invited
 * email is shown in full only to that account.
 */
export async function previewInvite(
  db: Database,
  limiter: RateLimiter,
  token: InviteToken,
  viewerEmail: string | null,
  now = new Date(),
): Promise<PreviewResult> {
  return db.withSystemJob({ orgId: token.orgId }, async (tx) => {
    const org = await tx
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', token.orgId)
      .executeTakeFirst();
    if (!org) return {};
    const limit = await limiter.hit(tx, 'org', token.orgId);
    if (limit.exceeded) return { limit };

    const invite = await findInvite(tx, token.secret, false);
    if (!usable(invite, now)) return { limit };

    const project = await tx
      .selectFrom('projects')
      .select(['name', 'description'])
      .where('id', '=', invite.project_id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!project) return { limit };

    const { rows: members } = await sql<{ display_name: string; total: string }>`
      SELECT u.display_name, count(*) OVER () AS total
      FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ${invite.project_id}
      ORDER BY pm.added_at, pm.user_id
      LIMIT 4`.execute(tx);
    const inviter = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', invite.invited_by)
      .executeTakeFirst();

    const open = invite.email === OPEN_INVITE_EMAIL;
    const matches =
      viewerEmail === null ? null : open || viewerEmail.toLowerCase() === invite.email;
    return {
      limit,
      preview: {
        arena: {
          name: project.name,
          description: project.description,
          member_count: Number(members[0]?.total ?? 0),
          member_initials: members.map((m) => initials(m.display_name)),
        },
        invited_by: { display_name: inviter?.display_name ?? 'A teammate' },
        email: open ? '' : matches ? invite.email : maskEmail(invite.email),
        email_matches: matches,
        expires_at: invite.expires_at.toISOString(),
        open,
      },
    };
  });
}

export interface Invitee {
  userId: string;
  /** The account email (verified by the identity provider at sign-in). */
  email: string;
}

export interface AcceptResult {
  projectId: string;
  name: string;
  /** True when this accept added the member (false: already a member). */
  joined: boolean;
}

/**
 * POST /invites/{token}:accept. Locks the invitation, checks it is pending, unexpired and for the
 * caller's email, then adds the org, team and project memberships with the invite's roles
 * (idempotent if already a member) and marks it accepted (single use).
 */
export async function acceptInvite(
  db: Database,
  token: InviteToken,
  invitee: Invitee,
  now = new Date(),
): Promise<AcceptResult> {
  return db.withSystemJob({ orgId: token.orgId }, async (tx) => {
    const invite = await findInvite(tx, token.secret, true);
    if (!usable(invite, now)) throw inviteGone();
    const open = invite.email === OPEN_INVITE_EMAIL;
    if (!open && invite.email !== invitee.email.trim().toLowerCase()) {
      throw new ApiError(403, 'FORBIDDEN', {
        detail: `This invite is for ${maskEmail(invite.email)}. Sign in with that email to join.`,
      });
    }
    const project = await tx
      .selectFrom('projects')
      .select(['id', 'name', 'team_id'])
      .where('id', '=', invite.project_id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!project) throw inviteGone();

    const org = token.orgId;
    const user = invitee.userId;
    await tx
      .insertInto('org_memberships')
      .values({ org_id: org, user_id: user, role: 'member' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await tx
      .insertInto('team_members')
      .values({ org_id: org, team_id: project.team_id, user_id: user, role: 'member' })
      .onConflict((oc) => oc.doNothing())
      .execute();
    const added = await tx
      .insertInto('project_members')
      .values({ org_id: org, project_id: project.id, user_id: user, added_by: invite.invited_by })
      .onConflict((oc) => oc.doNothing())
      .returning('user_id')
      .executeTakeFirst();
    // Opening the open link again as a member changes nothing (and announces nothing).
    if (open && !added) return { projectId: project.id, name: project.name, joined: false };
    if (invite.project_role_ids.length) {
      await tx
        .insertInto('project_member_roles')
        .values(
          invite.project_role_ids.map((roleId) => ({
            org_id: org,
            project_id: project.id,
            user_id: user,
            role_id: roleId,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    if (!open) {
      await tx
        .updateTable('invitations')
        .set({ status: 'accepted' })
        .where('id', '=', invite.id)
        .execute();
    }
    const joiner = await tx
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', user)
      .executeTakeFirst();
    await notify(tx, {
      orgId: org,
      projectId: project.id,
      type: 'system',
      title: `${joiner?.display_name ?? 'A teammate'} joined ${project.name}`,
      preview: open ? 'Joined with the arena link' : 'Accepted your invite',
      resourceType: 'user',
      resourceId: user,
      deepLink: `/arena/${project.id}`,
      actor: { type: 'user', id: user },
      dedupeKey: `joined:${project.id}:${user}`,
      recipients: { userIds: [invite.invited_by] },
    });
    await emit(tx, {
      type: 'member.joined',
      org_id: org,
      subject: user,
      actor: { type: 'user', id: user, on_behalf_of: null },
      data: { user_id: user, invitation_id: invite.id, project_id: project.id },
    });
    return { projectId: project.id, name: project.name, joined: Boolean(added) };
  });
}
