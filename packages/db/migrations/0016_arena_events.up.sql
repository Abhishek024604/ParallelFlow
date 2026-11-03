-- ADR-044: the arena's activity log is an event stream in audit_events.
--
-- Every API action that changes an arena writes one audit_events row in the same transaction as the
-- change (packages/db events.ts), so a rolled-back change leaves no event. PROGRESS.md is rendered
-- from these rows only (apps/api progress/activity-log.ts). Metadata holds ids, names, counts and
-- refs: never message or file content (CLAUDE.md rule 7).
--
--   project_id   the arena the event belongs to (null: an org-level event; none are written yet)
--   chain        a BEFORE INSERT trigger links each row to the previous one of its arena (or of its
--                org, for org-level rows) under a per-chain advisory lock: it takes the id from the
--                sequence while holding the lock, so ids grow along the chain, and sets
--                hash = sha256(prev_hash || canonical row). The app never computes or sends a hash.
--   visibility   tenant_isolation (0001) still limits rows to the arena's org; a new RESTRICTIVE
--                SELECT policy also limits an arena's rows to its members (system jobs: all).
--   append-only  audit_append_only (0001) is unchanged.
-- Existing arenas get their history backfilled from the tables that already record it
-- (metadata.backfilled = true), so their logs are not empty. No existing policy is edited.

SET search_path = saras, public;

ALTER TABLE audit_events ADD COLUMN project_id uuid;
CREATE INDEX audit_events_project_time ON audit_events (project_id, occurred_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX audit_events_project_chain ON audit_events (project_id, id DESC)
  WHERE project_id IS NOT NULL;

-- The row as hashed: fixed keys, times in UTC with microseconds, so the text never depends on the
-- session's TimeZone or on key order (jsonb orders keys itself).
CREATE FUNCTION saras.audit_event_canonical(e saras.audit_events) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', e.id,
    'org_id', e.org_id,
    'project_id', e.project_id,
    'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', e.actor_type,
    'actor_id', e.actor_id,
    'on_behalf_of', e.on_behalf_of,
    'action', e.action,
    'target_type', e.target_type,
    'target_id', e.target_id,
    'outcome', e.outcome,
    'reason', e.reason,
    'metadata', e.metadata,
    'request_id', e.request_id)::text
$$;

CREATE FUNCTION saras.audit_events_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  prev bytea;
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('audit-chain:' || NEW.project_id::text, 0));
    SELECT e.hash INTO prev FROM saras.audit_events e
     WHERE e.project_id = NEW.project_id ORDER BY e.id DESC LIMIT 1;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('audit-chain-org:' || NEW.org_id::text, 0));
    SELECT e.hash INTO prev FROM saras.audit_events e
     WHERE e.project_id IS NULL AND e.org_id = NEW.org_id ORDER BY e.id DESC LIMIT 1;
  END IF;
  -- Under the lock: a later row of this chain always gets a larger id.
  NEW.id := nextval(pg_get_serial_sequence('saras.audit_events', 'id'));
  NEW.prev_hash := prev;
  NEW.hash := sha256(coalesce(prev, '\x'::bytea)
                     || convert_to(saras.audit_event_canonical(NEW), 'UTF8'));
  RETURN NEW;
END $$;

CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION saras.audit_events_chain();

-- An arena's events: its members only (and system jobs: the log renderer, webhooks).
CREATE POLICY audit_events_project_members ON audit_events AS RESTRICTIVE FOR SELECT USING (
  project_id IS NULL
  OR saras.is_system_job()
  OR EXISTS (SELECT 1 FROM project_members pm
              WHERE pm.project_id = audit_events.project_id
                AND pm.user_id = saras.current_user_id())
);

-- ---------------------------------------------------------------- backfill
-- One INSERT, ordered by time, so each arena's chain follows its history. Runs as the migration
-- owner (no RLS). Names and counts only, never content.

INSERT INTO audit_events (org_id, project_id, occurred_at, actor_type, actor_id, action,
                          target_type, target_id, outcome, metadata, hash)
SELECT org_id, project_id, at, actor_type, actor_id, action, target_type, target_id, 'ok',
       metadata || '{"backfilled": true}'::jsonb, '\x'::bytea
  FROM (
    -- The arena itself.
    SELECT p.org_id, p.id AS project_id, p.created_at AS at, 'user'::principal_type AS actor_type,
           p.created_by AS actor_id, 'arena.created' AS action, 'arena' AS target_type,
           p.id::text AS target_id, jsonb_build_object('name', p.name) AS metadata, 0 AS ord
      FROM projects p WHERE p.deleted_at IS NULL
    UNION ALL
    -- Members (the creator joined with the arena).
    SELECT pm.org_id, pm.project_id, pm.added_at, 'user', pm.user_id, 'team.member.joined',
           'user', pm.user_id::text, '{}'::jsonb, 1
      FROM project_members pm
    UNION ALL
    -- Cycles.
    SELECT c.org_id, c.project_id, c.created_at, 'user', c.created_by, 'loop.cycle.started',
           'cycle', c.id::text, jsonb_build_object('cycle', c.number), 2
      FROM sdlc_cycles c
    UNION ALL
    -- Stage moves and send-backs ('open' is the cycle's start, above).
    SELECT t.org_id, c.project_id, t.created_at, t.actor_type, t.actor_id,
           CASE WHEN t.kind = 'send_back' THEN 'loop.stage.sent_back' ELSE 'loop.stage.moved' END,
           'cycle', c.id::text,
           jsonb_build_object('cycle', c.number, 'from', t.from_stage, 'to', t.to_stage,
                              'kind', t.kind), 3
      FROM stage_transitions t JOIN sdlc_cycles c ON c.id = t.cycle_id
     WHERE t.kind <> 'open'
    UNION ALL
    -- Gate requests.
    SELECT ar.org_id, ar.project_id, ar.created_at,
           CASE WHEN ar.detail -> 'requested_by' ->> 'type' = 'agent'
                THEN 'agent' ELSE 'user' END::principal_type,
           COALESCE((ar.detail -> 'requested_by' ->> 'id')::uuid,
                    '00000000-0000-0000-0000-000000000000'),
           CASE WHEN ar.detail -> 'requested_by' ->> 'type' = 'agent'
                THEN 'ai.gate.requested' ELSE 'loop.gate.requested' END,
           'approval', ar.id::text,
           jsonb_build_object('stage', ar.stage, 'to', ar.detail ->> 'to',
                              'cycle', (ar.detail ->> 'cycle_number')::int,
                              'required', ar.min_approvals), 4
      FROM approval_requests ar
     WHERE ar.detail ->> 'kind' = 'stage_gate'
    UNION ALL
    -- Gate decisions: the last vote for the outcome decided it.
    SELECT ar.org_id, ar.project_id, ar.decided_at, 'user',
           COALESCE((SELECT v.user_id FROM approval_votes v
                      WHERE v.approval_id = ar.id
                        AND v.decision = CASE WHEN ar.status = 'approved' THEN 'approve'
                                              ELSE 'reject' END
                      ORDER BY v.created_at DESC LIMIT 1),
                    '00000000-0000-0000-0000-000000000000'),
           CASE WHEN ar.status = 'approved' THEN 'loop.gate.approved' ELSE 'loop.gate.rejected' END,
           'approval', ar.id::text,
           jsonb_build_object(
             'stage', ar.stage, 'to', ar.detail ->> 'to',
             'cycle', (ar.detail ->> 'cycle_number')::int, 'required', ar.min_approvals,
             'approvals', (SELECT count(*) FROM approval_votes v
                            WHERE v.approval_id = ar.id AND v.decision = 'approve')), 5
      FROM approval_requests ar
     WHERE ar.detail ->> 'kind' = 'stage_gate' AND ar.status IN ('approved', 'rejected')
       AND ar.decided_at IS NOT NULL
    UNION ALL
    -- Arena files: first versions, new versions, pushes from private chats, the AI's drafts.
    SELECT a.org_id, a.project_id, v.created_at, v.created_by_type, v.created_by,
           CASE WHEN v.created_by_type = 'agent' THEN 'ai.file.drafted'
                WHEN v.source_ref ->> 'type' = 'push' THEN 'file.pushed_from_private'
                WHEN v.version_no = 1 THEN 'file.created'
                ELSE 'file.version_added' END,
           'file', a.id::text,
           jsonb_build_object('name', a.name, 'version', v.version_no), 6
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.scope = 'project' AND a.project_id IS NOT NULL
       AND a.kind NOT IN ('progress', 'stage_summary')
    UNION ALL
    -- File approvals.
    SELECT a.org_id, a.project_id, v.approved_at, 'user',
           COALESCE(v.approved_by, '00000000-0000-0000-0000-000000000000'),
           'file.approved', 'file', a.id::text,
           jsonb_build_object('name', a.name, 'version', v.version_no), 7
      FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id
     WHERE a.scope = 'project' AND a.project_id IS NOT NULL AND v.approved_at IS NOT NULL
       AND a.kind NOT IN ('progress', 'stage_summary')
    UNION ALL
    -- Deleted files.
    SELECT a.org_id, a.project_id, a.deleted_at, 'user',
           COALESCE(a.deleted_by, '00000000-0000-0000-0000-000000000000'),
           'file.deleted', 'file', a.id::text, jsonb_build_object('name', a.name), 8
      FROM artifacts a
     WHERE a.scope = 'project' AND a.project_id IS NOT NULL AND a.deleted_at IS NOT NULL
       AND a.kind NOT IN ('progress', 'stage_summary')
    UNION ALL
    -- Arena files copied into private chats.
    SELECT b.org_id, b.project_id, b.created_at, 'user', b.user_id, 'file.copied_to_private',
           'file', COALESCE(b.ref ->> 'artifact_id', b.id::text),
           jsonb_build_object('count', COALESCE(jsonb_array_length(
             CASE WHEN jsonb_typeof(b.ref -> 'artifacts') = 'array' THEN b.ref -> 'artifacts' END),
             1)), 9
      FROM bridge_events b
     WHERE b.direction = 'copy_from_arena'
    UNION ALL
    -- Pull requests: opened, merged.
    SELECT pr.org_id, pr.project_id, pr.created_at,
           CASE WHEN pr.author_user_id IS NULL THEN 'service' ELSE 'user' END::principal_type,
           COALESCE(pr.author_user_id, '00000000-0000-0000-0000-000000000000'),
           'repo.pr.opened', 'pull_request', pr.id::text,
           jsonb_strip_nulls(jsonb_build_object('number', COALESCE(pr.github_number, pr.number),
                              'title', left(pr.title, 120), 'branch', pr.branch,
                              'login', pr.author_login)), 10
      FROM pull_requests pr
    UNION ALL
    SELECT pr.org_id, pr.project_id, pr.merged_at,
           CASE WHEN pr.merged_by IS NULL THEN 'service' ELSE 'user' END::principal_type,
           COALESCE(pr.merged_by, '00000000-0000-0000-0000-000000000000'),
           'repo.pr.merged', 'pull_request', pr.id::text,
           jsonb_build_object('number', COALESCE(pr.github_number, pr.number),
                              'title', left(pr.title, 120)), 11
      FROM pull_requests pr WHERE pr.merged_at IS NOT NULL
    UNION ALL
    -- GitHub repository connected.
    SELECT g.org_id, g.project_id, g.connected_at, 'user', g.connected_by, 'repo.connected',
           'repository', g.repo_id::text,
           jsonb_build_object('repo', g.owner || '/' || g.name), 12
      FROM arena_github_repos g
  ) h
 WHERE at IS NOT NULL
 ORDER BY project_id, at, ord;
