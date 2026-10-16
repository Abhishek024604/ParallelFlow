-- Reverts 0005_outbox_relay in this database. Drops the pg-boss schema with every job in it.
-- The saras_relay role itself is cluster-wide and may hold privileges in other databases (e.g. Neon
-- branches), so it is left in place, like saras_app (0002).

ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM saras_relay;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM saras_relay;
DROP SCHEMA IF EXISTS pgboss CASCADE;

DROP POLICY IF EXISTS relay_sweep ON saras.idempotency_keys;
DROP POLICY IF EXISTS relay_cleanup ON saras.outbox_events;
DROP POLICY IF EXISTS relay_publish ON saras.outbox_events;
DROP POLICY IF EXISTS relay_read ON saras.outbox_events;

-- Revoking table privileges also revokes the column privilege on published_at.
REVOKE ALL ON saras.outbox_events, saras.idempotency_keys FROM saras_relay;
REVOKE USAGE ON SCHEMA saras FROM saras_relay;
