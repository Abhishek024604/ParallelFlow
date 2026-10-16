import type { RelayDatabase } from '@saras/db';

// Housekeeping crons (F21-05), run by pg-boss schedules as the relay role (ADR-033).

export interface HousekeepingTask {
  queue: string;
  /** Cron, UTC. */
  cron: string;
  /** Returns how many rows it removed. */
  run(relayDb: RelayDatabase): Promise<number>;
}

export const HOUSEKEEPING: readonly HousekeepingTask[] = [
  {
    // doc 06 §6.6: outbox rows are kept 7 days after publish.
    queue: 'housekeeping.outbox_cleanup',
    cron: '17 * * * *',
    run: (relayDb) => relayDb.deletePublishedOutbox(),
  },
  {
    // F21-04 debt: idempotency records expire after 24 h; sweep users who stopped calling the API.
    queue: 'housekeeping.idempotency_sweep',
    cron: '*/15 * * * *',
    run: (relayDb) => relayDb.sweepExpiredIdempotencyKeys(),
  },
];
