-- ADR-030: the application role.
-- FORCE RLS does not apply to superusers or roles with BYPASSRLS (including managed-Postgres owner
-- roles such as Neon's neondb_owner). API, worker and tests therefore connect as a login role that is
-- a member of saras_app, which has no BYPASSRLS and owns no tables. Login roles are provisioned per
-- environment (`pnpm db:migrate` locally, Terraform in AWS), not here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saras_app') THEN
    CREATE ROLE saras_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA saras TO saras_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA saras TO saras_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA saras TO saras_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA saras GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saras_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA saras GRANT USAGE, SELECT ON SEQUENCES TO saras_app;

-- The capability catalogue is system-defined (ADR-020): the app reads it, never writes it.
REVOKE INSERT, UPDATE, DELETE ON saras.capabilities FROM saras_app;

-- Message partitions have no RLS of their own: policies on `messages` apply only when the parent is
-- queried. Access must always go through the parent, so the app gets no grants on partitions.
-- New partitions (pg_partman) must be revoked the same way; the tenant suite checks this.
REVOKE ALL ON saras.messages_2026_10, saras.messages_2026_11, saras.messages_2026_12, saras.messages_default
  FROM saras_app;
