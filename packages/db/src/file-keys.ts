import { type RawBuilder, sql } from 'kysely';

// The arena's stable file keys (F-1, F-2 …, ADR-045 playbook): every project file in order of its
// first version, deleted ones too, so a number never moves. One definition for the playbook (API)
// and the arena.file App Tool, so both always name a file the same way.
//
// A member's context cannot see a deleted file's row (RLS), only its versions: those count by the
// arena's org (one project per hidden org, ADR-029). The arena's own logs (PROGRESS.md, STATE.md)
// are left out. Use as `WITH ${fileKeysCte(projectId)} SELECT … FROM file_keys k …`; the CTE has
// `artifact_id` and `n`.

export function fileKeysCte(projectId: string): RawBuilder<unknown> {
  return sql`file_keys AS (
    SELECT v1.artifact_id, row_number() OVER (ORDER BY v1.created_at, v1.artifact_id)::int AS n
      FROM artifact_versions v1
      LEFT JOIN artifacts a ON a.id = v1.artifact_id
     WHERE v1.version_no = 1
       AND v1.org_id = (SELECT org_id FROM projects WHERE id = ${projectId})
       AND (a.id IS NULL
            OR (a.project_id = ${projectId} AND a.scope = 'project'
                AND a.kind NOT IN ('progress', 'stage_summary')))
  )`;
}

/** "F-3", "f3", "F 3" → 3; anything else → null. */
export function parseFileKey(text: string): number | null {
  const m = /^\s*F\s*-?\s*(\d{1,6})\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

export const fileKey = (n: number): string => `F-${n}`;
