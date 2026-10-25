import {
  archDocName,
  archPathOf,
  isStandardFileName,
  type SdlcStage,
  suggestFileName,
  uniqueFileName,
} from '@parallelflow/contracts';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// ADR-038: arena files saved before the standard-name rule get a standard name, once, after
// `db:migrate`. SWA's documents ("arch › hld › hld.md") get their exact standard name
// (arch-docs.ts); other files the name their words point to (suggestFileName), made unique in their
// arena. The arena's own logs (PROGRESS.md, STATE.md) and files already standard are left alone,
// so running it again changes nothing. Ids and names only are printed, never content.

export interface FileRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  stage: SdlcStage | null;
}

export interface Rename {
  id: string;
  from: string;
  to: string;
}

const LOG_KINDS = new Set(['progress', 'stage_summary']);

/** The renames for one or more arenas' files (pure; unit tested). */
export function planRenames(rows: readonly FileRow[]): Rename[] {
  const byProject = new Map<string, FileRow[]>();
  for (const row of rows)
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  const renames: Rename[] = [];
  for (const files of byProject.values()) {
    const taken = new Set(files.filter((f) => isStandardFileName(f.name)).map((f) => f.name));
    for (const f of files) {
      if (LOG_KINDS.has(f.kind) || isStandardFileName(f.name)) continue;
      const arch = archPathOf(f.name);
      const wanted = arch ? archDocName(arch) : suggestFileName(f.name, f.stage ?? 'PLAN');
      const to = uniqueFileName(wanted, taken);
      taken.add(to);
      renames.push({ id: f.id, from: f.name, to });
    }
  }
  return renames;
}

/** Applies planRenames to every arena file (as a system job: owner role under FORCE RLS). */
export async function renameLegacyFiles(db: Kysely<unknown>): Promise<number> {
  return db.transaction().execute(async (tx) => {
    await sql`SELECT set_config('search_path', 'saras, public', true), set_config('app.system_job', 'on', true)`.execute(
      tx,
    );
    const { rows } = await sql<FileRow>`
      SELECT id, project_id, name, kind, stage FROM artifacts
       WHERE scope = 'project' AND deleted_at IS NULL`.execute(tx);
    const renames = planRenames(rows);
    for (const r of renames) {
      await sql`UPDATE artifacts SET name = ${r.to}, updated_at = now() WHERE id = ${r.id}`.execute(
        tx,
      );
    }
    return renames.length;
  });
}
