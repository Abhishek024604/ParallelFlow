import { uuidv7 } from '@saras/contracts';
import { type Database, SYSTEM_USER_ID } from '@saras/db';
import type { Logger } from '@saras/observability';
import type { TurnRunner } from '../agent/turn-runner.js';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildProgressSnapshot } from '../repo/snapshot.js';
import {
  factsEntry,
  lastEntryAt,
  parseAiProgress,
  parseLog,
  type ProgressEntry,
  progressPrompt,
  type ProgressTrigger,
} from './progress-log.js';
import {
  arenaAgent,
  gateEntryId,
  progressFacts,
  readProgressLog,
  writeProgressEntry,
} from './progress-store.js';

// Progress-log jobs (build step: richer progress.md). They run after the request that triggered them
// has committed (an approved gate, or the ~20th human message since the last entry), so there is no
// request membership left: like the AI turn store, each step opens withSystemJob for the arena's own
// org (eslint allowlist) and filters every query by the project.
//
//   1. facts since the previous entry (counts, stage moves, gates, document names; no message text)
//   2. a progress turn in the arena's own runtime session (TurnRunner.runCaptured: same session,
//      read-only tools, the reply is captured, never posted)
//   3. the entry (the AI's, or one built from the facts) → a new version of the progress artifact
//   4. if the arena has a repo, a follow-up commit "Update progress"
//
// One job per arena at a time; a message-triggered job is skipped while one runs or within the
// cooldown. Logs carry ids and outcomes only.

export const PROGRESS_JOBS = Symbol('PROGRESS_JOBS');

const MESSAGE_COOLDOWN_MS = 2 * 60_000;
const BUSY_RETRY_MS = 15_000;

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
      /** Waits before the one retry when the AI was busy. Tests pass 0. */
      retryMs?: number;
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
    const { db, runner } = this.deps;
    const entryId = req.approvalId ? gateEntryId(req.approvalId) : `messages:${uuidv7()}`;

    // 1. Facts, and a queued system turn in the arena's own session.
    const prepared = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, req.projectId);
      if (!agent) return null;
      const log = await readProgressLog(tx, req.projectId);
      const existing = parseLog(log?.content).find((e) => e.id === entryId);
      const facts = await progressFacts(
        tx,
        req.projectId,
        agent.arenaId,
        lastEntryAt(log?.content, entryId),
      );
      return { agent, facts, at: existing?.at ?? new Date().toISOString(), hasPlain: !!existing };
    });
    if (!prepared) return;
    const { agent, facts } = prepared;

    // 2. The AI's entry, through the runtime (one retry when the session was busy).
    const ask = async (): Promise<string | null> => {
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
      return runner.runCaptured({
        turnId,
        messageId: turnId,
        userId: SYSTEM_USER_ID,
        orgId: req.orgId,
        projectId: req.projectId,
        arenaId: agent.arenaId,
        purpose: 'progress',
        text: progressPrompt(facts, req.trigger),
      });
    };
    let reply = await ask();
    if (!reply) {
      await new Promise((resolve) => setTimeout(resolve, this.deps.retryMs ?? BUSY_RETRY_MS));
      reply = await ask();
    }
    const parsed = reply ? parseAiProgress(reply) : null;
    const base = { id: entryId, at: prepared.at, trigger: req.trigger };
    const plain = factsEntry(base, facts);
    let entry: ProgressEntry;
    if (parsed) {
      entry = {
        ...plain,
        ...parsed,
        source: 'ai',
        // The recorded stage moves stay in the timeline when the AI names no milestones.
        timeline: parsed.timeline.length ? parsed.timeline : plain.timeline,
        decisions: parsed.decisions.length ? parsed.decisions : plain.decisions,
      };
    } else if (prepared.hasPlain) {
      // The gate's plain entry is already in the log and the repo.
      this.deps.logger.info({ projectId: req.projectId }, 'progress: kept the plain entry');
      return;
    } else {
      entry = plain;
    }

    // 3 + 4. The entry, then the repo (only arenas that already have one).
    const hasRepo = (await this.deps.repos.read(req.projectId, 1)).commits.length > 0;
    const snapshot = await db.withSystemJob({ orgId: req.orgId }, async (tx) => {
      await writeProgressEntry(
        tx,
        { orgId: req.orgId, projectId: req.projectId, agentId: agent.agentId },
        entry,
      );
      return hasRepo ? buildProgressSnapshot(tx, req.projectId) : null;
    });
    this.deps.cache?.invalidate(projectTag(req.projectId));
    if (snapshot) await this.deps.repos.commit(req.projectId, snapshot);
    this.deps.logger.info(
      { projectId: req.projectId, trigger: req.trigger, source: entry.source },
      'progress: entry written',
    );
  }
}
