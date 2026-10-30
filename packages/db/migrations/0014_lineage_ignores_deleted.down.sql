DROP INDEX IF EXISTS artifacts_lineage_per_project;
CREATE UNIQUE INDEX artifacts_lineage_per_project ON artifacts (project_id, lineage_id)
  WHERE scope = 'project';
