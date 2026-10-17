// `pnpm --filter @saras/app-tools dev | start`: the App Tools MCP server on APP_TOOLS_URL
// (default http://localhost:4200/mcp). Reads .env.local / .env from the repo root. Never prints
// connection strings or keys.
import { createServer } from 'node:http';
import { createDatabase } from '@saras/db';
import { createLogger } from '@saras/observability';
import { loadContract } from './contract.js';
import { DbToolBackend } from './db.js';
import { createAppToolsHandler } from './server.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // Optional: CI and deployed environments set variables directly.
  }
}

async function main(): Promise<void> {
  const logger = createLogger({ name: 'app-tools', level: process.env.LOG_LEVEL || 'info' });
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const toolTokenKey = process.env.TOOL_TOKEN_KEY ?? '';
  if (toolTokenKey.length < 32) {
    throw new Error('TOOL_TOKEN_KEY must be set (at least 32 characters, same as the API)');
  }
  const url = new URL(process.env.APP_TOOLS_URL || 'http://localhost:4200/mcp');
  const port = Number(process.env.APP_TOOLS_PORT || url.port || 4200);

  const db = createDatabase({
    connectionString: databaseUrl,
    onIdleConnectionError: (info) => logger.warn(info, 'database connection dropped'),
  });
  const handler = createAppToolsHandler({
    contract: loadContract(),
    backend: new DbToolBackend(db),
    toolTokenKey,
    logger,
    path: url.pathname,
    auditInBackground: true,
  });
  const server = createServer((req, res) => void handler(req, res));
  server.listen(port, () => logger.info({ port }, 'app tools listening'));
  const stop = (): void => {
    server.close(() => void db.destroy().finally(() => process.exit(0)));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'App Tools failed to start');
  process.exit(1);
});
