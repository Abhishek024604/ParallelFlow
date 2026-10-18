-- Reverts 0008_ext_coding. Dev only: drops the extension's tokens, coding sessions, pull requests
-- and reviews, the pr.merge capability (and every role's grant of it) and the llm rate-limit rows.
SET search_path = saras, public;

DROP POLICY IF EXISTS llm_rate_limit_counters ON rate_limit_counters;
DELETE FROM rate_limit_counters WHERE bucket = 'llm';
ALTER TABLE rate_limit_counters DROP CONSTRAINT IF EXISTS rate_limit_counters_bucket_check;
ALTER TABLE rate_limit_counters ADD CONSTRAINT rate_limit_counters_bucket_check
  CHECK (bucket IN ('user', 'org'));

DELETE FROM role_capabilities WHERE capability = 'pr.merge';
DELETE FROM capabilities WHERE key = 'pr.merge';

DROP TABLE IF EXISTS pr_reviews;
DROP TABLE IF EXISTS pull_requests;
DROP TABLE IF EXISTS coding_sessions;
DROP TABLE IF EXISTS ext_access_tokens;
DROP TABLE IF EXISTS ext_device_codes;

DROP FUNCTION IF EXISTS saras.signed_in_user();
DROP FUNCTION IF EXISTS saras.current_credential();
