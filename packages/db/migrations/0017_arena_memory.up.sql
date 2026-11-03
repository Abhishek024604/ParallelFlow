-- ADR-045: the arena's memory is a knowledge graph; STATE.md is the nightly story told from it.
--
-- Each night, after the arena's day ends in its own timezone, the API reads that day (messages,
-- events, approved files, pull requests), asks the arena's AI for the people, decisions, rules,
-- questions, risks and actions in it (strict JSON), merges them into the graph with deterministic
-- code, and asks the AI for the day's chapter. STATE.md is rendered from the graph and the chapters.
--
--   projects.timezone         IANA zone the arena's day ends in (default UTC; the web sends the
--                             owner's browser zone when the arena is created; the owner edits it)
--   arena_github_repos.repo_private  whether the GitHub repo is private (null: not known yet).
--                             STATE.md and docs/state/ go to GitHub only when it is true.
--   memory_schedule           one row per arena (kept by a trigger on projects): its zone and the
--                             last day written. No tenant content: the nightly scheduler reads it
--                             across arenas under the 'memory-scheduler' credential (ADR-037
--                             credential scope, SELECT only), then works in each arena's own org.
--   kg_nodes / kg_edges       the graph: typed nodes with a stable key per arena (D-001 …), typed
--                             edges, both time-aware (valid_from / valid_to: a superseded decision
--                             keeps its history). embedding is nullable: there is no embedding
--                             provider yet, so matching uses keys and titles (SLICE_DEBT).
--   kg_sources                where each node or edge came from (a message, an event, a file
--                             version, a pull request): ids only.
--   state_days                one row per arena-day: its status, the chapter (append-only once
--                             done) and the "story so far" written that night.
-- Tenant tables: tenant_isolation like 0011, plus a RESTRICTIVE members-only SELECT like 0016
-- (system jobs: all). Writes come from system jobs only. No existing policy is edited; no
-- SECURITY DEFINER.

SET search_path = saras, public;

-- ---------------------------------------------------------------- the arena's day
ALTER TABLE projects ADD COLUMN timezone text NOT NULL DEFAULT 'UTC'
  CHECK (char_length(timezone) BETWEEN 1 AND 64 AND timezone ~ '^[A-Za-z0-9_+/-]+$');

ALTER TABLE arena_github_repos ADD COLUMN repo_private boolean;

CREATE TABLE memory_schedule (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL,
  timezone   text NOT NULL,
  last_day   date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE memory_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_schedule
  USING (org_id = saras.current_org_id())
  WITH CHECK (org_id = saras.current_org_id());
-- The nightly scheduler lists every arena's zone and last day (ids and dates only).
CREATE POLICY memory_schedule_by_scheduler ON memory_schedule FOR SELECT USING (
  saras.current_credential() = encode(sha256(convert_to('memory-scheduler', 'UTF8')), 'hex')
);

-- The schedule follows the project: created with it, its zone kept equal.
CREATE FUNCTION saras.memory_schedule_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO saras.memory_schedule (project_id, org_id, timezone)
  VALUES (NEW.id, NEW.org_id, NEW.timezone)
  ON CONFLICT (project_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now();
  RETURN NEW;
END $$;
CREATE TRIGGER projects_memory_schedule AFTER INSERT OR UPDATE OF timezone ON projects
  FOR EACH ROW EXECUTE FUNCTION saras.memory_schedule_sync();

INSERT INTO memory_schedule (project_id, org_id, timezone)
SELECT p.id, p.org_id, p.timezone FROM projects p
ON CONFLICT (project_id) DO NOTHING;

-- ---------------------------------------------------------------- the graph
CREATE TABLE kg_nodes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL,
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN (
                   'Person', 'Role', 'Decision', 'Instruction', 'Requirement', 'Question', 'Risk',
                   'ActionItem', 'Artifact', 'Story', 'Component', 'Milestone', 'Topic')),
  key            text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 120),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  summary        text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 2000),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN (
                   'active', 'open', 'resolved', 'done', 'superseded', 'dropped')),
  attrs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding      vector(1536),
  search         tsvector GENERATED ALWAYS AS (
                   to_tsvector('simple', coalesce(key, '') || ' ' || coalesce(title, '') || ' '
                                         || coalesce(summary, ''))) STORED,
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_to       timestamptz,
  first_seen_day date NOT NULL,
  last_seen_day  date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, type, key)
);
CREATE INDEX kg_nodes_project_type ON kg_nodes (project_id, type, status);
CREATE INDEX kg_nodes_search ON kg_nodes USING gin (search);

CREATE TABLE kg_edges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  src         uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  dst         uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN (
                'DECIDED_BY', 'RAISED_BY', 'OWNS', 'ASSIGNED_TO', 'ABOUT', 'AFFECTS',
                'SUPERSEDES', 'ANSWERS', 'BLOCKS', 'DEPENDS_ON', 'IMPLEMENTS', 'HAPPENED_ON')),
  confidence  real NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  created_day date NOT NULL,
  CHECK (src <> dst)
);
-- One live edge of a type between two nodes.
CREATE UNIQUE INDEX kg_edges_live ON kg_edges (project_id, src, dst, type) WHERE valid_to IS NULL;
CREATE INDEX kg_edges_src ON kg_edges (src);
CREATE INDEX kg_edges_dst ON kg_edges (dst);

CREATE TABLE kg_sources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id     uuid REFERENCES kg_nodes(id) ON DELETE CASCADE,
  edge_id     uuid REFERENCES kg_edges(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN (
                'message', 'event', 'artifact_version', 'pull_request')),
  source_id   text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 80),
  day         date NOT NULL,
  CHECK ((node_id IS NULL) <> (edge_id IS NULL))
);
CREATE UNIQUE INDEX kg_sources_node ON kg_sources (node_id, source_type, source_id)
  WHERE node_id IS NOT NULL;
CREATE UNIQUE INDEX kg_sources_edge ON kg_sources (edge_id, source_type, source_id)
  WHERE edge_id IS NOT NULL;

CREATE TABLE state_days (
  org_id     uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day        date NOT NULL,
  status     text NOT NULL CHECK (status IN ('pending', 'done', 'quiet', 'failed')),
  title      text CHECK (char_length(title) <= 200),
  chapter    text CHECK (char_length(chapter) <= 20000),
  story      text CHECK (char_length(story) <= 8000),
  stage      text,
  cycle      int,
  attempts   int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  model      text CHECK (char_length(model) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day)
);

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kg_nodes', 'kg_edges', 'kg_sources', 'state_days'] LOOP
    EXECUTE format('ALTER TABLE saras.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE saras.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON saras.%I
      USING (org_id = saras.current_org_id()) WITH CHECK (org_id = saras.current_org_id())', t);
    -- An arena's memory: its members only (and system jobs: the nightly job, App Tools).
    EXECUTE format('CREATE POLICY %I ON saras.%I AS RESTRICTIVE FOR SELECT USING (
      saras.is_system_job()
      OR EXISTS (SELECT 1 FROM saras.project_members pm
                  WHERE pm.project_id = %I.project_id AND pm.user_id = saras.current_user_id()))',
      t || '_members', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants
-- The graph is never deleted row by row (nodes close with valid_to, edges too); arenas cascade.
GRANT SELECT, INSERT, UPDATE ON kg_nodes, kg_edges, kg_sources, state_days, memory_schedule
  TO saras_app;
REVOKE DELETE, TRUNCATE ON kg_nodes, kg_edges, kg_sources, state_days, memory_schedule
  FROM saras_app;
-- saras_relay gets nothing.
