-- Reverts 0016_arena_events. Dev only: every arena event (and the backfill) is lost; PROGRESS.md
-- keeps its last rendering until the next one.
SET search_path = saras, public;

DROP POLICY IF EXISTS audit_events_project_members ON audit_events;
DROP TRIGGER IF EXISTS audit_events_chain ON audit_events;
DROP FUNCTION IF EXISTS saras.audit_events_chain();
-- audit_events is append-only (0001 trigger): drop the arena rows with the trigger off.
ALTER TABLE audit_events DISABLE TRIGGER audit_append_only;
DELETE FROM audit_events WHERE project_id IS NOT NULL;
ALTER TABLE audit_events ENABLE TRIGGER audit_append_only;
DROP FUNCTION IF EXISTS saras.audit_event_canonical(saras.audit_events);
DROP INDEX IF EXISTS audit_events_project_chain;
DROP INDEX IF EXISTS audit_events_project_time;
ALTER TABLE audit_events DROP COLUMN IF EXISTS project_id;
