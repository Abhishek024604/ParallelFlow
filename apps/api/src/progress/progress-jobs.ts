import { uuidv7 } from '@saras/contracts';
import { type Database, SYSTEM_USER_ID } from '@saras/db';
import type { Logger } from '@saras/observability';
import type { TurnRunner } from '../agent/turn-runner.js';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildProgressSnapshot } from '../repo/snapshot.js';
import { dayOf, lastEntryAt, parseLog, type ProgressTrigger } from './progress-log.js';
import {
  arenaAgent,
  dbNow,
  gateEntryId,
  progressFacts,
  readProgressLog,
  readStateLog,
  writeProgressEntry,
  writeStateDay,
} from './progress-store.js';
import { factsDay, parseAiState, parseState, type StateDay, statePrompt } from './state-log.js';

// Log jobs: progress.md and state.md. They run after the request that triggered them has committed
// (an approved gate, or the ~20th human message since the last entry), so there is no request
// membership left: like the AI turn store, each step opens withSystemJob for the arena's own org
// (eslint allowlist) and filters every query by the project.
//
//   1. facts for the entry's window (counts, stage moves, gates, versions, pushes; no message text)
//      and the day's state.md section so far
//   2. the AI's day through Pi: an ephemeral fork of the arena's runtime session running the
//      summarize-state skill (TurnRunner.runCaptured: reads the session's history, writes nothing to
//      it, runs beside a live reply, read-only tools; the reply is captured, never posted)
//   3. progress.md: the factual entry with the repo commits not yet listed (a gate's entry, written
//      in the vote's transaction, gets the gate's own commit here); state.md: the AI's day, or the
//      recorded decisions when the AI could not answer
//   4. if the arena has a repo, a follow-up commit "Update progress and state"
//
// One job per arena at a time; a message-triggered job is skipped while one runs or within the
// cooldown. Logs carry ids and outcomes only.

export const PROGRESS_JOBS = Symbol('PROGRESS_JOBS');

const MESSAGE_COOLDOWN_MS = 2 * 60_000;

export interface ProgressRequest {
  orgId: string;
  projectId: string;
  trigger: ProgressTrigger;
  /** The approval, for a gate entry (its plain entry was written in the vote's transaction). */
  approvalId?: string;
}

export class ProgressJobs {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly lastMessageRun = new Map<string, number>();

  constructor(
    private readonly deps: {
      db: Database;
      runner: TurnRunner;
      repos: ArenaRepos;
      logger: Logger;
      cache?: ReadCache;
      clock?: () => number;
    },
  ) {}

  /** Queues a progress entry for the arena. Never throws. */
  request(req: ProgressRequest): void {
    const now = (this.deps.clock ?? Date.now)();
    if (req.trigger === 'messages') {
      if (this.chains.has(req.projectId)) return;
      const last = this.lastMessageRun.get(req.projectId) ?? 0;
      if (now - last < MESSAGE_COOLDOWN_MS) return;
      this.lastMessageRun.set(req.projectId, now);
    }
    const previous = this.chains.get(req.projectId) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(req))
      .catch(() => {
        this.deps.logger.warn({ projectId: req.projectId }, 'progress: entry failed');
      })
      .finally(() => {
        if (this.chains.get(req.projectId) === next) this.chains.delete(req.projectId);
      });
    this.chains.set(req.projectId, next);
  }

  /** Waits for the arena's queued jobs (tests). */
  async idle(projectId: string): Promise<void> {
    await this.chains.get(projectId);
  }

  private async run(req: ProgressRequest): Promise<void> {
    const { db, runner, repos } = this.deps;
    const entryId = req.approvalId ? gateEntryId(req.approvalId) : `messages:${uuidv7()}`;

    // 1. Facts for the entry's window, and the day's state so far.
    const prepared = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, req.projectId);
      if (!agent) return null;
      const log = await readProgressLog(tx, req.projectId);
      const existing = parseLog(log?.content).find((e) => e.id === entryId);
      const at = existing?.at ?? (await dbNow(tx));
      const facts = await progressFacts(
        tx,
        req.projectId,
        agent.arenaId,
        lastEntryAt(log?.content, entryId),
        at,
      );
      const state = await readStateLog(tx, req.projectId);
      const today = parseState(state?.content).find((d) => d.date === dayOf(at));
      return { agent, facts, at, today };
    });
    if (!prepared) return;
    const { agent, facts, at, today } = prepared;

    // 2. The AI's summary of the day: a Pi fork of the arena session (no busy wait: a fork runs
    // beside a live reply; Pi itself retries other models on overload).
    const turnId = uuidv7();
    await db.withSystemJob({ orgId: req.orgId }, (tx) =>
      tx
        .insertInto('runtime_turns')
        .values({
          id: turnId,
          org_id: req.orgId,
          agent_session_id: agent.agentSessionId,
          trigger_message_id: null,
          requested_by: null,
          mode: 'system',
        })
        .execute(),
    );
    const reply = await runner.runCaptured({
      turnId,
      messageId: turnId,
      userId: SYSTEM_USER_ID,
      orgId: req.orgId,
      projectId: req.projectId,
      arenaId: agent.arenaId,
      purpose: 'progress',
      text: statePrompt(facts, req.trigger, today),
    });
    const parsed = reply ? parseAiState(reply) : null;
    const day: StateDay = parsed
      ? { date: dayOf(at), source: 'ai', ...parsed }
      : factsDay(dayOf(at), facts);

    // 3 + 4. Both files, then the repo (only arenas that already have one; after its queued
    // commits, so the gate's own commit is listed).
    await repos.settled(req.projectId);
    const { commits } = await repos.read(req.projectId, 50);
    const snapshot = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      const writer = { orgId: req.orgId, projectId: req.projectId, agentId: agent.agentId };
      await writeProgressEntry(
        tx,
        writer,
        { id: entryId, at, trigger: req.trigger, facts },
        commits,
      );
      await writeStateDay(tx, writer, day);
      return commits.length ? buildProgressSnapshot(tx, req.projectId) : null;
    });
    this.deps.cache?.invalidate(projectTag(req.projectId));
    if (snapshot) await repos.commit(req.projectId, snapshot);
    this.deps.logger.info(
      { projectId: req.projectId, trigger: req.trigger, source: day.source },
      'progress: logs written',
    );
  }
}
