import { createHash } from 'node:crypto';
import { uuidv7 } from '@parallelflow/contracts';
import { type ArenaEventAction, type Database, SYSTEM_USER_ID } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { sql } from 'kysely';
import type { TurnRunner } from '../agent/turn-runner.js';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import { arenaAgent, dbNow } from '../progress/progress-store.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildMemorySnapshot } from '../repo/snapshot.js';
import {
  advanceSchedule,
  applyPlan,
  arenaFirstDay,
  collectDay,
  type DayInput,
  type DayRow,
  dayWatermark,
  knownItems,
  loadDays,
  loadEdges,
  loadNodes,
  markDayRead,
  retryable,
  saveDay,
  writeStory,
} from './memory-store.js';
import { parseExtraction } from './model.js';
import {
  extractPrompt,
  factsChapter,
  narratePrompt,
  parseNarration,
  repairPrompt,
} from './prompts.js';
import { type DeltaItem, earlierDelta, resolveDay } from './resolver.js';
import { addDays, daysToRun, localClock, MAX_CATCH_UP } from './schedule.js';

// The nightly memory job (ADR-045). Every 15 minutes the API lists the arenas' zones and last told
// days (memory_schedule, under the scheduler credential: ids and dates only) and queues each arena
// whose day has ended (00:30 local, schedule.ts). Per arena, one at a time, for each day due (and
// each failed day of the last week, once a night):
//   1. collect   the day's messages, events, approved files and PRs, with citable refs; a day with
//                no people talking and nothing recorded is quiet (a row, no AI call)
//   2. extract   the arena's AI (a read-only Pi fork of its session, extract-memory skill, so the
//                arena's own AI key applies) returns strict JSON; one repair try when it does not
//                validate
//   3. resolve   deterministic code merges it into the graph (resolver.ts) and writes it
//   4. narrate   the AI tells the day (narrate-day skill) from what changed; when it cannot, the
//                day is told from the facts and marked failed, to be retold the next night
//   5. STATE.md  re-rendered from the graph and the chapters; arenas with a repo get one commit
//                ("Update logs: state"), and a GitHub repo only while it is private
// Each step opens withSystemJob for the arena's own org (eslint allowlist) and filters every query
// by the project. Logs carry ids, days, counts and outcomes only: never message text or prompts.
//
// Event runs (the playbook updates sooner): an approved gate, a file pushed or approved, or a busy
// stretch of chat (about 20 people's messages since the memory last read the arena) asks for a run
// of today so far (trigger). It extracts only what came after the last run (today's state_days row
// stays 'pending'; its updated_at is the watermark), resolves it into the graph and rewrites
// STATE.md. The chapter is still told at night, which then extracts only the rest of the day and
// narrates all of it. At most one event run per arena per EVENT_WINDOW_MS (a later trigger waits
// for the window's end), never beside another run of the arena (one chain per arena), and none
// while yesterday is not told yet. The nightly sweep stays the safety net.

export const MEMORY_JOBS = Symbol('MEMORY_JOBS');

export const MEMORY_TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** At most one event run per arena in this window. */
export const EVENT_WINDOW_MS = 10 * 60_000;
/** An event run waits this long, so the request that triggered it has committed. */
export const EVENT_SETTLE_MS = 30_000;
/** An event run reads up to this long before now: messages still being written wait for the next. */
const EVENT_LAG_MS = 10_000;

export type MemoryTrigger = 'gate' | 'file' | 'messages';

/** The arena events that refresh the playbook soon: an approved gate, a file pushed or approved. */
export function memoryTriggerOf(action: ArenaEventAction): MemoryTrigger | null {
  if (action === 'loop.gate.approved') return 'gate';
  if (action === 'file.approved' || action === 'file.pushed_from_private') return 'file';
  return null;
}

/** How long until the arena's next event run may start (pure; unit tested). */
export function eventRunDelay(now: number, lastRun: number | undefined): number {
  const free = lastRun === undefined ? now : lastRun + EVENT_WINDOW_MS;
  return Math.max(EVENT_SETTLE_MS, free - now);
}

/** The scheduler's credential (0017 memory_schedule_by_scheduler): SHA-256 of 'memory-scheduler'. */
export const SCHEDULER_CREDENTIAL = createHash('sha256').update('memory-scheduler').digest('hex');

interface ScheduleRow {
  project_id: string;
  org_id: string;
  timezone: string;
  last_day: string | null;
}

interface Arena {
  orgId: string;
  projectId: string;
  timezone: string;
}

type Scope = { orgId: string; projectId: string };

type ArenaAgent = { arenaId: string; agentId: string; agentSessionId: string };

interface Extracted {
  /** quiet: nothing to read; failed: the AI's reply never validated (nothing written). */
  status: 'quiet' | 'extracted' | 'failed';
  input: DayInput;
  delta: DeltaItem[];
  counts: { created: number; updated: number; edges: number };
}

export class MemoryJobs {
  private readonly chains = new Map<string, Promise<void>>();
  /** Event runs waiting for their window, and when each arena's last one started. */
  private readonly soon = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEventRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: {
      db: Database;
      runner: TurnRunner;
      repos: ArenaRepos;
      logger: Logger;
      cache?: ReadCache;
      clock?: () => number;
      tickMs?: number;
    },
  ) {}

  /** Starts the nightly scheduler (a first look a minute after start, then every 15 minutes). */
  start(): void {
    if (this.timer) return;
    const run = () => void this.tick();
    this.first = setTimeout(run, FIRST_TICK_MS);
    this.first.unref?.();
    this.timer = setInterval(run, this.deps.tickMs ?? MEMORY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = undefined;
    this.timer = undefined;
    for (const t of this.soon.values()) clearTimeout(t);
    this.soon.clear();
  }

  /** Event runs follow the scheduler: on only once it was started (main.ts). */
  get enabled(): boolean {
    return this.timer !== undefined;
  }

  private get now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  /** Waits for the arena's queued nights (tests). */
  async idle(projectId: string): Promise<void> {
    await this.chains.get(projectId);
  }

  /**
   * Something happened that the playbook should show soon: a run of today so far, after the settle
   * time and outside the arena's window. Only schedules (safe inside the writer's transaction).
   * Never throws.
   */
  trigger(scope: Scope, reason: MemoryTrigger): void {
    if (!this.enabled || this.soon.has(scope.projectId)) return;
    const wait = eventRunDelay(this.now, this.lastEventRun.get(scope.projectId));
    const timer = setTimeout(() => {
      this.soon.delete(scope.projectId);
      this.lastEventRun.set(scope.projectId, this.now);
      this.enqueue(scope.projectId, () => this.runToday(scope, reason));
    }, wait);
    timer.unref?.();
    this.soon.set(scope.projectId, timer);
  }

  /** One look at every arena's clock. Never throws. */
  async tick(): Promise<void> {
    const now = new Date(this.now);
    let rows: ScheduleRow[];
    try {
      rows = await this.deps.db.withCredential({ credential: SCHEDULER_CREDENTIAL }, async (tx) => {
        const { rows: found } = await sql<ScheduleRow>`
          SELECT project_id, org_id, timezone, to_char(last_day, 'YYYY-MM-DD') AS last_day
            FROM memory_schedule`.execute(tx);
        return found;
      });
    } catch {
      this.deps.logger.warn('memory: schedule not read');
      return;
    }
    for (const row of rows) {
      if (this.chains.has(row.project_id)) continue;
      const days = daysToRun(now, row.timezone, row.last_day);
      if (days.length) {
        this.request(
          { orgId: row.org_id, projectId: row.project_id, timezone: row.timezone },
          days,
        );
      }
    }
  }

  /** Queues the arena's days. Never throws. */
  request(arena: Arena, days: readonly string[]): void {
    this.enqueue(arena.projectId, () => this.runArena(arena, days));
  }

  /** Runs `work` after the arena's other runs: never two at once for an arena. Never throws. */
  private enqueue(projectId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch(() => {
        this.deps.logger.warn({ projectId }, 'memory: run failed');
      })
      .finally(() => {
        if (this.chains.get(projectId) === next) this.chains.delete(projectId);
      });
    this.chains.set(projectId, next);
  }

  private async runArena(arena: Arena, due: readonly string[]): Promise<void> {
    const { db } = this.deps;
    const prepared = await db.withSystemJob({ orgId: arena.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, arena.projectId);
      if (!agent) return null;
      const project = await tx
        .selectFrom('projects')
        .select('name')
        .where('id', '=', arena.projectId)
        .executeTakeFirstOrThrow();
      return {
        agent,
        name: project.name,
        since: await arenaFirstDay(tx, arena.projectId, arena.timezone),
        days: await loadDays(tx, arena.projectId),
      };
    });
    if (!prepared) return;
    const first = due[0];
    const last = due.at(-1);
    if (!first || !last) return;
    const retries = retryable(prepared.days, addDays(first, -MAX_CATCH_UP), MAX_ATTEMPTS);
    const told = new Set(
      prepared.days.filter((d) => d.status === 'done' || d.status === 'quiet').map((d) => d.day),
    );
    const todo = [
      ...new Set([...retries.map((d) => d.day), ...due.filter((d) => d >= prepared.since)]),
    ]
      .filter((d) => !told.has(d))
      .sort();
    const attempts = new Map(prepared.days.map((d) => [d.day, d.attempts]));

    let ai = false;
    for (const day of todo) {
      ai =
        (await this.runDay(arena, prepared.agent, prepared.name, day, attempts.get(day) ?? 0)) ||
        ai;
    }
    // Days before the arena existed still count as told.
    await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
      advanceSchedule(tx, arena.projectId, last),
    );
    await this.publish(arena, prepared.agent.agentId, ai);
  }

  /**
   * One event run: today so far, from the last run's watermark to now, into the graph; then
   * STATE.md. Skipped while yesterday waits for its night, and within the window of the last run
   * (also after a restart: the watermark is in the database).
   */
  private async runToday(scope: Scope, reason: MemoryTrigger): Promise<void> {
    const { db, logger } = this.deps;
    const prepared = await db.withSystemJob({ orgId: scope.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, scope.projectId);
      if (!agent) return null;
      const project = await tx
        .selectFrom('projects')
        .select(['name', 'timezone'])
        .where('id', '=', scope.projectId)
        .executeTakeFirstOrThrow();
      const now = await dbNow(tx);
      const today = localClock(new Date(now), project.timezone).day;
      return {
        agent,
        name: project.name,
        timezone: project.timezone,
        now,
        today,
        since: await arenaFirstDay(tx, scope.projectId, project.timezone),
        days: await loadDays(tx, scope.projectId),
        watermark: await dayWatermark(tx, scope.projectId, today),
      };
    });
    if (!prepared) return;
    const { today, now, watermark } = prepared;
    const yesterday = addDays(today, -1);
    const waiting =
      yesterday >= prepared.since &&
      !prepared.days.some((d) => d.day === yesterday && d.status !== 'pending');
    const recent =
      watermark !== null &&
      Date.parse(now) - Date.parse(watermark) < EVENT_WINDOW_MS - EVENT_SETTLE_MS;
    if (waiting || recent) {
      logger.info(
        { projectId: scope.projectId, reason, skipped: waiting ? 'night' : 'recent' },
        'memory: event run skipped',
      );
      return;
    }
    const arena: Arena = { ...scope, timezone: prepared.timezone };
    const until = new Date(Date.parse(now) - EVENT_LAG_MS).toISOString();
    const read = await this.extractDay(arena, prepared.agent, prepared.name, today, {
      after: watermark,
      until,
    });
    // A failed extraction leaves the watermark: the next run (or the night) reads it again.
    if (read.status !== 'failed') {
      await db.withSystemJob({ orgId: scope.orgId }, (tx) =>
        markDayRead(tx, scope, {
          day: today,
          until,
          stage: read.input.material.stage,
          cycle: read.input.material.cycle,
        }),
      );
    }
    logger.info(
      { projectId: scope.projectId, reason, day: today, status: read.status, ...read.counts },
      'memory: event run',
    );
    await this.publish(arena, prepared.agent.agentId, read.status === 'extracted');
  }

  /** STATE.md from the graph; arenas with a repo then get one commit. */
  private async publish(arena: Arena, agentId: string, ai: boolean): Promise<void> {
    const { db } = this.deps;
    const writer = { orgId: arena.orgId, projectId: arena.projectId, agentId };
    const changed = await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
      writeStory(tx, writer, ai ? 'ai' : 'auto'),
    );
    if (!changed) return;
    this.deps.cache?.invalidate(projectTag(arena.projectId));
    // Only arenas that already have a repo; after its queued commits.
    const { repos } = this.deps;
    await repos.settled(arena.projectId);
    const { commits } = await repos.read(arena.projectId, 1);
    if (commits.length) {
      const snapshot = await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
        buildMemorySnapshot(tx, arena.projectId),
      );
      await repos.commit(arena.projectId, snapshot, arena.orgId);
    }
  }

  /**
   * Extracts part of a day into the graph: its material after `after` (the last event run's
   * watermark; null = from the day's start) and before `until` (null = the day's end), the AI's
   * JSON (one repair try), resolved and written.
   */
  private async extractDay(
    arena: Arena,
    agent: ArenaAgent,
    arenaName: string,
    day: string,
    window: { after: string | null; until?: string | null },
  ): Promise<Extracted> {
    const { db } = this.deps;
    const scope = { orgId: arena.orgId, projectId: arena.projectId };
    const read = await db.withSystemJob({ orgId: arena.orgId }, async (tx) => ({
      input: await collectDay(tx, {
        projectId: arena.projectId,
        arenaId: agent.arenaId,
        day,
        timezone: arena.timezone,
        arenaName,
        after: window.after,
        until: window.until ?? null,
      }),
      nodes: await loadNodes(tx, arena.projectId),
      edges: await loadEdges(tx, arena.projectId),
    }));
    const { input } = read;
    const none = { created: 0, updated: 0, edges: 0 };
    if (input.quiet) return { status: 'quiet', input, delta: [], counts: none };

    const material = { ...input.material, known: knownItems(read.nodes) };
    const prompt = extractPrompt(material);
    let parsed = parseExtraction(await this.ask(arena, agent, 'extract-memory', prompt));
    if (!parsed.ok) {
      parsed = parseExtraction(
        await this.ask(arena, agent, 'extract-memory', repairPrompt(prompt, parsed.error)),
      );
    }
    if (!parsed.ok) return { status: 'failed', input, delta: [], counts: none };
    const plan = resolveDay({
      day,
      at: input.at,
      nodes: read.nodes,
      edges: read.edges,
      extraction: parsed.value,
      sources: input.sources,
      newId: uuidv7,
    });
    await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
      applyPlan(tx, scope, plan, day, input.at),
    );
    return {
      status: 'extracted',
      input,
      delta: plan.delta,
      counts: {
        created: plan.creates.length,
        updated: plan.updates.length,
        edges: plan.edges.length,
      },
    };
  }

  /** One arena-day at night. Returns whether the AI told it. */
  private async runDay(
    arena: Arena,
    agent: ArenaAgent,
    arenaName: string,
    day: string,
    attempts: number,
  ): Promise<boolean> {
    const { db, logger } = this.deps;
    const scope = { orgId: arena.orgId, projectId: arena.projectId };
    // The whole day (the chapter's facts), how much of it event runs already read, the story.
    const read = await db.withSystemJob({ orgId: arena.orgId }, async (tx) => {
      const days = await loadDays(tx, arena.projectId);
      const story =
        [...days].reverse().find((d) => d.day < day && d.story && d.status === 'done')?.story ??
        null;
      return {
        whole: await collectDay(tx, {
          projectId: arena.projectId,
          arenaId: agent.arenaId,
          day,
          timezone: arena.timezone,
          arenaName,
        }),
        watermark: await dayWatermark(tx, arena.projectId, day),
        story,
      };
    });
    const { whole } = read;
    const base: Omit<DayRow, 'status' | 'title' | 'chapter' | 'story'> = {
      day,
      stage: whole.material.stage,
      cycle: whole.material.cycle,
      attempts,
    };

    if (whole.quiet) {
      await db.withSystemJob({ orgId: arena.orgId }, async (tx) => {
        await saveDay(tx, scope, {
          ...base,
          status: 'quiet',
          title: null,
          chapter: null,
          story: null,
        });
        await advanceSchedule(tx, arena.projectId, day);
      });
      logger.info({ projectId: arena.projectId, day, status: 'quiet' }, 'memory: day told');
      return false;
    }

    // 2–3. Extract what event runs have not read yet (all of the day without them).
    const extracted = await this.extractDay(arena, agent, arenaName, day, {
      after: read.watermark,
    });
    const ok = extracted.status !== 'failed';
    // The chapter tells the whole day: this run's changes and the event runs' earlier ones.
    let delta = extracted.delta;
    if (read.watermark && ok) {
      const nodes = await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
        loadNodes(tx, arena.projectId),
      );
      delta = [...delta, ...earlierDelta(nodes, day, delta)];
    }

    // 4. Narrate.
    const narration = ok
      ? parseNarration(
          await this.ask(
            arena,
            agent,
            'narrate-day',
            narratePrompt(whole.material, delta, read.story, whole.counts),
          ),
        )
      : null;
    const row: DayRow = narration
      ? { ...base, status: 'done', ...narration }
      : {
          ...base,
          status: 'failed',
          ...factsChapter(delta, whole.material.events),
          story: null,
          attempts: attempts + 1,
        };
    await db.withSystemJob({ orgId: arena.orgId }, async (tx) => {
      await saveDay(tx, scope, row);
      await advanceSchedule(tx, arena.projectId, day);
    });
    logger.info(
      {
        projectId: arena.projectId,
        day,
        status: row.status,
        extracted: ok,
        ...extracted.counts,
      },
      'memory: day told',
    );
    return row.status === 'done';
  }

  /** One read-only fork of the arena's AI session running `skill`; its reply, or null. */
  private async ask(
    arena: Scope,
    agent: { arenaId: string; agentSessionId: string },
    skill: 'extract-memory' | 'narrate-day',
    text: string,
  ): Promise<string | null> {
    const turnId = uuidv7();
    await this.deps.db.withSystemJob({ orgId: arena.orgId }, (tx) =>
      tx
        .insertInto('runtime_turns')
        .values({
          id: turnId,
          org_id: arena.orgId,
          agent_session_id: agent.agentSessionId,
          trigger_message_id: null,
          requested_by: null,
          mode: 'system',
        })
        .execute(),
    );
    return this.deps.runner.runCaptured({
      turnId,
      messageId: turnId,
      userId: SYSTEM_USER_ID,
      orgId: arena.orgId,
      projectId: arena.projectId,
      arenaId: agent.arenaId,
      purpose: 'progress',
      skill,
      text,
    });
  }
}
