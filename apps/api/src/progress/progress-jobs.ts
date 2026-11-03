import { uuidv7 } from '@parallelflow/contracts';
import { type Database, SYSTEM_USER_ID } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import type { TurnRunner } from '../agent/turn-runner.js';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildProgressSnapshot } from '../repo/snapshot.js';
import { dayOf, type ProgressTrigger } from './progress-log.js';
import {
  arenaAgent,
  dbNow,
  progressFacts,
  readStateLog,
  stateSince,
  writeActivityLog,
  writeStateDay,
} from './progress-store.js';
import { factsDay, parseAiState, parseState, type StateDay, statePrompt } from './state-log.js';

// The STATE.md job. It runs after the request that triggered it has committed (an approved gate,
// or the ~20th human message since STATE.md was last written), so there is no request membership
// left: like the AI turn store, each step opens withSystemJob for the arena's own org (eslint
// allowlist) and filters every query by the project. PROGRESS.md is the activity log now
// (activity-jobs.ts, ADR-044); this job re-renders it too, so its commit carries both files.
//
//   1. facts since STATE.md's last write (for a gate: the write before the vote's) — counts, stage
//      moves, gates, versions, pushes; no message text — and the day's STATE.md section so far
//   2. the AI's day through Pi: an ephemeral fork of the arena's runtime session running the
//      summarize-state skill (TurnRunner.runCaptured: reads the session's history, writes nothing to
//      it, runs beside a live reply, read-only tools; the reply is captured, never posted)
//   3. STATE.md: the AI's day, or the recorded decisions when the AI could not answer; and
//      PROGRESS.md re-rendered from the events
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
    // 1. Facts since STATE.md's last write, and the day's state so far.
    const prepared = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, req.projectId);
      if (!agent) return null;
      const at = await dbNow(tx);
      const facts = await progressFacts(
        tx,
        req.projectId,
        agent.arenaId,
        await stateSince(tx, req.projectId, req.trigger === 'gate'),
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
    // commits, so this one lands on top of the gate's).
    await repos.settled(req.projectId);
    const { commits } = await repos.read(req.projectId, 1);
    const snapshot = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      const writer = { orgId: req.orgId, projectId: req.projectId, agentId: agent.agentId };
      await writeActivityLog(tx, writer);
      await writeStateDay(tx, writer, day);
      return commits.length ? buildProgressSnapshot(tx, req.projectId) : null;
    });
    this.deps.cache?.invalidate(projectTag(req.projectId));
    if (snapshot) await repos.commit(req.projectId, snapshot, req.orgId);
    this.deps.logger.info(
      { projectId: req.projectId, trigger: req.trigger, source: day.source },
      'progress: logs written',
    );
  }
}
