import type { ArenaEventScope, Database } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { projectTag, type ReadCache } from '../pipeline/read-cache.js';
import type { ArenaRepos } from '../repo/git.js';
import { buildActivitySnapshot } from '../repo/snapshot.js';
import { arenaAgent, writeActivityLog } from './progress-store.js';

// When PROGRESS.md (the activity log, ADR-044) is rewritten. Every recorded event touches its
// arena (packages/db setArenaEventListener, wired in app.ts); the log is rendered ~60 s after the
// arena's last event, and at the latest 5 min after its first unrendered one, so a busy arena
// still gets fresh logs. A gate decision is rendered at once (flush). Rendering is deterministic
// and writes a version only when the text changed; arenas with a repo then get one commit
// ("Update logs: activity", which push webhooks ignore). Runs as a system job for the arena's org,
// after the writer committed (a touch from a transaction that rolls back renders nothing new).
// Logs carry ids and outcomes only.

export const ACTIVITY_JOBS = Symbol('ACTIVITY_JOBS');

export const ACTIVITY_DEBOUNCE_MS = 60_000;
export const ACTIVITY_MAX_WAIT_MS = 5 * 60_000;

interface Pending {
  scope: ArenaEventScope;
  timer: ReturnType<typeof setTimeout>;
  first: number;
}

export class ActivityJobs {
  private readonly pending = new Map<string, Pending>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      db: Database;
      repos: ArenaRepos;
      logger: Logger;
      cache?: ReadCache;
      clock?: () => number;
      debounceMs?: number;
      maxWaitMs?: number;
    },
  ) {}

  private get now(): number {
    return (this.deps.clock ?? Date.now)();
  }

  /** An event was recorded for the arena: render its log after the quiet period. Never throws. */
  touch(scope: ArenaEventScope): void {
    const key = scope.projectId;
    const debounce = this.deps.debounceMs ?? ACTIVITY_DEBOUNCE_MS;
    const maxWait = this.deps.maxWaitMs ?? ACTIVITY_MAX_WAIT_MS;
    const existing = this.pending.get(key);
    const first = existing?.first ?? this.now;
    if (existing) clearTimeout(existing.timer);
    const wait = Math.max(0, Math.min(debounce, first + maxWait - this.now));
    const timer = setTimeout(() => this.flush(scope), wait);
    timer.unref?.();
    this.pending.set(key, { scope, timer, first });
  }

  /** Renders the arena's log now (after any render already running). Never throws. */
  flush(scope: ArenaEventScope): void {
    const key = scope.projectId;
    const waiting = this.pending.get(key);
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(key);
    }
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.run(scope))
      .catch(() => {
        this.deps.logger.warn({ projectId: key }, 'activity: log not written');
      })
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Waits for the arena's render (tests). */
  async idle(projectId: string): Promise<void> {
    await this.chains.get(projectId);
  }

  /** Stops every waiting render (shutdown, tests). */
  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  private async run(scope: ArenaEventScope): Promise<void> {
    const { db, repos } = this.deps;
    const changed = await db.withSystemJob({ orgId: scope.orgId }, async (tx) => {
      const agent = await arenaAgent(tx, scope.projectId);
      if (!agent) return false;
      return writeActivityLog(tx, { ...scope, agentId: agent.agentId });
    });
    if (!changed) return;
    this.deps.cache?.invalidate(projectTag(scope.projectId));
    // Only arenas that already have a repo; after its queued commits.
    await repos.settled(scope.projectId);
    const { commits } = await repos.read(scope.projectId, 1);
    if (commits.length) {
      const snapshot = await db.withSystemJob({ orgId: scope.orgId }, (tx) =>
        buildActivitySnapshot(tx, scope.projectId),
      );
      await repos.commit(scope.projectId, snapshot, scope.orgId);
    }
    this.deps.logger.info({ projectId: scope.projectId }, 'activity: log written');
  }
}
