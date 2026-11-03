-- ADR-043: bring your own AI provider key.
--
-- A person can add their own key (OpenAI, Anthropic, DeepSeek, OpenRouter, …) for their private
-- chats, and an arena owner can add one for the arena's AI. Without one, ParallelFlow's own key pool
-- answers, as before. The key is sealed by the API (AES-256-GCM, key derived from the server
-- secret, like user_connections in 0010): the database never holds it in clear text. key_last4 is
-- the only part ever shown.
--
-- One table, two owners, two RLS shapes:
--   user rows    (user_id set, org_id/project_id null): owner-only in user scope (0010 style);
--   project rows (org_id + project_id set, user_id null): tenant_isolation (0011 style). Every
--                 member's request can read the row (provider, model, last4 are shown in arena
--                 settings); only the arena owner may write it, checked by the API.
-- A tenant context never sees a user row (org_id is null there) and user scope never sees a
-- project row (user_id is null there). No existing policy is edited; no SECURITY DEFINER.

SET search_path = saras, public;

CREATE TABLE ai_provider_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid,
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN (
                  'openai', 'anthropic', 'deepseek', 'openrouter', 'google',
                  'groq', 'mistral', 'xai', 'together', 'fireworks')),
  model         text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  secret_sealed text NOT NULL CHECK (char_length(secret_sealed) BETWEEN 20 AND 2000),
  key_last4     text NOT NULL CHECK (char_length(key_last4) BETWEEN 1 AND 4),
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Exactly one owner: a person, or an arena (its org and project together).
  CONSTRAINT ai_provider_keys_one_owner CHECK (
    (user_id IS NOT NULL AND org_id IS NULL AND project_id IS NULL)
    OR (user_id IS NULL AND org_id IS NOT NULL AND project_id IS NOT NULL))
);
-- One key per owner.
CREATE UNIQUE INDEX ai_provider_keys_user ON ai_provider_keys (user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ai_provider_keys_project ON ai_provider_keys (project_id)
  WHERE project_id IS NOT NULL;

ALTER TABLE ai_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_provider_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY private_space_ai_keys ON ai_provider_keys FOR ALL
  USING (user_id IS NOT NULL AND saras.in_user_scope() AND user_id = saras.current_user_id())
  WITH CHECK (user_id IS NOT NULL AND saras.in_user_scope() AND user_id = saras.current_user_id());
CREATE POLICY tenant_isolation ON ai_provider_keys
  USING (org_id IS NOT NULL AND org_id = saras.current_org_id())
  WITH CHECK (org_id IS NOT NULL AND org_id = saras.current_org_id());

-- The app role only; saras_relay gets nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_provider_keys TO saras_app;
