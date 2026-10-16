-- ADR-033 (F21-05): the outbox relay role and the pg-boss schema.
--
-- The relay reads outbox rows of every org and enqueues pg-boss jobs. No app context can do that
-- (RLS limits each one to one org), and BYPASSRLS would let it read everything. `saras_relay` is a
-- NOLOGIN group role without BYPASSRLS that owns nothing. Its grants and `TO saras_relay` policies
-- below let it see exactly:
--   outbox_events     every row (ids and event metadata, no content); publish once; delete after 7 days
--   idempotency_keys  delete expired rows only, never read them (they hold response bodies)
--   pgboss            DML on the job tables pg-boss creates
-- and nothing else in `saras`. Login roles join it per environment (`pnpm db:migrate` from
-- RELAY_DATABASE_URL locally, Terraform in AWS), like saras_app (ADR-030).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saras_relay') THEN
    CREATE ROLE saras_relay NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA saras TO saras_relay;

-- ---------------------------------------------------------------- outbox_events
-- Column privileges: the relay may change published_at and nothing else.
GRANT SELECT, DELETE ON saras.outbox_events TO saras_relay;
GRANT UPDATE (published_at) ON saras.outbox_events TO saras_relay;

-- Permissive policies OR with schema_v2's tenant_isolation, but only for members of saras_relay.
-- The app role is not a member, so its view stays one org.
CREATE POLICY relay_read ON saras.outbox_events FOR SELECT TO saras_relay
  USING (true);
-- Publish once: only unpublished rows, and only to a published state (also what FOR UPDATE checks).
CREATE POLICY relay_publish ON saras.outbox_events FOR UPDATE TO saras_relay
  USING (published_at IS NULL)
  WITH CHECK (published_at IS NOT NULL);
-- Retention (doc 06 §6.6): only rows published more than 7 days ago. Keep in sync with
-- OUTBOX_RETENTION_DAYS in packages/db/src/relay.ts.
CREATE POLICY relay_cleanup ON saras.outbox_events FOR DELETE TO saras_relay
  USING (published_at < now() - interval '7 days');

-- ---------------------------------------------------------------- idempotency_keys
-- Global sweep of expired records (F21-04 debt). DELETE only, no SELECT: the sweep is a bare
-- `DELETE FROM idempotency_keys` and this policy picks the rows, so stored responses are never read.
GRANT DELETE ON saras.idempotency_keys TO saras_relay;
CREATE POLICY relay_sweep ON saras.idempotency_keys FOR DELETE TO saras_relay
  USING (expires_at < now());

-- ---------------------------------------------------------------- pg-boss
-- Created empty here, owned by the schema owner. `pnpm db:migrate` then runs pg-boss's own install
-- as the owner (packages/db installJobSchema), so runtime roles never need CREATE. Not tenant data:
-- jobs carry the ids-only event envelope. saras_app gets nothing here.
CREATE SCHEMA IF NOT EXISTS pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO saras_relay;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saras_relay;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO saras_relay;
