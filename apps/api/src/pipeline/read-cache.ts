import { SetMetadata } from '@nestjs/common';
import type { Clock } from './tokens.js';

// Short-lived, in-process cache of GET responses (demo perf, SLICE_DEBT.md). A cached read answers
// without touching the database: no rate-limit round trip, no transaction.
//
//   key        user id + full request URL, so an entry only ever answers the user whose request,
//              run under RLS (membership verified in the same transaction), produced it
//   ttl        ≤ 30 s: a revoked membership or another process's write is seen within the TTL
//   tags       `user:<id>` (own data: me, arenas, private chats) and `project:<id>` (arena data).
//              Invalidating a tag bumps its generation; entries made under an older one are dead.
//
// Writes invalidate after they commit: the pipeline does it for every mutation (the caller's user tag,
// and the project tag on project routes), and background writers (AI replies) call invalidate()
// themselves. A read snapshots its tags' generations before its transaction opens and is stored only
// if none changed meanwhile, so a read racing a write is never cached with stale data.
// Single instance only: another API process's writes are not seen until the TTL (Redis later).

export const CACHED_READ = 'parallelflow:cached-read';
export const READ_CACHE = Symbol('READ_CACHE');

export const userTag = (userId: string): string => `user:${userId}`;
export const projectTag = (projectId: string): string => `project:${projectId}`;

/** Marks a GET route as cacheable. Its tags: the caller's user tag, plus the route's project tag. */
export const CachedRead = () => SetMetadata(CACHED_READ, true);

export const READ_CACHE_TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

type Snapshot = readonly (readonly [tag: string, gen: number])[];

interface Entry {
  body: unknown;
  until: number;
  tags: Snapshot;
}

export class ReadCache {
  private readonly entries = new Map<string, Entry>();
  private readonly gens = new Map<string, number>();

  constructor(
    readonly enabled: boolean,
    private readonly clock: Clock = Date.now,
    private readonly ttlMs = READ_CACHE_TTL_MS,
  ) {}

  /** The current generations of `tags`, taken before a read starts. */
  snapshot(tags: readonly string[]): Snapshot {
    return tags.map((tag) => [tag, this.gens.get(tag) ?? 0] as const);
  }

  private current(tags: Snapshot): boolean {
    return tags.every(([tag, gen]) => (this.gens.get(tag) ?? 0) === gen);
  }

  get(key: string): { body: unknown } | undefined {
    if (!this.enabled) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= this.clock() || !this.current(entry.tags)) {
      this.entries.delete(key);
      return undefined;
    }
    return { body: entry.body };
  }

  /** Stores a read made under `tags` (from snapshot()) unless a write invalidated one meanwhile. */
  set(key: string, body: unknown, tags: Snapshot): void {
    if (!this.enabled || !this.current(tags)) return;
    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    this.entries.set(key, { body, until: this.clock() + this.ttlMs, tags });
  }

  /** After a write commits: every entry under these tags is dead. Generations are never reset. */
  invalidate(...tags: string[]): void {
    for (const tag of tags) this.gens.set(tag, (this.gens.get(tag) ?? 0) + 1);
  }
}
