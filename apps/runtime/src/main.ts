// `pnpm --filter @saras/runtime dev | start`: the Saras agent runtime on :7070 (RIC v0.2, base /v1).
// Reads .env.local / .env from the repo root. Never prints keys, tokens, prompts or replies.
import { createServer } from 'node:http';
import { createLogger } from '@saras/observability';
import { McpToolSource } from './app-tools.js';
import { loadConfig } from './config.js';
import { createRuntimeHandler } from './http.js';
import { PiEngine } from './pi-engine.js';
import { capabilities } from './index.js';
import { RuntimeService } from './service.js';
import { FsSessionStore } from './store.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // Optional: CI and deployed environments set variables directly.
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ name: 'runtime', level: config.logLevel });
  const engine = new PiEngine({
    apiKey: config.openRouterKey,
    model: config.model,
    dataDir: config.dataDir,
  });
  await engine.init();
  const reason = engine.unavailableReason();
  if (reason) logger.warn({ reason }, 'AI turns are off; sessions still work');

  const service = new RuntimeService({
    engine,
    tools: new McpToolSource(),
    store: new FsSessionStore(config.dataDir),
    logger,
  });
  const handler = createRuntimeHandler({
    service,
    jwtKey: config.jwtKey,
    logger,
    health: () => {
      const why = engine.unavailableReason();
      return why
        ? { status: 'degraded', checks: { model: 'unavailable' } }
        : { status: 'ok', checks: { model: 'ok' } };
    },
    capabilities: () => capabilities(engine.model),
  });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(config.port, () => logger.info({ port: config.port }, 'runtime listening'));
  const stop = (): void => {
    service.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Runtime failed to start');
  process.exit(1);
});
