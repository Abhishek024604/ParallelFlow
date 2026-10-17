import type { Database, Tx } from '@saras/db';
import { sql } from 'kysely';
import type { Autonomy } from './policy.js';
import type { ToolPrincipal } from './token.js';
import type { CallAudit, ToolBackend } from './tools.js';

// Database access for App Tools (ADR-035). The verified ToolToken is the authorisation:
//   arena token   → withSystemJob for the token's org (the agent is no user), and every query is
//                   filtered by the token's project, so one arena never reads another's rows;
//   private token → withUser(on_behalf_of): owner-only RLS (ADR-034) plus an explicit owner filter;
//   bound private → withSystemJob for the bound project's org after a membership check.
// Allowlisted in eslint.config.mjs (APP_TOOLS_DB_ALLOWLIST). Nothing here logs content.

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;
const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 20;
const ARTIFACT_TEXT_MAX = 100_000;
const SNIPPET = 400;

const clamp = (n: number | undefined, dflt: number, max: number): number =>
  Math.min(Math.max(1, n ?? dflt), max);

const snippet = (text: string): string =>
  text.length <= SNIPPET ? text : `${text.slice(0, SNIPPET - 1)}…`;

/**
 * Small in-process TTL cache for checks that every tool call repeats (each one is a transaction, and
 * a round trip to a remote database costs ~250 ms). Bounded; cleared when full. SLICE_DEBT.md.
 */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; until: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 5_000,
  ) {}

  async get(key: string, load: () => Promise<V>, keep: (value: V) => boolean): Promise<V> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.until > now) return hit.value;
    const value = await load();
    if (keep(value)) {
      if (this.entries.size >= this.max) this.entries.clear();
      this.entries.set(key, { value, until: now + this.ttlMs });
    }
    return value;
  }
}

/** Membership and agent policy: trusted for 30 s, like the API's account check. */
const CHECK_TTL_MS = 30_000;
/** A turn never moves to another session: a positive answer holds for the turn's life. */
const TURN_TTL_MS = 60 * 60_000;

export class DbToolBackend implements ToolBackend {
  private readonly members = new TtlCache<boolean>(CHECK_TTL_MS);
  private readonly policies = new TtlCache<Autonomy | null>(CHECK_TTL_MS);
  private readonly turns = new TtlCache<boolean>(TURN_TTL_MS);

  constructor(private readonly db: Database) {}

  /** The context a token may use. */
  private run<T>(p: ToolPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (p.isPrivate) {
      if (!p.onBehalfOf) throw new Error('Private token without a user');
      return this.db.withUser({ userId: p.onBehalfOf }, fn);
    }
    return this.db.withSystemJob({ orgId: p.orgId }, fn);
  }

  private project(p: ToolPrincipal): string {
    if (!p.projectId) throw new Error('Token has no project');
    return p.projectId;
  }

  autonomy(p: ToolPrincipal, cls: string): Promise<Autonomy | null> {
    const projectId = this.project(p);
    const key = JSON.stringify([p.isPrivate, p.orgId, p.onBehalfOf, projectId, cls]);
    return this.policies.get(
      key,
      () => this.loadAutonomy(p, projectId, cls),
      () => true,
    );
  }

  private async loadAutonomy(
    p: ToolPrincipal,
    projectId: string,
    cls: string,
  ): Promise<Autonomy | null> {
    const row = await this.run(p, (tx) =>
      tx
        .selectFrom('agent_policies')
        .select('autonomy')
        .where('project_id', '=', projectId)
        .where('class', '=', cls)
        .executeTakeFirst(),
    );
    return row?.autonomy ?? null;
  }

  isProjectMember(p: ToolPrincipal): Promise<boolean> {
    const projectId = this.project(p);
    const userId = p.onBehalfOf;
    if (!userId) return Promise.resolve(false);
    // Only a yes is kept: a new membership is seen at once, a removed one within 30 s.
    const key = JSON.stringify([p.isPrivate, p.orgId, projectId, userId]);
    return this.members.get(
      key,
      () => this.loadMember(p, projectId, userId),
      (yes) => yes,
    );
  }

  private async loadMember(p: ToolPrincipal, projectId: string, userId: string): Promise<boolean> {
    const row = await this.run(p, (tx) =>
      tx
        .selectFrom('project_members')
        .select('user_id')
        .where('project_id', '=', projectId)
        .where('user_id', '=', userId)
        .executeTakeFirst(),
    );
    return Boolean(row);
  }

  turnBelongsToSession(p: ToolPrincipal, turnId: string): Promise<boolean> {
    const key = JSON.stringify([p.sessionKey, p.isPrivate, p.orgId, p.onBehalfOf, turnId]);
    return this.turns.get(
      key,
      () => this.loadTurnInSession(p, turnId),
      (yes) => yes,
    );
  }

  private async loadTurnInSession(p: ToolPrincipal, turnId: string): Promise<boolean> {
    const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
      p.isPrivate || !p.projectId || p.kind === 'personal'
        ? this.db.withUser({ userId: p.onBehalfOf ?? '' }, fn)
        : this.db.withSystemJob({ orgId: p.orgId }, fn);
    const row = await run((tx) =>
      tx
        .selectFrom('runtime_turns as t')
        .innerJoin('agent_sessions as s', 's.id', 't.agent_session_id')
        .select('t.id')
        .where('t.id', '=', turnId)
        .where('s.session_key', '=', p.sessionKey)
        .executeTakeFirst(),
    );
    return Boolean(row);
  }

  readHistory(p: ToolPrincipal, args: { before?: string; limit?: number }): Promise<unknown> {
    const projectId = this.project(p);
    const limit = clamp(args.limit, HISTORY_DEFAULT, HISTORY_MAX);
    return this.run(p, async (tx) => {
      const before = args.before ? sql`AND m.created_at < ${new Date(args.before)}` : sql``;
      const { rows } = await sql<{
        id: string;
        author_type: string;
        author_id: string;
        author_name: string | null;
        body: string;
        parent_id: string | null;
        created_at: Date;
      }>`
        SELECT m.id, m.author_type, m.author_id, coalesce(u.display_name, ag.name) AS author_name,
               m.body, m.parent_id, m.created_at
          FROM messages m
          JOIN arenas a ON a.id = m.arena_id
          LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
          LEFT JOIN agents ag ON m.author_type = 'agent' AND ag.id = m.author_id
         WHERE a.project_id = ${projectId} AND m.deleted_at IS NULL ${before}
         ORDER BY m.created_at DESC
         LIMIT ${limit}`.execute(tx);
      return rows.reverse().map((m) => ({
        message_id: m.id,
        author: { type: m.author_type, id: m.author_id, name: m.author_name ?? 'Teammate' },
        text: m.body,
        reply_to: m.parent_id,
        at: m.created_at.toISOString(),
      }));
    });
  }

  projectOverview(p: ToolPrincipal): Promise<unknown> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      const project = await tx
        .selectFrom('projects')
        .select(['id', 'name', 'description', 'goal', 'status', 'created_at'])
        .where('id', '=', projectId)
        .executeTakeFirst();
      if (!project) return null;
      const { rows } = await sql<{ members: number; artifacts: number }>`
        SELECT (SELECT count(*)::int FROM project_members WHERE project_id = ${projectId}) AS members,
               (SELECT count(*)::int FROM artifacts
                 WHERE project_id = ${projectId} AND scope = 'project') AS artifacts`.execute(tx);
      return {
        project_id: project.id,
        name: project.name,
        description: project.description,
        goal: project.goal,
        status: project.status,
        members: rows[0]?.members ?? 0,
        artifacts: rows[0]?.artifacts ?? 0,
      };
    });
  }

  listMembers(p: ToolPrincipal): Promise<unknown> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      const { rows } = await sql<{ user_id: string; display_name: string; roles: string[] }>`
        SELECT u.id AS user_id, u.display_name,
               coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL),
                        '{}') AS roles
          FROM project_members pm
          JOIN users u ON u.id = pm.user_id
          LEFT JOIN project_member_roles pmr
                 ON pmr.project_id = pm.project_id AND pmr.user_id = pm.user_id
          LEFT JOIN project_roles r ON r.id = pmr.role_id
         WHERE pm.project_id = ${projectId}
         GROUP BY u.id, u.display_name
         ORDER BY u.display_name`.execute(tx);
      return rows;
    });
  }

  cycleState(p: ToolPrincipal): Promise<unknown> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      const cycle = await tx
        .selectFrom('sdlc_cycles')
        .select(['number', 'title', 'stage', 'status', 'updated_at'])
        .where('project_id', '=', projectId)
        .orderBy('number', 'desc')
        .executeTakeFirst();
      return cycle
        ? {
            cycle_number: cycle.number,
            title: cycle.title,
            stage: cycle.stage,
            status: cycle.status,
            updated_at: new Date(cycle.updated_at).toISOString(),
          }
        : null;
    });
  }

  listArtifacts(
    p: ToolPrincipal,
    args: { cycle_number?: number; kind?: string },
  ): Promise<unknown> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      const kind = args.kind ? sql`AND a.kind::text = ${args.kind}` : sql``;
      const cycle =
        args.cycle_number !== undefined ? sql`AND c.number = ${args.cycle_number}` : sql``;
      const { rows } = await sql<{
        id: string;
        name: string;
        kind: string;
        stage: string | null;
        head_version_no: number;
        approved_version_no: number | null;
        cycle_number: number | null;
        updated_at: Date;
      }>`
        SELECT a.id, a.name, a.kind, a.stage, a.head_version_no, a.approved_version_no,
               c.number AS cycle_number, a.updated_at
          FROM artifacts a
          LEFT JOIN sdlc_cycles c ON c.id = a.cycle_id
         WHERE a.project_id = ${projectId} AND a.scope = 'project' ${kind} ${cycle}
         ORDER BY a.updated_at DESC
         LIMIT 100`.execute(tx);
      return rows.map((a) => ({
        artifact_id: a.id,
        name: a.name,
        kind: a.kind,
        stage: a.stage,
        cycle_number: a.cycle_number,
        latest_version_no: a.head_version_no,
        approved_version_no: a.approved_version_no,
        updated_at: a.updated_at.toISOString(),
      }));
    });
  }

  readArtifact(
    p: ToolPrincipal,
    args: { artifact_id: string; version_no?: number },
  ): Promise<unknown | null | 'NO_VERSION'> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      // The artifact and the asked (or head) version in one statement: one round trip.
      const { rows } = await sql<{
        id: string;
        name: string;
        kind: string;
        approved_version_no: number | null;
        version_no: number | null;
        status: string | null;
        content: Buffer | null;
        has_blob: boolean;
      }>`
        SELECT a.id, a.name, a.kind, a.approved_version_no, v.version_no, v.status, b.content,
               b.sha256 IS NOT NULL AS has_blob
          FROM artifacts a
          LEFT JOIN artifact_versions v
            ON v.artifact_id = a.id
           AND v.version_no = coalesce(${args.version_no ?? null}::int, a.head_version_no)
          LEFT JOIN blobs b ON b.sha256 = v.blob_sha256 AND b.org_id = v.org_id
         WHERE a.id = ${args.artifact_id} AND a.project_id = ${projectId}
           AND a.scope = 'project'`.execute(tx);
      const artifact = rows[0];
      if (!artifact) return null;
      if (artifact.version_no === null || !artifact.has_blob) return 'NO_VERSION';
      const versionNo = artifact.version_no;
      const version = { status: artifact.status };
      const text = artifact.content?.toString('utf8') ?? '';
      return {
        artifact_id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        version_no: versionNo,
        status: version.status,
        approved: artifact.approved_version_no === versionNo,
        content: text.length <= ARTIFACT_TEXT_MAX ? text : `${text.slice(0, ARTIFACT_TEXT_MAX)}…`,
        truncated: text.length > ARTIFACT_TEXT_MAX,
      };
    });
  }

  search(p: ToolPrincipal, args: { query: string; limit?: number }): Promise<unknown> {
    const limit = clamp(args.limit, SEARCH_DEFAULT, SEARCH_MAX);
    const query = args.query.trim().slice(0, 200);
    if (!query) return Promise.resolve([]);
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.run(p, async (tx) => {
      // Arena (or bound) token: this project's arena only. Private token: the user's own chats.
      const where =
        p.projectId !== null
          ? sql`m.arena_id IN (SELECT id FROM arenas WHERE project_id = ${p.projectId})`
          : sql`m.private_session_id IN (SELECT id FROM private_sessions
                                          WHERE owner_user_id = ${p.onBehalfOf})`;
      const { rows: messages } = await sql<{ id: string; body: string; created_at: Date }>`
        SELECT m.id, m.body, m.created_at
          FROM messages m
         WHERE ${where} AND m.deleted_at IS NULL
           AND m.body_tsv @@ plainto_tsquery('simple', ${query})
         ORDER BY ts_rank(m.body_tsv, plainto_tsquery('simple', ${query})) DESC, m.created_at DESC
         LIMIT ${limit}`.execute(tx);
      const artifactWhere =
        p.projectId !== null
          ? sql`a.project_id = ${p.projectId} AND a.scope = 'project'`
          : sql`a.scope = 'private' AND a.owner_user_id = ${p.onBehalfOf}`;
      const { rows: artifacts } = await sql<{ id: string; name: string; kind: string }>`
        SELECT a.id, a.name, a.kind FROM artifacts a
         WHERE ${artifactWhere} AND a.name ILIKE ${like}
         ORDER BY a.updated_at DESC
         LIMIT ${limit}`.execute(tx);
      return [
        ...artifacts.map((a) => ({
          resource_type: 'artifact',
          resource_id: a.id,
          title: a.name,
          kind: a.kind,
        })),
        ...messages.map((m) => ({
          resource_type: 'message',
          resource_id: m.id,
          snippet: snippet(m.body),
          at: m.created_at.toISOString(),
        })),
      ];
    });
  }

  async logCall(p: ToolPrincipal, audit: CallAudit): Promise<void> {
    // Private audit rows must name a turn of the owner's session (RLS, migration 0006).
    if (p.isPrivate && !audit.turnId) return;
    await this.run(p, (tx) =>
      tx
        .insertInto('app_tool_calls')
        .values({
          org_id: p.isPrivate ? null : p.orgId,
          turn_id: audit.turnId,
          session_key: p.sessionKey,
          tool: audit.tool,
          args_hash: audit.argsHash,
          outcome: audit.outcome,
          deny_code: audit.denyCode,
          latency_ms: audit.latencyMs,
        })
        .execute(),
    );
  }
}
