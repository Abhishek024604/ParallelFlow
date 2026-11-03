-- Reverts 0015_ai_provider_keys. Dev only: saved AI keys are lost (the AI falls back to the pool).
SET search_path = saras, public;

DROP TABLE IF EXISTS ai_provider_keys;
