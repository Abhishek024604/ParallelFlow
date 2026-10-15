-- Reverts 0002_app_role in this database. The saras_app role itself is cluster-wide and may hold
-- privileges in other databases (e.g. Neon branches), so it is left in place.
ALTER DEFAULT PRIVILEGES IN SCHEMA saras REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM saras_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA saras REVOKE USAGE, SELECT ON SEQUENCES FROM saras_app;
REVOKE ALL ON ALL TABLES IN SCHEMA saras FROM saras_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA saras FROM saras_app;
REVOKE USAGE ON SCHEMA saras FROM saras_app;
