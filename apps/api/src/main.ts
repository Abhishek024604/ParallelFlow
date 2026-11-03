// `pnpm --filter @parallelflow/api dev | start`: the HTTP API on :4000 (doc 11 §11.1).
// Reads .env.local / .env from the repo root, like `pnpm db:*`. Never prints connection strings.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '@parallelflow/db';
import { smtpMailer } from './mail/mailer.js';
import { createLogger } from '@parallelflow/observability';
import {
  HttpRuntimeClient,
  mintToolToken,
  type ToolTokenInput,
} from '@parallelflow/runtime-client';
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
    if (!process.env.SMTP_URL)
      logger.info('SMTP_URL is not set: invite emails are off (copy links)');
    if (!runtime)
      logger.warn('RUNTIME_URL is not set: AI is not connected (@AI replies fail fast)');
    if (!config.github) logger.info('GITHUB_APP_ID is not set: arenas cannot connect to GitHub');
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
      ...(process.env.INVITE_LINK_KEY && { inviteKey: process.env.INVITE_LINK_KEY }),
      ...(process.env.SMTP_URL && {
        mailer: smtpMailer(
          {
            url: process.env.SMTP_URL,
            from: process.env.MAIL_FROM || 'ParallelFlow <no-reply@parallelflow.local>',
          },
          logger,
        ),
      }),
      // The nightly memory: each arena's day becomes a chapter of STATE.md (ADR-045).
      memorySchedule: true,
      // Each arena's git repository (a commit per approved gate).
      repoDir: resolve(
        process.env.ARENA_REPOS_DIR ||
          fileURLToPath(new URL('../../../.data/arena-repos', import.meta.url)),
      ),
      rateLimits: {
        userPerWindow: config.userPerMinute,
        orgPerWindow: config.orgPerMinute,
        llmPerWindow: config.llm.perMinute,
      },
      // The VS Code extension's model calls (ADR-037), with the server's OpenRouter key.
      llm: {
        ...(config.llm.apiKey && { apiKey: config.llm.apiKey }),
        ...(config.llm.apiKeys?.length && { apiKeys: config.llm.apiKeys }),
        models: config.llm.models,
        tiers: config.llm.tiers,
      },
      // The ParallelFlow GitHub App (ADR-040); unset = arenas stay on the server only.
      ...(config.github && { github: config.github }),
      // GET responses cached in memory for ≤ 30 s, invalidated by writes (single instance).
      readCache: process.env.API_READ_CACHE !== 'off',
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
