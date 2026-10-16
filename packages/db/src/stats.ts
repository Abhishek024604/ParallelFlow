import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Database round trips made on behalf of one unit of work (an HTTP request). Counts and time only:
 * never SQL text or parameters. Each statement sent to Postgres (including BEGIN / COMMIT) is one
 * round trip; a multi-statement simple query is one round trip.
 */
export interface QueryStats {
  roundTrips: number;
  /** Sum of round-trip times. Overlapping (parallel) round trips each add their own time. */
  ms: number;
}

const current = new AsyncLocalStorage<QueryStats>();

/** Runs `fn` with `stats` collecting the round trips of everything it starts. */
export function trackQueries<T>(stats: QueryStats, fn: () => T): T {
  return current.run(stats, fn);
}

/** Times one round trip and adds it to the current request's stats, if any. */
export async function timedRoundTrip<T>(run: () => Promise<T>): Promise<T> {
  const stats = current.getStore();
  if (!stats) return run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    stats.roundTrips += 1;
    stats.ms += performance.now() - start;
  }
}
