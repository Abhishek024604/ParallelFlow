import { authorLabel, plainDateTime, sourceLabel } from '@parallelflow/contracts';
import {
  type Database,
  enterProjectMember,
  fileKey,
  fileKeysCte,
  MembershipInactiveError,
  NotVisibleError,
  parseFileKey,
  recordArenaEvent,
  requestStageGate,
  type Tx,
} from '@parallelflow/db';
import { sql } from 'kysely';
import type { Autonomy } from './policy.js';
import type { ToolPrincipal } from './token.js';
import { fileText } from './file-text.js';
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
const RECALL_DEFAULT = 8;
const RECALL_MAX = 20;
const ARTIFACT_TEXT_MAX = 100_000;
/** arena.file: one arena file's text in a linked chat, cut beyond this (a turn's context is shared). */
export const ARENA_FILE_TEXT_MAX = 40_000;
const ARENA_READ = 'arena.read';
const SNIPPET = 400;

/**
 * Who wrote version `v` and who approved it (joins with prefix `p`): the author, the person an
 * arena AI turn was for (runtime_turns.requested_by) and the approver. Same tenant rows only.
 */
const versionPeople = (v: string, p: string) =>
  sql.raw(`LEFT JOIN users ${p}_u ON ${v}.created_by_type = 'user' AND ${p}_u.id = ${v}.created_by
       LEFT JOIN users ${p}_a ON ${p}_a.id = ${v}.approved_by
       LEFT JOIN runtime_turns ${p}_t
              ON ${v}.created_by_type = 'agent' AND ${v}.source_ref->>'type' = 'arena_turn'
             AND ${p}_t.id = CASE WHEN ${v}.source_ref->>'id' ~ '^[0-9a-fA-F-]{36}$'
                                  THEN (${v}.source_ref->>'id')::uuid END
       LEFT JOIN users ${p}_r ON ${p}_r.id = ${p}_t.requested_by`);

const versionPeopleColumns = (v: string, p: string) =>
  sql.raw(`${v}.created_by_type AS ${p}_type, ${p}_u.display_name AS ${p}_name,
          ${p}_r.display_name AS ${p}_for, ${v}.source_ref->>'type' AS ${p}_source,
          (${v}.source_ref->>'version_no')::int AS ${p}_private_no,
          ${p}_a.display_name AS ${p}_approver, ${v}.approved_at AS ${p}_approved_at,
          ${v}.created_at AS ${p}_at`);

interface PeopleRow {
  type: 'user' | 'agent' | 'service' | null;
  name: string | null;
  for: string | null;
  source: string | null;
  private_no: number | null;
  approver: string | null;
  approved_at: Date | null;
  at: Date | null;
}

const peopleOf = (row: Record<string, unknown>, p: string): PeopleRow => ({
  type: (row[`${p}_type`] ?? null) as PeopleRow['type'],
  name: (row[`${p}_name`] ?? null) as string | null,
  for: (row[`${p}_for`] ?? null) as string | null,
  source: (row[`${p}_source`] ?? null) as string | null,
  private_no: (row[`${p}_private_no`] ?? null) as number | null,
  approver: (row[`${p}_approver`] ?? null) as string | null,
  approved_at: (row[`${p}_approved_at`] ?? null) as Date | null,
  at: (row[`${p}_at`] ?? null) as Date | null,
});

/** Plain words for the AI: who wrote a version, how it got here, who approved it. No ids. */
export function describeVersion(
  people: PeopleRow,
  versionNo: number,
): {
  written_by?: string;
  how?: string;
  when?: string;
  approved_by?: string | null;
  approved_on?: string;
} {
  if (!people.type) return {};
  const facts = {
    sourceType: people.source,
    authorType: people.type,
    authorName: people.name,
    onBehalfOfName: people.for,
    versionNo,
    privateVersionNo: people.private_no,
  };
  return {
    written_by: authorLabel(facts),
    how: sourceLabel(facts),
    ...(people.at && { when: plainDateTime(people.at) }),
    approved_by: people.approver,
    ...(people.approved_at && { approved_on: plainDateTime(people.approved_at) }),
  };
}

const clamp = (n: number | undefined, dflt: number, max: number): number =>
  Math.min(Math.max(1, n ?? dflt), max);

/** Text cut at `max` characters, saying so (arena.file). */
export function cutText(
  text: string,
  max: number,
): { content: string; truncated: boolean; note?: string } {
  if (text.length <= max) return { content: text, truncated: false };
  return {
    content: `${text.slice(0, max)}…`,
    truncated: true,
    note: `Only the first ${max.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters are shown.`,
  };
}

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
        // No author ids: the AI refers to people by name. `at` stays exact (the `before` cursor).
        author: { type: m.author_type, name: m.author_name ?? 'Teammate' },
        text: m.body,
        reply_to: m.parent_id,
        at: m.created_at.toISOString(),
        when: plainDateTime(m.created_at),
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
        name: project.name,
        description: project.description,
        goal: project.goal,
        status: project.status,
        members: rows[0]?.members ?? 0,
        artifacts: rows[0]?.artifacts ?? 0,
      };
    });
  }

  async requestGate(
    p: ToolPrincipal,
    args: { summary: string; artifact_id?: string },
    turnId: string | null,
  ): Promise<Record<string, unknown>> {
    const projectId = this.project(p);
    if (p.kind !== 'central' || p.isPrivate) throw new Error('stage.request_gate is central only');
    const turn = turnId && (await this.turnBelongsToSession(p, turnId)) ? turnId : null;
    // System job for the token's org (the agent is no user); the request is the project's own.
    const out = await this.db.withSystemJob({ orgId: p.orgId }, (tx) =>
      requestStageGate(tx, {
        orgId: p.orgId,
        projectId,
        actor: { type: 'agent', id: p.agentId },
        summary: args.summary,
        artifactId: args.artifact_id ?? null,
        turnId: turn,
      }),
    );
    if (out.ok) {
      return {
        status: 'requested',
        approval_id: out.approvalId,
        cycle_number: out.cycleNumber,
        stage: out.stage,
        moves_to: out.toStage,
        approver_roles: out.approverRoles,
        min_approvals: out.minApprovals,
        note: 'The gate approvers decide. The AI cannot approve.',
      };
    }
    const why: Record<typeof out.reason, string> = {
      FORBIDDEN: 'Not allowed.',
      NO_CYCLE: 'There is no active cycle.',
      CYCLE_MISMATCH: 'There is no active cycle.',
      NO_GATE: 'This stage has no gate to request.',
      NOT_APPROVAL: 'This stage moves on without approval.',
      PENDING: 'A request for this gate is already waiting for approval.',
    };
    return { status: 'not_requested', reason: why[out.reason] };
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
      const { rows } = await sql<
        {
          id: string;
          name: string;
          kind: string;
          stage: string | null;
          head_version_no: number;
          approved_version_no: number | null;
          cycle_number: number | null;
          updated_at: Date;
          approver: string | null;
        } & Record<string, unknown>
      >`
        SELECT a.id, a.name, a.kind, a.stage, a.head_version_no, a.approved_version_no,
               c.number AS cycle_number, a.updated_at, ${versionPeopleColumns('hv', 'h')},
               ap_u.display_name AS approver
          FROM artifacts a
          LEFT JOIN sdlc_cycles c ON c.id = a.cycle_id
          LEFT JOIN artifact_versions hv
                 ON hv.artifact_id = a.id AND hv.version_no = a.head_version_no
          ${versionPeople('hv', 'h')}
          LEFT JOIN artifact_versions apv
                 ON apv.artifact_id = a.id AND apv.version_no = a.approved_version_no
          LEFT JOIN users ap_u ON ap_u.id = apv.approved_by
         WHERE a.project_id = ${projectId} AND a.scope = 'project' ${kind} ${cycle}
         ORDER BY a.updated_at DESC
         LIMIT 100`.execute(tx);
      return rows.map((a) => {
        const latest = describeVersion(peopleOf(a, 'h'), a.head_version_no);
        return {
          artifact_id: a.id,
          name: a.name,
          kind: a.kind,
          stage: a.stage,
          cycle_number: a.cycle_number,
          latest_version_no: a.head_version_no,
          latest_written_by: latest.written_by ?? null,
          latest_how: latest.how ?? null,
          approved_version_no: a.approved_version_no,
          approved_by: a.approved_version_no ? a.approver : null,
          last_updated: plainDateTime(a.updated_at),
        };
      });
    });
  }

  readArtifact(
    p: ToolPrincipal,
    args: { artifact_id: string; version_no?: number },
  ): Promise<unknown | null | 'NO_VERSION'> {
    const projectId = this.project(p);
    return this.run(p, async (tx) => {
      // The artifact and the asked (or head) version in one statement: one round trip.
      const { rows } = await sql<
        {
          id: string;
          name: string;
          kind: string;
          approved_version_no: number | null;
          version_no: number | null;
          status: string | null;
          content: Buffer | null;
          has_blob: boolean;
        } & Record<string, unknown>
      >`
        SELECT a.id, a.name, a.kind, a.approved_version_no, v.version_no, v.status, b.content,
               b.sha256 IS NOT NULL AS has_blob, ${versionPeopleColumns('v', 'p')}
          FROM artifacts a
          LEFT JOIN artifact_versions v
            ON v.artifact_id = a.id
           AND v.version_no = coalesce(${args.version_no ?? null}::int, a.head_version_no)
          ${versionPeople('v', 'p')}
          LEFT JOIN blobs b ON b.sha256 = v.blob_sha256 AND b.org_id = v.org_id
         WHERE a.id = ${args.artifact_id} AND a.project_id = ${projectId}
           AND a.scope = 'project'`.execute(tx);
      const artifact = rows[0];
      if (!artifact) return null;
      if (artifact.version_no === null || !artifact.has_blob) return 'NO_VERSION';
      const versionNo = artifact.version_no;
      // The newest versions' history, in plain words (who, how, when, approved by).
      const { rows: history } = await sql<{ version_no: number } & Record<string, unknown>>`
        SELECT hv.version_no, ${versionPeopleColumns('hv', 'h')}
          FROM artifact_versions hv
          ${versionPeople('hv', 'h')}
         WHERE hv.artifact_id = ${artifact.id}
         ORDER BY hv.version_no DESC
         LIMIT 10`.execute(tx);
      const version = { status: artifact.status };
      const text = artifact.content?.toString('utf8') ?? '';
      return {
        artifact_id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        version_no: versionNo,
        status: version.status,
        approved: artifact.approved_version_no === versionNo,
        ...describeVersion(peopleOf(artifact, 'p'), versionNo),
        history: history.map((h) => ({
          version_no: h.version_no,
          ...describeVersion(peopleOf(h, 'h'), h.version_no),
        })),
        content: text.length <= ARTIFACT_TEXT_MAX ? text : `${text.slice(0, ARTIFACT_TEXT_MAX)}…`,
        truncated: text.length > ARTIFACT_TEXT_MAX,
      };
    });
  }

  /**
   * arena.file (linked private chat, ADR-034 bridge): the chat's one linked arena is read from the
   * owner's own row (user scope), then the file is read in that arena's verified tenant context
   * (enterProjectMember: the withProjectMember check of active project + org membership) after the
   * arena.read check. F-keys come
   * from fileKeysCte, the same numbering as the product playbook.
   */
  async arenaFile(p: ToolPrincipal, args: { file: string }): Promise<Record<string, unknown>> {
    const notAvailable = (reason: string) => ({ status: 'not_available', reason });
    const userId = p.onBehalfOf;
    if (p.kind !== 'personal' || !p.isPrivate || !userId || !p.privateSessionId) {
      return notAvailable('Arena files can be opened only from a private chat linked to an arena.');
    }
    const asked = args.file.trim();
    if (!asked) return notAvailable('Name a file by its key (like F-3) or its exact name.');
    const sessionId = p.privateSessionId;
    try {
      // One transaction: the owner's own chat row (user scope), then the arena's verified tenant
      // context (enterProjectMember, the withProjectMember check), like a Push (ADR-034).
      return await this.db.withUser({ userId }, async (tx) => {
        const link = await tx
          .selectFrom('private_sessions')
          .select('bound_project_id')
          .where('id', '=', sessionId)
          .where('owner_user_id', '=', userId)
          .executeTakeFirst();
        const projectId = link?.bound_project_id ?? null;
        if (!projectId) return notAvailable('This chat is not linked to an arena.');
        await enterProjectMember(tx, { projectId, userId });
        const cap = await tx
          .selectFrom('member_capabilities')
          .select('capability')
          .where('project_id', '=', projectId)
          .where('user_id', '=', userId)
          .where('capability', '=', ARENA_READ)
          .executeTakeFirst();
        if (!cap) return notAvailable('You cannot read the linked arena.');
        const n = parseFileKey(asked);
        const match =
          n !== null ? sql`k.n = ${n}` : sql`lower(a.name) = lower(${asked.slice(0, 200)})`;
        const { rows } = await sql<{
          n: number;
          name: string;
          head_version_no: number;
          approved_version_no: number | null;
          content_type: string | null;
          content: Buffer | null;
        }>`
          WITH ${fileKeysCte(projectId)}
          SELECT k.n, a.name, a.head_version_no, a.approved_version_no, b.content_type, b.content
            FROM file_keys k
            JOIN artifacts a ON a.id = k.artifact_id
            LEFT JOIN artifact_versions v
                   ON v.artifact_id = a.id AND v.version_no = a.head_version_no
            LEFT JOIN blobs b ON b.sha256 = v.blob_sha256 AND b.org_id = v.org_id
           WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.deleted_at IS NULL
             AND ${match}
           ORDER BY k.n
           LIMIT 1`.execute(tx);
        const file = rows[0];
        if (!file) {
          return {
            status: 'not_found',
            reason: `No file "${asked.slice(0, 120)}" in the linked arena. Use a key from its playbook's file list (like F-3) or the exact name.`,
          };
        }
        const type = file.content_type ?? 'text/plain';
        const read =
          type.startsWith('text/') || type === 'application/json'
            ? { text: file.content?.toString('utf8') ?? null, note: 'The file has no content.' }
            : await fileText(type, file.content);
        const base = {
          status: 'ok',
          key: fileKey(file.n),
          name: file.name,
          version_no: file.head_version_no,
          approved: file.approved_version_no === file.head_version_no,
          approved_version_no: file.approved_version_no,
        };
        if (read.text === null) return { ...base, readable: false, note: read.note };
        return { ...base, readable: true, ...cutText(read.text, ARENA_FILE_TEXT_MAX) };
      });
    } catch (err) {
      if (err instanceof NotVisibleError || err instanceof MembershipInactiveError) {
        return notAvailable('You are no longer a member of the linked arena.');
      }
      throw err;
    }
  }

  /** Uploaded files: the arena's (its org's blobs) or, for a private token, the owner's own. */
  private fileOwner(p: ToolPrincipal) {
    if (p.isPrivate) {
      if (!p.onBehalfOf) throw new Error('Private token without a user');
      return sql`org_id IS NULL AND owner_user_id = ${p.onBehalfOf}`;
    }
    return sql`org_id = ${p.orgId}`;
  }

  listFiles(p: ToolPrincipal, args: { limit?: number }): Promise<unknown> {
    const limit = clamp(args.limit, 50, 100);
    return this.run(p, async (tx) => {
      // Uploads carry a file name; artifact versions' blobs do not (they are read as artifacts).
      const { rows } = await sql<{
        id: string;
        name: string;
        content_type: string;
        size_bytes: string | number;
        created_at: Date;
      }>`
        SELECT id, name, content_type, size_bytes, created_at
          FROM blobs
         WHERE ${this.fileOwner(p)} AND name IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ${limit}`.execute(tx);
      return rows.map((f) => ({
        file_id: f.id,
        name: f.name,
        mime_type: f.content_type,
        size_bytes: Number(f.size_bytes),
        uploaded_at: f.created_at.toISOString(),
      }));
    });
  }

  readFile(p: ToolPrincipal, args: { file_id: string }): Promise<unknown | null> {
    return this.run(p, async (tx) => {
      const { rows } = await sql<{
        id: string;
        name: string | null;
        content_type: string;
        size_bytes: string | number;
        content: Buffer | null;
      }>`
        SELECT id, name, content_type, size_bytes, content
          FROM blobs
         WHERE id = ${args.file_id} AND ${this.fileOwner(p)} AND name IS NOT NULL`.execute(tx);
      const file = rows[0];
      if (!file) return null;
      const read = await fileText(file.content_type, file.content);
      const text = read.text ?? '';
      return {
        file_id: file.id,
        name: file.name,
        mime_type: file.content_type,
        size_bytes: Number(file.size_bytes),
        ...(read.text === null
          ? { readable: false, note: read.note }
          : {
              readable: true,
              content:
                text.length <= ARTIFACT_TEXT_MAX ? text : `${text.slice(0, ARTIFACT_TEXT_MAX)}…`,
              truncated: text.length > ARTIFACT_TEXT_MAX,
            }),
      };
    });
  }

  listPrivateArtifacts(
    p: ToolPrincipal,
    args: { limit?: number; this_chat?: boolean },
  ): Promise<unknown> {
    const limit = clamp(args.limit, 50, 100);
    // this_chat: only the documents of the chat the token belongs to (its session key).
    const chat =
      args.this_chat === true
        ? p.privateSessionId
          ? sql`AND a.private_session_id = ${p.privateSessionId}`
          : sql`AND false`
        : sql``;
    return this.run(p, async (tx) => {
      const { rows } = await sql<{
        id: string;
        name: string;
        kind: string;
        head_version_no: number;
        approved_version_no: number | null;
        updated_at: Date;
        by_ai: boolean | null;
      }>`
        SELECT a.id, a.name, a.kind, a.head_version_no, a.approved_version_no, a.updated_at,
               (hv.created_by_type = 'agent') AS by_ai
          FROM artifacts a
          LEFT JOIN artifact_versions hv
                 ON hv.artifact_id = a.id AND hv.version_no = a.head_version_no
         WHERE a.scope = 'private' AND a.owner_user_id = ${p.onBehalfOf} ${chat}
         ORDER BY a.updated_at DESC
         LIMIT ${limit}`.execute(tx);
      // No chat ids: the AI only needs the artifact id to read a file back.
      return rows.map((a) => ({
        artifact_id: a.id,
        name: a.name,
        kind: a.kind,
        latest_version_no: a.head_version_no,
        approved_version_no: a.approved_version_no,
        latest_written_by: a.by_ai ? 'AI' : 'you',
        last_updated: plainDateTime(a.updated_at),
      }));
    });
  }

  readPrivateArtifact(
    p: ToolPrincipal,
    args: { artifact_id: string; version_no?: number },
  ): Promise<unknown | null | 'NO_VERSION'> {
    return this.run(p, async (tx) => {
      const { rows } = await sql<{
        id: string;
        name: string;
        kind: string;
        version_no: number | null;
        content: Buffer | null;
        has_blob: boolean;
        created_by_type: string | null;
        created_at: Date | null;
      }>`
        SELECT a.id, a.name, a.kind, v.version_no, b.content, b.sha256 IS NOT NULL AS has_blob,
               v.created_by_type, v.created_at
          FROM artifacts a
          LEFT JOIN artifact_versions v
            ON v.artifact_id = a.id
           AND v.version_no = coalesce(${args.version_no ?? null}::int, a.head_version_no)
          LEFT JOIN blobs b
            ON b.sha256 = v.blob_sha256 AND b.owner_user_id = v.blob_owner_user_id
         WHERE a.id = ${args.artifact_id} AND a.scope = 'private'
           AND a.owner_user_id = ${p.onBehalfOf}`.execute(tx);
      const artifact = rows[0];
      if (!artifact) return null;
      if (artifact.version_no === null || !artifact.has_blob) return 'NO_VERSION';
      const text = artifact.content?.toString('utf8') ?? '';
      return {
        artifact_id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        version_no: artifact.version_no,
        written_by: artifact.created_by_type === 'agent' ? 'AI' : 'you',
        ...(artifact.created_at && { when: plainDateTime(artifact.created_at) }),
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

  recall(
    p: ToolPrincipal,
    args: { query: string; type?: string; limit?: number },
  ): Promise<unknown> {
    // Arena memory only: an unbound private token has no arena (the contract refuses it first).
    const projectId = this.project(p);
    const limit = clamp(args.limit, RECALL_DEFAULT, RECALL_MAX);
    const query = args.query.trim().slice(0, 200);
    if (!query) return Promise.resolve([]);
    const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.run(p, async (tx) => {
      const type = args.type ? sql`AND n.type = ${args.type}` : sql``;
      const { rows: nodes } = await sql<{
        id: string;
        type: string;
        key: string;
        title: string;
        summary: string;
        status: string;
        attrs: Record<string, unknown> | null;
        first_seen: string;
        last_seen: string;
      }>`
        SELECT n.id, n.type, n.key, n.title, n.summary, n.status, n.attrs,
               to_char(n.first_seen_day, 'YYYY-MM-DD') AS first_seen,
               to_char(n.last_seen_day, 'YYYY-MM-DD') AS last_seen
          FROM kg_nodes n
         WHERE n.project_id = ${projectId} ${type}
           AND (lower(n.key) = lower(${query})
                OR n.search @@ plainto_tsquery('simple', ${query})
                OR n.title ILIKE ${like})
         ORDER BY (lower(n.key) = lower(${query})) DESC,
                  ts_rank(n.search, plainto_tsquery('simple', ${query})) DESC,
                  n.last_seen_day DESC
         LIMIT ${limit}`.execute(tx);
      if (!nodes.length) return [];
      const ids = nodes.map((n) => n.id);
      const { rows: related } = await sql<{
        node_id: string;
        relation: string;
        direction: 'out' | 'in';
        type: string;
        key: string;
        title: string;
        status: string;
      }>`
        SELECT e.src AS node_id, e.type AS relation, 'out' AS direction, o.type, o.key, o.title, o.status
          FROM kg_edges e JOIN kg_nodes o ON o.id = e.dst
         WHERE e.project_id = ${projectId} AND e.valid_to IS NULL AND e.src = ANY(${ids}::uuid[])
        UNION ALL
        SELECT e.dst, e.type, 'in', o.type, o.key, o.title, o.status
          FROM kg_edges e JOIN kg_nodes o ON o.id = e.src
         WHERE e.project_id = ${projectId} AND e.valid_to IS NULL AND e.dst = ANY(${ids}::uuid[])
         LIMIT 400`.execute(tx);
      const { rows: sources } = await sql<{
        node_id: string;
        kind: string;
        count: number;
        first_day: string;
        last_day: string;
      }>`
        SELECT node_id, source_type AS kind, count(*)::int AS count,
               to_char(min(day), 'YYYY-MM-DD') AS first_day, to_char(max(day), 'YYYY-MM-DD') AS last_day
          FROM kg_sources
         WHERE project_id = ${projectId} AND node_id = ANY(${ids}::uuid[])
         GROUP BY node_id, source_type`.execute(tx);
      // No ids: the AI cites items by key ("D-003") and people by name.
      return nodes.map((n) => {
        const attrs = n.attrs ?? {};
        return {
          key: n.key,
          type: n.type,
          title: n.title,
          summary: n.summary,
          status: n.status,
          ...(typeof attrs.why === 'string' && { why: attrs.why }),
          ...(typeof attrs.by === 'string' && { by: attrs.by }),
          ...(Array.isArray(attrs.roles) && { roles: attrs.roles }),
          ...(attrs.needs_confirmation === true && { needs_confirmation: true }),
          first_seen: n.first_seen,
          last_seen: n.last_seen,
          related: related
            .filter((r) => r.node_id === n.id)
            .slice(0, 20)
            .map((r) => ({
              relation: r.direction === 'out' ? r.relation : `${r.relation} (from)`,
              key: r.key,
              type: r.type,
              title: r.title,
              status: r.status,
            })),
          sources: sources
            .filter((s) => s.node_id === n.id)
            .map((s) => ({
              kind: s.kind,
              count: s.count,
              first_day: s.first_day,
              last_day: s.last_day,
            })),
        };
      });
    });
  }

  async logCall(p: ToolPrincipal, audit: CallAudit): Promise<void> {
    // Private audit rows must name a turn of the owner's session (RLS, migration 0006).
    if (p.isPrivate && !audit.turnId) return;
    await this.run(p, async (tx) => {
      // A refused arena tool call is in the arena's activity log too (ADR-044): tool and code only.
      if (audit.outcome === 'denied' && !p.isPrivate && p.projectId && p.kind === 'central') {
        await recordArenaEvent(
          tx,
          { orgId: p.orgId, projectId: p.projectId },
          { type: 'agent', id: p.agentId },
          {
            action: 'ai.tool.denied',
            target: { type: 'tool', id: audit.tool },
            metadata: { tool: audit.tool, code: audit.denyCode },
          },
        );
      }
      await tx
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
        .execute();
    });
  }
}
