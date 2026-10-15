-- Reverts 0001_baseline: removes every schema_v2 object (tables, types, functions, views, policies).
-- Extensions (pgcrypto, citext, vector) are left installed: they are database-wide and may be shared.
DROP SCHEMA IF EXISTS saras CASCADE;
