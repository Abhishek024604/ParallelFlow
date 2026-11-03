import { createHash } from 'node:crypto';
import { uuidv7 } from '@parallelflow/contracts';
import { type Database, SYSTEM_USER_ID } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { sql } from 'kysely';
import type { TurnRunner } from '../agent/turn-runner.js';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import { arenaAgent } from '../progress/progress-store.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildMemorySnapshot } from '../repo/snapshot.js';
import {
  advanceSchedule,
  applyPlan,
  arenaFirstDay,
  collectDay,
  type DayRow,
  knownItems,
  loadDays,
  loadEdges,
  loadNodes,
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
import { resolveDay } from './resolver.js';
import { addDays, daysToRun, MAX_CATCH_UP } from './schedule.js';

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

export const MEMORY_JOBS = Symbol('MEMORY_JOBS');

export const MEMORY_TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;
const MAX_ATTEMPTS = 3;

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

export class MemoryJobs {
  private readonly chains = new Map<string, Promise<void>>();
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
  }

  /** Waits for the arena's queued nights (tests). */
  async idle(projectId: string): Promise<void> {
    await this.chains.get(projectId);
  }

  /** One look at every arena's clock. Never throws. */
  async tick(): Promise<void> {
    const now = new Date((this.deps.clock ?? Date.now)());
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
    const previous = this.chains.get(arena.projectId) ?? Promise.resolve();
    const next = previous
      .then(() => this.runArena(arena, days))
      .catch(() => {
        this.deps.logger.warn({ projectId: arena.projectId }, 'memory: night failed');
      })
      .finally(() => {
        if (this.chains.get(arena.projectId) === next) this.chains.delete(arena.projectId);
      });
    this.chains.set(arena.projectId, next);
  }

  private async runArena(arena: Arena, due: readonly string[]): Promise<void> {
    const { db } = this.deps;
    const scope = { orgId: arena.orgId, projectId: arena.projectId };
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

    const writer = { ...scope, agentId: prepared.agent.agentId };
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

  /** One arena-day. Returns whether the AI told it. */
  private async runDay(
    arena: Arena,
    agent: { arenaId: string; agentId: string; agentSessionId: string },
    arenaName: string,
    day: string,
    attempts: number,
  ): Promise<boolean> {
    const { db, logger } = this.deps;
    const scope = { orgId: arena.orgId, projectId: arena.projectId };
    const read = await db.withSystemJob({ orgId: arena.orgId }, async (tx) => {
      const input = await collectDay(tx, {
        projectId: arena.projectId,
        arenaId: agent.arenaId,
        day,
        timezone: arena.timezone,
        arenaName,
      });
      const days = await loadDays(tx, arena.projectId);
      const story =
        [...days].reverse().find((d) => d.day < day && d.story && d.status === 'done')?.story ??
        null;
      return {
        input,
        nodes: await loadNodes(tx, arena.projectId),
        edges: await loadEdges(tx, arena.projectId),
        story,
      };
    });
    const { input } = read;
    const base: Omit<DayRow, 'status' | 'title' | 'chapter' | 'story'> = {
      day,
      stage: input.material.stage,
      cycle: input.material.cycle,
      attempts,
    };

    if (input.quiet) {
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

    // 2. Extract (one repair try).
    const material = { ...input.material, known: knownItems(read.nodes) };
    const prompt = extractPrompt(material);
    let parsed = parseExtraction(await this.ask(arena, agent, 'extract-memory', prompt));
    if (!parsed.ok) {
      parsed = parseExtraction(
        await this.ask(arena, agent, 'extract-memory', repairPrompt(prompt, parsed.error)),
      );
    }

    // 3. Resolve and write.
    let delta: ReturnType<typeof resolveDay>['delta'] = [];
    let counts = { created: 0, updated: 0, edges: 0 };
    if (parsed.ok) {
      const extraction = parsed.value;
      const plan = resolveDay({
        day,
        at: input.at,
        nodes: read.nodes,
        edges: read.edges,
        extraction,
        sources: input.sources,
        newId: uuidv7,
      });
      await db.withSystemJob({ orgId: arena.orgId }, (tx) =>
        applyPlan(tx, scope, plan, day, input.at),
      );
      delta = plan.delta;
      counts = {
        created: plan.creates.length,
        updated: plan.updates.length,
        edges: plan.edges.length,
      };
    }

    // 4. Narrate.
    const narration = parsed.ok
      ? parseNarration(
          await this.ask(
            arena,
            agent,
            'narrate-day',
            narratePrompt(material, delta, read.story, input.counts),
          ),
        )
      : null;
    const row: DayRow = narration
      ? { ...base, status: 'done', ...narration }
      : {
          ...base,
          status: 'failed',
          ...factsChapter(delta, material.events),
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
        extracted: parsed.ok,
        ...counts,
      },
      'memory: day told',
    );
    return row.status === 'done';
  }

  /** One read-only fork of the arena's AI session running `skill`; its reply, or null. */
  private async ask(
    arena: Arena,
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
