import { createHmac } from 'node:crypto';
import { formatInviteToken, INVITE_TTL_DAYS, OPEN_INVITE_EMAIL, uuidv7 } from '@saras/contracts';
import { emit, type Tx } from '@saras/db';
import { sql } from 'kysely';
import { inviteSecretHash } from '../arenas/naming.js';

// Making invite links from inside an arena (Phase A step 2 follow-up).
//
// A link's secret is HMAC-SHA256(server invite key, invitation id), base64url (43 characters, the
// same shape as a random secret). Only SHA-256(secret) is stored, as before; because the secret can
// be derived again from the id, people who may invite can copy a pending link again later instead
// of seeing it once. Rotating the key (INVITE_LINK_KEY / WORKOS_COOKIE_PASSWORD) kills every link.
//
// Two kinds of invitation rows, both scope 'project':
//   email invite   one email, single use (invites.ts checks the email on accept);
//   open join link email = OPEN_INVITE_EMAIL, any signed-in account, many uses, until it expires
//                  or is reset (reset revokes the old row).
// Both give the arena's Member role. Tenant `tx` (verified project member, member.invite checked by
// the controller). Tokens and emails are never logged.

export const MEMBER_INVITE = 'member.invite';

/** The secret of an invitation, derived from its id. */
export function inviteSecretFor(key: Buffer, invitationId: string): string {
  return createHmac('sha256', key).update(`saras-invite:${invitationId}`).digest('base64url');
}

export function inviteTokenFor(key: Buffer, orgId: string, invitationId: string): string {
  return formatInviteToken(orgId, inviteSecretFor(key, invitationId));
}

/** True when `tokenHash` is this invitation's derived hash (it was made by this file). */
export function isDerived(key: Buffer, invitationId: string, tokenHash: string): boolean {
  return inviteSecretHash(inviteSecretFor(key, invitationId)) === tokenHash;
}

interface Scope {
  orgId: string;
  projectId: string;
  userId: string;
}

/** The role invitees get: the arena's "Member" role, else its least-privileged non-owner role. */
async function memberRoleId(tx: Tx, projectId: string): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT r.id
      FROM project_roles r
      LEFT JOIN role_capabilities c ON c.role_id = r.id
     WHERE r.project_id = ${projectId} AND r.system_kind IS NULL
       AND NOT EXISTS (SELECT 1 FROM role_capabilities o
                        WHERE o.role_id = r.id AND o.capability = 'role.manage')
     GROUP BY r.id, r.name, r.created_at
     ORDER BY (r.name = 'Member') DESC, count(c.capability), r.created_at
     LIMIT 1`.execute(tx);
  return rows[0] ? [rows[0].id] : [];
}

const expiry = (now: Date) => new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

export interface NewInvite {
  id: string;
  email: string;
  token: string;
}

/**
 * Email invites for `emails`, skipping existing members. A still-pending invite for the same email
 * is revoked, so each person has one live link.
 */
export async function createEmailInvites(
  tx: Tx,
  key: Buffer,
  scope: Scope,
  emails: string[],
  now = new Date(),
): Promise<{ invites: NewInvite[]; alreadyMembers: string[] }> {
  if (!emails.length) return { invites: [], alreadyMembers: [] };
  const members = await tx
    .selectFrom('project_members')
    .innerJoin('users', 'users.id', 'project_members.user_id')
    .select('users.email')
    .where('project_members.project_id', '=', scope.projectId)
    .where(sql<boolean>`lower(users.email) IN (${sql.join(emails)})`)
    .execute();
  const taken = new Set(members.map((m) => String(m.email).toLowerCase()));
  const fresh = emails.filter((email) => !taken.has(email));
  if (!fresh.length) return { invites: [], alreadyMembers: [...taken] };

  await tx
    .updateTable('invitations')
    .set({ status: 'revoked' })
    .where('project_id', '=', scope.projectId)
    .where('status', '=', 'pending')
    .where(sql<boolean>`lower(email) IN (${sql.join(fresh)})`)
    .execute();
  const roles = await memberRoleId(tx, scope.projectId);
  const invites = fresh.map((email) => {
    const id = uuidv7();
    return { id, email, token: inviteTokenFor(key, scope.orgId, id) };
  });
  await tx
    .insertInto('invitations')
    .values(
      invites.map((invite) => ({
        id: invite.id,
        org_id: scope.orgId,
        email: invite.email,
        scope: 'project',
        org_role: 'member' as const,
        project_id: scope.projectId,
        project_role_ids: roles,
        expires_at: expiry(now),
        token_hash: inviteSecretHash(inviteSecretFor(key, invite.id)),
        invited_by: scope.userId,
      })),
    )
    .execute();
  for (const invite of invites) {
    await emit(tx, {
      type: 'member.invited',
      org_id: scope.orgId,
      subject: invite.id,
      actor: { type: 'user', id: scope.userId, on_behalf_of: null },
      data: { invitation_id: invite.id, project_id: scope.projectId },
    });
  }
  return { invites, alreadyMembers: [...taken] };
}

/** A new open join link; the previous one (if any) stops working. */
export async function resetJoinLink(
  tx: Tx,
  key: Buffer,
  scope: Scope,
  now = new Date(),
): Promise<{ token: string; expires_at: string }> {
  await tx
    .updateTable('invitations')
    .set({ status: 'revoked' })
    .where('project_id', '=', scope.projectId)
    .where('email', '=', OPEN_INVITE_EMAIL)
    .where('status', '=', 'pending')
    .execute();
  const id = uuidv7();
  const expiresAt = expiry(now);
  await tx
    .insertInto('invitations')
    .values({
      id,
      org_id: scope.orgId,
      email: OPEN_INVITE_EMAIL,
      scope: 'project',
      org_role: 'member',
      project_id: scope.projectId,
      project_role_ids: await memberRoleId(tx, scope.projectId),
      expires_at: expiresAt,
      token_hash: inviteSecretHash(inviteSecretFor(key, id)),
      invited_by: scope.userId,
    })
    .execute();
  return { token: inviteTokenFor(key, scope.orgId, id), expires_at: expiresAt.toISOString() };
}
