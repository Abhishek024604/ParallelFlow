-- Reverts 0009_soft_delete. Dev only: deleted files and arenas become visible again.
SET search_path = saras, public;

DROP INDEX IF EXISTS artifacts_stage_doc_per_cycle;
CREATE UNIQUE INDEX artifacts_stage_doc_per_cycle ON artifacts (cycle_id, kind)
  WHERE cycle_id IS NOT NULL AND kind IN ('goal','spec','plan','test_report','release_notes');

DROP POLICY IF EXISTS projects_not_deleted ON projects;
DROP POLICY IF EXISTS artifacts_not_deleted ON artifacts;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_archived_or_deleted;
ALTER TABLE projects DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE artifacts DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS deleted_at;
