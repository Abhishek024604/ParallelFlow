-- Reverts 0004_request_pipeline.
SET search_path = saras, public;

DROP TABLE IF EXISTS rate_limit_counters;
DROP TABLE IF EXISTS idempotency_keys;
