-- ADR-039: private extensions (marketplace) and connected services.
--
-- A person installs an extension (Software Architect, Product Manager) for all of their private
-- chats; the arena's AI stays general. A connected service (Linear, for the PM extension) keeps the
-- person's credential sealed by the API (AES-256-GCM, key derived from the server secret): the
-- database never holds it in clear text. Both tables are owner-only, like private_projects (0006):
-- gated on user scope, so no tenant context (even the owner's own) ever sees them.

SET search_path = saras, public;

CREATE TABLE user_extensions (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension_key text NOT NULL CHECK (extension_key IN ('swa', 'pm')),
  installed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, extension_key)
);

CREATE TABLE user_connections (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('linear')),
  secret_sealed text NOT NULL CHECK (char_length(secret_sealed) BETWEEN 20 AND 2000),
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE user_extensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_extensions FORCE ROW LEVEL SECURITY;
CREATE POLICY private_space_extensions ON user_extensions FOR ALL
  USING (saras.in_user_scope() AND user_id = saras.current_user_id())
  WITH CHECK (saras.in_user_scope() AND user_id = saras.current_user_id());

ALTER TABLE user_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY private_space_connections ON user_connections FOR ALL
  USING (saras.in_user_scope() AND user_id = saras.current_user_id())
  WITH CHECK (saras.in_user_scope() AND user_id = saras.current_user_id());

-- The app role only; saras_relay gets nothing.
GRANT SELECT, INSERT, DELETE ON user_extensions TO saras_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_connections TO saras_app;
