import type { Database, RelayDatabase } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import type { PgBoss } from 'pg-boss';
import type { RelaySettings } from './config.js';
import {
  assertUniqueConsumers,
  consumerQueue,
  deadLetterQueue,
  runConsumerJob,
  type Consumer,
} from './consumer.js';
import { HOUSEKEEPING, type HousekeepingTask } from './housekeeping.js';
import { OutboxRelay } from './relay.js';

// Wires the worker together (F21-05): role checks, pg-boss queues, consumers, crons, the relay.

export interface WorkerOptions {
  /** App role (saras_app): consumer handlers run here in withSystemJob. */
  db: Database;
  /** Relay role (saras_relay): outbox relay and housekeeping. */
  relayDb: RelayDatabase;
  /** pg-boss on the relay login, schema JOB_SCHEMA, `migrate: false`. Not started yet. */
  boss: PgBoss;
  consumers: readonly Consumer[];
  logger: Logger;
  relay: RelaySettings;
  /** How often consumer workers fetch jobs, seconds (pg-boss minimum 0.5). Default 1. */
  pollingIntervalSeconds?: number;
  /** Housekeeping tasks. Default HOUSEKEEPING; tests pass none. */
  housekeeping?: readonly HousekeepingTask[];
  /** Start the relay loop. Default true; tests drive `relay.tick()` themselves. */
  startRelay?: boolean;
}

export interface RunningWorker {
  relay: OutboxRelay;
  /** Stops the relay, then pg-boss (waiting for jobs in flight), then closes both pools. */
  stop(): Promise<void>;
}

/** Days a dead-lettered job stays queued for inspection or redrive. */
const DEAD_LETTER_RETENTION_SECONDS = 14 * 86_400;

const errInfo = (err: unknown) => {
  const e = err as { name?: unknown; code?: unknown };
  return {
    err_name: typeof e?.name === 'string' ? e.name : 'Error',
    ...(typeof e?.code === 'string' && { err_code: e.code }),
  };
};

/** Creates the queue, or updates its options when it already exists. */
interface QueueSettings {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  retentionSeconds?: number;
  deadLetter?: string;
}

async function ensureQueue(boss: PgBoss, name: string, options: QueueSettings): Promise<void> {
  await boss.createQueue(name, options);
  await boss.updateQueue(name, options);
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { db, relayDb, boss, consumers, logger } = options;
  assertUniqueConsumers(consumers);
  await db.assertAppRole();
  await relayDb.assertRelayRole();

  // pg-boss reports background failures (maintenance, fetch) here. Ids and codes only.
  boss.on('error', (err) => logger.error(errInfo(err), 'jobs.error'));
  await boss.start();

  try {
    const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 1;
    for (const consumer of consumers) {
      const dead = deadLetterQueue(consumer);
      await ensureQueue(boss, dead, { retentionSeconds: DEAD_LETTER_RETENTION_SECONDS });
      await ensureQueue(boss, consumerQueue(consumer), { ...consumer.retry, deadLetter: dead });
      await boss.work(
        consumerQueue(consumer),
        { includeMetadata: true, batchSize: 1, pollingIntervalSeconds },
        async ([job]) => {
          if (job) await runConsumerJob(db, consumer, job, logger);
        },
      );
    }

    for (const task of options.housekeeping ?? HOUSEKEEPING) {
      await ensureQueue(boss, task.queue, { retryLimit: 2, retryDelay: 30, retryBackoff: true });
      await boss.schedule(task.queue, task.cron, null, { tz: 'UTC' });
      await boss.work(task.queue, async () => {
        const started = Date.now();
        try {
          const deleted = await task.run(relayDb);
          logger.info(
            { task: task.queue, deleted, duration_ms: Date.now() - started },
            'housekeeping.done',
          );
        } catch (err) {
          logger.error({ task: task.queue, ...errInfo(err) }, 'housekeeping.failed');
          throw Object.assign(new Error(`Housekeeping ${task.queue} failed`), errInfo(err));
        }
      });
    }
  } catch (err) {
    await boss.stop({ graceful: false });
    throw err;
  }

  const relay = new OutboxRelay({
    relayDb,
    boss,
    consumers,
    logger,
    settings: options.relay,
  });
  if (options.startRelay ?? true) relay.start();
  logger.info(
    { consumers: consumers.length, housekeeping: (options.housekeeping ?? HOUSEKEEPING).length },
    'worker started',
  );

  return {
    relay,
    async stop() {
      await relay.stop();
      await boss.stop({ graceful: true, timeout: 30_000 });
      await relayDb.destroy();
      await db.destroy();
    },
  };
}
