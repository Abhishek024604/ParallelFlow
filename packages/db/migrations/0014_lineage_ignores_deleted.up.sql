-- A deleted arena file no longer blocks pushing its private file again: the one-copy-per-lineage
-- rule (0001) counts only files that are not deleted, like artifacts_stage_doc_per_cycle (0009).

SET search_path = saras, public;

DROP INDEX IF EXISTS artifacts_lineage_per_project;
CREATE UNIQUE INDEX artifacts_lineage_per_project ON artifacts (project_id, lineage_id)
  WHERE scope = 'project' AND deleted_at IS NULL;
