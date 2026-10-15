# 11 — Engineering Handbook

> Build Pack v2.0 · How we build Saras day to day: setup, standards, Definition of Done, testing, CI/CD, environments, observability and runbooks.

---

## 11.1 Day-1 setup

```bash
git clone git@github.com:<org>/saras.git && cd saras
corepack enable && pnpm install
cp .env.example .env.local            # WorkOS test keys, local S3 (MinIO), stub runtime URL
docker compose up -d                  # postgres16+pgvector, redis, minio, mailpit, stub-runtime
pnpm db:migrate && pnpm db:seed       # schema_v2 + demo org "Adva AI Lab" (startup + enterprise presets)
pnpm dev                              # web :3000, api :4000, realtime :4100, worker, app-tools :4200
```

Seed data:
- 2 orgs:
  - "Adva AI Lab" (startup);
  - "Acme Global" (enterprise, 3 units).
- 4 teams.
- 5 projects across all templates.
- 12 users, covering every org role, a Unit Lead, a guest and an observer.

Log in via the WorkOS test identity provider.

Notes:
- On Windows without admin rights, `corepack enable` fails with EPERM. Run `npm i -g pnpm@9.15.9` instead (the version pinned in `package.json`).
- Integration tests (`pnpm test:integration`) need Docker. Locally they skip when Docker is not running; in CI they fail instead.

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
| Runtime | RIC conformance kit vs stub (every PR) and vs Tau (checkpoints) | Lifecycle, idempotency, SSE resume, approvals, bind |
| Security | Tenant suite (every table with foreign org id), Private suite, canary isolation, authz matrix | Release-blocking |
| E2E | Playwright | Golden paths: onboarding → setup (custom roles) → Arena → Private push → gate → AI teammate → routine → dashboard |
| Load | k6 | 500 concurrent Arena users, 50 msg/s, 100 concurrent turns (stub with latency) |

## 11.6 CI/CD

```
PR:     lint · typecheck · unit · integration (Testcontainers) · contract (oasdiff) · migrations on fresh DB
        · RLS/tenant + authz suites · RIC conformance vs stub · Semgrep/CodeQL/gitleaks · build images
main:   deploy staging (ECS blue/green) → Playwright golden paths → k6 smoke
release tag vX.Y.Z: manual approval (we dogfood our own DEPLOY gate) → prod blue/green → automatic rollback on error-rate alarm
```

Current jobs, the required `ci-ok` check and branch protection setup: `docs/ci-branch-protection.md`. Jobs not built yet are tracked in `SLICE_DEBT.md`.

## 11.7 Environments and configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET_*` | Data stores |
| `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_WEBHOOK_SECRET` | Auth / SSO / SCIM |
| `RUNTIME_URL`, `RUNTIME_KIND` (stub \| tau), `RUNTIME_JWT_KEY` | Agent runtime |
| `APP_TOOLS_URL`, `TOOL_TOKEN_KEY` | MCP server and token signing |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | Evidence |
| `SES_*`, `POSTHOG_KEY`, `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Email, analytics, errors, tracing |

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
| Runtime down | Confirm via `/health`. The app auto-degrades. Post a status banner. Routines fall back to templates. Switch `RUNTIME_KIND=stub` (thin-llm) if the outage is > 30 min |
| Isolation alarm | Freeze the affected sessions (`agent_sessions.status=failed`). Rotate tool tokens. Collect `app_tool_calls` and audit. Incident SEV1 |
| WorkOS outage | Existing sessions continue. New logins fail. Status banner |
| GitHub outage | Evidence jobs retry for 24 h. Gates are unaffected |
| Bad deploy | ECS rollback to the previous task set. Migrations are expand-only, so rollback is safe |
| Budget exhausted | Org notified at 80/100%. A Billing admin raises the budget. Turns return `BUDGET_EXCEEDED` until then |
