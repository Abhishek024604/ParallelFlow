# Saras: AI-native SDLC workspace (MVP)

Saras is a collaborative workspace where human teams and AI work together across the whole software lifecycle. Every person has a **Private** space. Every project has one shared **Arena** and one central-agent session. Work runs in an SDLC **loop** of cycles with stage gates, and teams define their own **project roles** (our USP).

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
- **Global top bar (every signed-in page):** Saras logo on the left; a **Private / Arena / Developer** switch in the centre (Developer is disabled, labelled "Soon"); Inbox bell and avatar on the right. Build it once as the app-shell layout in `apps/web` and never repeat it per page. Sign-up and join pages have no bar.
- **Private sidebar works like ChatGPT projects:** New chat, Search chats, My files, **Projects** (personal folders that group private chats; a project expands to show its chats), then Recent chats. There is no "My Arenas" list in Private mode; arenas are reached through the top switch. Private projects are only the user's own folders. They are not arena projects and are not shared.
- **Data for Private projects (not in schema_v2 yet):** add a migration for `private_projects` (id, user_id, name, created_at, archived_at). Add a nullable `private_project_id` FK on the private-session table. RLS: owner only (`user_id = app.user_id`). Deleting a project moves its chats to Recent and never deletes them.
- **Wording:** a private chat that is linked to an arena shows "Linked to arena · <name>". Never show "bound".
- Target screens are `docs/design/screens/11_Onboarding.png` (sign up) and `18_ArenaEmpty.png`, `19_CreateArena.png`, `20_JoinInvite.png`. Backlog stories for the hidden features are deferred.

## Read before coding (in this order)
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

## Sources of truth
| What | Where | Rule |
|---|---|---|
| Database | `docs/contracts/schema_v2.sql` | First migration in `packages/db/migrations`. Never edit RLS policies without an ADR |
| HTTP API | `docs/contracts/openapi_v2.yaml` | Every endpoint enforces its `x-required-permission` |
| Agent runtime (Tau) | `docs/contracts/runtime-integration-contract_v0.2.yaml` | `apps/stub-runtime` implements it until Tau is ready |
| Tools the runtime calls | `docs/contracts/app-tools_v0.2.mcp.json` | Session-scoped tokens only |
| Role templates | `docs/contracts/role_templates_v2.json` | Seeded into setup wizard |
| UI | `docs/design/Saras_Brand_Template_v1.md`, `docs/design/saras-brand.css`, `docs/design/screens/*.png` | Tokens only, no hex in components. Screens are the target layout |
| Work | `docs/backlog/backlog.csv` | Build one story ID at a time |
| Decisions | `docs/13_Decision_Log.md` | Add an ADR for any contract or architecture change |

`docs/09_UX_and_Design_System.md` still applies for flows and accessibility. Its colours and type are replaced by the brand template.

## Stack
- **Web:** Next.js 15 + React 19 + Tailwind + Radix/shadcn + TanStack Query + Zustand.
- **API:** NestJS 11 on Node 22 (modular monolith) + Kysely.
- **Data:** Postgres 16 + pgvector (FORCE RLS), Redis pub/sub, pg-boss jobs.
- **Services:** WorkOS auth, S3 (MinIO locally), SES (Mailpit locally), PostHog, Sentry, OTel.
- **Monorepo:** pnpm + Turborepo, TypeScript strict.

## Non-negotiable rules
1. **Tenant isolation:** every query runs inside `withTenant(tx, ctx)`. RLS on every tenant table. Test denied paths with a non-member.
2. **Session isolation:** one agent session per project. Context from two projects never mixes. Canary tests must stay at 100%.
3. **Bind is write-once:** a Private session binds to one project once. Push copies the artifact; it never shares the session.
4. **Humans close the loop:** AI-assigned tasks can only reach `in_review`. Only a human verifies or approves gates.
5. **Gate separation of duties:** enforce `min_approvals`, `min_distinct_roles` and `forbid_self_approval` on the server.
6. **Permissions follow responsibility, not seniority.** Org admins see status, not Arena content, unless they are members.
7. **Never log** message or artifact content, prompts or tokens.
8. **UI:** ink is the primary button, with at most one orange CTA per screen. Dusk (`--ai`) is reserved for the AI. Sage means positive.

## Commands
```bash
pnpm install
docker compose up -d          # postgres16+pgvector, redis, minio, mailpit, stub-runtime
pnpm db:migrate && pnpm db:seed
pnpm dev                      # web :3000, api :4000, realtime :4100, app-tools :4200
pnpm lint && pnpm typecheck && pnpm test
```
(Until the scaffold exists, these scripts are created by story F21-01.)

## How to work in this repo
- Use `/story <ID>` for backlog work and `/dod` before committing. Use `/adr <topic>` when a contract or architecture must change.
- For anything touching more than 2 files, plan first and wait for approval.
- Branch: `feat/<ID>-short-name`. Conventional commits: `feat(<module>): <summary> [<ID>]`.
- Keep slice shortcuts in `SLICE_DEBT.md`. Don't silently cut corners.
- When behaviour differs from the docs, update the docs in the same PR.
