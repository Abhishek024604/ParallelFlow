-- ADR-041: copy an arena file into a private chat (with its upstream), and roles that work in stages.
--
-- 1. A private copy of an arena file remembers where it came from: the arena (project), the arena
--    file and the arena version it was copied at (or last pushed back as). Pushing the copy back
--    adds a version to that same arena file. Private rows only, so the existing owner-only policies
--    (private_space_artifacts, private_artifacts_owner_only) cover the columns; no policy changes.
--    No foreign key: the arena file lives in the arena's tenant, the copy in no tenant, and the
--    arena file may be soft-deleted (ADR-038) while the copy stays. The copy keeps the arena file's
--    lineage_id, so lineage links them as well.
-- 2. bridge_events gets the crossing `copy_from_arena` (append-only, in the arena's org, ids only).
-- 3. project_roles.stages: the SDLC stages a role works in. When a gate moves the loop on, the
--    members whose roles work in the next stage get the handoff (Inbox). Backfilled from the role
--    keys with the same rules as contracts roles.ts defaultRoleStages.

SET search_path = saras, public;

-- ---------------------------------------------------------------- upstream of a private copy
ALTER TABLE artifacts
  ADD COLUMN upstream_project_id  uuid,
  ADD COLUMN upstream_artifact_id uuid,
  ADD COLUMN upstream_version_no  integer;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_upstream_private_only CHECK (
  num_nonnulls(upstream_project_id, upstream_artifact_id, upstream_version_no) IN (0, 3)
  AND (upstream_artifact_id IS NULL OR scope = 'private')
  AND (upstream_version_no IS NULL OR upstream_version_no > 0));

-- "Is this arena file already in one of my chats?" and the round trip lookups.
CREATE INDEX artifacts_upstream ON artifacts (owner_user_id, upstream_artifact_id)
  WHERE upstream_artifact_id IS NOT NULL;

-- ---------------------------------------------------------------- bridge crossing
ALTER TABLE bridge_events DROP CONSTRAINT IF EXISTS bridge_events_direction_check;
ALTER TABLE bridge_events ADD CONSTRAINT bridge_events_direction_check
  CHECK (direction IN ('push_artifact', 'pull_context', 'open_from_arena', 'copy_from_arena'));

-- ---------------------------------------------------------------- roles work in stages
ALTER TABLE project_roles ADD COLUMN stages sdlc_stage[] NOT NULL DEFAULT '{}';
ALTER TABLE project_roles ADD CONSTRAINT project_roles_stages_size
  CHECK (cardinality(stages) <= 6);

-- Same order as defaultRoleStages (packages/contracts/src/roles.ts). System roles work in none.
UPDATE project_roles SET stages = CASE
    WHEN system_kind IS NOT NULL THEN '{}'
    WHEN key ~ 'security' THEN '{TEST}'
    WHEN key ~ '(qa|test)' THEN '{TEST}'
    WHEN key ~ '(sre|ops|release|deploy)' THEN '{DEPLOY,MAINTAIN}'
    WHEN key ~ '(tech_lead|platform_lead)' THEN '{DESIGN,BUILD}'
    WHEN key ~ '(manager|product|program|pm|stakeholder|analyst)' THEN '{PLAN}'
    WHEN key ~ '(design|architect)' THEN '{DESIGN}'
    WHEN key ~ '(engineer|dev|builder|coder)' THEN '{BUILD}'
    WHEN key ~ 'research' THEN '{PLAN}'
    ELSE '{}' END::sdlc_stage[];
