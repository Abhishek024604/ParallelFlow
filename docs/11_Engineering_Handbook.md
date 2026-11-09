# 11 — Engineering Handbook

> Build Pack v2.0 · How we build ParallelFlow day to day: setup, standards, Definition of Done, testing, CI/CD, environments, observability and runbooks.

---

## 11.1 Day-1 setup

```bash
git clone git@github.com:<org>/parallelflow.git && cd parallelflow
node -v                               # Node >= 22.19 (.nvmrc); the Pi runtime needs it
corepack enable && pnpm install
cp .env.example .env.local            # fill in: Neon URLs, WorkOS keys, RUNTIME_JWT_KEY, TOOL_TOKEN_KEY,
                                      # OPENROUTER_API_KEY(S) and models; optional GitHub App, SMTP, connectors
pnpm db:migrate                       # run by the project owner, not by agents or scripts (see below)
pnpm db:seed                          # optional: 2 demo arenas
pnpm dev                              # web :3000, api :4000, app-tools :4200, runtime :7070
```

What `pnpm dev` starts (`scripts/dev.mjs`): web, API and App Tools through turbo with watchers, and the agent runtime as a plain child process (Pi hangs under turbo's task runner on Windows). The worker is left out (`pnpm dev:worker` runs it alone); `apps/realtime` is a placeholder. Open `http://localhost:3000`: the browser calls only the web origin, which proxies `/v1/*` to the API.

Other ways to run:
- **`pnpm demo`** (`scripts/demo.mjs`): one `next build` into `apps/web/.next-demo`, then web (`next start`), API, App Tools and runtime without watchers. Pages answer in milliseconds. `pnpm demo --no-build` reuses the last build. Use it to show or film the app.
- **`pnpm demo:check`**: a preflight for filming. Checks `.env.local`, every OpenRouter key in the pool, the models, the GitHub App settings, the running services and the VS Code extension download; never prints a secret. `--live` also makes one tiny model call per key.
- **VS Code extension:** `pnpm --filter @parallelflow/vscode package` builds the `.vsix` and copies it to `apps/web/public/downloads/`, where "Build in VS Code" serves it.

Database (ADR-030):
- The dev database is on **Neon** (Postgres 16). `.env.example` explains each URL: `MIGRATION_DATABASE_URL` (owner, direct endpoint; migrations and codegen only), `DATABASE_URL` (the app login, pooled endpoint, member of `saras_app`), `RELAY_DATABASE_URL` (worker relay login, direct endpoint). Database names stay `saras` on purpose after the rename (SLICE_DEBT).
- Migrations are plain SQL up/down files in `packages/db/migrations`, **0001 to 0017** today: baseline, app role, identity RLS, request pipeline, outbox relay, private space, private files, extension coding, soft delete, user extensions, GitHub, arena copy, GitHub pull requests, lineage ignores deleted, AI provider keys, arena events, arena memory. `pnpm db:migrate` also creates the login roles, installs pg-boss and renames older arena files once.
- **`pnpm db:migrate` against the shared dev database is run by the project owner by hand.** Agents and scripts never run it; they write the migration and its integration test and say that it needs running.
- `docker compose up -d` still offers local Postgres + pgvector, Redis, MinIO and Mailpit. Only Postgres (if you are not on Neon) and Mailpit (as `SMTP_URL=smtp://localhost:1025`) are used by any code today.

Seed data (ADR-029 shape, `packages/db/src/seed.ts`):
- 2 arenas, each a hidden org + team + project + arena + AI session: "Checkout revamp" and "Mobile onboarding".
- 3 users: Asha (owner of the first arena), Ben (owner of the second) and Chitra (member of the first), at `@example.com`. Sign-in matches accounts by verified email (ADR-032), so you normally sign up with your own Google or email account and create an arena from the empty home.

Notes:
- On Windows without admin rights, `corepack enable` fails with EPERM. Run `npm i -g pnpm@9.15.9` instead (the version pinned in `package.json`).
- Without `RUNTIME_URL`, or without an OpenRouter key or model, the app works and every AI request says "AI isn't connected yet".
- Integration tests (`pnpm test:integration`) need Docker (Testcontainers) or `TEST_DATABASE_URL`. Locally they skip when neither is available; in CI they fail instead. In Phase A agents write integration tests but do not run the suite; unit tests, lint and typecheck are run.
- UI reference: the running app and `docs/design/ParallelFlow_Brand_Template_v2.md` (monochrome) with `docs/design/parallelflow-brand.css`. There are no design screen images any more.

## 11.2 Coding standards

| Topic | Rule |
|---|---|
| Language | TypeScript strict everywhere; no `any` without a comment |
| Contracts first | Change `packages/contracts` (Zod) → regenerate OpenAPI → review → implement |
| Module boundaries | `eslint-plugin-boundaries`: apps import packages, modules don't import each other's internals |
| Domain logic | Pure functions in `packages/domain` (state machines) and `packages/authz`; no DB inside |
| Database | Kysely only; every query runs inside `withTenant(tx, ctx)`; no raw string SQL concatenation |
| Errors | Throw typed `DomainError(code)` → mapped to problem+json; never leak stack traces |
| Logging | Structured (pino) with `request_id`, `org_id`, `user_id`, `turn_id`; **never** log message/artifact content, prompts or tokens |
| Frontend | Server state in TanStack Query; UI state in Zustand; components from `packages/ui`; no inline colors (tokens only) |
| Accessibility | Every interactive element is a real button, link or input; axe check in Playwright |
| Feature flags | PostHog flags for every user-visible new capability; flags removed within 2 sprints after GA |

## 11.3 Git and review

- **Trunk-based:** short-lived branches `feat/F09-arena-mentions`. PRs under 400 lines where possible.
- **Conventional commits.** Squash merge.
- **One approval required.** Two for `packages/authz`, `packages/db/migrations`, `apps/app-tools`, and RLS policies.
- **PR template asks:**
  - feature ID and backlog story;
  - contract change?;
  - migration?;
  - security checklist (doc 10 §10.8);
  - screenshots for UI.

## 11.4 Definition of Done (every story)

Phase A (the demo build, 16 Oct – early Nov 2026) skipped this list by design: one smoke test per feature, RLS and `withTenant` on every new table and query, and a `SLICE_DEBT.md` line for every shortcut. The full list applies again in Phase B.

- [ ] Acceptance criteria from the backlog met and demoed on staging
- [ ] API matches `openapi_v2.yaml` (contract test green); `x-required-permission` correct
- [ ] Authz tested (allowed and denied paths, including agent principal where relevant)
- [ ] RLS covers new tables; tenant and isolation suites green
- [ ] Audit events for medium/high-risk actions; notifications wired
- [ ] UI states: loading, empty, error, read-only, dark theme
- [ ] Analytics event (ids only) where listed in PRD §2.6
- [ ] Docs updated (this Build Pack) when behaviour differs

## 11.5 Testing strategy

| Layer | Tooling | Must cover |
|---|---|---|
| Unit | Vitest | `packages/authz` (≥95% branches), `packages/domain` state machines, cron validation, progress formula |
| Integration | Vitest + Testcontainers (PG16, Redis, MinIO) | Use-cases with real DB + RLS; outbox → consumers; setup:complete atomicity |
| Contract | Schemathesis against staging; oasdiff on PRs | No breaking change without a version bump |
| Runtime | RIC conformance kit vs the Pi runtime in `apps/runtime` (every PR) and vs Tau (checkpoints); not built yet | Lifecycle, idempotency, SSE resume, approvals, bind |
| Security | Tenant suite (every table with foreign org id), Private suite, canary isolation, authz matrix | Release-blocking |
| E2E | Playwright | Golden paths: onboarding → setup (custom roles) → Arena → Private push → gate → AI teammate → routine → dashboard |
| Load | k6 | 500 concurrent Arena users, 50 msg/s, 100 concurrent turns (against a runtime with a fake model and set latency) |

## 11.6 CI/CD

```
PR:     lint · typecheck · unit · integration (Testcontainers) · contract (oasdiff) · migrations on fresh DB
        · RLS/tenant + authz suites · RIC conformance vs the Pi runtime · Semgrep/CodeQL/gitleaks · build images
main:   deploy staging (ECS blue/green) → Playwright golden paths → k6 smoke
release tag vX.Y.Z: manual approval (we dogfood our own DEPLOY gate) → prod blue/green → automatic rollback on error-rate alarm
```

Current jobs, the required `ci-ok` check and branch protection setup: `docs/ci-branch-protection.md`. Jobs not built yet are tracked in `SLICE_DEBT.md`.

**Deploy today (Phase A):** no staging or ECS yet. The demo deploy is one VM with Docker Compose + Caddy (`deploy/azure/`, `Dockerfile`; doc 05 §5.12), built and started by hand on the VM: `docker compose --env-file ../../.env.production up -d --build` from `deploy/azure`. Steps and checks: `DEPLOY_PLAN.md`. Before building, run `pnpm --filter @parallelflow/vscode package` so the web serves the current `.vsix`.

## 11.7 Environments and configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` (app role, may be pooled), `MIGRATION_DATABASE_URL` (owner, direct), `TEST_DATABASE_URL` (optional, throwaway test DBs) | Postgres (ADR-030) |
| `RELAY_DATABASE_URL` | Outbox relay and pg-boss login (`saras_relay` member, ADR-033). **Direct** endpoint and its own user (not the owner, not the app login). `pnpm db:migrate` creates the role |
| `PORT` (API, default 4000), `LOG_LEVEL` (default `info`) | API process |
| `OUTBOX_POLL_MS` (250), `OUTBOX_IDLE_MAX_MS` (2000), `OUTBOX_BATCH_SIZE` (100) | Worker relay polling (doc 05 §5.5). The worker also reads `DATABASE_URL`, `RELAY_DATABASE_URL` and `LOG_LEVEL` |
| `RATE_LIMIT_USER_PER_MINUTE` (600), `RATE_LIMIT_ORG_PER_MINUTE` (6000) | API rate limits (doc 07 §7.1); override only for load tests |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (≥ 32 chars), `WORKOS_REDIRECT_URI`, `WORKOS_WEBHOOK_SECRET` | Auth / SSO / SCIM. Set the first four together or none (none = sign-in off, every route 401). The redirect URI is on the web origin (`http://localhost:3000/v1/auth/callback` locally), because the web app proxies `/v1/*` to the API and the cookies belong to the web origin. It must be https except on localhost; http://localhost turns the `Secure` cookie flag off |
| `WEB_ORIGIN` (default `http://localhost:3000`), `COOKIE_DOMAIN` (optional) | The web app: the only post-login redirect target and the only CORS origin (a safety net; the browser calls the API same-origin through the proxy). `COOKIE_DOMAIN` sets the domain of the readable `parallelflow_csrf` cookie when web and API are sibling hosts; leave it unset behind the proxy |
| `API_URL` (web, server-side, default `http://localhost:4000`) | Where `apps/web` proxies `/v1/*` (`next.config.ts`) and where its middleware and server components call the API. The proxy target is fixed when `next build` (or `next dev`) starts, so set it at build time. The browser only calls the web origin, so there is no `NEXT_PUBLIC_API_URL` |
| `RUNTIME_URL` (API → runtime, `http://localhost:7070/v1`; unset = AI not connected), `RUNTIME_JWT_KEY` (≥ 32 chars, same value in the API and the runtime) | Agent runtime (ADR-035). Needs Node ≥ 22.19. `.env.example` still has `RUNTIME_KIND=tau`, but no code reads it |
| `OPENROUTER_API_KEY`, `OPENROUTER_API_KEYS` (comma-separated pool) | The runtime's model provider; the API's `/v1/llm/*` proxy for the VS Code extension uses the same pool. Empty = AI turns fail fast with `RUNTIME_UNAVAILABLE` |
| `RUNTIME_MODEL` (forced single model), `RUNTIME_MODEL_FAST`, `RUNTIME_MODEL_STRONG`, `RUNTIME_FALLBACK_MODELS` | OpenRouter model ids. No built-in defaults: models come from the environment only (`.env.example` sets `RUNTIME_MODEL=anthropic/claude-sonnet-4.5`). Routing: doc 08 §8.6.3 |
| `RUNTIME_DATA_DIR` (default `apps/runtime/.data`), `RUNTIME_PORT` (default: the port of `RUNTIME_URL`, else 7070) | Runtime session files and port |
| `RUNTIME_CONNECTORS` (default `drawio`; known: `drawio`, `sentry`, `semgrep`), `SENTRY_AUTH_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Connectors and Vercel deploy tools for the arena's AI (doc 05 §5.15). An empty key skips that connector or tool set |
| `APP_TOOLS_URL` (default `http://localhost:4200/mcp`), `TOOL_TOKEN_KEY` (≥ 32 chars, same value in the API and App Tools) | App Tools MCP server and tool-token signing (ADR-035). App Tools also reads `DATABASE_URL`, `LOG_LEVEL` and `APP_TOOLS_PORT` (default: the port of `APP_TOOLS_URL`) |
| `ARENA_REPOS_DIR` (default `.data/arena-repos`) | Folder of the arenas' git repositories on the API server (a persistent volume in any deploy) |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` (PEM; one line with `\n` works), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` (≥ 20 chars) | The ParallelFlow GitHub App (ADR-040). Set all six or none; none = arenas stay on the server. Setup: `docs/github-app-setup.md` |
| `SMTP_URL`, `MAIL_FROM`, `INVITE_LINK_KEY` (optional; default derived from `WORKOS_COOKIE_PASSWORD`) | Invite emails through nodemailer (unset = no email; copy links from the Members tab) and the invite-link signing key (changing it ends all links) |
| `API_READ_CACHE=off` | Turns off the API's 30 s in-memory GET cache |
| `WORKOS_COOKIE_PASSWORD` (again) | Besides the session cookie, the API derives from it the AES-256-GCM key that seals own AI keys and connections, and the GitHub state HMAC key. Rotating it orphans sealed keys (SLICE_DEBT) |
| `SES_*`, `POSTHOG_KEY`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `REDIS_URL`, `S3_*` | Email, analytics, errors, tracing and data stores of the production target; in `.env.example` but not read by any code yet |

## 11.8 Observability and SLOs

| SLI | SLO | Alert |
|---|---|---|
| API availability | 99.9% / 30 d | Burn rate 14× / 1 h, 6× / 6 h |
| API p95 latency | < 250 ms reads | > 400 ms for 10 min |
| Arena fan-out p95 | < 300 ms | > 1 s for 5 min |
| Agent first event p95 | < 3 s | > 6 s for 10 min |
| Turn success rate | > 97% | < 93% for 15 min |
| Outbox lag | < 5 s | > 30 s |
| Routine on-time rate | > 99% within 2 min of schedule | < 95% / day |
| Isolation alarms | 0 | Any `SCOPE_MISMATCH` from adapter guard → page |

## 11.9 Runbooks (summary)

| Situation | First steps |
|---|---|
| Runtime down | Confirm via `GET /v1/health` on the runtime. Human chat keeps working; AI requests say the AI isn't connected. Restart the runtime (turns in flight and the follow-up queue are lost; the API marks them failed). If OpenRouter is the cause, check the keys and models with `pnpm demo:check --live` and set `RUNTIME_FALLBACK_MODELS`. (Planned: routines fall back to templates; Tau or the Pi runtime as each other's fallback) |
| Isolation alarm | Freeze the affected sessions (`agent_sessions.status=failed`). Rotate tool tokens. Collect `app_tool_calls` and audit. Incident SEV1 |
| WorkOS outage | Existing sessions continue. New logins fail. Status banner |
| GitHub outage | Evidence jobs retry for 24 h. Gates are unaffected. Phase A: gates still commit to the arena's local repo; the push to GitHub fails, shows in the arena Overview (`last_sync_error`) and is retried at the next change or with "Sync" (ADR-040) |
| Bad deploy | ECS rollback to the previous task set. Migrations are expand-only, so rollback is safe |
| Budget exhausted | Org notified at 80/100%. A Billing admin raises the budget. Turns return `BUDGET_EXCEEDED` until then |
