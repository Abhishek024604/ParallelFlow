-- Reverts 0011_github. Dev only: arenas forget their GitHub repository (the repositories on
-- GitHub and the local arena repos are untouched) and the delivery log is dropped.
SET search_path = saras, public;

DROP TABLE IF EXISTS github_webhook_deliveries;
DROP TABLE IF EXISTS arena_github_repos;
