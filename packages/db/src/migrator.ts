import { readFile, readdir } from 'node:fs/promises';
import {
  Kysely,
  Migrator,
  NO_MIGRATIONS,
  PostgresDialect,
  sql,
  type Migration,
  type MigrationProvider,
  type MigrationResultSet,
} from 'kysely';
import pg from 'pg';

// ADR-030: plain SQL migrations (`NNNN_name.up.sql` / `NNNN_name.down.sql`) run by Kysely's Migrator.
// Each run takes an advisory lock and applies pending files in one transaction, so use a direct
// (non-pooled) owner connection: MIGRATION_DATABASE_URL.

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

class SqlFileMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.up.sql')).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const name = file.replace(/\.up\.sql$/, '');
      migrations[name] = {
        up: (db) => runFile(db, `${name}.up.sql`),
        down: (db) => runFile(db, `${name}.down.sql`),
      };
    }
    return migrations;
  }
}

async function runFile(db: Kysely<unknown>, file: string): Promise<void> {
  const text = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
  // No parameters, so pg uses the simple query protocol and multi-statement files run as one batch.
  await sql.raw(text).execute(db);
}

export interface MigrationRun {
  applied: string[];
  error?: unknown;
}

export class SchemaMigrator {
  private readonly db: Kysely<unknown>;
  private readonly migrator: Migrator;

  constructor(ownerConnectionString: string) {
    this.db = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: ownerConnectionString, max: 1 }),
      }),
    });
    this.migrator = new Migrator({
      db: this.db,
      provider: new SqlFileMigrationProvider(),
      // Tracking tables live outside `parallelflow`, so `down` of the baseline can drop the whole schema.
      migrationTableSchema: 'public',
    });
  }

  latest(): Promise<MigrationRun> {
    return this.run(this.migrator.migrateToLatest());
  }

  down(): Promise<MigrationRun> {
    return this.run(this.migrator.migrateDown());
  }

  downAll(): Promise<MigrationRun> {
    return this.run(this.migrator.migrateTo(NO_MIGRATIONS));
  }

  async applied(): Promise<string[]> {
    const all = await this.migrator.getMigrations();
    return all.filter((m) => m.executedAt).map((m) => m.name);
  }

  destroy(): Promise<void> {
    return this.db.destroy();
  }

  private async run(result: Promise<MigrationResultSet>): Promise<MigrationRun> {
    const { error, results = [] } = await result;
    const applied = results
      .filter((r) => r.status === 'Success')
      .map((r) => `${r.direction === 'Up' ? '↑' : '↓'} ${r.migrationName}`);
    if (error) {
      throw new Error(`Migration failed after: [${applied.join(', ')}]`, { cause: error });
    }
    return { applied };
  }
}
