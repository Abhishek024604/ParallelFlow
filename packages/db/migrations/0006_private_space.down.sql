-- Reverts 0006_private_space. org_id cannot be NOT NULL again while org-less Private rows exist, so
-- they are deleted first (dev only: Private chats are lost). Fails if a bridge_events row points at
-- a private session (append-only; none exist before the bridge step).
SET search_path = saras, public;

DROP POLICY IF EXISTS private_space_tool_calls ON app_tool_calls;
DROP POLICY IF EXISTS private_space_turns ON runtime_turns;
DROP POLICY IF EXISTS private_space_agent_sessions ON agent_sessions;
DROP POLICY IF EXISTS private_space_agents ON agents;
DROP POLICY IF EXISTS private_space_messages ON messages;
DROP POLICY IF EXISTS private_space_sessions ON private_sessions;

DELETE FROM app_tool_calls WHERE org_id IS NULL;
DELETE FROM runtime_turns WHERE org_id IS NULL;
DELETE FROM messages WHERE org_id IS NULL;
DELETE FROM agent_sessions WHERE org_id IS NULL;
DELETE FROM private_sessions WHERE org_id IS NULL;
DELETE FROM agents WHERE org_id IS NULL;

ALTER TABLE private_sessions DROP COLUMN IF EXISTS private_project_id;
DROP TABLE IF EXISTS private_projects;

DROP INDEX IF EXISTS agents_one_personal_per_user;
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_private_no_org;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_personal_no_org;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_private_no_org;
ALTER TABLE private_sessions DROP CONSTRAINT IF EXISTS private_sessions_no_org;

ALTER TABLE app_tool_calls   ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE runtime_turns    ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE agent_sessions   ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE agents           ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE messages         ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE private_sessions ALTER COLUMN org_id SET NOT NULL;
