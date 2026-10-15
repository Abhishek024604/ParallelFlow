// `pnpm db:migrate | db:migrate:down | db:reset | db:seed` (run from the repo root).
// Reads .env.local / .env from the repo root. Prints migration names only, never connection strings.
import { createDatabase } from './database.js';
import { SchemaMigrator } from './migrator.js';
import { ensureAppLogin } from './roles.js';
import { seed } from './seed.js';

for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(`../../../${file}`, import.meta.url));
  } catch {
    // Optional: CI and deployed environments set variables directly.
  }
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

async function migrate(direction: 'latest' | 'down' | 'reset'): Promise<void> {
  const migrator = new SchemaMigrator(env('MIGRATION_DATABASE_URL'));
  try {
    const runs =
      direction === 'latest'
        ? [await migrator.latest()]
        : direction === 'down'
          ? [await migrator.down()]
          : [await migrator.downAll(), await migrator.latest()];
    const applied = runs.flatMap((r) => r.applied);
    console.warn(applied.length ? applied.join('\n') : 'Database is up to date.');
  } finally {
    await migrator.destroy();
  }
  if (direction !== 'down' && process.env.DATABASE_URL) {
    const user = await ensureAppLogin(env('MIGRATION_DATABASE_URL'), env('DATABASE_URL'));
    console.warn(`App login role ready: ${user}`);
  }
}

async function runSeed(): Promise<void> {
  const db = createDatabase({ connectionString: env('DATABASE_URL') });
  try {
    await db.assertAppRole();
    await seed(db);
    console.warn('Seeded 2 arenas and 3 users.');
  } finally {
    await db.destroy();
  }
}

const commands: Record<string, () => Promise<void>> = {
  migrate: () => migrate('latest'),
  down: () => migrate('down'),
  reset: () => migrate('reset'),
  seed: runSeed,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: cli <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
command().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof Error && err.cause instanceof Error)
    console.error(`  cause: ${err.cause.message}`);
  process.exit(1);
});
