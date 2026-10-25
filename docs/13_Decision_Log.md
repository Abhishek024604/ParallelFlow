# 13 — Decision Log (ADRs, consolidated)

> Build Pack v2.0 · Append-only. A changed decision gets a new entry that supersedes the old one. Full option analyses for v1 ADRs remain in the v1.0 playbook doc 09.

---

| ID | Decision | Status | Date | Alternatives considered | Revisit when |
|---|---|---|---|---|---|
| ADR-001 | TypeScript modular monolith (NestJS) + separate realtime / worker / app-tools services | Accepted | 12 Oct | Microservices; Python backend | Team > 15 or independent scaling needs |
| ADR-002 | PostgreSQL 16 as system of record (+ pgvector, FTS) | Accepted | 12 Oct | Postgres + OpenSearch + vector DB; MongoDB | > 50M vectors / DB CPU > 60% |
| ADR-003 | Temporal for workflows | **Superseded by ADR-016** | 12 Oct | — | — |
| ADR-004 | Transactional outbox → Redis Streams | **Superseded by ADR-017** | 12 Oct | — | — |
| ADR-005 | Artifacts in S3 (content-addressed); Git as evidence mirror | Accepted | 12 Oct | Git as primary store | — |
| ADR-006 | One personal agent per user, one central agent per org; roles are modes, not identities | Accepted | 12 Oct | Agent per role | Demand for "team agents" |
| ADR-007 | Authz in-house (pure library + Postgres facts + RLS) | Accepted, extended by ADR-020 | 12 Oct | OpenFGA / SpiceDB; OPA / Cedar | Per-resource sharing, cross-org guests |
| ADR-008 | Sandboxes in the app | **Superseded by ADR-014** (runtime owns sandboxes) | 12 Oct | — | — |
| ADR-009 | Own WebSocket gateway; REST is the only write path | Accepted | 12 Oct | Ably / Pusher; SSE-only | Multi-region presence |
| ADR-010 | Hybrid search in Postgres, ACL in SQL | Accepted | 12 Oct | Dedicated search engine | With ADR-002 trigger |
| ADR-011 | Multi-tenancy: shared DB + `org_id` + FORCE RLS | Accepted | 12 Oct | Schema- or DB-per-tenant | Regulated single-tenant deals |
| ADR-012 | Model gateway in the app | **Superseded by ADR-014** | 12 Oct | — | — |
| ADR-013 | Agent runtime is a separate product (Tau) integrated via a contract (RIC) + App Tools MCP | Accepted | 12 Oct | Embed runtime in app | — |
| ADR-014 | Tau owns harness, skills, tools, model routing and sandboxes; app owns identity, permissions, approvals, persistence | Accepted | 12 Oct | Shared ownership | — |
| ADR-015 | One Arena per project = one shared agent session; no channels; private sessions bind to ≤1 project, write-once | Accepted | 12 Oct | Channels; per-user sessions in Arena | Users need sub-spaces (post-MVP threads first) |
| ADR-016 | Long waits (gates, approvals) as DB state machines; jobs and schedules on **pg-boss** | Accepted | 12 Oct | Temporal; Step Functions; Inngest | Complex multi-step orchestration in the app |
| ADR-017 | Outbox → **pg-boss** consumers; Redis pub/sub only for realtime fan-out | Accepted | 15 Oct | Redis Streams; Kafka | > 20 consumers or replay needs |
| ADR-018 | SDLC as a loop of cycles; one active development cycle per project | Accepted | 12 Oct | Parallel intents | Teams need parallel streams |
| ADR-019 | **Four permission planes** (org, unit, team, project) + agent plane; permissions follow responsibility, not seniority; oversight ≠ access | Accepted | 15 Oct | Hierarchy-inherited access; fixed project roles | Enterprise feedback |
| ADR-020 | Project roles = **team-defined bags of a fixed 27-capability catalogue** + system Owner/Observer roles; gate approvers point to roles | Accepted | 15 Oct | Fixed PM/Eng/QA roles; free-form permissions | New capability needs (ship with migration, default off) |
| ADR-021 | Agent **autonomy policy** per project per capability class (off / suggest / approve / act), capped by org and unit ceilings, enforced in App Tools | Accepted | 15 Oct | Prompt-only rules; global switch | Usage data from beta |
| ADR-022 | **Separation of duties** on gates: `min_approvals`, `min_distinct_roles`, `forbid_self_approval` | Accepted | 15 Oct | Single approver | — |
| ADR-023 | **WorkOS** for login, SSO (SAML/OIDC) and SCIM | Accepted | 15 Oct | Auth.js + custom SAML; Auth0; Clerk | Pricing at scale |
| ADR-024 | Hosting on **AWS ECS Fargate** (ap-south-1), Terraform | Accepted | 15 Oct | EKS; Render / Fly | > 30 services or need for k8s-native tooling |
| ADR-025 | **PostHog** for product analytics and feature flags; Sentry for errors; OTel → Grafana Cloud | Accepted | 15 Oct | Unleash + Mixpanel | — |
| ADR-026 | **Routines** run as `mode=routine` turns on the central agent's Arena session, with deterministic fallback | Accepted | 15 Oct | Separate scheduler agent | — |
| ADR-027 | **AI teammate** tasks: agent can reach `in_review` only; human reviewer required; DB check on `verified_by` | Accepted | 15 Oct | Agent self-completion with audit | — |
| ADR-028 | Org **presets** (Startup / Enterprise) set policy defaults; everything stays editable | Accepted | 15 Oct | Single default | — |
| ADR-029 | **MVP has no visible organization layer.** Arena-first onboarding: sign up → empty home → create arena + invite by email → invitees sign up and join from the link. Each arena is backed by a hidden org + team + project created in one transaction | Accepted | 15 Oct | Org-first onboarding (org → teams → projects) | Paying customers ask for org admin, SSO or cross-arena reporting |
| ADR-030 | **Migrations: Kysely Migrator with plain SQL up/down files; the app connects as `saras_app`, never as the schema owner.** Local and dev Postgres on **Neon** | Accepted | 15 Oct | graphile-migrate (forward-only, no down); node-pg-migrate (second DB library); app as owner (bypasses RLS) | Need for zero-downtime tooling beyond expand/contract, or Neon limits |
| ADR-031 | **RLS on `users` and `organizations`, plus a read-only "user scope" and "identity scope".** Request handlers derive the tenant from a verified active membership (`withOrgMember` / `withProjectMember`), never from client input | Accepted | 15 Oct | Leave identity tables global and filter in code; SECURITY DEFINER lookup functions (fragile: owner roles differ between Neon, RDS and containers) | Org directory or guests need wider user visibility |
| ADR-032 | **Web session = WorkOS sealed session in a signed `parallelflow_session` envelope.** The API enforces 12 h absolute / 2 h idle from signed timestamps, binds a CSRF token to the session (`X-CSRF-Token`), and matches accounts by verified email | Accepted | 15 Oct | Server-side session table (needs a migration and a lookup per request); companion timestamp cookie (can be swapped between sessions); plain double-submit cookie (subdomain cookie tossing) | Bearer tokens for integrations; Redis arrives (shared revocation list); storing the WorkOS user id |
| ADR-033 | **Outbox relay runs as a dedicated `saras_relay` role** (NOLOGIN group, no BYPASSRLS, owns nothing) with `TO saras_relay` policies: read every outbox row, publish once, delete after 7 days, delete expired idempotency records without reading them. pg-boss lives in schema `pgboss`, installed by the owner during `db:migrate`, used only by this role | Accepted | 16 Oct | BYPASSRLS relay role (reads all tenant content); `withSystemJob` per org (relay must poll every org); SECURITY DEFINER functions (owner differs between Neon, RDS and containers, ADR-031); pg-boss creating its own schema at startup (runtime role needs CREATE) | Outbox volume needs partitioning, or a second relay-style job needs cross-org access |
| ADR-034 | **Private belongs to no org.** Private rows (`private_sessions`, their messages, the personal agent, `agent_sessions` kind private, their `runtime_turns` and `app_tool_calls`, and since 0007 private `artifacts`, their versions and blobs) have `org_id` NULL, enforced by CHECKs, and are reached only by their owner in user scope through new PERMISSIVE owner-only policies. Adds `private_projects` (owner's chat folders). The RIC org uuid for Private is the nil uuid | Accepted | 16 Oct | A hidden "personal org" per user (an extra tenant, membership and bootstrap for every sign-up); Private in each arena's org (Private would vanish with no arena, and splits per arena) | Private artifacts or the bridge need an org, or org-level Private policies appear |
| ADR-035 | **The agent runtime is the Pi harness behind RIC v0.2, and App Tools trusts the ToolToken.** `apps/runtime` (replaces `apps/stub-runtime`) wraps `@earendil-works/pi-coding-agent` in a thin HTTP service on :7070; one Pi session (own session file, own empty cwd, own agentDir) per `session_key`; Pi's built-in tools are disabled and the AI gets only App Tools; the model is OpenRouter. `apps/app-tools` is an MCP Streamable HTTP server that verifies the ToolToken (HS256 `TOOL_TOKEN_KEY`) and opens `withSystemJob` for an arena token's org (queries filtered by its project) or `withUser(on_behalf_of)` for a Private token | Accepted | 17 Oct | A scripted / thin-LLM stub (doc 08 §8.6) while waiting for Tau; Pi's own MCP extension (needs its extension loader and global config); App Tools calling the API over HTTP | Tau ships its own HTTP wrapper; Pi's SDK changes incompatibly; App Tools needs per-user capabilities (F08-01) |
| ADR-036 | **Loop routes carry the project in the path.** `GET /projects/{id}/cycles/current`, `POST /projects/{id}/cycles/{cycle_id}/gate-requests`, `POST /projects/{id}/cycles/{cycle_id}:send-back` and `POST /projects/{id}/approvals/{approval_id}/votes` are additive, project-prefixed forms of getCycle, requestGate, sendBack and vote, so the pipeline verifies membership and opens the tenant transaction before the handler (no extra lookup round trip). A gate card is an arena message with the same id as its `approval_requests` row (`kind: gate`). Phase A approvers: holders of `stage.approve.<stage>` who also hold one of the gate's approver roles. The unprefixed paths stay in the contract for later. | Accepted | 17 Oct | Unprefixed paths with an id→project lookup (an extra round trip and a security-definer resolver) | A route needs a cycle or approval without its project (deep links, notifications) |
| ADR-037 | **The VS Code extension signs in with a device code and talks to ParallelFlow with a bearer token; code reaches main only through reviewed pull requests.** Migration 0008 adds `ext_device_codes`, `ext_access_tokens` (SHA-256 at rest, 30 days, revocable) under a new transaction-local **credential scope** (`app.credential` = the secret's hash or the typed user code), tenant tables `coding_sessions`, `pull_requests`, `pr_reviews`, the `pr.merge` capability and an `llm` rate-limit bucket. The API proxies the extension's model calls to OpenRouter (`/v1/llm/*`): the one place the API talks to a model provider, so no provider keys live on laptops | Accepted | 18 Oct | Personal API keys pasted into the extension (long-lived, no device approval); SECURITY DEFINER token lookups (ADR-031); keys on laptops calling OpenRouter directly; pushing straight to main | Tau ships its own coding runtime; a GitHub remote (PRs move to GitHub); per-org model budgets |
| ADR-038 | **Soft delete for files and arenas, and standard arena file names.** Migration 0009 adds `deleted_at` / `deleted_by` to `artifacts` and `projects`, with RESTRICTIVE `FOR SELECT` policies that hide deleted rows from app roles (system jobs still see them, like every restrictive policy); the per-cycle stage-document index ignores deleted rows. Only the arena **owner** archives (reversible, read-only), unarchives, renames or deletes an arena, and deletes arena files; a person deletes their own private files. Arena files must have a standard name (`plan`, `requirements`, `hld`, `lld`, `architecture`, `build`, `test`, `deploy`, `maintain`, optional `-suffix`, `.md`/`.yaml`/`.json`/`.drawio`; plus README/PROGRESS/STATE), checked on create, push and AI drafts; SWA keeps its arch/ paths, mapped exactly to standard names (`contracts/arch-docs.ts`). `db:migrate` renames older arena files once (idempotent). Private files stay free-form and get a standard name when pushed | Accepted | 25 Oct | Hard delete (loses audit and history); a `status` enum value (every query would need to know it); free-form arena names | Restore / trash UI, or retention-based purge |

### ADR-029 detail: arena-first MVP

- **Why:** first-time users should reach a working arena in under a minute, with no org setup, jargon or extra windows.
- **Data model:** keep `schema_v2.sql` as it is. Creating an arena runs one transaction that inserts:
  - `organizations` (hidden, named after the arena);
  - `teams`;
  - `projects`, with system Owner and Member roles;
  - `arenas`;
  - one central agent session.
  The creator becomes org owner, team owner and project Owner. RLS and session isolation are unchanged.
- **Invites:** use the `invitations` table, with email, arena and a token. They expire after 7 days and are single use. When someone accepts, their org membership (member), team membership and project membership are added together. An invite link needs an account with the same email: sign up first, then join.
- **Hidden in the MVP UI:**
  - org units and unit roles;
  - org dashboard and org policies or presets;
  - SSO/SCIM;
  - guests;
  - access requests;
  - org-level knowledge upload.
  These stay in the schema and API for later phases.
- **Optional in arena settings:** custom roles and stage approvals. The default is a single approver: the arena owner.
- **Copy:** use "arena", "teammates" and "AI". Avoid "org", "unit", "tenant", "bind" and "central agent" in the UI.

### ADR-030 detail: migrations and the app role

- **Why:** F21-03 requires migrations that go up and down, tested. graphile-migrate (doc 05/06) is forward-only. Kysely is already our query layer, and its Migrator gives ordering, a tracking table and an advisory lock.
- **Migrations:** `packages/db/migrations/NNNN_name.up.sql` and `NNNN_name.down.sql`, numbered without gaps.
  - `0001_baseline` is a byte-for-byte copy of `contracts/schema_v2.sql` (a unit test enforces it). Its down drops the `parallelflow` schema and keeps extensions.
  - Pending migrations run in one transaction, so `CREATE INDEX CONCURRENTLY` needs its own non-transactional step when we first need it.
  - Tracking tables live in `public`, so down of the baseline can drop `parallelflow`.
- **App role (`0002_app_role`):** FORCE RLS does not apply to superusers or roles with BYPASSRLS, which includes managed owner roles such as Neon's `neondb_owner`.
  - `saras_app` is NOLOGIN, without BYPASSRLS, and owns nothing. It has DML on `parallelflow` tables, read-only on `capabilities`, and no grants on message partitions (partitions have no RLS of their own).
  - Each environment's login role is a member of it. `pnpm db:migrate` creates it locally from `DATABASE_URL`; Terraform does it in AWS.
  - `Database.assertAppRole()` refuses to run as anything else.
- **Connections:** `MIGRATION_DATABASE_URL` is the owner on a direct endpoint, for migrations and codegen. `DATABASE_URL` is the app login and may be pooled (PgBouncer transaction mode). `withTenant` sets `search_path`, `app.org_id`, `app.user_id` and `app.system_job` with `set_config(..., true)` inside each transaction, so nothing survives on a pooled connection.
- **System jobs:** `withSystemJob` sets `app.user_id` to the nil uuid, because policies cast it to uuid.
- **Neon:** used for local and dev databases while the team has no Docker. Production hosting stays as in ADR-024 (RDS) unless a later ADR changes it. Create Neon projects on Postgres 16 to match.

### ADR-031 detail: identity RLS and verified tenant context

- **Why:** `schema_v2` left `users` and `organizations` without RLS, so the app role could read every account's email and every org name across arenas. Most tenant tables check only `org_id`, so code that passes the wrong `org_id` to `withTenant` would read that org's data.
- **Contexts** (`packages/db`, all transaction-local, every key set every time):
  - **tenant:** one org, as a user (schema_v2 policies, unchanged).
  - **system:** one org, as a worker.
  - **user:** `app.org_id` is the nil uuid. Only your own `org_memberships` / `project_members` rows, your projects (while your org membership is active), your orgs and your own `users` row. Read only. Gating the self-row policies on user scope keeps tenant contexts strictly single-org.
  - **identity:** nil org and user, plus `app.user_email` set to the email the identity provider verified. Only that account can be read, created or updated. Used by sign-up and login.
- **Policies (migration `0003_identity_rls`):**
  - `users`: read yourself, the identity email, or co-members of the current org. Insert your own verified email (or as a system job, for seeds and tests). Update yourself, or as a system job only members of its org. No delete.
  - `organizations`: read the current org, or your active orgs in user scope. Insert and update only the current org id. No delete.
  - New policies read settings through `saras.current_user_id()` and related helpers, which treat `''` as NULL so pooled connections don't hit uuid cast errors.
- **Verified entry points:** `withOrgMember` and `withProjectMember` look up an *active* membership (guests not past `expires_at`) in user scope. Then, in the same transaction, they switch to the tenant context for that org. If no membership is found they throw `NotVisibleError`, which APIs map to 404. `withTenant` is unchecked and reserved for flows that create the org (create arena) or already hold a verified membership.
- **Not changed:** every schema_v2 policy, so the tenant suite is unchanged. Membership-aware visibility of `projects` *inside* an org (discoverability) stays in `packages/authz`.

### ADR-032 detail: web login and session (F01-01)

- **Flow:** `GET /auth/login?return_to=` sets `parallelflow_login` (AES-256-GCM: random `state`, PKCE verifier, `return_to`, 10 min; HttpOnly, SameSite=Lax, Path=/v1/auth) and 302s to AuthKit. `GET /auth/callback` clears it, compares `state` in constant time, exchanges the code with the PKCE verifier, and requires a verified email. It then finds or creates the account by that email in identity scope (ADR-031), sets the cookies and 302s to `return_to`.
- **Callback failures** 302 to `WEB_ORIGIN/?auth_error=<reason>` (`denied`, `invalid_state`, `invalid_code`, `email_unverified`, `account_deactivated`), never echo the code, and leave any existing session alone. The WorkOS session of a refused login is revoked.
- **`return_to`:** a relative path on the web app or an absolute URL on `WEB_ORIGIN`; anything else (other origins, `//`, backslashes, control characters, credentials) falls back to the web root. No open redirect.
- **`parallelflow_session`** (HttpOnly, SameSite=Lax, Path=/, Secure unless the API is on http://localhost, Max-Age = time left of the 12 h): `s1.<meta>.<mac>.<sealed>`. `meta` holds our user id, issued-at, last-seen and the CSRF token. `mac` is HMAC-SHA256 over meta and sealed, with a key derived by HKDF from `WORKOS_COOKIE_PASSWORD`. `sealed` is the WorkOS sealed session (access + refresh token, encrypted by the SDK).
- **Every request:**
  - MAC check, then the 12 h / 2 h limits;
  - WorkOS `authenticate()` (JWT verified locally); an expired access token is refreshed once, and concurrent refreshes in one process are coalesced;
  - not revoked by a logout in this process; email still verified;
  - the account exists in user scope, is not deactivated and has the same email;
  - the cookie is re-issued when refreshed, or when last-seen is more than 5 min old.
  - Any failure clears both cookies and answers 401. A WorkOS outage during refresh answers 500 and keeps the cookie.
- **CSRF:** `parallelflow_csrf` (readable, SameSite=Lax, optional `COOKIE_DOMAIN`) carries the session's token. POST, PUT, PATCH and DELETE must send it as `X-CSRF-Token`; the header is compared with the token inside the signed session, so a planted cookie cannot pass. Missing or wrong → 403 `FORBIDDEN` (no new error code). Logout needs it too.
- **Logout** (`POST /auth/logout`, 204): adds the WorkOS session id to an in-process revocation list (1 h), calls `revokeSession`, and clears both cookies.
  - Known gap: WorkOS access tokens are verified locally. On another API instance, a copied cookie keeps working until its access token expires (WorkOS default 5 min); then refresh fails. Tracked in SLICE_DEBT.
- **CORS:** only `WEB_ORIGIN`, with credentials. Allowed headers: `Content-Type`, `X-CSRF-Token`, `Idempotency-Key`, `X-Request-Id`. Exposed headers: `X-Request-Id`, `RateLimit-*`, `Retry-After`, `Idempotent-Replayed`.
- **Isolation:** only `apps/api/src/identity/workos-provider.ts` imports the WorkOS SDK, behind the `IdentityProvider` interface. Tests use a fake.

### ADR-033 detail: the outbox relay role and pg-boss (F21-05)

- **Why:** the relay must read unpublished outbox rows of every org. Every app context is limited to one org by RLS, BYPASSRLS would expose all tenant content, and polling org by org does not scale. The F21-04 idempotency sweep has the same shape: a global delete of rows only their owner can see.
- **Role (migration `0005_outbox_relay`):** `saras_relay` is NOLOGIN, NOSUPERUSER, NOBYPASSRLS and owns nothing. Its grants in `parallelflow`:
  - `outbox_events`: `SELECT`, `DELETE` and `UPDATE (published_at)` only (column privilege);
  - `idempotency_keys`: `DELETE` only. No `SELECT`, so a `WHERE` or `RETURNING` on that table fails; the sweep is a bare `DELETE` and the policy picks the rows;
  - no grant on any other table. The tenant catalog test checks that `outbox_events` is the only `parallelflow` table it can read.
- **Policies (permissive, `TO saras_relay`, so the app role is unaffected):**
  - `relay_read` on `outbox_events` `FOR SELECT USING (true)`;
  - `relay_publish` `FOR UPDATE USING (published_at IS NULL) WITH CHECK (published_at IS NOT NULL)`: publish once, never un-publish (also what `SELECT … FOR UPDATE` checks);
  - `relay_cleanup` `FOR DELETE USING (published_at < now() - interval '7 days')` (doc 06 §6.6);
  - `relay_sweep` on `idempotency_keys` `FOR DELETE USING (expires_at < now())`.
  - The relay never sets `app.*` settings, so schema_v2's `tenant_isolation` sees NULL and adds nothing.
- **Login:** `RELAY_DATABASE_URL`, a direct (non-pooled) endpoint and a user different from the owner and the app login. `pnpm db:migrate` creates it as a `saras_relay` member (`ensureRelayLogin`); Terraform in AWS. `RelayDatabase.assertRelayRole()` refuses to start unless the login is a `saras_relay` member, not a `saras_app` member, not the table owner, and without SUPERUSER or BYPASSRLS.
- **pg-boss schema:** 0005 creates an empty `pgboss` schema owned by the schema owner, revokes PUBLIC, grants `USAGE` to `saras_relay` and sets default privileges (table DML, sequence usage) for it. `pnpm db:migrate` then runs pg-boss's own install/upgrade as the owner (`installJobSchema`, `createSchema: false`, `migrate: true`) and re-grants DML. At runtime the worker starts pg-boss as the relay login with `migrate: false` (version check only) and `reindex: false` (REINDEX needs the owner). So runtime roles need no `CREATE`. Constraint: no `partition: true` queues (pg-boss would `CREATE TABLE` as the runtime role). `saras_app` gets nothing in `pgboss`.
- **Who runs what:** the relay transaction (claim rows `FOR UPDATE SKIP LOCKED` → `insert` one pg-boss job per subscribed consumer through the same transaction → set `published_at`) and pg-boss itself (fetch, complete, retry, dead-letter, schedules, maintenance) run as the relay login. Consumer handlers run as the app role in `withSystemJob` for the event's org, and record `processed_events` there; the relay role has no grant on `processed_events`.
- **Down:** drops the `pgboss` schema (every job in it), the four policies and the grants. The cluster-wide role stays, like `saras_app`.

### ADR-034 detail: Private without an org (migration 0006)

- **Why:** Arena and Private are separate. An arena is a team's workspace (one team = one org). Private is every person's own space, whether or not they are in any arena; tying it to an org would make it disappear without an arena and split it across arenas. The only link is the bridge (step 6).
- **Schema (`0006_private_space`):** `org_id` becomes nullable on `private_sessions`, `messages` (the partitioned parent; partitions follow), `agents`, `agent_sessions`, `runtime_turns`, `app_tool_calls`. CHECKs: `private_sessions.org_id IS NULL`; messages `(private_session_id IS NOT NULL) = (org_id IS NULL)`; agents `(kind = 'personal') = (org_id IS NULL)`; agent_sessions `(kind = 'private') = (org_id IS NULL)`. New unique index `agents_one_personal_per_user (owner_user_id) WHERE kind = 'personal'` (schema_v2's `agents_one_personal` is kept; with NULL org ids it no longer constrains). `private_projects (id, user_id, name, created_at, archived_at)` with FORCE RLS, and `private_sessions.private_project_id` FK `ON DELETE SET NULL`.
- **Policies:** nothing in schema_v2 is edited or dropped. `tenant_isolation` (`org_id = app.org_id`) never matches NULL, so tenant contexts and system jobs see no Private row. New PERMISSIVE `private_space_*` policies (FOR ALL) allow `org_id IS NULL AND in_user_scope()` rows owned by `current_user_id()`: sessions by `owner_user_id`; messages, agent sessions, turns and tool calls through the owned session; agents by `owner_user_id`. WITH CHECK also requires a filed project to be yours, a message author to be you or your personal agent, and a private agent session to use your personal agent. The RESTRICTIVE `private_owner_only`, `message_visibility` and `arena_post_requires_capability` still apply and pass for the owner's rows.
- **Who writes:** the request handlers in user scope (`db.withUser`), and the background writes of a private AI turn, also in user scope as the owner (not a system job: Private rows have no org).
- **Runtime contract:** RIC v0.2 needs an org uuid in `session_key` and `scope.org_id`. Private uses the nil uuid: `org/00000000-0000-0000-0000-000000000000/user/{u}/private/{s}`, `scope.org_id` = nil, `project_id` null, profile `personal_private`. The tool token carries the nil org too. No contract change.
- **Unchanged:** `bridge_events` keeps the arena's org. Private `artifacts` stay org-scoped until the bridge step (out of scope here).
- **Down:** deletes org-less rows (dev only), drops the policies, `private_projects` and the column, and restores NOT NULL.

#### Extension: private files and the bridge (migration 0007, build step 6)

- **Why:** the bridge pushes a private artifact into an arena. Keeping private artifacts in an org would put Private back into a tenant, which 0006 removed.
- **Artifacts:** `artifacts.org_id` and `artifact_versions.org_id` become nullable. CHECK `artifacts_private_no_org`: `(scope = 'private') = (org_id IS NULL)`.
- **Blob keys (the choice):** schema_v2 keys `blobs` by `(org_id, sha256)`, and a primary-key column cannot be NULL. Options were (a) a separate `private_blobs` table, (b) a sentinel org uuid for private rows, (c) a surrogate key with two natural keys. We chose (c):
  - `blobs.id uuid` becomes the primary key (and the public file id of an upload);
  - org blobs stay unique on `(org_id, sha256)`, now a UNIQUE constraint that backs schema_v2's FK;
  - private blobs carry `owner_user_id` instead of `org_id` (CHECK `blobs_org_or_owner`) and are unique on `(owner_user_id, sha256)`;
  - `artifact_versions.blob_owner_user_id` (CHECK: set exactly when `org_id` is NULL) has a second composite FK to `blobs (owner_user_id, sha256)`.
  Both FKs are MATCH SIMPLE, so each covers exactly one kind of row; real FKs give integrity without a trigger. (a) duplicates the table and its readers; (b) puts a fake tenant back. One trigger, `artifact_versions_match_artifact` (INSERT, or UPDATE of `artifact_id` / `blob_owner_user_id`), checks that a version has its artifact's org, and for a private artifact its owner's blobs. Org changes are already rejected by RLS WITH CHECK.
- **In-database content (Phase A):** `blobs.content bytea` (nullable) and `s3_key` nullable, CHECK `num_nonnulls(content, s3_key) = 1`; in-database content is at most 10 MB and equals `size_bytes`. `blobs.name` keeps the file name of the first upload of that content. SLICE_DEBT: move content to S3 (ADR-024).
- **Policies:** nothing existing is edited or dropped. New PERMISSIVE `private_space_artifacts`, `private_space_artifact_versions`, `private_space_blobs` in the 0006 style: `org_id IS NULL AND in_user_scope()` and owned by `current_user_id()` (versions through their artifact; WITH CHECK also needs your own blobs and, for an artifact filed under a chat, your own chat). Arena rows keep `tenant_isolation`; RESTRICTIVE `private_artifacts_owner_only` still applies.
- **One transaction across the bridge:** `@parallelflow/db` exports `enterProjectMember(tx, {projectId, userId})` (the withProjectMember check, then the project's tenant context in the same transaction) and `enterUserScope(tx, {userId})`. A Push reads the private version in user scope, writes the arena copy, `bridge_events` and the stream card in the arena tenant, and binds the chat back in user scope, all or nothing. No `withTenant` / `withSystemJob` in apps/api.
- **Files:** a blob in an arena belongs to the arena's hidden org (ADR-029: one org per arena), so a file download checks the org of the project you are a member of.
- **Down:** deletes org-less artifacts, versions and blobs and every in-database blob (dev only), then restores the `(org_id, sha256)` primary key, the FK and NOT NULL.

### ADR-035 detail: the Pi runtime and App Tools

- **Why:** the demo needs a real AI teammate now. Tau is a fork of Pi, so running Pi behind RIC v0.2 is the shortest path and keeps the swap to Tau a configuration change (`RUNTIME_URL`).
- **Runtime (`apps/runtime`):** RIC v0.2 on `http://localhost:7070/v1`. Every call except `GET /health` needs the app's service JWT (HS256 `RUNTIME_JWT_KEY`, `aud=parallelflow-runtime`, exp checked); errors use the RIC `Error` schema. Sessions are idempotent on `session_key` (the id is a hash of the key), turns on `turn_id`; bind is write-once (`ALREADY_BOUND`); a tool token whose `session_key` claim names another session is refused (`SCOPE_MISMATCH`). Turn events are kept per turn in memory with a TTL and resume with `Last-Event-ID`.
- **Isolation (doc 08 rules 1–5):** one Pi `AgentSession` per session, created lazily, with its own folder `RUNTIME_DATA_DIR/sessions/<id>/` (`pi/` session file, empty `workspace/` cwd, own `agent/` dir). A custom ResourceLoader returns no AGENTS.md / context files, skills, prompt templates, themes or extensions, and settings are in memory, so nothing from the repo or `~/.pi` is loaded. Tool tokens live in memory only (never on disk, never in events).
- **Tools:** Pi's built-ins (read, write, edit, bash, …) are never enabled (`tools` allowlist = App Tools, `noTools: 'all'`). Pi 1.x has MCP only as a CLI extension, so each App Tool listed by the server for the session's token is wrapped as a Pi custom tool that calls App Tools with the MCP SDK client, sending the session's current token and the turn id (`x-parallelflow-turn-id`, for the audit row).
- **Drafts (one path):** `artifacts.create_draft` / `private.save_artifact` are authorised by App Tools (scope, autonomy); on `accepted` the runtime emits the RIC `artifact.proposed` event and the API stores the draft with its existing code (never approved). Replies are only `message.completed`; `arena.post_message` answers "not available yet", so a reply is never posted twice.
- **Model:** OpenRouter (`OPENROUTER_API_KEY`, `RUNTIME_MODEL`, default `anthropic/claude-sonnet-4.5`). With no key (or Node < 22.19, which Pi needs) sessions still work and every turn fails fast with `RUNTIME_UNAVAILABLE` (not retryable).
- **App Tools (`apps/app-tools`):** MCP Streamable HTTP (stateless) at `APP_TOOLS_URL`. The verified ToolToken is the authorisation: claims are checked for consistency (central = the arena key of its own org and project; personal = the owner's private key, nil org unless bound). Arena tokens run in `withSystemJob` for the token's org with every query filtered by the token's project (any other id → `SCOPE_MISMATCH`); Private tokens run in `withUser(on_behalf_of)` (owner-only RLS, ADR-034). Each call checks the agent kind and token scopes, then the project's `agent_policies` (`off` → `FORBIDDEN`, `suggest` → drafts only, `approve` → `APPROVAL_REQUIRED`, `act` → run), and writes an `app_tool_calls` row (tool, args SHA-256, outcome, deny code, latency; never arguments). Human-only actions are never tools; the server refuses to start if the contract adds one.
- **App side:** the API gives the session a fresh tool token before every turn (`PUT /sessions/{id}/token`; it re-creates the session on `NOT_FOUND`), and the personal agent's scopes are `private.save_artifact` and `knowledge.search`.

### ADR-037 detail: extension sign-in, LLM proxy and pull requests

- **Device flow (RFC 8628 style):** `POST /ext/device/code` (public, rate limited per IP) stores the SHA-256 of a random device code and an 8-character user code (no vowels, 0 or 1; unique while pending; 10 min). The person opens `/device`, signed in, and approves or denies (session + CSRF). `POST /ext/device/token` (public) answers `authorization_pending`, `slow_down`, `expired_token`, `access_denied`, or once only an access token `parallelflow_ext_<random>` (30 days).
- **Credential scope:** `app.credential` is set like every other key (`''` in every other context). Device codes are visible by their hash, or (pending only) by user code to a signed-in user; tokens by their hash, or to their owner in user scope. Only status/user/poll time and last-used/revoked columns are updatable. No SECURITY DEFINER.
- **Bearer:** `Authorization: Bearer parallelflow_ext_…` authenticates as the token's owner, without CSRF, only on routes marked for it (`GET /me`, `GET /arenas`, `GET /arenas/{id}`, `/ext/*` except device approval, and `/llm/*`, which is bearer only). Everything else answers 401 to a bearer. Scoped routes go through the same membership pipeline (`withProjectMember`).
- **LLM proxy:** `/llm/chat/completions` (OpenAI-compatible, SSE passthrough) and `/llm/models` forward to OpenRouter with the server key; models are limited to the runtime's list (RUNTIME_MODEL + fallbacks); 60 requests/min per user (`llm` bucket); 4 MB bodies; bodies and prompts are never logged; the upstream call is aborted when the client goes away; on 429/503 for the primary model the next allowed model is tried.
- **Coding sessions and PRs:** the extension clones the arena repo from a bundle, works on `ai/<slug>-<hex>`, pushes a bundle that may only update its own branch (never main), and opens a PR. The person who ran the session is the accountable author. Merging needs `pr.merge`, an approval of the current head by someone other than the author (also enforced by a RESTRICTIVE insert policy on `pr_reviews`), and no outstanding change request; ParallelFlow merges with `--no-ff`. The docs snapshot now manages only README.md, progress.md, state.md, `cycle-*/` and `docs/`, so merged code is never removed by a gate commit.

