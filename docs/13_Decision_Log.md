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
| ADR-032 | **Web session = WorkOS sealed session in a signed `saras_session` envelope.** The API enforces 12 h absolute / 2 h idle from signed timestamps, binds a CSRF token to the session (`X-CSRF-Token`), and matches accounts by verified email | Accepted | 15 Oct | Server-side session table (needs a migration and a lookup per request); companion timestamp cookie (can be swapped between sessions); plain double-submit cookie (subdomain cookie tossing) | Bearer tokens for integrations; Redis arrives (shared revocation list); storing the WorkOS user id |

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
  - `0001_baseline` is a byte-for-byte copy of `contracts/schema_v2.sql` (a unit test enforces it). Its down drops the `saras` schema and keeps extensions.
  - Pending migrations run in one transaction, so `CREATE INDEX CONCURRENTLY` needs its own non-transactional step when we first need it.
  - Tracking tables live in `public`, so down of the baseline can drop `saras`.
- **App role (`0002_app_role`):** FORCE RLS does not apply to superusers or roles with BYPASSRLS, which includes managed owner roles such as Neon's `neondb_owner`.
  - `saras_app` is NOLOGIN, without BYPASSRLS, and owns nothing. It has DML on `saras` tables, read-only on `capabilities`, and no grants on message partitions (partitions have no RLS of their own).
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

- **Flow:** `GET /auth/login?return_to=` sets `saras_login` (AES-256-GCM: random `state`, PKCE verifier, `return_to`, 10 min; HttpOnly, SameSite=Lax, Path=/v1/auth) and 302s to AuthKit. `GET /auth/callback` clears it, compares `state` in constant time, exchanges the code with the PKCE verifier, and requires a verified email. It then finds or creates the account by that email in identity scope (ADR-031), sets the cookies and 302s to `return_to`.
- **Callback failures** 302 to `WEB_ORIGIN/?auth_error=<reason>` (`denied`, `invalid_state`, `invalid_code`, `email_unverified`, `account_deactivated`), never echo the code, and leave any existing session alone. The WorkOS session of a refused login is revoked.
- **`return_to`:** a relative path on the web app or an absolute URL on `WEB_ORIGIN`; anything else (other origins, `//`, backslashes, control characters, credentials) falls back to the web root. No open redirect.
- **`saras_session`** (HttpOnly, SameSite=Lax, Path=/, Secure unless the API is on http://localhost, Max-Age = time left of the 12 h): `s1.<meta>.<mac>.<sealed>`. `meta` holds our user id, issued-at, last-seen and the CSRF token. `mac` is HMAC-SHA256 over meta and sealed, with a key derived by HKDF from `WORKOS_COOKIE_PASSWORD`. `sealed` is the WorkOS sealed session (access + refresh token, encrypted by the SDK).
- **Every request:**
  - MAC check, then the 12 h / 2 h limits;
  - WorkOS `authenticate()` (JWT verified locally); an expired access token is refreshed once, and concurrent refreshes in one process are coalesced;
  - not revoked by a logout in this process; email still verified;
  - the account exists in user scope, is not deactivated and has the same email;
  - the cookie is re-issued when refreshed, or when last-seen is more than 5 min old.
  - Any failure clears both cookies and answers 401. A WorkOS outage during refresh answers 500 and keeps the cookie.
- **CSRF:** `saras_csrf` (readable, SameSite=Lax, optional `COOKIE_DOMAIN`) carries the session's token. POST, PUT, PATCH and DELETE must send it as `X-CSRF-Token`; the header is compared with the token inside the signed session, so a planted cookie cannot pass. Missing or wrong → 403 `FORBIDDEN` (no new error code). Logout needs it too.
- **Logout** (`POST /auth/logout`, 204): adds the WorkOS session id to an in-process revocation list (1 h), calls `revokeSession`, and clears both cookies.
  - Known gap: WorkOS access tokens are verified locally. On another API instance, a copied cookie keeps working until its access token expires (WorkOS default 5 min); then refresh fails. Tracked in SLICE_DEBT.
- **CORS:** only `WEB_ORIGIN`, with credentials. Allowed headers: `Content-Type`, `X-CSRF-Token`, `Idempotency-Key`, `X-Request-Id`. Exposed headers: `X-Request-Id`, `RateLimit-*`, `Retry-After`, `Idempotent-Replayed`.
- **Isolation:** only `apps/api/src/identity/workos-provider.ts` imports the WorkOS SDK, behind the `IdentityProvider` interface. Tests use a fake.
