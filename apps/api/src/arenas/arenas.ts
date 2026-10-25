import {
  type ArenaDetail,
  type ArenaInvite,
  type ArenaJoinLink,
  type ArenaSummary,
  OPEN_INVITE_EMAIL,
  type SdlcStage,
} from '@parallelflow/contracts';
import { type Database, readInEachMemberProject, sqlLiteral, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { inviteTokenFor, isDerived, MEMBER_INVITE } from '../invites/links.js';
import { hasCapability } from './messages.js';

// Reading arenas. The list starts in user scope (ADR-031: own project and org memberships). Cycle,
// arena and member rows are tenant data that user scope does not show, so each org's arenas are read
// in its own verified tenant context, all in the list's one transaction (readInEachMemberProject).

interface SummaryRow {
  id: string;
  arena_id: string;
  name: string;
  description: string | null;
  key: string;
  cycle: number | null;
  stage: SdlcStage | null;
  member_count: string;
  is_owner: boolean;
  status: string;
}

function toSummary(row: SummaryRow): ArenaSummary {
  return {
    id: row.id,
    arena_id: row.arena_id,
    name: row.name,
    description: row.description,
    key: row.key,
    cycle: row.cycle,
    stage: row.stage,
    member_count: Number(row.member_count),
    role: row.is_owner ? 'owner' : 'member',
    archived: row.status === 'archived',
  };
}

/** Summary of one arena. `tx` must be the verified tenant context of the project's org. */
export async function arenaSummary(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<ArenaSummary | undefined> {
  const { rows } = await sql<SummaryRow>`
    SELECT p.id, a.id AS arena_id, p.name, p.description, p.key, p.status,
           c.number AS cycle, c.stage,
           (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
           EXISTS (SELECT 1 FROM project_member_roles pmr
                   JOIN project_roles r ON r.id = pmr.role_id AND r.system_kind = 'owner'
                   WHERE pmr.project_id = p.id AND pmr.user_id = ${userId}) AS is_owner
    FROM projects p
    JOIN arenas a ON a.project_id = p.id
    LEFT JOIN sdlc_cycles c ON c.project_id = p.id AND c.status IN ('active', 'operating')
    WHERE p.id = ${projectId}
    ORDER BY c.number DESC NULLS LAST
    LIMIT 1`.execute(tx);
  const row = rows[0];
  return row ? toSummary(row) : undefined;
}

/** Your arenas (GET /arenas). `userTx` is the pipeline's user-scope transaction. */
export async function listArenas(
  _db: Database,
  userTx: Tx,
  userId: string,
): Promise<ArenaSummary[]> {
  const me = sqlLiteral(userId);
  // One read per org, each in its verified tenant context, two round trips in all (@parallelflow/db).
  const rows = await readInEachMemberProject<SummaryRow & { created_at: Date }>(
    userTx,
    userId,
    (ids) => `
      SELECT p.id, a.id AS arena_id, p.name, p.description, p.key, p.status, p.created_at,
             c.number AS cycle, c.stage,
             (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
             EXISTS (SELECT 1 FROM project_member_roles pmr
                     JOIN project_roles r ON r.id = pmr.role_id AND r.system_kind = 'owner'
                     WHERE pmr.project_id = p.id AND pmr.user_id = ${me}) AS is_owner
      FROM projects p
      JOIN arenas a ON a.project_id = p.id
      LEFT JOIN LATERAL (
        SELECT c.number, c.stage FROM sdlc_cycles c
        WHERE c.project_id = p.id AND c.status IN ('active', 'operating')
        ORDER BY c.number DESC LIMIT 1) c ON true
      WHERE p.id IN ${ids} AND p.status IN ('active', 'archived')`,
  );
  // Newest first, as before.
  rows.sort(
    (x, y) =>
      new Date(y.created_at).getTime() - new Date(x.created_at).getTime() ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return rows.map(toSummary);
}

/**
 * One arena. For people who may invite (member.invite): the email invites with their links (pending
 * ones only) and the open join link. Tenant `tx`; `orgId` is the verified tenant.
 */
export async function arenaDetail(
  tx: Tx,
  projectId: string,
  userId: string,
  invite: { key: Buffer; orgId: string },
): Promise<ArenaDetail | undefined> {
  const summary = await arenaSummary(tx, projectId, userId);
  if (!summary) return undefined;
  const canInvite = await hasCapability(tx, projectId, userId, MEMBER_INVITE);
  const invites: ArenaInvite[] = [];
  let joinLink: ArenaJoinLink | null = null;
  if (canInvite) {
    const rows = await tx
      .selectFrom('invitations')
      .select(['id', 'email', 'status', 'expires_at', 'token_hash'])
      .where('project_id', '=', projectId)
      .where('status', '!=', 'revoked')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const now = Date.now();
    for (const row of rows) {
      // A pending invite past its date is expired, whether or not a job has marked it yet.
      const status =
        row.status === 'pending' && row.expires_at.getTime() <= now ? 'expired' : row.status;
      const token =
        status === 'pending' && isDerived(invite.key, row.id, row.token_hash)
          ? inviteTokenFor(invite.key, invite.orgId, row.id)
          : null;
      if (row.email === OPEN_INVITE_EMAIL) {
        if (token) joinLink = { token, expires_at: row.expires_at.toISOString() };
        continue;
      }
      invites.push({
        id: row.id,
        email: row.email,
        status,
        expires_at: row.expires_at.toISOString(),
        token,
      });
    }
  }
  return { ...summary, invites, join_link: joinLink, can_invite: canInvite };
}
