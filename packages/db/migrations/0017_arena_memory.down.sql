-- Reverts 0017_arena_memory. Dev only: the arena's memory graph and nightly chapters are lost;
-- STATE.md keeps its last rendering.
SET search_path = saras, public;

DROP TABLE IF EXISTS state_days;
DROP TABLE IF EXISTS kg_sources;
DROP TABLE IF EXISTS kg_edges;
DROP TABLE IF EXISTS kg_nodes;
DROP TRIGGER IF EXISTS projects_memory_schedule ON projects;
DROP FUNCTION IF EXISTS saras.memory_schedule_sync();
DROP TABLE IF EXISTS memory_schedule;
ALTER TABLE arena_github_repos DROP COLUMN IF EXISTS repo_private;
ALTER TABLE projects DROP COLUMN IF EXISTS timezone;
