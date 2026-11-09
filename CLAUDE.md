# ParallelFlow: AI-native SDLC workspace (MVP)

ParallelFlow is a collaborative workspace where human teams and AI work together across the whole software lifecycle. Every person has a **Private** space. Every project has one shared **Arena** and one central-agent session. Work runs in an SDLC **loop** of cycles with stage gates, and teams define their own **project roles** (our USP).

## Build order (from 16 Oct): product first, hardening second
The final product and its features are unchanged; only the order changes. Ship every visible feature end to end first, then do the production hardening.

**Phase A: product showcase (now → YC video, 30 Oct).** Build in this order:
1. App shell: global top bar + Private and Arena sidebars
2. First run: sign up/login (done) → empty home → create arena + invite link → join
3. Arena chat: messages, members panel, polling every 2 s
4. @AI in the Arena: streaming replies using the arena's messages and files as context
5. Private chats + Projects sidebar + AI drafting
6. Push to Arena + file viewer
7. Stage strip + approval card + Approve moves the stage
8. Custom roles screen with templates
9. Demo seed data + deploy

**Phase B: hardening (after the video).** Remaining backlog stories in order: authz library, realtime (Redis/WebSockets), Tau via the runtime contract, contract tests, security scanners, Terraform, the full Definition of Done, then paying back `SLICE_DEBT.md`.

**Phase A working rules**
- Real, working features, using the simplest path: a thin NestJS controller + Kysely query, or a Next.js route handler. Fake data only in the seed script.
- Still required now (cheap, and avoids rework later): RLS + `withTenant` on every new table and query, and session isolation between arenas.
- Allowed interim choices (one line each in `SLICE_DEBT.md`): polling instead of WebSockets; the Pi runtime with OpenRouter (ADR-035) instead of Tau; a copyable invite link instead of email; owner/member checks instead of the full authz library.
- Tests: one smoke test per feature. No test loops.
- No new ADRs unless the schema contract changes. Skip `/dod`. Plan first only if a change touches more than 5 files.
- Read docs only on demand, and only the section you need. Never open `docs/contracts/openapi_v2.yaml` or `schema_v2.sql` in full.
- Commit after each working feature: `feat(<area>): <summary> [demo]`.

## MVP scope override (ADR-029, 15 Oct): read this first
The MVP has **no organization layer in the UI**. The first run is:
1. **Sign up:** Google or email.
2. **Empty home:** a "Create arena" button.
3. **Create arena:** name, an optional description, and invites by email.
4. **Join:** invitees get an email, sign up with that email, open the link and join.

- Each arena = hidden org + team + project + arena + agent session, all created in one transaction. The schema is unchanged.
- **Don't build for the MVP:**
  - org units, the org dashboard, org policies/presets, SSO/SCIM, guests, access requests;
  - setup wizards;
  - extra windows.
- Custom roles and stage approvals are **optional arena settings**. The default single approver is the arena owner.
- Keep pages basic and copy plain. Use "arena", "teammates" and "AI". Never show "org", "unit", "tenant", "bind" or "central agent".
- **Global top bar (every signed-in page):** ParallelFlow logo on the left; a **Private / Arena / Developer** switch in the centre (Developer is disabled, labelled "Soon"); Inbox bell and avatar on the right. Build it once as the app-shell layout in `apps/web` and never repeat it per page. Sign-up and join pages have no bar.
- **Private sidebar works like ChatGPT projects:** New chat, Search chats, My files, **Projects** (personal folders that group private chats; a project expands to show its chats), then Recent chats. There is no "My Arenas" list in Private mode; arenas are reached through the top switch. Private projects are only the user's own folders. They are not arena projects and are not shared.
- **Data for Private projects (not in schema_v2 yet):** add a migration for `private_projects` (id, user_id, name, created_at, archived_at). Add a nullable `private_project_id` FK on the private-session table. RLS: owner only (`user_id = app.user_id`). Deleting a project moves its chats to Recent and never deletes them.
- **Wording:** a private chat that is linked to an arena shows "Linked to arena · <name>". Never show "bound".
- The UI reference is the running app (`apps/web`) plus the brand template v2; the old design screens were deleted (9 Nov). Backlog stories for the hidden features are deferred.

## Reference docs (read on demand in Phase A; read in order in Phase B)
<!-- Phase B: read before each story
1. `docs/00_README.md`: reading order and the 10 rules
2. `docs/05_Architecture.md`: stack, monorepo layout (§5.3), module map (§5.4)
3. `docs/11_Engineering_Handbook.md`: Day-1 setup, coding standards, Definition of Done
4. `docs/12_Delivery_Plan.md`: phases and the YC demo slice (16–30 Oct)
5. Topic docs as a story needs them:
   - 03 RBAC
   - 04 workflows
   - 06 data model
   - 07 API
   - 08 agent runtime
   - 10 security
-->
Key docs: 05 Architecture (layout §5.3), 04 workflows, 06 data model, 08 agent runtime. UI: the running app + brand template v2.

## Sources of truth
| What | Where | Rule |
|---|---|---|
| Database | `docs/contracts/schema_v2.sql` + `packages/db/migrations` 0002–0017 (doc 06 §6.8) | schema_v2 = migration 0001, byte-identical (tested), never edited. Never edit RLS policies without an ADR |
| HTTP API | `docs/contracts/openapi_v2.yaml` | Phase A: owner/member checks; Phase B: every endpoint enforces its `x-required-permission` |
| Agent runtime (Pi) | `docs/contracts/runtime-integration-contract_v0.2.yaml` | Phase A: `apps/runtime`, the Pi harness behind RIC v0.2 with OpenRouter models (ADR-035); later: Tau behind the same contract |
| Tools the runtime calls | `docs/contracts/app-tools_v0.2.mcp.json` | Session-scoped tokens only |
| Role templates | `docs/contracts/role_templates_v2.json` | Seeded into setup wizard |
| UI | `docs/design/ParallelFlow_Brand_Template_v2.md`, `apps/web/src/styles/parallelflow-brand.css`, the running app | Tokens only, no hex in components. New screens follow the pages already built |
| Work | `docs/backlog/backlog.csv` | Phase A follows the build order above; Phase B goes story by story |
| Decisions | `docs/13_Decision_Log.md` | ADR only when the schema contract changes (Phase A) |

`docs/09_UX_and_Design_System.md` still applies for flows and accessibility. Its colours and type are replaced by the brand template v2.

## Stack
- **Web:** Next.js 15 + React 19 + Tailwind + Radix/shadcn + TanStack Query + Zustand.
- **API:** NestJS 11 on Node 22 (modular monolith) + Kysely.
- **Data:** Postgres 16 + pgvector (FORCE RLS), Redis pub/sub, pg-boss jobs.
- **Services:** WorkOS auth, S3 (MinIO locally), SES (Mailpit locally), PostHog, Sentry, OTel.
- **Monorepo:** pnpm + Turborepo, TypeScript strict.

## Non-negotiable rules
1. **Tenant isolation:** every query runs inside `withTenant(tx, ctx)`. RLS on every tenant table. Test denied paths with a non-member.
2. **Session isolation:** one agent session per project. Context from two projects never mixes. (Canary test suite: Phase B.)
3. **Bind is write-once:** a Private session binds to one project once. Push copies the artifact; it never shares the session.
4. **Humans close the loop:** AI-assigned tasks can only reach `in_review`. Only a human verifies or approves gates.
5. **Gate separation of duties:** Phase A: the arena owner approves. Phase B: enforce `min_approvals`, `min_distinct_roles` and `forbid_self_approval` on the server.
6. **Permissions follow responsibility, not seniority.** Org admins see status, not Arena content, unless they are members.
7. **Never log** message or artifact content, prompts or tokens.
8. **UI:** monochrome; ink is the primary button, with at most one orange CTA per screen. Violet (`--ai`) is reserved for the AI. Green means positive.

## Commands
```bash
pnpm install
docker compose up -d          # local services (dev DB is on Neon, see ADR-030)
pnpm db:migrate && pnpm db:seed
pnpm dev                      # web :3000, api :4000, realtime :4100, app-tools :4200
pnpm lint && pnpm typecheck && pnpm test
```

## How to work in this repo
- **Phase A:** use `/feature <name>` for each item in the build order. Work on `main`, commit per feature, then `/clear`.
- Keep slice shortcuts in `SLICE_DEBT.md` (one line each). Don't silently cut corners.
<!-- Phase B (after the YC video): restore these
- Use `/story <ID>` for backlog work and `/dod` before committing. Use `/adr <topic>` when a contract or architecture must change.
- For anything touching more than 2 files, plan first and wait for approval.
- Branch: `feat/<ID>-short-name`. Conventional commits: `feat(<module>): <summary> [<ID>]`.
- When behaviour differs from the docs, update the docs in the same PR.
-->
