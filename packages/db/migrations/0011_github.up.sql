-- ADR-040: an arena's repository on GitHub, through the ParallelFlow GitHub App.
--
-- arena_github_repos: the one GitHub repository an arena is connected to (installation, repo,
-- default branch) and how the last sync went. A tenant table (the arena's org) with the same
-- tenant_isolation shape as schema_v2 and 0008. No token is ever stored: installation tokens are
-- minted on demand and kept in the API's memory only.
--
-- Webhooks arrive before we know the arena, like a bearer request does (ADR-037), so they use the
-- credential scope: after verifying the signature, the API sets `app.credential` to the SHA-256 of
-- 'github-repo:<repo id>' or 'github-installation:<installation id>', and only the rows of that
-- repository or installation are readable (SELECT only; writes then go through the arena's own
-- org as a system job). github_webhook_deliveries remembers each delivery id once (no payload, no
-- tenant content); a delivery is readable and insertable only under the SHA-256 of its own id.
-- No existing policy is edited or dropped; no SECURITY DEFINER.

SET search_path = saras, public;

CREATE TABLE arena_github_repos (
  org_id          uuid NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repo_id         bigint NOT NULL CHECK (repo_id > 0),
  owner           text NOT NULL CHECK (owner ~ '^[A-Za-z0-9-]{1,39}$'),
  name            text NOT NULL CHECK (name ~ '^[A-Za-z0-9._-]{1,100}$'),
  default_branch  text NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 200),
  connected_by    uuid NOT NULL REFERENCES users(id),
  connected_at    timestamptz NOT NULL DEFAULT now(),
  last_synced_at  timestamptz,
  last_sync_error text CHECK (char_length(last_sync_error) <= 500),
  PRIMARY KEY (project_id)
);
CREATE INDEX ON arena_github_repos (repo_id);
CREATE INDEX ON arena_github_repos (installation_id);

ALTER TABLE arena_github_repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena_github_repos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON arena_github_repos
  USING (org_id = saras.current_org_id())
  WITH CHECK (org_id = saras.current_org_id());
-- A verified webhook finds the arenas of its repository or installation (read only).
CREATE POLICY github_repos_by_webhook ON arena_github_repos FOR SELECT USING (
  saras.current_credential() IN (
    encode(sha256(convert_to('github-repo:' || repo_id::text, 'UTF8')), 'hex'),
    encode(sha256(convert_to('github-installation:' || installation_id::text, 'UTF8')), 'hex'))
);

CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY CHECK (delivery_id ~ '^[A-Za-z0-9-]{1,100}$'),
  event       text NOT NULL CHECK (event ~ '^[a-z_]{1,60}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON github_webhook_deliveries (received_at);

ALTER TABLE github_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY github_webhook_deliveries_by_id ON github_webhook_deliveries FOR ALL
  USING (encode(sha256(convert_to(delivery_id, 'UTF8')), 'hex') = saras.current_credential())
  WITH CHECK (encode(sha256(convert_to(delivery_id, 'UTF8')), 'hex') = saras.current_credential());

-- ---------------------------------------------------------------- grants
-- 0002's default privileges gave saras_app full DML on new tables. Deliveries are only ever added
-- (no cleanup job yet, SLICE_DEBT); repositories are connected, updated after a sync, disconnected.
REVOKE UPDATE, DELETE, TRUNCATE ON github_webhook_deliveries FROM saras_app;
GRANT SELECT, INSERT ON github_webhook_deliveries TO saras_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON arena_github_repos TO saras_app;
-- saras_relay gets nothing.
