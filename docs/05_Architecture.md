# 05 — Architecture (HLD + LLD, consolidated)

> Build Pack v2.0 · Supersedes v1.0 docs 02–04 and v1.1 §3. Decisions and their alternatives: doc 13.

---

## 5.1 Shape of the system

ParallelFlow is two products joined by a contract:

1. **App platform (built from 16 Oct).** Identity, org hierarchy, RBAC, teams, projects, Arena, Private, bridge, artifacts, tasks, SDLC loop, routines, notifications, audit.
2. **Agent runtime "Tau" (separate team and phase).** A fork of the open-source Pi coding-agent harness. It holds the harness, sessions (tree + compaction), bundled tools and skills, model access and sandboxes.

They talk only through the **Runtime Integration Contract v0.2** (doc 08):
- the app calls Tau over HTTPS + SSE;
- Tau calls back into the app only through the **App Tools MCP server**, using session-scoped tokens.

Until Tau is ready, a **Stub Runtime** that implements the same contract powers every agent feature, including the YC demo.

![Containers](../diagrams/png/32_container_v2.png)

## 5.2 Technology stack (final for MVP)

| Layer | Choice | Notes |
|---|---|---|
| Web | **Next.js 15 (App Router), React 19, TypeScript, Tailwind, Radix/shadcn, TanStack Query, Zustand** | Design tokens from doc 09; Geist font |
| API | **NestJS 11 on Node 22 (TypeScript)**, modular monolith | Zod DTOs shared with web via `packages/contracts` |
| DB access | **Kysely** + plain SQL up/down migrations (Kysely Migrator, ADR-030) | Schema = `contracts/schema_v2.sql`; app connects as `saras_app` |
| Database | **PostgreSQL 16** (AWS RDS, Multi-AZ) + **pgvector** | RLS for tenant, Private and Arena visibility |
| Jobs & schedules | **pg-boss** (Postgres-backed queues, cron) | Outbox relay, notifications, routines, digests, evidence, retention, guest expiry |
| Cache / realtime fan-out | **Redis 7** (ElastiCache) | Pub/sub for WebSocket fan-out, authz fact cache, rate limits, presence |
| Realtime | Own WebSocket gateway (`ws`) | 5-minute tokens, topic authz, resume by seq |
| Files | **S3** (SSE-KMS), pre-signed uploads, ClamAV scan Lambda | Content-addressed artifact blobs |
| Auth | **WorkOS AuthKit + SSO + Directory Sync (SCIM)** | Google, Microsoft, magic link, SAML/OIDC, SCIM |
| Email | AWS SES | Invites, digests |
| Source control evidence | GitHub App | Commit approved stage artifacts, read PR/CI status |
| Hosting | **AWS ap-south-1, ECS Fargate**, ALB, CloudFront + WAF, Terraform | Simpler than Kubernetes for the MVP; Tau may run elsewhere |
| Observability | OpenTelemetry → Grafana Cloud; Sentry; uptime checks | doc 11 |
| Product analytics & flags | PostHog (events + feature flags) | Ids only, no content |
| CI/CD | GitHub Actions → ECR → ECS (blue/green) | Preview environments per PR (P1) |

## 5.3 Monorepo layout

```
parallelflow/
├─ apps/
│  ├─ web/                 Next.js app (Private, Arena, setup, loop, dashboards, inbox, settings)
│  ├─ api/                 NestJS monolith (HTTP + adapter dispatch)
│  ├─ realtime/            WebSocket gateway
│  ├─ worker/              pg-boss consumers + cron (outbox, notifications, routines, evidence, retention)
│  ├─ app-tools/           MCP server exposed to the runtime
│  └─ runtime/             RIC v0.2 over the Pi harness (ADR-035; replaces stub-runtime)
├─ packages/
│  ├─ contracts/           Zod schemas → OpenAPI v2, RIC types, event types, role_templates_v2.json
│  ├─ db/                  migrations (schema_v2), Kysely types, tenant-context helper
│  ├─ authz/               permission engine (doc 03 §3.8) — pure functions + exhaustive tests
│  ├─ domain/              state machines: cycle, gate, task, bind, routine, access request
│  ├─ runtime-client/      RIC client, SSE consumer, isolation guard
│  ├─ ui/                  design system components (tokens light/dark)
│  └─ observability/       OTel, logger with redaction
├─ infra/terraform/        VPC, ECS, RDS, ElastiCache, S3, SES, WAF, secrets
├─ tests/                  e2e (Playwright), canary isolation suite, RIC conformance kit
└─ docs/                   this Build Pack
```

## 5.4 API module map (bounded contexts)

| Module | Owns tables | Key responsibilities |
|---|---|---|
| `identity` | users | Session, `/me`, WorkOS callback/webhooks |
| `org` | organizations, org_policies, org_memberships, invitations, knowledge_sources | Org, policies, directory, invites, offboarding |
| `units` | org_units, unit_role_assignments | Hierarchy, unit roles, dashboards scope |
| `teams` | teams, team_members | Teams and team roles |
| `projects` | projects, project_roles, role_capabilities, project_members, project_member_roles, stage_gate_policies, agent_policies, access_requests | Setup wizard, RBAC data, access |
| `arena` | arenas, messages, message_mentions | Arena stream, mentions, moderation |
| `private` | private_sessions, bridge_events | Private sessions, bind, pull context |
| `artifacts` | blobs, artifacts, artifact_versions, evidence, files | Versions, push, uploads, evidence |
| `tasks` | tasks | Tasks, delegation, AI teammate, verify |
| `loop` | sdlc_cycles, stage_transitions, approval_requests, approval_votes | Cycles, gates, votes, progress.md |
| `routines` | routines, routine_runs | Schedules and runs |
| `runtime` | agents, agent_sessions, runtime_turns, app_tool_calls | Adapter, turn ledger, usage |
| `messaging` | dm_threads, dm_participants (+messages) | DMs |
| `notify` | notifications, notification_prefs | Routing, inbox, email digest |
| `audit` | audit_events, outbox_events, processed_events | Audit chain, outbox |
| `search` | (views + FTS indexes) | ACL-filtered search |

Boundary rules:
- A module touches only its own tables.
- It reads other modules through their service interfaces.
- Cross-module side effects go through outbox events (enforced by lint rules plus DB grants per schema in production).

## 5.5 Request lifecycle (LLD)

1. **Edge:** CloudFront/WAF → ALB → `api`.
2. **Middleware order:**
   1. request id (`X-Request-Id`, kept if well formed, else a new UUIDv7) and one access-log line per request;
   2. session/bearer auth → principal `{user_id}` (pluggable `SessionVerifier`; routes are authenticated unless `@Public()`);
   3. per-user rate limit, so probing unknown ids is limited too;
   4. org membership status check: the tenant comes only from the path id of a `@ProjectScoped` / `@OrgScoped` route, through `withProjectMember` / `withOrgMember` (ADR-031). No membership or unknown id → 404; suspended, deprovisioned or expired guest → 403 `MEMBERSHIP_INACTIVE`. Then the per-org rate limit;
   5. idempotency (`Idempotency-Key`, 24 h; `@Idempotent()` routes), inside the handler transaction;
   6. Zod validation;
   7. **authz** (`packages/authz`, facts cached by `membership_version`);
   8. handler, which receives the transaction (`@DbTx()`) and never picks a database context itself;
   9. problem+json mapper.

   **Step 2 as built (F01-01, ADR-032):** `WorkosSessionVerifier` reads `parallelflow_session`, checks its MAC and the 12 h / 2 h limits, verifies the WorkOS access token (refreshing it once if expired), loads the account in user scope (exists, not deactivated, same email), and checks `X-CSRF-Token` on POST/PUT/PATCH/DELETE (403 `FORBIDDEN`). A bad or expired session clears the cookies and answers 401. Without WorkOS configuration the API runs with no verifier: every authenticated route is 401.

   **Slice implementation (F21-04):** rate limits and idempotency records are stored in Postgres (`rate_limit_counters`, `idempotency_keys`, migration 0004), not Redis, until realtime brings Redis (SLICE_DEBT). Rate limits are fixed one-minute windows, each counted in its own short transaction before the handler. The idempotency check, the handler and the stored 2xx response share one transaction, so a response is stored only if the handler's writes commit; a concurrent duplicate gets 409 `CONFLICT` (advisory lock). `X-ParallelFlow-Org` is not read yet: no route needs it until multi-org users exist. authz (step 7) lands with `packages/authz` (F08-01).
3. **DB transaction:**
   - `SET LOCAL app.org_id`, `app.user_id` (and `app.system_job` for workers);
   - domain writes, `audit_events` (risk ≥ medium) and `outbox_events` all in **one transaction**.
4. **After commit:**
   - the outbox relay (pg-boss job every 250 ms or LISTEN/NOTIFY) enqueues consumer jobs;
   - Redis publish for realtime.

   **Outbox as built (F21-05, ADR-033):**
   - **Emit:** producers call `emit(tx, event)` from `packages/db` inside the handler transaction. It validates the doc 07 §7.5 envelope (Zod registry in `packages/contracts/src/events.ts`: ids and enums only, strict objects, at most 4 KB), assigns a UUIDv7 id, and inserts only if `org_id` is the transaction's tenant (`OutboxTenantMismatchError` otherwise). The event commits or rolls back with the change.
   - **Relay:** `apps/worker` polls in a loop, not as a pg-boss job: every 250 ms while rows arrive, at once after a full batch, doubling to 2 s when idle (`OUTBOX_POLL_MS`, `OUTBOX_IDLE_MAX_MS`, `OUTBOX_BATCH_SIZE`). An idle poll is one `EXISTS` query. A busy poll is one transaction as the `saras_relay` login: claim up to 100 rows `ORDER BY created_at FOR UPDATE SKIP LOCKED`, insert one pg-boss job per subscribed consumer through the same transaction (job id = event id), set `published_at`. Two relays never publish a row twice; a crash before commit publishes nothing. A row that fails validation (only raw SQL can write one) is published without jobs and logged by id. No LISTEN/NOTIFY yet (SLICE_DEBT).
   - **Consumers:** `defineConsumer({ name, events, handler, retry })`, one queue `consumer.<name>` each. A job re-validates the event, opens `withSystemJob` for its org (app role), inserts `(consumer, event_id)` into `processed_events` `ON CONFLICT DO NOTHING` and runs the handler only if the row is new; both commit together. A throw rolls both back and pg-boss retries with exponential backoff (default 6 retries starting around 5 s, capped at 10 min), then moves the job to `consumer.<name>.dead` (kept 14 days for inspection or `redrive`). Logs carry ids, types, counts and durations only; the error pg-boss stores names the error class only.

## 5.6 Realtime

- `POST /v1/realtime/token` → 5-minute JWT.
- WebSocket `wss://rt.parallelflow.app/v1/ws`.
- **Topics:**
  - `arena:{project}`;
  - `private:{session}` (owner only);
  - `dm:{thread}`;
  - `user:{id}` (notifications);
  - `turn:{turn}`.
- Subscribing is authorized with the same authz engine. On membership changes, the gateway force-unsubscribes.
- Frames carry a per-topic `seq`. On reconnect, the client sends `resume` and the gateway replays the last 500 frames from a Redis list, or tells the client to refetch over REST.
- REST is the only write path. WebSocket is for delivery only.

## 5.7 Runtime adapter (inside `api` + `worker`)

| Concern | Design |
|---|---|
| Session provisioning | On setup complete: `POST /sessions` with `session_key`, profile `central_arena`, `context_seed` (org brief, project brief, roles, gates) and a tool token. Retries with backoff. Status in `agent_sessions` |
| Turn dispatch | `runtime_turns` row (id = idempotency key) → `POST /sessions/{id}/turns` with `mode`, input, `app_state` (cycle, stage), effective `autonomy`, `task_ref` / `routine_ref` |
| Event ingest | Worker consumes SSE: deltas → Redis publish (`turn:{id}`, `arena:{project}`). `message.completed` → persist agent message. `artifact.proposed` → draft artifact. `approval.requested` → approval card. `turn.completed` → usage |
| Isolation guard | Before every dispatch, recompute the expected `session_key` from the project or private session and compare. Mismatch → refuse, alert, audit |
| Ambient batching | Arena messages not addressed to `@central` are batched (20 messages / 60 s) as `reply_expected=false` |
| Fallback | If the runtime is unavailable: human chat continues, the agent is marked degraded, routines digest/nudge use deterministic templates, turns fail with `RUNTIME_UNAVAILABLE` |
| Budgets | Per-org monthly budget (Billing admin). Turns refused with `BUDGET_EXCEEDED` at 100%, alerts at 80% |

## 5.8 App Tools MCP server

- Streamable HTTP MCP endpoint.
- Bearer **tool token** carries `session_key`, `org_id`, `project_id`, principal (central agent / personal agent on behalf of a user), scopes and expiry (≤60 min).
- Every tool call runs this pipeline: resolve resources → reject anything outside `token.project_id` (`SCOPE_MISMATCH`) → authz (capability of the on-behalf-of user, or central-agent grant) → **autonomy check** (class from `app-tools_v0.2.mcp.json`; `approve` → creates an approval and returns `APPROVAL_REQUIRED`) → execute → log `app_tool_calls`.
- 20 tools; the human-only list is never exposed (doc 08).

## 5.9 Jobs and schedules (pg-boss)

| Queue | Trigger | Job |
|---|---|---|
| `outbox.relay` | Continuous | Move outbox rows to consumer queues. **As built:** a polling loop in `apps/worker`, not a queue (§5.5) |
| `consumer.<name>` / `consumer.<name>.dead` | Domain events | One queue per consumer (F21-05) and its dead-letter queue |
| `housekeeping.outbox_cleanup` | Cron hourly (`17 * * * *`, UTC) | Delete outbox rows published more than 7 days ago (doc 06 §6.6) |
| `housekeeping.idempotency_sweep` | Cron every 15 min (UTC) | Delete expired `idempotency_keys` rows (F21-04) |
| `notify.fanout` | Domain events | Route notifications (doc 04 §4.12), apply prefs, publish realtime |
| `routine.tick` | Cron every minute | Find due routines → enqueue `routine.run` with unique `(routine, slot)` |
| `routine.run` | Tick | Dispatch `mode=routine` turn or deterministic fallback |
| `loop.after_transition` | Stage transition | Stage summary, `progress.md`, system turn, evidence commit |
| `evidence.git` | Approved stage artifact | GitHub App commit `.parallelflow/cycles/{n}/{stage}.md`, retries |
| `members.guest_expiry` | Daily | Warn at 7 days, suspend at expiry |
| `members.offboard` | Offboarding | Revoke sessions, remove memberships, flag owner-less projects |
| `private.retention` | Daily | Delete Private content after retention for deprovisioned users |
| `knowledge.index` | Upload | Parse, chunk, embed (pgvector) |
| `approvals.expire` | Hourly | Expire stale approvals, notify requesters |
| `audit.archive` | Nightly | Export to S3 (Object Lock) |

pg-boss (12.35.1) lives in schema `pgboss`, installed and upgraded by the owner during `pnpm db:migrate`. The worker runs it as the `saras_relay` login on a direct endpoint with `migrate: false` and `reindex: false` (ADR-033). Queues are not partitioned: a partitioned queue would need `CREATE` at runtime.

## 5.10 Caching

| Data | Where | Invalidation |
|---|---|---|
| Authz facts (org role, unit roles, team roles, project capabilities) | Redis `authz:{org}:{user}:v{membership_version}` | Bump `membership_version` on any membership/role change |
| Project progress | Redis `progress:{project}:{tasks_version}` | `tasks_version` bump trigger |
| Role templates / capability catalogue | In-process | Deploy |
| Dashboard aggregates | Redis, 60 s | TTL |

## 5.11 Errors and resilience

| Class | Handling |
|---|---|
| Validation / authz / domain guard | 4xx problem+json with stable code (doc 07 §7.4); no retry |
| Transient DB / Redis | Client retries with the same Idempotency-Key (exponential backoff + jitter, max 3) |
| Runtime unavailable | Degrade (above); banner in Arena; turns can be retried |
| GitHub / SES failures | Job retries up to 24 h; evidence shows `pending` / `failed` |
| Concurrency on gates | `SELECT … FOR UPDATE` on approval + cycle `version` check; double advance impossible |

## 5.12 Deployment topology

| Service | ECS tasks (min / max) | Scaling signal |
|---|---|---|
| web (Next.js) | 2 / 8 | CPU / requests |
| api | 2 / 10 | CPU / p95 latency |
| realtime | 2 / 6 | Connections per task (~5k) |
| worker | 2 / 8 | pg-boss queue depth |
| app-tools | 2 / 6 | Requests |
| stub-runtime (staging, demo, fallback) | 1 / 2 | — |

Data: RDS PG16 `db.r7g.large` Multi-AZ + 1 read replica (search, dashboards) · ElastiCache Redis `cache.r7g.large` · S3 · SES.

Environments:

| Environment | Notes |
|---|---|
| `local` | docker-compose: Postgres + pgvector, Redis, MinIO, Mailpit, stub runtime |
| `preview` | Per PR, P1 |
| `staging` | Synthetic orgs + dogfood |
| `prod` | — |

## 5.13 Capacity estimate (year 1)

| Driver | Assumption | Load |
|---|---|---|
| Users | 5,000 (DAU 50%) | — |
| Arena messages | 40 / DAU / day | ~100k/day, ~15/s peak |
| Agent turns | 10 / DAU / day + routines | ~30k/day |
| Storage | Messages ~1 KB; artifacts ~30 KB/version | < 200 GB year 1 |

The bottleneck is model latency and cost in the runtime, not the app. Back-pressure points are: turn queue, budgets, ambient batching.

## 5.14 What we'd change at scale

| Trigger | Change |
|---|---|
| > 5k orgs or DB CPU > 60% sustained | Split `arena` and `messaging` into their own service and database |
| > 50M vectors | Dedicated vector store |
| Many event consumers or replay needs | Kafka/Redpanda behind the outbox |
| Regulated enterprise deals | Single-tenant cells, BYO runtime / model keys, additional regions |
