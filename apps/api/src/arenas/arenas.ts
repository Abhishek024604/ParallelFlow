import type { ArenaDetail, ArenaInvite, ArenaSummary, SdlcStage } from '@saras/contracts';
import { type Database, MembershipInactiveError, NotVisibleError, type Tx } from '@saras/db';
import { sql } from 'kysely';

// Reading arenas. The list starts in user scope (ADR-031: own project and org memberships, projects
// you belong to). Cycle, arena and member rows are tenant data that user scope does not show, so each
// arena's details are read in its own verified tenant context (withProjectMember). One short
// transaction per arena; fine for the handful of arenas a person has (SLICE_DEBT).

interface MyProjectRow {
  id: string;
  name: string;
  description: string | null;
  key: string;
}

/** Projects you are an active member of, newest first. `tx` must be your user scope. */
async function myProjects(tx: Tx, userId: string): Promise<MyProjectRow[]> {
  return tx
    .selectFrom('project_members as pm')
    .innerJoin('projects as p', 'p.id', 'pm.project_id')
    .select(['p.id', 'p.name', 'p.description', 'p.key'])
    .where('pm.user_id', '=', userId)
    .where('p.status', '=', 'active')
    .orderBy('p.created_at', 'desc')
    .orderBy('p.id')
    .execute();
}

/** Summary of one arena. `tx` must be the verified tenant context of the project's org. */
export async function arenaSummary(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<ArenaSummary | undefined> {
  const { rows } = await sql<{
    id: string;
    arena_id: string;
    name: string;
    description: string | null;
    key: string;
    cycle: number | null;
    stage: SdlcStage | null;
    member_count: string;
    is_owner: boolean;
  }>`
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
  if (!row) return undefined;
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

/** Your arenas (GET /arenas). `userTx` is the pipeline's user-scope transaction. */
export async function listArenas(
  db: Database,
  userTx: Tx,
  userId: string,
): Promise<ArenaSummary[]> {
  const projects = await myProjects(userTx, userId);
  const items: ArenaSummary[] = [];
  for (const project of projects) {
    const summary = await db
      .withProjectMember({ projectId: project.id, userId }, (tx) =>
        arenaSummary(tx, project.id, userId),
      )
      // Left between the two reads (or suspended meanwhile): just leave it out.
      .catch((err: unknown) => {
        if (err instanceof NotVisibleError || err instanceof MembershipInactiveError)
          return undefined;
        throw err;
      });
    if (summary) items.push(summary);
  }
  return items;
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
