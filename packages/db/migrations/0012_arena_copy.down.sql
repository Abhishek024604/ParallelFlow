-- Reverts 0012_arena_copy. Dev only: copies lose their upstream (they become plain private files),
-- and roles lose their stages. bridge_events is append-only, so its copy_from_arena rows stay; the
-- old check comes back NOT VALID so they do not block the revert.
SET search_path = saras, public;

ALTER TABLE project_roles DROP CONSTRAINT IF EXISTS project_roles_stages_size;
ALTER TABLE project_roles DROP COLUMN IF EXISTS stages;

ALTER TABLE bridge_events DROP CONSTRAINT IF EXISTS bridge_events_direction_check;
ALTER TABLE bridge_events ADD CONSTRAINT bridge_events_direction_check
  CHECK (direction IN ('push_artifact', 'pull_context', 'open_from_arena')) NOT VALID;

DROP INDEX IF EXISTS artifacts_upstream;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_upstream_private_only;
ALTER TABLE artifacts
  DROP COLUMN IF EXISTS upstream_version_no,
  DROP COLUMN IF EXISTS upstream_artifact_id,
  DROP COLUMN IF EXISTS upstream_project_id;
