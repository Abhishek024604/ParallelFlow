// `pnpm --filter @saras/api dev | start`: the HTTP API on :4000 (doc 11 §11.1).
// Reads .env.local / .env from the repo root, like `pnpm db:*`. Never prints connection strings.
import { createDatabase } from '@saras/db';
import { createLogger } from '@saras/observability';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // Optional: CI and deployed environments set variables directly.
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: 'api', level: config.logLevel });
  const db = createDatabase({
    connectionString: config.databaseUrl,
    onIdleConnectionError: (info) => logger.warn(info, 'database connection dropped'),
  });
  try {
    const app = await createApp({
      db,
      logger,
      rateLimits: { userPerWindow: config.userPerMinute, orgPerWindow: config.orgPerMinute },
    });
    app.enableShutdownHooks();
    await app.listen(config.port);
    logger.info({ port: config.port }, 'api listening');
  } catch (err) {
    await db.destroy();
    throw err;
  }
}

main().catch((err: unknown) => {
  // Startup errors (unsafe DB role, missing env) carry no secrets; print the message only.
  console.error(err instanceof Error ? err.message : 'API failed to start');
  process.exit(1);
});
