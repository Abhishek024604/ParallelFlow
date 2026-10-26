import { sql } from 'kysely';
import type { Tx } from './database.js';

// Soft delete (ADR-038). The `*_not_deleted` policies hide a row once deleted_at is set, and Postgres
// checks an UPDATE's new row against the SELECT policies too, so the app role cannot set deleted_at
// on a row it can see: "new row violates row-level security policy". The one UPDATE that marks the
// row runs with app.system_job on (the exception those policies already make), then the setting is
// put back. The caller has already checked who may delete; the row is named by id, in the caller's
// own context (tenant or user scope), inside its transaction.

/** Marks one artifact or arena (project) deleted by `userId`. */
export async function softDelete(
  tx: Tx,
  table: 'artifacts' | 'projects',
  id: string,
  userId: string,
): Promise<void> {
  const { rows } = await sql<{ previous: string | null }>`
    SELECT current_setting('app.system_job', true) AS previous,
           set_config('app.system_job', 'on', true)`.execute(tx);
  const previous = rows[0]?.previous ?? '';
  const marked = { deleted_at: sql<Date>`now()`, deleted_by: userId };
  // On an error the transaction is aborted and rolls back, setting included.
  if (table === 'projects') {
    await tx
      .updateTable('projects')
      .set({ ...marked, archived_at: null })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
  } else {
    await tx
      .updateTable('artifacts')
      .set(marked)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .execute();
  }
  await sql`SELECT set_config('app.system_job', ${previous}, true)`.execute(tx);
}
