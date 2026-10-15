# 06 — Data Model

> Build Pack v2.0 · Source of truth: `contracts/schema_v2.sql` (PostgreSQL 16 + pgvector). Supersedes `schema.sql` v1.0 and `schema_v1.1.sql`.
> Validated on PostgreSQL 16.15: 45 tables (+4 monthly message partitions), 2 views, RLS on 41 tables, 27 seeded capabilities.
> After migrations 0002–0004: 47 tables, forced RLS on 45 (the 41 tenant tables, `users`, `organizations`, `idempotency_keys`, `rate_limit_counters`).

---

## 6.1 Entity relationships

![ERD v2](../diagrams/png/33_erd_v2.png)

## 6.2 Table catalogue

| Area | Tables | Notes |
|---|---|---|
| Organization | `organizations`, `org_policies`, `org_memberships`, `invitations` | Preset, WorkOS ids, region; one policy row per org; membership has role, status, home unit, level/title (metadata), reports_to, guest expiry, `membership_version` |
| Hierarchy | `org_units`, `unit_role_assignments` | Tree ≤5 levels, materialised `path` for subtree queries; Unit Lead / Unit Admin |
| Teams | `teams`, `team_members` | Unit link, team role owner/admin/member, team defaults |
| Identity & agents | `users`, `agents` | One personal agent per (org, user); one central agent per org (identity only; brains in Tau) |
| Projects & RBAC | `projects`, `capabilities`, `project_roles`, `role_capabilities`, `project_members`, `project_member_roles`, `stage_gate_policies`, `agent_policies`, `access_requests` | System roles (owner/observer) + custom roles; 27 capabilities; gate SoD controls; autonomy per class |
| Arena & sessions | `arenas`, `agent_sessions`, `messages` (partitioned), `message_mentions` | Exactly one Arena and one agent session per project; messages belong to exactly one of arena / private session / DM |
| Private & bridge | `private_sessions`, `bridge_events` | Write-once `bound_project_id`; every crossing audited |
| DMs | `dm_threads`, `dm_participants` | User-to-user only |
| SDLC loop | `sdlc_cycles`, `stage_transitions`, `approval_requests`, `approval_votes`, `evidence` | One active cycle; append-only transitions |
| Work | `tasks` | Agent assignee requires reviewer; completion requires verifier |
| Artifacts | `blobs`, `artifacts`, `artifact_versions` | Content-addressed; one approved version |
| Routines | `routines`, `routine_runs` | Cron + timezone; unique run per slot |
| Runtime ledger | `runtime_turns`, `app_tool_calls` | Turns, usage, every tool call |
| Notifications | `notifications`, `notification_prefs` | 10 types; dedupe key |
| Events & audit | `outbox_events`, `processed_events`, `audit_events` | Outbox, idempotent consumers, hash-chained audit |
| Request pipeline (F21-04, migration 0004) | `idempotency_keys`, `rate_limit_counters` | Not tenant tables (no `org_id`). Stored 2xx responses per (user, Idempotency-Key) for 24 h; fixed one-minute request counters per user and per org. Postgres until Redis lands (SLICE_DEBT) |
| Views | `member_capabilities`, `org_dashboard_projects` (+ `project_progress` derivable) | `security_invoker = true` so the caller's RLS applies |

## 6.3 Invariants enforced by the database

| Invariant | Mechanism | Verified |
|---|---|---|
| Tenant isolation | RLS `tenant_isolation` (FORCE) on 41 tables via `app.org_id` | ✓ |
| Identity tables are not global | RLS on `users` (self, verified sign-in email, co-members of the current org) and `organizations` (current org; your active orgs in user scope). ADR-031 | ✓ `identity-scope.int.test.ts` |
| Cross-arena reads are own-rows only | User scope (nil `app.org_id`): your memberships, projects and orgs; no tenant content. ADR-031 | ✓ |
| Tenant comes from a verified membership | `withOrgMember` / `withProjectMember` check an active membership, then set the tenant in the same transaction. No membership → `NotVisibleError` (404); your own membership suspended, deprovisioned or an expired guest → `MembershipInactiveError` (403 `MEMBERSHIP_INACTIVE`). ADR-031, F21-04 | ✓ |
| Idempotency records are owner-only | FORCE RLS on `idempotency_keys`: `user_id = current_user_id()` for read and write; system jobs and identity scope see nothing | ✓ `request-pipeline.int.test.ts` |
| Rate-limit counters: own user, current org only | FORCE RLS on `rate_limit_counters`: `user` bucket = current user, `org` bucket = current org (tenant context, reached via a verified membership) | ✓ |
| Every app-readable table has forced RLS | Catalog test; the only exceptions are `capabilities` (read-only catalogue) and `processed_events` (consumer ids) | ✓ `tenant-isolation.int.test.ts` |
| Private is owner-only | RESTRICTIVE policies on `private_sessions`, private `artifacts`, private messages | ✓ |
| Arena content is member-only (org admins and unit leads are not implicit members) | RESTRICTIVE `message_visibility` | ✓ Unit Lead (non-member) reads 0 messages |
| Observers cannot post | RESTRICTIVE INSERT `arena_post_requires_capability` (needs `arena.post`) | ✓ insert rejected |
| One Arena per project; one agent session key | `arenas.project_id UNIQUE`, `agent_sessions.session_key UNIQUE` | ✓ |
| One Owner role and one Observer role per project | partial unique index on `(project_id, system_kind)` | ✓ |
| Owner role has all capabilities | `member_capabilities` view grants all to `system_kind='owner'` | ✓ 27 |
| Private session binds once | trigger `bound_project_write_once` | ✓ |
| One active cycle per project | partial unique index | ✓ |
| Approval gates name approver roles | CHECK on `stage_gate_policies`; `min_distinct_roles ≤ min_approvals` | ✓ |
| Guests must expire | CHECK on `org_memberships` | ✓ |
| AI-teammate tasks need a human reviewer; completion needs a verifier | CHECKs on `tasks` | ✓ |
| Audit, transitions and bridge events are append-only | `forbid_mutation` triggers | ✓ |
| One pending access request per user per project | partial unique index | — |
| Routine runs are idempotent | `UNIQUE (routine_id, scheduled_for)` | — |

"✓" means the invariant was exercised in the v2 smoke test against PostgreSQL 16 (see `build/schema_v2_smoke.txt`).

## 6.4 Key rules not expressible in SQL (enforced in `packages/domain`)

- Every project keeps ≥1 member holding the Owner role (checked on remove/role change).
- An approval gate's roles must each have ≥1 member when the gate is used. Deleting a role or removing the last holder is blocked with `GATE_UNSTAFFED`.
- Agent autonomy ≤ org ceiling ≤ unit override (the effective policy is computed on read and sent to the runtime).
- Cross-unit membership allowed only if `allow_cross_unit_projects`.
- Guests cannot hold the Owner role, create teams, or see the directory beyond co-members.

## 6.5 Indexing and partitioning

| Query | Index |
|---|---|
| Arena / Private / DM history | `messages (arena_id / private_session_id / dm_thread_id, created_at DESC)` partial indexes; monthly partitions (pg_partman creates 3 ahead) |
| Unit subtree dashboards | `org_units (org_id, path text_pattern_ops)` |
| My projects | `project_members (user_id, last_opened_at DESC)` |
| Board | `tasks (project_id, status)` |
| Due routines | `routines (next_run_at) WHERE enabled` |
| Inbox | `notifications (user_id, created_at DESC) WHERE resolved_at IS NULL` |
| Search | GIN on generated `tsvector` columns; pgvector HNSW on knowledge chunks (P1) |

## 6.6 Retention

| Data | Default | Configurable by |
|---|---|---|
| Arena messages, artifacts, transitions | Life of project + 1 year after decommission | Security admin (P1) |
| Private content of deprovisioned users | 30 days, then deleted | `org_policies.private_retention_days_after_leave` |
| Audit events | 400 days hot, 7 years in S3 Object Lock | Security admin |
| Runtime turns / tool calls | 400 days | — |
| Outbox | 7 days after publish | — |
| Idempotency records | 24 h (expired rows of a user are deleted on that user's next idempotent request; global sweep: SLICE_DEBT) | — |
| Rate-limit counters | Current window only (older windows deleted when a subject starts a new one) | — |

## 6.7 Migrations

- Tool: Kysely Migrator with plain SQL files `packages/db/migrations/NNNN_name.up.sql` / `.down.sql` (ADR-030).
- `schema_v2.sql` is the baseline migration `0001_baseline.up.sql`, byte-for-byte. Later changes are incremental files. `0002_app_role` creates the `saras_app` role the app connects as. `0003_identity_rls` adds RLS on `users` / `organizations` (ADR-031). `0004_request_pipeline` adds `idempotency_keys` and `rate_limit_counters` (F21-04).
- Commands: `pnpm db:migrate`, `pnpm db:migrate:down` (one step), `pnpm db:reset`, `pnpm db:codegen` (Kysely types into `packages/db/src/schema.gen.ts`).
- Rules:
  - every migration has a tested down;
  - expand → migrate → contract;
  - `CREATE INDEX CONCURRENTLY` on big tables (in its own non-transactional step);
  - each migration is reviewed with its RLS impact;
  - new `messages` partitions get no grants for `saras_app`;
  - CI applies all migrations to a fresh database, runs down and up again, and runs the RLS / isolation suite (`packages/db/src/*.int.test.ts`).
