-- F21-04: storage for the request pipeline (doc 05 §5.5, doc 07 §7.1).
-- Idempotency records and rate-limit counters live in Postgres for the YC slice and move to Redis
-- when realtime lands (SLICE_DEBT.md). Neither table has an org_id column: they are keyed by user
-- (and, for org rate limits, by the org of a verified membership), not by tenant.

SET search_path = saras, public;

-- ---------------------------------------------------------------- idempotency_keys
-- One row per (user, Idempotency-Key): the completed response of a creating / state-transition POST,
-- replayed for 24 h. The body can hold content (messages, artifacts), so only its owner can see it.
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key              text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
  method           text NOT NULL,
  path             text NOT NULL,
  request_hash     text NOT NULL,          -- sha256 of the canonical request (body + query), never the body
  response_status  int  NOT NULL CHECK (response_status BETWEEN 200 AND 299),
  response_headers jsonb NOT NULL DEFAULT '{}',
  response_body    text,                   -- the JSON exactly as sent, so a replay is byte-identical
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX ON idempotency_keys (user_id, expires_at);
CREATE INDEX ON idempotency_keys (expires_at);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

-- Owner only, in every context that names a user (user scope or tenant). Identity scope and system
-- jobs carry the nil user and see nothing.
CREATE POLICY own_idempotency_keys ON idempotency_keys FOR ALL
  USING (user_id = saras.current_user_id())
  WITH CHECK (user_id = saras.current_user_id());

-- ---------------------------------------------------------------- rate_limit_counters
-- Fixed one-minute windows: 600 requests per user, 6,000 per org (doc 07 §7.1). Counts only, no
-- content. A user touches only their own counter; an org counter only inside that org's tenant
-- context, which request handlers reach through a verified membership (ADR-031).
CREATE TABLE rate_limit_counters (
  bucket       text NOT NULL CHECK (bucket IN ('user', 'org')),
  subject_id   uuid NOT NULL CHECK (subject_id <> '00000000-0000-0000-0000-000000000000'),
  window_start timestamptz NOT NULL,
  hits         int NOT NULL DEFAULT 0 CHECK (hits >= 0),
  PRIMARY KEY (bucket, subject_id, window_start)
);

ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY own_rate_limit_counters ON rate_limit_counters FOR ALL
  USING (
    (bucket = 'user' AND subject_id = saras.current_user_id())
    OR (bucket = 'org' AND subject_id = saras.current_org_id())
  )
  WITH CHECK (
    (bucket = 'user' AND subject_id = saras.current_user_id())
    OR (bucket = 'org' AND subject_id = saras.current_org_id())
  );

-- 0002 set default privileges, so saras_app already has DML on both tables. Restated for clarity.
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys, rate_limit_counters TO saras_app;
