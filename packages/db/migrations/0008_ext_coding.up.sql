-- ADR-037: the VS Code extension. Device sign-in (RFC 8628 style) and bearer tokens for the
-- extension, AI coding sessions on `ai/*` branches of the arena repo, pull requests into main and
-- their reviews, the `pr.merge` capability, and a per-user LLM proxy rate-limit bucket.
--
-- Credential scope (new, ADR-037). The device-code poll and every bearer request arrive before we
-- know who is calling, like sign-in does (identity scope, ADR-031). packages/db sets
-- `app.credential` (transaction-local, like every other key) to the SHA-256 of the secret the
-- client sent (device code or access token) or, to approve a device, to the typed user code; a row
-- is visible only when its hash or user code equals that value. No SECURITY DEFINER lookup
-- (ADR-031). Every other context sets `app.credential` to '' and sees none of these rows, except a
-- person's own access tokens in user scope (Connected apps).
--
-- coding_sessions, pull_requests and pr_reviews are tenant tables (one arena's org), with the same
-- tenant_isolation shape as schema_v2. No existing policy is edited or dropped.

SET search_path = saras, public;

CREATE FUNCTION saras.current_credential() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.credential', true), '') $$;

-- Signed in as a real user (user scope; the nil uuid is nobody).
CREATE FUNCTION saras.signed_in_user() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(saras.in_user_scope()
                        AND saras.current_user_id() <> '00000000-0000-0000-0000-000000000000', false) $$;

-- ---------------------------------------------------------------- device authorization (RFC 8628)
CREATE TABLE ext_device_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
  -- 8 characters from an alphabet without look-alikes (no vowels, 0, 1); shown as XXXX-XXXX.
  user_code        text NOT NULL CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$'),
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'used')),
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,
  client_name      text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 80),
  last_polled_at   timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Pending codes belong to nobody yet; approved, denied and used ones name who decided.
  CHECK (status <> 'pending' OR user_id IS NULL),
  CHECK (status IN ('pending', 'expired') OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX ext_device_codes_pending_user_code ON ext_device_codes (user_code)
  WHERE status = 'pending';
CREATE INDEX ON ext_device_codes (expires_at);

ALTER TABLE ext_device_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext_device_codes FORCE ROW LEVEL SECURITY;

-- The device sees its own row by the hash of its device code. A signed-in person sees a pending
-- row by its user code (to approve or deny it), and afterwards the row they decided (an UPDATE's
-- new row must pass this policy too), and nothing else.
CREATE POLICY ext_device_codes_read ON ext_device_codes FOR SELECT USING (
  device_code_hash = saras.current_credential()
  OR (user_code = saras.current_credential() AND saras.signed_in_user()
      AND (status = 'pending' OR user_id = saras.current_user_id()))
);
CREATE POLICY ext_device_codes_insert ON ext_device_codes FOR INSERT WITH CHECK (
  device_code_hash = saras.current_credential() AND status = 'pending' AND user_id IS NULL
);
CREATE POLICY ext_device_codes_update ON ext_device_codes FOR UPDATE
  USING (
    device_code_hash = saras.current_credential()
    OR (user_code = saras.current_credential() AND status = 'pending' AND saras.signed_in_user())
  )
  WITH CHECK (
    device_code_hash = saras.current_credential()
    OR (user_code = saras.current_credential() AND saras.signed_in_user()
        AND user_id = saras.current_user_id())
  );
-- No DELETE policy: expired rows are kept (SLICE_DEBT: cleanup job).

-- ---------------------------------------------------------------- extension access tokens
CREATE TABLE ext_access_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX ON ext_access_tokens (user_id, created_at);

ALTER TABLE ext_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext_access_tokens FORCE ROW LEVEL SECURITY;

-- A bearer request finds its token by hash; the owner lists and revokes their own in user scope.
CREATE POLICY ext_access_tokens_read ON ext_access_tokens FOR SELECT USING (
  token_hash = saras.current_credential()
  OR (saras.signed_in_user() AND user_id = saras.current_user_id())
);
-- Issued by the device-token exchange, for the person who approved the code, under the new hash.
CREATE POLICY ext_access_tokens_insert ON ext_access_tokens FOR INSERT WITH CHECK (
  token_hash = saras.current_credential() AND saras.signed_in_user()
  AND user_id = saras.current_user_id()
);
CREATE POLICY ext_access_tokens_update ON ext_access_tokens FOR UPDATE
  USING (
    token_hash = saras.current_credential()
    OR (saras.signed_in_user() AND user_id = saras.current_user_id())
  )
  WITH CHECK (
    token_hash = saras.current_credential()
    OR (saras.signed_in_user() AND user_id = saras.current_user_id())
  );

-- ---------------------------------------------------------------- AI coding sessions
CREATE TABLE coding_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  branch      text NOT NULL CHECK (branch ~ '^ai/[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?-[0-9a-f]{4}$'),
  base_sha    text NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha    text CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'pushed', 'done', 'abandoned')),
  started_by  uuid NOT NULL REFERENCES users(id),
  -- The arena message "… started an AI coding task" (thread root of the session's events).
  message_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, branch)
);
CREATE INDEX ON coding_sessions (project_id, created_at DESC);

-- ---------------------------------------------------------------- pull requests
CREATE TABLE pull_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number            int NOT NULL CHECK (number > 0),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 20000),
  branch            text NOT NULL CHECK (branch ~ '^ai/'),
  base              text NOT NULL DEFAULT 'main' CHECK (base = 'main'),
  head_sha          text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'approved', 'changes_requested', 'merged', 'closed')),
  -- For an AI-authored PR, the person who ran the coding session is the accountable author.
  author_user_id    uuid NOT NULL REFERENCES users(id),
  author_kind       text NOT NULL CHECK (author_kind IN ('human', 'ai')),
  coding_session_id uuid REFERENCES coding_sessions(id) ON DELETE SET NULL,
  message_id        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  merged_at         timestamptz,
  merged_by         uuid REFERENCES users(id),
  merge_sha         text CHECK (merge_sha ~ '^[0-9a-f]{40}$'),
  UNIQUE (project_id, number),
  CHECK ((status = 'merged') = (merged_at IS NOT NULL AND merged_by IS NOT NULL AND merge_sha IS NOT NULL))
);
-- One open PR per branch.
CREATE UNIQUE INDEX pull_requests_one_open_per_branch ON pull_requests (project_id, branch)
  WHERE status IN ('open', 'approved', 'changes_requested');
CREATE INDEX ON pull_requests (project_id, created_at DESC);

CREATE TABLE pr_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  pr_id       uuid NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('approve', 'request_changes', 'comment')),
  body        text NOT NULL DEFAULT '' CHECK (char_length(body) <= 10000),
  -- The head the review was given on: a merge needs an approval of the current head.
  head_sha    text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pr_reviews (pr_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['coding_sessions', 'pull_requests', 'pr_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = saras.current_org_id())
      WITH CHECK (org_id = saras.current_org_id())$p$, t);
  END LOOP;
END $$;

-- Separation of duties (defense in depth; the API checks first): reviews are written by the
-- signed-in reviewer themselves, and the author of a PR can never approve it.
CREATE POLICY pr_reviews_by_reviewer ON pr_reviews AS RESTRICTIVE FOR INSERT WITH CHECK (
  reviewer_id = saras.current_user_id()
  AND (decision <> 'approve' OR NOT EXISTS (
        SELECT 1 FROM pull_requests p
         WHERE p.id = pr_reviews.pr_id AND p.author_user_id = pr_reviews.reviewer_id))
);

-- ---------------------------------------------------------------- capability: pr.merge
-- The Owner holds every capability (member_capabilities), so Owners get it at once.
INSERT INTO capabilities (key, description, risk)
VALUES ('pr.merge', 'Approve and merge pull requests into main', 'high');

-- ---------------------------------------------------------------- LLM proxy rate limit
-- A third bucket of rate_limit_counters: the caller's own LLM proxy requests per minute.
ALTER TABLE rate_limit_counters DROP CONSTRAINT rate_limit_counters_bucket_check;
ALTER TABLE rate_limit_counters ADD CONSTRAINT rate_limit_counters_bucket_check
  CHECK (bucket IN ('user', 'org', 'llm'));
CREATE POLICY llm_rate_limit_counters ON rate_limit_counters FOR ALL
  USING (bucket = 'llm' AND subject_id = saras.current_user_id())
  WITH CHECK (bucket = 'llm' AND subject_id = saras.current_user_id());

-- ---------------------------------------------------------------- grants
-- Credential tables: only the columns the flows change are updatable, and nothing is deleted. 0002's
-- default privileges gave saras_app full DML on new tables, so that is revoked first.
REVOKE UPDATE, DELETE, TRUNCATE ON ext_device_codes, ext_access_tokens FROM saras_app;
GRANT SELECT, INSERT ON ext_device_codes, ext_access_tokens TO saras_app;
GRANT UPDATE (status, user_id, last_polled_at) ON ext_device_codes TO saras_app;
GRANT UPDATE (last_used_at, revoked_at) ON ext_access_tokens TO saras_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON coding_sessions, pull_requests, pr_reviews TO saras_app;
-- saras_relay gets nothing: no outbox events are emitted for these yet.
