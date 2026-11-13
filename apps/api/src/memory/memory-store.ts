import type { Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import {
  readArenaEvents,
  readStateLog,
  stateVersion,
  type Writer,
  writeStateContent,
} from '../progress/progress-store.js';
import {
  type EdgeType,
  type MemoryEdge,
  type MemoryNode,
  type NodeAttrs,
  type NodeStatus,
  type NodeType,
  isProductNode,
} from './model.js';
import { type DayMaterial, factOf, type KnownItem, MAX_KNOWN } from './prompts.js';
import type { DaySource, ResolvePlan } from './resolver.js';
import { renderPlaybook } from './playbook.js';
import { runWindow } from './schedule.js';
import { loadPlaybook } from './playbook-store.js';
import { type ChapterStatus, type GraphSource, isMemoryStory, renderGraphJson } from './story.js';

// The arena's memory in the database (ADR-045): one day's material, the graph, the nightly rows and
// STATE.md. Every function takes the nightly job's system transaction for the arena's own org (or
// the snapshot's) and filters by the project. Message text is read here only to hand it to the
// arena's own AI; it is never logged and never stored in the graph (titles and summaries are the
// AI's words, with ids of their sources).

const MAX_DAY_MESSAGES = 600;
const MAX_DAY_FILES = 6;
const MAX_DAY_PULLS = 20;

/** [start, end) of a local day as ISO instants, from the database's zone rules. */
export async function dayBounds(
  tx: Tx,
  day: string,
  timezone: string,
): Promise<{ from: string; until: string }> {
  const { rows } = await sql<{ from: Date; until: Date }>`
    SELECT (${day}::date)::timestamp AT TIME ZONE ${timezone} AS "from",
           (${day}::date + 1)::timestamp AT TIME ZONE ${timezone} AS until`.execute(tx);
  const r = rows[0];
  if (!r) throw new Error('no bounds');
  return { from: r.from.toISOString(), until: r.until.toISOString() };
}

/** The arena's first local day (no chapter before it). */
export async function arenaFirstDay(tx: Tx, projectId: string, timezone: string): Promise<string> {
  const { rows } = await sql<{ day: string }>`
    SELECT to_char(created_at AT TIME ZONE ${timezone}, 'YYYY-MM-DD') AS day
      FROM projects WHERE id = ${projectId}`.execute(tx);
  return rows[0]?.day ?? '1970-01-01';
}

// ---------------------------------------------------------------- the graph

interface NodeRow {
  id: string;
  type: NodeType;
  key: string;
  title: string;
  summary: string;
  status: NodeStatus;
  attrs: NodeAttrs | null;
  first_seen_day: string;
  last_seen_day: string;
}

/** Every node of the arena (closed ones too: the story shows replaced decisions). */
export async function loadNodes(tx: Tx, projectId: string): Promise<MemoryNode[]> {
  const { rows } = await sql<NodeRow>`
    SELECT id, type, key, title, summary, status, attrs,
           to_char(first_seen_day, 'YYYY-MM-DD') AS first_seen_day,
           to_char(last_seen_day, 'YYYY-MM-DD') AS last_seen_day
      FROM kg_nodes WHERE project_id = ${projectId}
     ORDER BY created_at, key`.execute(tx);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    key: r.key,
    title: r.title,
    summary: r.summary,
    status: r.status,
    attrs: r.attrs ?? {},
    firstSeenDay: r.first_seen_day,
    lastSeenDay: r.last_seen_day,
  }));
}

/** The live edges (valid_to null). */
export async function loadEdges(tx: Tx, projectId: string): Promise<MemoryEdge[]> {
  const { rows } = await sql<{
    id: string;
    src: string;
    dst: string;
    type: EdgeType;
    confidence: number;
  }>`
    SELECT id, src, dst, type, confidence FROM kg_edges
     WHERE project_id = ${projectId} AND valid_to IS NULL`.execute(tx);
  return rows.map((r) => ({ ...r, confidence: Number(r.confidence) }));
}

/** The items the AI is shown so it reuses their keys (open and live first, newest seen first). */
export function knownItems(nodes: readonly MemoryNode[]): KnownItem[] {
  return (
    [...nodes]
      // The product summary is not an item to reuse: the extraction replaces it with `product`.
      .filter((n) => n.status !== 'dropped' && n.status !== 'superseded' && !isProductNode(n))
      .sort((a, b) => b.lastSeenDay.localeCompare(a.lastSeenDay))
      .slice(0, MAX_KNOWN)
      .map((n) => ({ type: n.type, key: n.key, title: n.title, status: n.status }))
  );
}

/** Writes a resolved day: new nodes, updated nodes, new edges, their sources. */
export async function applyPlan(
  tx: Tx,
  scope: { orgId: string; projectId: string },
  plan: ResolvePlan,
  day: string,
  at: string,
): Promise<void> {
  for (const n of plan.creates) {
    await sql`
      INSERT INTO kg_nodes (id, org_id, project_id, type, key, title, summary, status, attrs,
                            valid_from, first_seen_day, last_seen_day)
      VALUES (${n.id}, ${scope.orgId}, ${scope.projectId}, ${n.type}, ${n.key}, ${n.title},
              ${n.summary}, ${n.status}, ${JSON.stringify(n.attrs)}::jsonb, ${at}::timestamptz,
              ${n.firstSeenDay}::date, ${n.lastSeenDay}::date)`.execute(tx);
  }
  for (const n of plan.updates) {
    await sql`
      UPDATE kg_nodes
         SET title = ${n.title}, summary = ${n.summary}, status = ${n.status},
             attrs = ${JSON.stringify(n.attrs)}::jsonb,
             last_seen_day = GREATEST(last_seen_day, ${n.lastSeenDay}::date),
             valid_to = COALESCE(valid_to, ${n.validTo ?? null}::timestamptz),
             updated_at = now()
       WHERE id = ${n.id} AND project_id = ${scope.projectId}`.execute(tx);
  }
  for (const e of plan.edges) {
    await sql`
      INSERT INTO kg_edges (id, org_id, project_id, src, dst, type, confidence, valid_from,
                            created_day)
      VALUES (${e.id}, ${scope.orgId}, ${scope.projectId}, ${e.src}, ${e.dst}, ${e.type},
              ${e.confidence}, ${at}::timestamptz, ${day}::date)
      ON CONFLICT DO NOTHING`.execute(tx);
  }
  for (const s of plan.sources) {
    await sql`
      INSERT INTO kg_sources (org_id, project_id, node_id, edge_id, source_type, source_id, day)
      SELECT ${scope.orgId}, ${scope.projectId}, ${s.nodeId ?? null}::uuid, ${s.edgeId ?? null}::uuid,
             ${s.source.type}, ${s.source.id}, ${day}::date
       WHERE ${s.edgeId ?? null}::uuid IS NULL
          OR EXISTS (SELECT 1 FROM kg_edges WHERE id = ${s.edgeId ?? null}::uuid)
      ON CONFLICT DO NOTHING`.execute(tx);
  }
}

// ---------------------------------------------------------------- one day's material

export interface DayInput {
  material: DayMaterial;
  sources: Map<string, DaySource>;
  counts: { people: number; ai: number };
  /** No people talked and nothing was recorded: no AI call, a quiet row. */
  quiet: boolean;
  /** The day's end: when what was said that day became true. */
  at: string;
}

/**
 * Everything the AI reads about one local day of the arena, with citable refs: the whole day, or
 * with `after` / `until` only that part of it (an event run, or the night after event runs).
 */
export async function collectDay(
  tx: Tx,
  input: {
    projectId: string;
    arenaId: string;
    day: string;
    timezone: string;
    arenaName: string;
    after?: string | null;
    until?: string | null;
  },
): Promise<DayInput> {
  const { projectId, arenaId, day, timezone } = input;
  const range = runWindow(
    await dayBounds(tx, day, timezone),
    input.after ?? null,
    input.until ?? null,
  );
  const sources = new Map<string, DaySource>();
  const localTime = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(iso));

  const { rows: messages } = await sql<{
    id: string;
    author_type: string;
    author: string | null;
    body: string;
    created_at: Date;
  }>`
    SELECT m.id, m.author_type::text AS author_type, u.display_name AS author, m.body, m.created_at
      FROM messages m
      LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
     WHERE m.arena_id = ${arenaId} AND m.deleted_at IS NULL
       AND m.created_at >= ${range.from}::timestamptz AND m.created_at < ${range.until}::timestamptz
     ORDER BY m.created_at, m.id
     LIMIT ${MAX_DAY_MESSAGES}`.execute(tx);

  const events = (await readArenaEvents(tx, projectId, range, 400)).reverse();

  const { rows: files } = await sql<{
    artifact_id: string;
    name: string;
    version_no: number;
    content: Buffer | null;
  }>`
    SELECT a.id AS artifact_id, a.name, v.version_no, substring(b.content FROM 1 FOR 2400) AS content
      FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE a.project_id = ${projectId} AND a.scope = 'project'
       AND a.kind NOT IN ('progress', 'stage_summary')
       AND v.approved_at >= ${range.from}::timestamptz AND v.approved_at < ${range.until}::timestamptz
     ORDER BY v.approved_at
     LIMIT ${MAX_DAY_FILES}`.execute(tx);

  const { rows: pulls } = await sql<{
    id: string;
    number: number;
    github_number: number | null;
    title: string;
    status: string;
    description: string;
  }>`
    SELECT id, number, github_number, title, status, description FROM pull_requests
     WHERE project_id = ${projectId}
       AND ((created_at >= ${range.from}::timestamptz AND created_at < ${range.until}::timestamptz)
         OR (updated_at >= ${range.from}::timestamptz AND updated_at < ${range.until}::timestamptz))
     ORDER BY created_at
     LIMIT ${MAX_DAY_PULLS}`.execute(tx);

  const cycle = await tx
    .selectFrom('sdlc_cycles')
    .select(['number', 'stage'])
    .where('project_id', '=', projectId)
    .orderBy('number', 'desc')
    .executeTakeFirst();

  const material: DayMaterial = {
    arenaName: input.arenaName,
    day,
    timezone,
    stage: cycle?.stage ?? null,
    cycle: cycle?.number ?? null,
    messages: messages.map((m, i) => {
      const ref = `M${i + 1}`;
      sources.set(ref, { type: 'message', id: m.id });
      return {
        ref,
        time: localTime(m.created_at.toISOString()),
        author: m.author ?? 'A former teammate',
        ai: m.author_type !== 'user',
        text: m.body,
      };
    }),
    events: events.map((e, i) => {
      const ref = `E${i + 1}`;
      sources.set(ref, { type: 'event', id: e.id });
      return { ref, time: localTime(e.at), line: factOf(e) };
    }),
    files: files.map((f, i) => {
      const ref = `F${i + 1}`;
      sources.set(ref, { type: 'artifact_version', id: `${f.artifact_id}:${f.version_no}` });
      return {
        ref,
        name: f.name,
        version: f.version_no,
        excerpt: f.content ? f.content.toString('utf8') : '',
      };
    }),
    pulls: pulls.map((p, i) => {
      const ref = `P${i + 1}`;
      sources.set(ref, { type: 'pull_request', id: p.id });
      return {
        ref,
        number: p.github_number ?? p.number,
        title: p.title,
        state: p.status,
        excerpt: p.description,
      };
    }),
    known: [],
  };
  const people = messages.filter((m) => m.author_type === 'user').length;
  return {
    material,
    sources,
    counts: { people, ai: messages.length - people },
    quiet: people === 0 && events.length === 0,
    at: range.until,
  };
}

// ---------------------------------------------------------------- nightly rows

export interface DayRow {
  day: string;
  status: ChapterStatus;
  title: string | null;
  chapter: string | null;
  story: string | null;
  stage: string | null;
  cycle: number | null;
  attempts: number;
}

/** Writes the day's row (a retry replaces a failed day's text). */
export async function saveDay(
  tx: Tx,
  scope: { orgId: string; projectId: string },
  row: DayRow,
): Promise<void> {
  await sql`
    INSERT INTO state_days (org_id, project_id, day, status, title, chapter, story, stage, cycle,
                            attempts)
    VALUES (${scope.orgId}, ${scope.projectId}, ${row.day}::date, ${row.status}, ${row.title},
            ${row.chapter}, ${row.story}, ${row.stage}, ${row.cycle}, ${row.attempts})
    ON CONFLICT (project_id, day) DO UPDATE
       SET status = EXCLUDED.status, title = EXCLUDED.title, chapter = EXCLUDED.chapter,
           story = EXCLUDED.story, stage = EXCLUDED.stage, cycle = EXCLUDED.cycle,
           attempts = EXCLUDED.attempts, updated_at = now()
     WHERE state_days.status NOT IN ('done', 'quiet')`.execute(tx);
}

/** The arena's nightly rows, oldest first. */
export async function loadDays(tx: Tx, projectId: string): Promise<DayRow[]> {
  const { rows } = await sql<DayRow>`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, status, title, chapter, story, stage, cycle, attempts
      FROM state_days WHERE project_id = ${projectId} ORDER BY day`.execute(tx);
  return rows;
}

/** Failed days still worth another try, oldest first. */
export const retryable = (days: readonly DayRow[], from: string, maxAttempts = 3): DayRow[] =>
  days.filter((d) => d.status === 'failed' && d.attempts < maxAttempts && d.day >= from);

/**
 * The end of what the event runs already read of `day` (its pending row's updated_at), or null
 * when no event run read any of it. The night then extracts only what came after.
 */
export async function dayWatermark(tx: Tx, projectId: string, day: string): Promise<string | null> {
  const { rows } = await sql<{ updated_at: Date }>`
    SELECT updated_at FROM state_days
     WHERE project_id = ${projectId} AND day = ${day}::date AND status = 'pending'`.execute(tx);
  return rows[0]?.updated_at.toISOString() ?? null;
}

/**
 * An event run read `day` up to `until`: the day's row stays pending (not told yet; the night tells
 * it) and its updated_at is the new watermark. Never touches a told day.
 */
export async function markDayRead(
  tx: Tx,
  scope: { orgId: string; projectId: string },
  input: { day: string; until: string; stage: string | null; cycle: number | null },
): Promise<void> {
  await sql`
    INSERT INTO state_days (org_id, project_id, day, status, stage, cycle, updated_at)
    VALUES (${scope.orgId}, ${scope.projectId}, ${input.day}::date, 'pending', ${input.stage},
            ${input.cycle}, ${input.until}::timestamptz)
    ON CONFLICT (project_id, day) DO UPDATE
       SET stage = EXCLUDED.stage, cycle = EXCLUDED.cycle,
           updated_at = GREATEST(state_days.updated_at, EXCLUDED.updated_at)
     WHERE state_days.status = 'pending'`.execute(tx);
}

/** About this many people's messages since the memory last read the arena: a busy stretch. */
export const MEMORY_MESSAGE_THRESHOLD = 20;

/**
 * Whether people have talked enough since the memory last read the arena (its newest day row, the
 * event runs' watermark or the night's). Checked after each arena message, in the post's own
 * transaction; stops counting at the threshold.
 */
export async function memoryDue(tx: Tx, projectId: string, arenaId: string): Promise<boolean> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM messages m
       WHERE m.arena_id = ${arenaId} AND m.author_type = 'user' AND m.deleted_at IS NULL
         AND m.created_at > COALESCE(
               (SELECT max(d.updated_at) FROM state_days d WHERE d.project_id = ${projectId}),
               '-infinity'::timestamptz)
       LIMIT ${MEMORY_MESSAGE_THRESHOLD}) recent`.execute(tx);
  return Number(rows[0]?.n ?? 0) >= MEMORY_MESSAGE_THRESHOLD;
}

/** The schedule moves on: this day (and every day before it) has a row. */
export async function advanceSchedule(tx: Tx, projectId: string, day: string): Promise<void> {
  await sql`
    UPDATE memory_schedule SET last_day = GREATEST(COALESCE(last_day, ${day}::date), ${day}::date),
                               updated_at = now()
     WHERE project_id = ${projectId}`.execute(tx);
}

// ---------------------------------------------------------------- STATE.md and graph.json

export interface MemoryFiles {
  story: string;
  graph: string;
  legacy: string | null;
}

/** The STATE.md version before the memory, if the arena had one. */
async function legacyState(
  tx: Tx,
  projectId: string,
): Promise<{ versionNo: number; content: string } | null> {
  const doc = await readStateLog(tx, projectId);
  if (!doc) return null;
  if (!isMemoryStory(doc.content)) return { versionNo: doc.versionNo, content: doc.content };
  const v = doc.source?.legacy_version;
  if (typeof v !== 'number') return null;
  const content = await stateVersion(tx, doc.id, v);
  return content === null ? null : { versionNo: v, content };
}

/** STATE.md (the product playbook), graph.json and the legacy STATE.md, as of now. */
export async function renderMemoryFiles(tx: Tx, projectId: string): Promise<MemoryFiles> {
  const input = await loadPlaybook(tx, projectId);
  const legacy = await legacyState(tx, projectId);
  const { rows: sources } = await sql<{
    node_id: string | null;
    edge_id: string | null;
    source_type: string;
    source_id: string;
  }>`
    SELECT node_id, edge_id, source_type, source_id FROM kg_sources
     WHERE project_id = ${projectId} ORDER BY day, id`.execute(tx);
  return {
    story: renderPlaybook({
      ...input,
      facts: { ...input.facts, hasLegacy: legacy !== null },
    }),
    graph: renderGraphJson({
      arenaName: input.facts.arenaName,
      upTo: input.upTo,
      nodes: input.nodes,
      edges: input.edges,
      sources: sources.map((s): GraphSource => ({
        nodeId: s.node_id,
        edgeId: s.edge_id,
        type: s.source_type,
        id: s.source_id,
      })),
    }),
    legacy: legacy?.content ?? null,
  };
}

/** Rewrites the app's STATE.md from the memory; keeps the pre-memory version as its legacy. */
export async function writeStory(
  tx: Tx,
  writer: Writer,
  generated: 'ai' | 'auto',
): Promise<boolean> {
  const before = await readStateLog(tx, writer.projectId);
  const legacy = await legacyState(tx, writer.projectId);
  const files = await renderMemoryFiles(tx, writer.projectId);
  if (before?.content === files.story) return false;
  const days = await loadDays(tx, writer.projectId);
  await writeStateContent(tx, writer, files.story, {
    type: 'memory_story',
    day: days.filter((d) => d.status !== 'pending').at(-1)?.day ?? null,
    legacy_version: legacy?.versionNo ?? null,
    generated,
  });
  return true;
}

/** May STATE.md go into the arena's repo? Not to a GitHub repo unless it is private (ADR-045). */
export async function storyMayBePublished(tx: Tx, projectId: string): Promise<boolean> {
  const repo = await tx
    .selectFrom('arena_github_repos')
    .select('repo_private')
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  return !repo || repo.repo_private === true;
}
