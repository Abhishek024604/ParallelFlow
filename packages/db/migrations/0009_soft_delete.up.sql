-- ADR-038: soft delete for arena files, private files and arenas.
--
-- An arena owner can archive an arena (read-only, listed under Archived, reversible) or delete it,
-- and delete arena files; a person can delete their own private files. A delete is soft: the row
-- stays for audit and history, with who deleted it and when, and a RESTRICTIVE policy hides it from
-- the app roles. System jobs (app.system_job = 'on') still see it, like every other restrictive
-- policy in the schema. No existing policy is edited or dropped.
--
-- The one-document-per-stage index of a cycle ignores deleted rows, so a stage document can be
-- written again after its old one was deleted.

SET search_path = saras, public;

ALTER TABLE artifacts
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id);

ALTER TABLE projects
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id);

-- Archiving and deleting are separate states: a deleted arena is not also archived.
ALTER TABLE projects ADD CONSTRAINT projects_archived_or_deleted
  CHECK (archived_at IS NULL OR deleted_at IS NULL);

CREATE POLICY artifacts_not_deleted ON artifacts AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL OR current_setting('app.system_job', true) = 'on');

CREATE POLICY projects_not_deleted ON projects AS RESTRICTIVE FOR SELECT
  USING (deleted_at IS NULL OR current_setting('app.system_job', true) = 'on');

DROP INDEX IF EXISTS artifacts_stage_doc_per_cycle;
CREATE UNIQUE INDEX artifacts_stage_doc_per_cycle ON artifacts (cycle_id, kind)
  WHERE cycle_id IS NOT NULL AND deleted_at IS NULL
    AND kind IN ('goal','spec','plan','test_report','release_notes');
