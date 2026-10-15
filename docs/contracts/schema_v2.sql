-- =====================================================================
-- SARAS — PostgreSQL 16 schema v2.0 (production MVP, app platform)
-- Build Pack v2.0 · supersedes schema_v1.1.sql
-- v2 adds: MNC org hierarchy (org units, unit roles), expanded org roles,
-- team roles, project system roles (Owner/Observer), 27-capability catalogue,
-- org policies & presets, agent autonomy policies, access requests,
-- invitations, routines (AI routine tasker), AI-teammate task assignment,
-- separation-of-duties gate controls, capability-checked Arena writes (RLS).
-- Conventions: uuid ids (UUIDv7 from app), org_id + RLS on every tenant table,
-- timestamptz UTC, `version int` for optimistic concurrency.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS saras;
SET search_path = saras, public;

-- ---------------------------------------------------------------- enums
CREATE TYPE org_role            AS ENUM ('owner','admin','security_admin','billing_admin','member','guest');
CREATE TYPE membership_status   AS ENUM ('invited','active','suspended','deprovisioned');
CREATE TYPE unit_role           AS ENUM ('unit_lead','unit_admin');
CREATE TYPE team_role           AS ENUM ('owner','admin','member');
CREATE TYPE discoverability     AS ENUM ('hidden','team','org');
CREATE TYPE autonomy_level      AS ENUM ('off','suggest','approve','act');
CREATE TYPE access_req_status   AS ENUM ('pending','approved','rejected','cancelled');
CREATE TYPE invite_status       AS ENUM ('pending','accepted','revoked','expired');
CREATE TYPE routine_kind        AS ENUM ('daily_digest','standup','gate_nudge','weekly_report','custom');
CREATE TYPE principal_type      AS ENUM ('user','agent','service');
CREATE TYPE agent_kind          AS ENUM ('personal','central');
CREATE TYPE project_status      AS ENUM ('setup','active','archived','decommissioned');
CREATE TYPE sdlc_stage          AS ENUM ('PLAN','DESIGN','BUILD','TEST','DEPLOY','MAINTAIN');
CREATE TYPE cycle_status        AS ENUM ('active','operating','closed','abandoned');
CREATE TYPE gate_mode           AS ENUM ('approval','auto','skip');
CREATE TYPE task_status         AS ENUM ('backlog','ready','in_progress','in_review','blocked','completed','cancelled');
CREATE TYPE task_priority       AS ENUM ('low','medium','high','urgent');
CREATE TYPE artifact_scope      AS ENUM ('private','project');
CREATE TYPE artifact_kind       AS ENUM ('goal','spec','plan','test_report','release_notes','progress',
                                         'stage_summary','diagram','document','code_ref','other');
CREATE TYPE artifact_ver_status AS ENUM ('draft','in_review','approved','superseded','discarded');
CREATE TYPE approval_status     AS ENUM ('pending','approved','rejected','expired','cancelled');
CREATE TYPE session_status      AS ENUM ('provisioning','ready','degraded','archived','failed');
CREATE TYPE turn_status         AS ENUM ('queued','running','awaiting_approval','completed','failed','cancelled');
CREATE TYPE notification_type   AS ENUM ('artifact_push','stage_update','delegation','tag','dm','approval_request','access_request','assignment','routine','system');

-- ---------------------------------------------------------------- org / identity  [C2]
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext UNIQUE NOT NULL,
  name          text NOT NULL,
  onboarded_by  uuid,                                   -- first org owner
  preset        text NOT NULL DEFAULT 'startup' CHECK (preset IN ('startup','enterprise')),
  unit_level_names text[] NOT NULL DEFAULT '{"Business unit","Department","Group"}',
  workos_org_id text UNIQUE,                            -- SSO / SCIM (WorkOS)
  data_region   text NOT NULL DEFAULT 'ap-south-1',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  display_name  text NOT NULL,
  handle        citext UNIQUE NOT NULL,
  avatar_url    text,
  last_active_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz
);
ALTER TABLE organizations ADD FOREIGN KEY (onboarded_by) REFERENCES users(id);

-- Org policies (one row per org; presets fill defaults)  [RBAC §3.10]
CREATE TABLE org_policies (
  org_id                      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  require_sso                 boolean NOT NULL DEFAULT false,
  member_team_creation        text NOT NULL DEFAULT 'members' CHECK (member_team_creation IN ('members','unit_admins','org_admins')),
  allow_cross_unit_projects   boolean NOT NULL DEFAULT true,
  guest_default_expiry_days   int NOT NULL DEFAULT 90 CHECK (guest_default_expiry_days BETWEEN 1 AND 365),
  agent_max_autonomy          autonomy_level NOT NULL DEFAULT 'act',
  allowed_model_classes       text[] NOT NULL DEFAULT '{fast,balanced,deep}',
  private_retention_days_after_leave int NOT NULL DEFAULT 30,
  project_member_limit        int NOT NULL DEFAULT 200,
  updated_by                  uuid,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Org units: BU → department → group (max 5 levels), materialised path for subtree queries
CREATE TABLE org_units (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES org_units(id) ON DELETE RESTRICT,
  name          text NOT NULL,
  depth         int NOT NULL CHECK (depth BETWEEN 1 AND 5),
  path          text NOT NULL,                        -- '/<root-id>/<child-id>/' for LIKE prefix subtree match
  scim_group_id text,
  policy_overrides jsonb NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"agent_max_autonomy":"approve"}
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, parent_id, name)
);
CREATE INDEX ON org_units (org_id, path text_pattern_ops);

CREATE TABLE org_memberships (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          org_role NOT NULL DEFAULT 'member',
  status        membership_status NOT NULL DEFAULT 'active',
  home_unit_id  uuid REFERENCES org_units(id) ON DELETE SET NULL,
  job_title     text,                                 -- metadata only, never grants access
  level         text,                                 -- e.g. L4 / Senior — metadata only
  reports_to    uuid REFERENCES users(id),            -- directory only
  scim_external_id text,
  expires_at    timestamptz,                          -- guests
  membership_version int NOT NULL DEFAULT 1,           -- bump → authz cache invalidation
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CHECK (role <> 'guest' OR expires_at IS NOT NULL)
);
CREATE INDEX ON org_memberships (user_id);

CREATE TABLE unit_role_assignments (
  org_id        uuid NOT NULL,
  unit_id       uuid NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          unit_role NOT NULL,
  assigned_by   uuid REFERENCES users(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (unit_id, user_id, role)
);

CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  unit_id       uuid REFERENCES org_units(id) ON DELETE SET NULL,
  name          text NOT NULL,
  description   text,
  allow_member_project_creation boolean NOT NULL DEFAULT true,
  default_role_template text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  UNIQUE (org_id, name)
);

CREATE TABLE team_members (
  org_id        uuid NOT NULL,
  team_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          team_role NOT NULL DEFAULT 'member',
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

-- Agents are identities only; their brains live in the external runtime  [C4]
CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind          agent_kind NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  name          text NOT NULL,
  runtime_profile text NOT NULL DEFAULT 'default',     -- harness/bundle profile name in Tau
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'personal') = (owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX agents_one_personal ON agents (org_id, owner_user_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX agents_one_central  ON agents (org_id) WHERE kind = 'central';

-- ---------------------------------------------------------------- projects + custom roles  [C1]
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams(id),
  key           text NOT NULL,
  name          text NOT NULL,
  description   text,
  goal          text,
  status        project_status NOT NULL DEFAULT 'setup',
  role_template text,                                   -- enterprise_squad | platform | program | fe_be_split | lean_squad | research | blank
  discoverability discoverability NOT NULL DEFAULT 'team',
  member_limit  int NOT NULL DEFAULT 200 CHECK (member_limit BETWEEN 1 AND 2000),
  repo_full_name text,
  setup_completed_at timestamptz,
  archived_at   timestamptz,
  tasks_version bigint NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (org_id, key),
  CHECK (status = 'setup' OR setup_completed_at IS NOT NULL)
);

-- Fixed, system-defined capability catalogue; roles are user-defined bags of these.
CREATE TABLE capabilities (
  key           text PRIMARY KEY,                      -- e.g. arena.post, stage.approve.DESIGN
  description   text NOT NULL,
  risk          text NOT NULL DEFAULT 'low'
);

CREATE TABLE project_roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           text NOT NULL,                         -- 'frontend_dev', 'architect', ...
  name          text NOT NULL,
  description   text,
  system_kind   text CHECK (system_kind IN ('owner','observer')),  -- system roles; null = custom
  is_project_admin boolean GENERATED ALWAYS AS (COALESCE(system_kind = 'owner', false)) STORED,
  color         text,
  template_key  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);
CREATE UNIQUE INDEX project_one_system_role ON project_roles (project_id, system_kind) WHERE system_kind IS NOT NULL;

CREATE TABLE role_capabilities (
  org_id        uuid NOT NULL,
  role_id       uuid NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  capability    text NOT NULL REFERENCES capabilities(key),
  PRIMARY KEY (role_id, capability)
);

CREATE TABLE project_members (
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by      uuid REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX ON project_members (user_id, last_opened_at DESC);

CREATE TABLE project_member_roles (
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL,
  user_id       uuid NOT NULL,
  role_id       uuid NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id, role_id),
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id) ON DELETE CASCADE
);

-- Who approves which stage gate, configured during setup  [C1, C10]
CREATE TABLE stage_gate_policies (
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage         sdlc_stage NOT NULL,                   -- gate to LEAVE this stage
  mode          gate_mode NOT NULL DEFAULT 'approval',
  approver_role_ids uuid[] NOT NULL DEFAULT '{}',
  min_approvals int NOT NULL DEFAULT 1 CHECK (min_approvals >= 1),
  required_artifact_kind artifact_kind,
  notify_role_ids uuid[] NOT NULL DEFAULT '{}',
  forbid_self_approval boolean NOT NULL DEFAULT false,
  min_distinct_roles int NOT NULL DEFAULT 1 CHECK (min_distinct_roles >= 1),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, stage),
  CHECK (min_distinct_roles <= min_approvals),
  CHECK (mode <> 'approval' OR cardinality(approver_role_ids) >= 1),
  CHECK (stage <> 'MAINTAIN' OR mode <> 'skip')
);

-- ---------------------------------------------------------------- arena = one shared session per project  [C5,C6,C7]
CREATE TABLE arenas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,  -- exactly one arena
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Registry of runtime sessions. One row per arena, one per private session.
CREATE TABLE agent_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  session_key   text NOT NULL UNIQUE,                  -- org/{org}/project/{p}/arena | org/{org}/user/{u}/private/{s}
  kind          text NOT NULL CHECK (kind IN ('arena','private')),
  arena_id      uuid UNIQUE REFERENCES arenas(id) ON DELETE CASCADE,
  private_session_id uuid UNIQUE,
  scope_project_id uuid REFERENCES projects(id),       -- the ONLY project this session may touch
  agent_id      uuid NOT NULL REFERENCES agents(id),   -- central (arena) or personal (private)
  runtime_session_id text,                             -- id returned by Tau / stub
  runtime_kind  text NOT NULL DEFAULT 'stub',          -- stub | tau
  status        session_status NOT NULL DEFAULT 'provisioning',
  last_turn_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'arena') = (arena_id IS NOT NULL)),
  CHECK ((kind = 'private') = (private_session_id IS NOT NULL)),
  CHECK (kind <> 'arena' OR scope_project_id IS NOT NULL)
);

-- ---------------------------------------------------------------- private space + bridge  [C3]
CREATE TABLE private_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  title         text,
  bound_project_id uuid REFERENCES projects(id),       -- set once by the bridge, never changed
  bound_at      timestamptz,
  is_archived   boolean NOT NULL DEFAULT false,
  last_message_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((bound_project_id IS NULL) = (bound_at IS NULL))
);
CREATE INDEX ON private_sessions (owner_user_id, last_message_at DESC);
ALTER TABLE agent_sessions ADD FOREIGN KEY (private_session_id) REFERENCES private_sessions(id) ON DELETE CASCADE;

CREATE FUNCTION bound_project_write_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bound_project_id IS NOT NULL AND NEW.bound_project_id IS DISTINCT FROM OLD.bound_project_id THEN
    RAISE EXCEPTION 'private session % is bound to project % and cannot be rebound', OLD.id, OLD.bound_project_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER private_sessions_bind_once BEFORE UPDATE ON private_sessions
  FOR EACH ROW EXECUTE FUNCTION bound_project_write_once();

CREATE TABLE bridge_events (                          -- audit of every Private <-> Arena crossing
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  private_session_id uuid REFERENCES private_sessions(id),
  project_id    uuid NOT NULL REFERENCES projects(id),
  direction     text NOT NULL CHECK (direction IN ('push_artifact','pull_context','open_from_arena')),
  ref           jsonb NOT NULL,                        -- artifact version / context selection
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- DMs  [C9]
CREATE TABLE dm_threads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  participant_key text NOT NULL,                       -- sorted user ids joined; dedupe 1:1 / small group
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, participant_key)
);
CREATE TABLE dm_participants (
  org_id        uuid NOT NULL,
  thread_id     uuid NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  last_read_at  timestamptz,
  PRIMARY KEY (thread_id, user_id)
);

-- ---------------------------------------------------------------- messages (arena | private | dm)
CREATE TABLE messages (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  org_id        uuid NOT NULL,
  arena_id      uuid,
  private_session_id uuid,
  dm_thread_id  uuid,
  parent_id     uuid,
  author_type   principal_type NOT NULL,
  author_id     uuid NOT NULL,
  on_behalf_of  uuid,
  body          text NOT NULL,
  attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  artifact_refs uuid[] NOT NULL DEFAULT '{}',
  turn_id       uuid,                                  -- runtime turn that produced / was triggered by it
  edited_at     timestamptz,
  deleted_at    timestamptz,
  body_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body,''))) STORED,
  PRIMARY KEY (id, created_at),
  CHECK (num_nonnulls(arena_id, private_session_id, dm_thread_id) = 1),
  CHECK (dm_thread_id IS NULL OR author_type = 'user')            -- agents don't DM in MVP
) PARTITION BY RANGE (created_at);
CREATE TABLE messages_2026_10 PARTITION OF messages FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE messages_2026_11 PARTITION OF messages FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE messages_2026_12 PARTITION OF messages FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE messages_default PARTITION OF messages DEFAULT;
CREATE INDEX ON messages (arena_id, created_at DESC) WHERE arena_id IS NOT NULL;
CREATE INDEX ON messages (private_session_id, created_at DESC) WHERE private_session_id IS NOT NULL;
CREATE INDEX ON messages (dm_thread_id, created_at DESC) WHERE dm_thread_id IS NOT NULL;
CREATE INDEX ON messages USING gin (body_tsv);

CREATE TABLE message_mentions (                       -- tags  [C9]
  org_id        uuid NOT NULL,
  message_id    uuid NOT NULL,
  message_created_at timestamptz NOT NULL,
  mentioned_type principal_type NOT NULL,
  mentioned_id  uuid NOT NULL,
  PRIMARY KEY (message_id, mentioned_type, mentioned_id),
  FOREIGN KEY (message_id, message_created_at) REFERENCES messages(id, created_at) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- SDLC loop  [C10]
CREATE TABLE sdlc_cycles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number        int NOT NULL,                          -- 1, 2, 3 ... per project
  title         text NOT NULL,
  stage         sdlc_stage NOT NULL DEFAULT 'PLAN',
  status        cycle_status NOT NULL DEFAULT 'active',
  opened_from_cycle_id uuid REFERENCES sdlc_cycles(id),  -- MAINTAIN of cycle N spawned N+1
  opened_reason text,                                  -- feedback | bug | incident | enhancement | initial
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (project_id, number),
  CHECK (status <> 'operating' OR stage = 'MAINTAIN')
);
-- MVP rule: at most one cycle in active development per project
CREATE UNIQUE INDEX one_active_cycle_per_project ON sdlc_cycles (project_id) WHERE status = 'active';

CREATE TABLE stage_transitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  cycle_id      uuid NOT NULL REFERENCES sdlc_cycles(id) ON DELETE CASCADE,
  from_stage    sdlc_stage,
  to_stage      sdlc_stage NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('advance','send_back','auto','skip','open')),
  actor_type    principal_type NOT NULL,
  actor_id      uuid NOT NULL,
  approvals     uuid[] NOT NULL DEFAULT '{}',          -- approval_request ids satisfied
  reason        text,
  evidence      jsonb,
  summary       text,                                  -- central agent stage summary
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id),
  cycle_id      uuid REFERENCES sdlc_cycles(id),
  stage         sdlc_stage,
  turn_id       uuid,                                  -- set when the runtime asked (tool needs approval)
  title         text NOT NULL,
  detail        jsonb NOT NULL,
  approver_role_ids uuid[] NOT NULL,
  min_approvals int NOT NULL DEFAULT 1,
  status        approval_status NOT NULL DEFAULT 'pending',
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE TABLE approval_votes (
  org_id        uuid NOT NULL,
  approval_id   uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  decision      text NOT NULL CHECK (decision IN ('approve','reject')),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (approval_id, user_id),
  CHECK (decision = 'approve' OR reason IS NOT NULL)
);

-- ---------------------------------------------------------------- tasks
CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id      uuid REFERENCES sdlc_cycles(id),
  stage         sdlc_stage,
  title         text NOT NULL,
  description   text,
  status        task_status NOT NULL DEFAULT 'backlog',
  blocked_reason text,
  priority      task_priority NOT NULL DEFAULT 'medium',
  weight        numeric(6,2) NOT NULL DEFAULT 1 CHECK (weight > 0),
  assignee_type principal_type,
  assignee_id   uuid,
  assignee_role_id uuid REFERENCES project_roles(id),  -- delegate to a role (e.g. "backend dev")
  delegated_by  uuid,
  reviewer_id   uuid REFERENCES users(id),             -- required when assignee is an agent
  agent_turn_id uuid,                                  -- last AI-teammate turn working on it
  verified_by   uuid REFERENCES users(id),
  due_date      date,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at  timestamptz,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK (status <> 'blocked' OR blocked_reason IS NOT NULL),
  CHECK ((assignee_type IS NULL) = (assignee_id IS NULL)),
  CHECK (assignee_type IS DISTINCT FROM 'agent' OR reviewer_id IS NOT NULL),
  CHECK (status <> 'completed' OR verified_by IS NOT NULL)
);
CREATE INDEX ON tasks (project_id, status);

-- ---------------------------------------------------------------- artifacts
CREATE TABLE blobs (
  org_id        uuid NOT NULL,
  sha256        text NOT NULL,
  size_bytes    bigint NOT NULL,
  content_type  text NOT NULL DEFAULT 'text/markdown',
  s3_key        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, sha256)
);

CREATE TABLE artifacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  lineage_id    uuid NOT NULL,
  scope         artifact_scope NOT NULL,
  kind          artifact_kind NOT NULL,
  name          text NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  private_session_id uuid REFERENCES private_sessions(id) ON DELETE SET NULL,
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id      uuid REFERENCES sdlc_cycles(id),
  stage         sdlc_stage,
  head_version_no int NOT NULL DEFAULT 0,
  approved_version_no int,
  created_by_type principal_type NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK ((scope = 'private' AND owner_user_id IS NOT NULL AND project_id IS NULL AND cycle_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX artifacts_lineage_per_project ON artifacts (project_id, lineage_id) WHERE scope = 'project';
CREATE UNIQUE INDEX artifacts_stage_doc_per_cycle ON artifacts (cycle_id, kind)
  WHERE cycle_id IS NOT NULL AND kind IN ('goal','spec','plan','test_report','release_notes');

CREATE TABLE artifact_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  version_no    int NOT NULL,
  blob_sha256   text NOT NULL,
  status        artifact_ver_status NOT NULL DEFAULT 'draft',
  change_note   text,
  source_ref    jsonb,                                 -- {type: private_session|arena_turn|push|upload, id}
  created_by_type principal_type NOT NULL,
  created_by    uuid NOT NULL,
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, version_no),
  FOREIGN KEY (org_id, blob_sha256) REFERENCES blobs(org_id, sha256)
);
CREATE UNIQUE INDEX artifact_one_approved ON artifact_versions (artifact_id) WHERE status = 'approved';

CREATE TABLE evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  artifact_version_id uuid REFERENCES artifact_versions(id),
  stage_transition_id uuid REFERENCES stage_transitions(id),
  kind          text NOT NULL CHECK (kind IN ('git_commit','pr','ci_run','deployment','link')),
  ref           text NOT NULL,
  url           text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','recorded','failed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- runtime turns (app-side ledger only)  [C4]
CREATE TABLE runtime_turns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- turn_id sent to runtime (idempotency key)
  org_id        uuid NOT NULL,
  agent_session_id uuid NOT NULL REFERENCES agent_sessions(id),
  trigger_message_id uuid,
  requested_by  uuid REFERENCES users(id),
  mode          text NOT NULL DEFAULT 'prompt' CHECK (mode IN ('prompt','steer','follow_up','system')),
  status        turn_status NOT NULL DEFAULT 'queued',
  failure_code  text,
  usage         jsonb NOT NULL DEFAULT '{}'::jsonb,           -- tokens/cost reported by runtime
  queued_at     timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX ON runtime_turns (agent_session_id, queued_at DESC);

CREATE TABLE app_tool_calls (                          -- every runtime -> App Tools call (audit + debugging)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  turn_id       uuid REFERENCES runtime_turns(id),
  session_key   text NOT NULL,
  tool          text NOT NULL,
  args_hash     text NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('ok','denied','error','approval_required')),
  deny_code     text,
  latency_ms    int,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- agent autonomy, access, invites, routines  [v2]
CREATE TABLE agent_policies (                       -- per project, per capability class  [RBAC §3.6]
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  class         text NOT NULL CHECK (class IN ('answer','post','draft_artifacts','tasks','request_gate','assigned_work','notify')),
  autonomy      autonomy_level NOT NULL,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, class)
);

CREATE TABLE access_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requester_id  uuid NOT NULL REFERENCES users(id),
  requested_role_id uuid REFERENCES project_roles(id),
  reason        text NOT NULL,
  status        access_req_status NOT NULL DEFAULT 'pending',
  decided_by    uuid REFERENCES users(id),
  granted_role_ids uuid[] NOT NULL DEFAULT '{}',
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  CHECK (status <> 'approved' OR cardinality(granted_role_ids) >= 1)
);
CREATE UNIQUE INDEX one_pending_request ON access_requests (project_id, requester_id) WHERE status = 'pending';

CREATE TABLE invitations (                          -- org / team / project invites (email-based)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  email         citext NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('org','team','project')),
  org_role      org_role NOT NULL DEFAULT 'member',
  team_id       uuid REFERENCES teams(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  project_role_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at    timestamptz NOT NULL,
  guest_access_until timestamptz,
  token_hash    text NOT NULL UNIQUE,
  status        invite_status NOT NULL DEFAULT 'pending',
  invited_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'team') = (team_id IS NOT NULL)),
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);

CREATE TABLE routines (                              -- AI routine tasker  [PRD F-11]
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          routine_kind NOT NULL,
  name          text NOT NULL,
  schedule_cron text NOT NULL,                         -- 5-field cron, min interval 1h (app-validated)
  timezone      text NOT NULL DEFAULT 'Asia/Kolkata',
  prompt        text,                                  -- custom routines; templates use built-in prompts
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,    -- e.g. {"stale_hours":24} for gate_nudge
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'custom' OR prompt IS NOT NULL)
);
CREATE INDEX ON routines (next_run_at) WHERE enabled;

CREATE TABLE routine_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  routine_id    uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('queued','running','posted','skipped','failed','awaiting_approval')),
  turn_id       uuid,
  message_id    uuid,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, scheduled_for)                   -- idempotent scheduling
);

-- ---------------------------------------------------------------- notifications  [C9]
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          notification_type NOT NULL,
  project_id    uuid REFERENCES projects(id),
  title         text NOT NULL,
  preview       text,
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  deep_link     text NOT NULL,
  actor_type    principal_type,
  actor_id      uuid,
  requires_action boolean NOT NULL DEFAULT false,
  dedupe_key    text NOT NULL,
  read_at       timestamptz,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX ON notifications (user_id, created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE notification_prefs (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid NOT NULL,
  type          notification_type NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('in_app','email_digest','off')),
  PRIMARY KEY (user_id, org_id, type)
);

-- ---------------------------------------------------------------- events / audit
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, topic text NOT NULL, type text NOT NULL,
  aggregate_id uuid NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;
CREATE TABLE processed_events (consumer text NOT NULL, event_id uuid NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id));

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY, org_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type principal_type NOT NULL, actor_id uuid NOT NULL, on_behalf_of uuid,
  action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL,
  outcome text NOT NULL, reason text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text, prev_hash bytea, hash bytea NOT NULL
);
CREATE INDEX ON audit_events (org_id, occurred_at DESC);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transitions_append_only BEFORE UPDATE OR DELETE ON stage_transitions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bridge_append_only BEFORE UPDATE OR DELETE ON bridge_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION bump_tasks_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE projects SET tasks_version = tasks_version + 1 WHERE id = COALESCE(NEW.project_id, OLD.project_id); RETURN NULL; END $$;
CREATE TRIGGER tasks_bump_version AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION bump_tasks_version();

-- ---------------------------------------------------------------- views
-- Effective capabilities of a member in a project (union of their roles)
CREATE VIEW member_capabilities WITH (security_invoker = true) AS
SELECT pmr.org_id, pmr.project_id, pmr.user_id, rc.capability
FROM project_member_roles pmr JOIN role_capabilities rc ON rc.role_id = pmr.role_id
UNION
SELECT pmr.org_id, pmr.project_id, pmr.user_id, c.key
FROM project_member_roles pmr JOIN project_roles r ON r.id = pmr.role_id AND r.system_kind = 'owner'
CROSS JOIN capabilities c;

-- Org admin dashboard (metadata only — no arena message content)  [C2]
-- security_invoker: RLS of the caller applies; API additionally requires org_role = org_admin.
CREATE VIEW org_dashboard_projects WITH (security_invoker = true) AS
SELECT p.org_id, t.unit_id, u.path AS unit_path, t.id AS team_id, t.name AS team_name, p.id AS project_id, p.key, p.name, p.status,
       c.number AS active_cycle, c.stage AS active_stage,
       (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) AS member_count,
       COALESCE(round(100 * sum(tk.weight) FILTER (WHERE tk.status = 'completed')
                / NULLIF(sum(tk.weight) FILTER (WHERE tk.status <> 'cancelled'), 0), 1), 0) AS progress_pct,
       count(tk.id) FILTER (WHERE tk.status = 'blocked') AS blocked_tasks,
       p.updated_at
FROM projects p
JOIN teams t ON t.id = p.team_id
LEFT JOIN org_units u ON u.id = t.unit_id
LEFT JOIN sdlc_cycles c ON c.project_id = p.id AND c.status = 'active'
LEFT JOIN tasks tk ON tk.project_id = p.id
GROUP BY p.org_id, t.unit_id, u.path, t.id, t.name, p.id, p.key, p.name, p.status, c.number, c.stage, p.updated_at;

-- ---------------------------------------------------------------- seed: capability catalogue
INSERT INTO capabilities(key, description, risk) VALUES
 ('arena.read','Read Arena messages, artifacts, tasks and loop state','low'),
 ('arena.post','Post, reply and tag people in the Arena','low'),
 ('arena.tag_roles','Tag a whole role (notifies every holder)','low'),
 ('agent.invoke','Ask the central agent in the Arena','low'),
 ('agent.assign_task','Assign a task to the AI teammate','medium'),
 ('agent.configure','Change the project agent autonomy policy','high'),
 ('routine.manage','Create, edit, pause and run routines','medium'),
 ('artifact.push','Push artifacts from Private into this Arena','low'),
 ('artifact.edit','Create new versions of project artifacts','low'),
 ('artifact.export','Download artifacts and progress.md','low'),
 ('task.create','Create tasks','low'),
 ('task.assign','Assign or reassign tasks to people','low'),
 ('task.delegate','Delegate tasks to people or roles','low'),
 ('task.verify','Verify acceptance criteria and close tasks','medium'),
 ('stage.request_gate','Request a stage gate','low'),
 ('stage.approve.PLAN','Approve leaving PLAN','medium'),
 ('stage.approve.DESIGN','Approve leaving DESIGN','medium'),
 ('stage.approve.BUILD','Approve leaving BUILD','medium'),
 ('stage.approve.TEST','Approve leaving TEST','medium'),
 ('stage.approve.DEPLOY','Approve leaving DEPLOY (release)','high'),
 ('cycle.open','Open the next SDLC cycle from MAINTAIN','medium'),
 ('member.invite','Add members and observers','high'),
 ('member.remove','Remove members','high'),
 ('role.manage','Create/edit custom roles and assign roles','high'),
 ('access.approve','Approve access requests','high'),
 ('project.settings','Edit project settings, gates and repo link','high'),
 ('project.archive','Archive, restore or decommission the project','high');

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_policies','org_units','unit_role_assignments','agent_policies','access_requests','invitations','routines','routine_runs','org_memberships','teams','team_members','agents','projects','project_roles','role_capabilities',
    'project_members','project_member_roles','stage_gate_policies','arenas','agent_sessions','private_sessions','bridge_events',
    'dm_threads','dm_participants','messages','message_mentions','sdlc_cycles','stage_transitions','approval_requests',
    'approval_votes','tasks','blobs','artifacts','artifact_versions','evidence','runtime_turns','app_tool_calls',
    'notifications','notification_prefs','outbox_events','audit_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (org_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (org_id = current_setting('app.org_id', true)::uuid)$p$, t);
  END LOOP;
END $$;

-- Private space is owner-only (defense in depth)  [C3]
CREATE POLICY private_owner_only ON private_sessions AS RESTRICTIVE
  USING (owner_user_id = current_setting('app.user_id', true)::uuid OR current_setting('app.system_job', true) = 'on');
CREATE POLICY private_artifacts_owner_only ON artifacts AS RESTRICTIVE
  USING (scope <> 'private' OR owner_user_id = current_setting('app.user_id', true)::uuid
         OR current_setting('app.system_job', true) = 'on');

-- Message visibility (defense in depth)  [C2,C3,C9]
--   arena  -> project members only (org admins are NOT implicit members)
--   private-> session owner only
--   dm     -> thread participants only
CREATE POLICY message_visibility ON messages AS RESTRICTIVE
  USING (current_setting('app.system_job', true) = 'on'
     OR (arena_id IS NOT NULL AND EXISTS (SELECT 1 FROM arenas a JOIN project_members pm ON pm.project_id = a.project_id
             WHERE a.id = messages.arena_id AND pm.user_id = current_setting('app.user_id', true)::uuid))
     OR (private_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM private_sessions ps
             WHERE ps.id = messages.private_session_id AND ps.owner_user_id = current_setting('app.user_id', true)::uuid))
     OR (dm_thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM dm_participants d
             WHERE d.thread_id = messages.dm_thread_id AND d.user_id = current_setting('app.user_id', true)::uuid)));

-- Arena writes require arena.post (defense in depth; agents/routines write as system jobs)  [RBAC §3.8]
CREATE POLICY arena_post_requires_capability ON messages AS RESTRICTIVE FOR INSERT
  WITH CHECK (arena_id IS NULL
     OR current_setting('app.system_job', true) = 'on'
     OR EXISTS (SELECT 1 FROM arenas a JOIN member_capabilities mc ON mc.project_id = a.project_id
                WHERE a.id = messages.arena_id
                  AND mc.user_id = current_setting('app.user_id', true)::uuid
                  AND mc.capability = 'arena.post'));

-- Guests and suspended members: app sets app.user_status; inactive users read nothing project-scoped
-- (enforced in the authz layer; DB keeps tenant + visibility guarantees above).
