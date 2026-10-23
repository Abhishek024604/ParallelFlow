// `pnpm --filter @parallelflow/worker dev | start`: outbox relay, consumers and housekeeping (F21-05).
// Reads .env.local / .env from the repo root, like the API. Never prints connection strings.
import { createDatabase, createRelayDatabase, JOB_SCHEMA } from '@parallelflow/db';
import { createLogger } from '@parallelflow/observability';
import { PgBoss } from 'pg-boss';
import { loadWorkerConfig } from './config.js';
import { CONSUMERS } from './consumers/index.js';
import { startWorker, type RunningWorker } from './worker.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // Optional: CI and deployed environments set variables directly.
  }
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const logger = createLogger({ name: 'worker', level: config.logLevel });
  const onIdleConnectionError = (pool: string) => (info: { name: string; code?: string }) =>
    logger.warn({ pool, ...info }, 'database connection dropped');

  const db = createDatabase({
    connectionString: config.databaseUrl,
    onIdleConnectionError: onIdleConnectionError('app'),
  });
  const relayDb = createRelayDatabase({
    connectionString: config.relayDatabaseUrl,
    onIdleConnectionError: onIdleConnectionError('relay'),
  });
  // pg-boss runs as the relay login on a direct endpoint. Its tables are installed by
  // `pnpm db:migrate` (ADR-033); here it only checks the version and never creates anything.
  const boss = new PgBoss({
    connectionString: config.relayDatabaseUrl,
    schema: JOB_SCHEMA,
    application_name: 'parallelflow-worker',
    migrate: false,
    createSchema: false,
    supervise: true,
    schedule: true,
    // REINDEX needs the table owner; the relay role is not.
    reindex: false,
    max: 5,
  });

  let worker: RunningWorker;
  try {
    worker = await startWorker({
      db,
      relayDb,
      boss,
      consumers: CONSUMERS,
      logger,
      relay: config.relay,
    });
  } catch (err) {
    await Promise.allSettled([relayDb.destroy(), db.destroy()]);
    throw err;
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping');
    worker
      .stop()
      .then(() => {
        logger.info('worker stopped');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err_name: (err as Error)?.name ?? 'Error' }, 'worker stop failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Startup errors (unsafe DB role, missing env, pg-boss not installed) carry no secrets.
  console.error(err instanceof Error ? err.message : 'Worker failed to start');
  process.exit(1);
});
