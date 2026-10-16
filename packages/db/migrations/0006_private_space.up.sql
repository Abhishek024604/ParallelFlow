-- ADR-034: Private belongs to no org. Every person has a Private space whether or not they are in any
-- arena. Private rows carry org_id NULL and are reachable only by their owner in user scope
-- (db.withUser: app.org_id = nil uuid, app.user_id = owner). schema_v2's tenant_isolation compares
-- org_id = app.org_id, which is never true for NULL, so no tenant context and no system job ever sees
-- or writes these rows. No existing policy is edited or dropped: the policies below are new
-- PERMISSIVE ones that OR with tenant_isolation, and schema_v2's RESTRICTIVE ones still apply
-- (private_owner_only, message_visibility and arena_post_requires_capability all pass for the owner's
-- private rows).
--
-- The bridge (bridge_events) keeps the arena's org. Private artifacts are unchanged (still org-scoped)
-- until the bridge step.

SET search_path = saras, public;

-- ---------------------------------------------------------------- nullable org on the private tables
-- messages is partitioned: DROP NOT NULL and ADD CONSTRAINT on the parent propagate to every partition.
ALTER TABLE private_sessions ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE messages         ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE agents           ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE agent_sessions   ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE runtime_turns    ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE app_tool_calls   ALTER COLUMN org_id DROP NOT NULL;

-- Strict: a row is private exactly when it has no org. Existing rows: schema_v2 has no private rows
-- in the dev seed; any org-scoped private row (an old fixture) fails here and must be removed first.
ALTER TABLE private_sessions ADD CONSTRAINT private_sessions_no_org CHECK (org_id IS NULL);
ALTER TABLE messages ADD CONSTRAINT messages_private_no_org
  CHECK ((private_session_id IS NOT NULL) = (org_id IS NULL));
ALTER TABLE agents ADD CONSTRAINT agents_personal_no_org
  CHECK ((kind = 'personal') = (org_id IS NULL));
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_private_no_org
  CHECK ((kind = 'private') = (org_id IS NULL));

-- One personal agent per person. agents_one_personal (org_id, owner_user_id) stays as it is but no
-- longer constrains anything: NULL org ids are distinct in a unique index.
CREATE UNIQUE INDEX agents_one_personal_per_user ON agents (owner_user_id) WHERE kind = 'personal';

-- ---------------------------------------------------------------- private projects (ChatGPT-style folders)
-- The owner's own folders for private chats. Not arena projects, never shared.
CREATE TABLE private_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX ON private_projects (user_id, created_at);

-- Deleting a project moves its chats to Recent: never deletes them.
ALTER TABLE private_sessions
  ADD COLUMN private_project_id uuid REFERENCES private_projects(id) ON DELETE SET NULL;
CREATE INDEX ON private_sessions (private_project_id) WHERE private_project_id IS NOT NULL;

ALTER TABLE private_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_projects FORCE ROW LEVEL SECURITY;
CREATE POLICY private_space_projects ON private_projects FOR ALL
  USING (saras.in_user_scope() AND user_id = saras.current_user_id())
  WITH CHECK (saras.in_user_scope() AND user_id = saras.current_user_id());

-- ---------------------------------------------------------------- owner-only policies for org-less rows
-- All gated on user scope, so a tenant context (even the owner's own) never sees Private.

CREATE POLICY private_space_sessions ON private_sessions FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND owner_user_id = saras.current_user_id())
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND owner_user_id = saras.current_user_id()
    -- A chat can only be filed in one of your own projects (RLS on private_projects).
    AND (private_project_id IS NULL
         OR EXISTS (SELECT 1 FROM private_projects pp WHERE pp.id = private_sessions.private_project_id)));

-- Messages of your own private chats: yours, and your personal agent's replies.
CREATE POLICY private_space_messages ON messages FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND private_session_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM private_sessions ps
                     WHERE ps.id = messages.private_session_id
                       AND ps.owner_user_id = saras.current_user_id()))
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND private_session_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM private_sessions ps
                     WHERE ps.id = messages.private_session_id
                       AND ps.owner_user_id = saras.current_user_id())
         AND ((author_type = 'user' AND author_id = saras.current_user_id())
              OR (author_type = 'agent' AND EXISTS (SELECT 1 FROM agents a
                     WHERE a.id = messages.author_id AND a.kind = 'personal'
                       AND a.owner_user_id = saras.current_user_id()))));

CREATE POLICY private_space_agents ON agents FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND kind = 'personal'
         AND owner_user_id = saras.current_user_id())
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND kind = 'personal'
         AND owner_user_id = saras.current_user_id());

CREATE POLICY private_space_agent_sessions ON agent_sessions FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND kind = 'private'
         AND EXISTS (SELECT 1 FROM private_sessions ps
                     WHERE ps.id = agent_sessions.private_session_id
                       AND ps.owner_user_id = saras.current_user_id()))
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND kind = 'private'
         AND scope_project_id IS NULL
         AND EXISTS (SELECT 1 FROM private_sessions ps
                     WHERE ps.id = agent_sessions.private_session_id
                       AND ps.owner_user_id = saras.current_user_id())
         AND EXISTS (SELECT 1 FROM agents a
                     WHERE a.id = agent_sessions.agent_id AND a.kind = 'personal'
                       AND a.owner_user_id = saras.current_user_id()));

CREATE POLICY private_space_turns ON runtime_turns FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope()
         AND EXISTS (SELECT 1 FROM agent_sessions s
                     JOIN private_sessions ps ON ps.id = s.private_session_id
                     WHERE s.id = runtime_turns.agent_session_id AND s.kind = 'private'
                       AND ps.owner_user_id = saras.current_user_id()))
  WITH CHECK (org_id IS NULL AND saras.in_user_scope()
         AND EXISTS (SELECT 1 FROM agent_sessions s
                     JOIN private_sessions ps ON ps.id = s.private_session_id
                     WHERE s.id = runtime_turns.agent_session_id AND s.kind = 'private'
                       AND ps.owner_user_id = saras.current_user_id()));

CREATE POLICY private_space_tool_calls ON app_tool_calls FOR ALL
  USING (org_id IS NULL AND saras.in_user_scope() AND turn_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM runtime_turns t
                     JOIN agent_sessions s ON s.id = t.agent_session_id
                     JOIN private_sessions ps ON ps.id = s.private_session_id
                     WHERE t.id = app_tool_calls.turn_id AND t.org_id IS NULL
                       AND ps.owner_user_id = saras.current_user_id()))
  WITH CHECK (org_id IS NULL AND saras.in_user_scope() AND turn_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM runtime_turns t
                     JOIN agent_sessions s ON s.id = t.agent_session_id
                     JOIN private_sessions ps ON ps.id = s.private_session_id
                     WHERE t.id = app_tool_calls.turn_id AND t.org_id IS NULL
                       AND ps.owner_user_id = saras.current_user_id()));

-- Grants: 0002's default privileges already give saras_app DML on new tables created by the migrating
-- role; granted explicitly as well (like 0004) so a different owner role cannot leave it out.
-- saras_relay gets nothing (0005 grants it outbox_events and idempotency_keys only).
GRANT SELECT, INSERT, UPDATE, DELETE ON private_projects TO saras_app;
