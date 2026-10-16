import type { ArenaDetail, ArenaInvite, ArenaSummary, SdlcStage } from '@saras/contracts';
import { type Database, readInEachMemberProject, sqlLiteral, type Tx } from '@saras/db';
import { sql } from 'kysely';

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
  };
}

/** Summary of one arena. `tx` must be the verified tenant context of the project's org. */
export async function arenaSummary(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<ArenaSummary | undefined> {
  const { rows } = await sql<SummaryRow>`
    SELECT p.id, a.id AS arena_id, p.name, p.description, p.key,
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
  // One read per org, each in its verified tenant context, two round trips in all (@saras/db).
  const rows = await readInEachMemberProject<SummaryRow & { created_at: Date }>(
    userTx,
    userId,
    (ids) => `
      SELECT p.id, a.id AS arena_id, p.name, p.description, p.key, p.created_at,
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
      WHERE p.id IN ${ids} AND p.status = 'active'`,
  );
  // Newest first, as before.
  rows.sort(
    (x, y) =>
      new Date(y.created_at).getTime() - new Date(x.created_at).getTime() ||
      (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  );
  return rows.map(toSummary);
}

/** One arena with, for its owner, the invites sent (never the links). Tenant `tx`. */
export async function arenaDetail(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<ArenaDetail | undefined> {
  const summary = await arenaSummary(tx, projectId, userId);
  if (!summary) return undefined;
  let invites: ArenaInvite[] = [];
  if (summary.role === 'owner') {
    const rows = await tx
      .selectFrom('invitations')
      .select(['id', 'email', 'status', 'expires_at'])
      .where('project_id', '=', projectId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const now = Date.now();
    invites = rows.map((row) => ({
      id: row.id,
      email: row.email,
      // A pending invite past its date is expired, whether or not a job has marked it yet.
      status: row.status === 'pending' && row.expires_at.getTime() <= now ? 'expired' : row.status,
      expires_at: row.expires_at.toISOString(),
    }));
  }
  return { ...summary, invites };
}
