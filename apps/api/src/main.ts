// `pnpm --filter @saras/api dev | start`: the HTTP API on :4000 (doc 11 §11.1).
// Reads .env.local / .env from the repo root, like `pnpm db:*`. Never prints connection strings.
import { createDatabase } from '@saras/db';
import { createLogger } from '@saras/observability';
import { HttpRuntimeClient, mintToolToken, type ToolTokenInput } from '@saras/runtime-client';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { WorkosIdentityProvider } from './identity/workos-provider.js';

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
    const { workos } = config;
    if (!workos)
      logger.warn('WorkOS is not configured: sign-in is off (every route needs a session)');
    const { url: runtimeUrl, jwtKey, toolTokenKey, appToolsUrl } = config.runtime;
    const runtime =
      runtimeUrl && jwtKey && toolTokenKey
        ? {
            client: new HttpRuntimeClient({ baseUrl: runtimeUrl, jwtKey }),
            mintToolToken: (input: ToolTokenInput) =>
              mintToolToken(input, toolTokenKey, appToolsUrl),
          }
        : undefined;
    if (!runtime)
      logger.warn('RUNTIME_URL is not set: AI is not connected (@AI replies fail fast)');
    const app = await createApp({
      db,
      logger,
      webOrigin: config.webOrigin,
      ...(workos && {
        auth: {
          provider: new WorkosIdentityProvider(workos),
          cookiePassword: workos.cookiePassword,
          secureCookies: config.secureCookies,
          ...(config.cookieDomain && { cookieDomain: config.cookieDomain }),
        },
      }),
      ...(runtime && { runtime }),
      rateLimits: { userPerWindow: config.userPerMinute, orgPerWindow: config.orgPerMinute },
    });
    // Open a few connections now: each new one costs seconds to a remote database.
    await db.warmUp();
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
