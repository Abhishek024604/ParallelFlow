# 07 — API Reference

> Build Pack v2.0 · Machine-readable: `contracts/openapi_v2.yaml` (OpenAPI 3.1 · 132 operations · 94 paths · 92 schemas · Redocly: 0 errors). Every operation carries `x-required-permission`; the table in §7.6 is generated from it.

---

## 7.1 Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.saras.app/v1` (staging: `api.staging.saras.app/v1`) |
| Auth | Web: `saras_session` cookie (HttpOnly) + CSRF header on mutations. Integrations/CI: Bearer token |
| Org context | Org-scoped paths include `{org_id}`. Other calls resolve the org from the resource; multi-org users send `X-Saras-Org` |
| IDs | UUIDv7 |
| Pagination | `limit` (≤100) + opaque `cursor`; responses carry `next_cursor` |
| Idempotency | `Idempotency-Key` **required** on all creating and state-transition POSTs (24 h replay window) |
| Concurrency | `ETag` / `If-Match` on versioned resources (projects, tasks, artifacts) → `412` on mismatch |
| Errors | RFC 7807 `application/problem+json` with stable `code` and, on 403, `required_permission` |
| Visibility | Private resources and projects you can't read return `404`, not `403` |
| Content boundaries | Org and unit dashboards never return message, artifact or task content |
| Versioning | `/v1`; additive changes only; breaking change → `/v2` with 6-month overlap |
| Rate limits | 600 req/min/user · 6,000 req/min/org · agent turns 30/min/user · headers `RateLimit-*` |

## 7.2 Resource map

| Area | Base paths |
|---|---|
| Identity | `/me`, `/auth/*` |
| Organization | `/orgs`, `/orgs/{org_id}/(policies / members / invites / sso / knowledge / usage / dashboard / audit-events)` |
| Hierarchy | `/orgs/{org_id}/units`, `/units/{unit_id}`, `/units/{unit_id}/(roles / dashboard)` |
| Teams | `/teams`, `/teams/{team_id}/members` |
| Projects & setup | `/capabilities`, `/role-templates`, `/projects`, `/projects/{id}/setup/*`, `/projects/{id}:archive / :restore / :decommission` |
| Roles & access | `/projects/{id}/(roles / members / access-requests / gates / agent-policy)`, `/access-requests/{id}:decide` |
| Arena | `/projects/{id}/arena`, `/projects/{id}/arena/messages`, `/messages/{id}` |
| Routines | `/projects/{id}/routines`, `/routines/{id}` |
| Private & bridge | `/private/sessions`, `/private/sessions/{id}/(messages / bridge/pull-context)`, `:bind` |
| Artifacts | `/artifacts`, `/artifacts/{id}/(versions / push-preview / push)`, `/files` |
| Tasks | `/projects/{id}/tasks`, `/tasks/{id}`, `:delegate`, `:assign-agent`, `:verify` |
| SDLC loop | `/projects/{id}/cycles`, `/cycles/{id}/(gate-requests / evidence)`, `:send-back`, `/approvals`, `/approvals/{id}/votes` |
| Messaging & notifications | `/dms`, `/notifications`, `/notification-prefs`, `/realtime/token` |
| Search, webhooks | `/search`, `/webhooks/workos`, `/webhooks/github` |

## 7.3 Worked examples

**Complete project setup (atomic):**
```http
POST /v1/projects/0193…/setup:complete
Idempotency-Key: 3f2c…
→ 200 { "id":"0193…", "key":"REF", "status":"active", "active_cycle":{"number":1,"stage":"PLAN"}, "my_roles":["Engineering Manager"], … }
→ 422 { "code":"GATE_UNSTAFFED", "detail":"DEPLOY requires roles SRE, Engineering Manager; SRE has no members", … }
```

**Observer tries to post:**
```http
POST /v1/projects/0193…/arena/messages
→ 403 { "code":"FORBIDDEN", "required_permission":"cap arena.post", "detail":"Your role in REF is Observer (read-only)." }
```

**Assign a task to the AI teammate:**
```http
POST /v1/tasks/0194…:assign-agent
Idempotency-Key: 9a1e…
{ "reviewer_id":"0191…", "instructions":"Draft the refunds API spec from goal.md v3", "model_class":"deep" }
→ 200 { "status":"in_progress", "assignee":{"type":"agent","id":"…central…"}, "reviewer_id":"0191…", … }
```

**Vote with separation of duties:**
```http
POST /v1/approvals/0195…/votes   { "decision":"approve" }
→ 422 { "code":"SELF_APPROVAL_FORBIDDEN", "detail":"DEPLOY gate forbids approving your own request." }
```

## 7.4 Error codes

| HTTP | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body / query invalid (`errors[]`) |
| 401 | `UNAUTHENTICATED` | No / expired session |
| 403 | `FORBIDDEN` | Missing permission (`required_permission` set) |
| 403 | `MEMBERSHIP_INACTIVE` | Suspended, expired guest, deprovisioned |
| 403 | `SSO_REQUIRED` | Org requires SSO |
| 403 | `HUMAN_ONLY_ACTION` | Agent attempted vote / verify / member or role change |
| 404 | `NOT_FOUND` | Missing or not visible |
| 409 | `ALREADY_EXISTS`, `CONFLICT` | Duplicate key / slug / name |
| 409 | `LAST_OWNER` | Removing the last Owner of a project or team |
| 409 | `ACTIVE_CYCLE_EXISTS` | Opening a cycle while one is active |
| 409 | `WRONG_STAGE`, `APPROVAL_CLOSED` | Loop guards |
| 409 | `BRIDGE_SCOPE_MISMATCH`, `ALREADY_BOUND` | Bridge guards |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body |
| 410 | `INVITE_EXPIRED` | Invite expired / revoked |
| 412 | `PRECONDITION_FAILED` | `If-Match` mismatch |
| 422 | `GATE_UNSTAFFED`, `DISTINCT_ROLES_UNSATISFIABLE`, `NO_OWNER` | Setup / role validation |
| 422 | `AUTONOMY_ABOVE_CEILING` | Agent policy above org/unit ceiling |
| 422 | `SELF_APPROVAL_FORBIDDEN`, `REASON_REQUIRED`, `REQUIRED_ARTIFACT_MISSING` | Gate rules |
| 422 | `ACCEPTANCE_CRITERIA_UNVERIFIED`, `REVIEWER_REQUIRED` | Task rules |
| 422 | `MEMBER_LIMIT_REACHED`, `CROSS_UNIT_NOT_ALLOWED`, `GUEST_RESTRICTED` | Membership rules |
| 422 | `CRON_TOO_FREQUENT` | Routine schedule < 1 h |
| 429 | `RATE_LIMITED`, `BUDGET_EXCEEDED` | With `Retry-After` |
| 503 | `RUNTIME_UNAVAILABLE` | Agent features degraded |

## 7.5 Domain events (outbox → pg-boss consumers)

Envelope: `{id, type, org_id, subject, actor{type,id,on_behalf_of}, time, trace_id, schema_version, data}`. Consumers are idempotent on `id`.

| Event | Main consumers |
|---|---|
| `org.created`, `org.policies_changed` | audit, cache bust |
| `member.invited`, `member.joined`, `member.role_changed`, `member.moved_unit`, `member.offboarded`, `guest.expiring`, `guest.suspended` | notify, authz cache, offboarding job |
| `unit.created`, `unit.moved`, `unit.roles_changed` | dashboards cache, authz cache |
| `team.created`, `team.member_changed` | notify, authz cache |
| `project.setup_completed`, `project.archived`, `project.decommissioned` | runtime adapter (session), routines, notify |
| `project.role_changed`, `project.member_added`, `project.member_removed` | authz cache, tool-token rotation, notify |
| `access.requested`, `access.decided` | notify, audit |
| `arena.message_posted`, `mention.created` | realtime, notify, ambient batcher, search index |
| `turn.requested`, `turn.completed`, `turn.failed` | adapter, usage, realtime |
| `artifact.version_created`, `artifact.pushed` | notify, search index, evidence |
| `task.created`, `task.delegated`, `task.assigned_agent`, `task.in_review`, `task.verified` | notify, progress, adapter |
| `gate.requested`, `gate.voted`, `cycle.advanced`, `cycle.sent_back`, `cycle.opened` | notify, progress.md, evidence, system turn |
| `routine.due`, `routine.posted`, `routine.failed` | adapter, notify |
| `dm.message_posted` | realtime, notify |

## 7.6 Endpoint catalogue with authorization rules (generated)

| Tag | Method | Path | Summary | Required permission |
|---|---|---|---|---|
| Identity | GET | `/me` | Current user, org memberships, unit roles, personal agent | authenticated |
| Identity | PATCH | `/me` | Update display name / handle | authenticated |
| Identity | GET | `/auth/login` | Start login (redirects to WorkOS AuthKit: SSO, Google, Microsoft, magic link) | public |
| Identity | GET | `/auth/callback` | OAuth callback; sets session cookie | public |
| Identity | POST | `/auth/logout` | End session | authenticated |
| Organization | POST | `/orgs` | Create an organization (creator becomes Org Owner) with a preset | authenticated |
| Organization | GET | `/orgs/{org_id}` | Organization details | org member |
| Organization | PATCH | `/orgs/{org_id}` | Rename, unit level names | org:owner\|admin |
| Organization | GET | `/orgs/{org_id}/policies` | Org policies | org:owner\|admin\|security_admin |
| Organization | PUT | `/orgs/{org_id}/policies` | Update org policies (security fields require security_admin or owner) | org:owner\|admin\|security_admin |
| Organization | GET | `/orgs/{org_id}/members` | Directory (guests see only co-members) | org member |
| Organization | PATCH | `/orgs/{org_id}/members/{user_id}` | Change org role, home unit, title, level, guest expiry | org:owner\|admin |
| Organization | DELETE | `/orgs/{org_id}/members/{user_id}` | Offboard: revoke sessions, remove from teams/projects, schedule Private retention | org:owner\|admin |
| Organization | GET | `/orgs/{org_id}/invites` | Pending invites | org:owner\|admin |
| Organization | POST | `/orgs/{org_id}/invites` | Invite people to org / team / project (guests need guest_access_until) | org:owner\|admin OR team:owner\|admin (team scope) OR cap member.invite (project scope) |
| Organization | DELETE | `/orgs/{org_id}/invites/{invite_id}` | Revoke invite | inviter OR org:owner\|admin |
| Organization | POST | `/invites/{token}:accept` | Accept an invite | authenticated (email must match) |
| Organization | GET | `/orgs/{org_id}/sso` | SSO / SCIM status and WorkOS admin-portal link | org:owner\|admin |
| Organization | POST | `/orgs/{org_id}/sso:portal-link` | Generate WorkOS admin-portal link to configure SAML/OIDC/SCIM | org:owner\|admin |
| Units | GET | `/orgs/{org_id}/units` | Org unit tree | org member |
| Units | POST | `/orgs/{org_id}/units` | Create unit (max depth 5) | org:owner\|admin |
| Units | PATCH | `/units/{unit_id}` | Rename / move unit / policy overrides | org:owner\|admin |
| Units | DELETE | `/units/{unit_id}` | Delete an empty unit | org:owner\|admin |
| Units | PUT | `/units/{unit_id}/roles` | Assign Unit Leads and Unit Admins | org:owner\|admin OR unit_lead (admins only) |
| Units | GET | `/units/{unit_id}/dashboard` | Portfolio dashboard for the unit subtree (metadata only) | unit_lead\|unit_admin on unit or ancestor OR org:owner\|admin\|security_admin |
| Organization | GET | `/orgs/{org_id}/dashboard` | Organization dashboard (metadata only) | org:owner\|admin\|security_admin |
| Organization | GET | `/orgs/{org_id}/knowledge` | Org knowledge sources used by the central agent | org member |
| Organization | POST | `/orgs/{org_id}/knowledge` | Add knowledge source (uploaded file) for indexing | org:owner\|admin OR unit_admin (unit scope) |
| Organization | DELETE | `/knowledge/{knowledge_id}` | Remove knowledge source | org:owner\|admin |
| Organization | GET | `/orgs/{org_id}/usage` | Agent usage and budget | org:owner\|admin\|billing_admin |
| Audit | GET | `/orgs/{org_id}/audit-events` | Audit log | org:owner\|security_admin |
| Audit | POST | `/orgs/{org_id}/audit-exports` | Export audit log (CSV/JSON) | org:owner\|security_admin |
| Teams | GET | `/teams` | Teams I belong to (filter=all for directory) | org member |
| Teams | POST | `/teams` | Create a team (creator = Team Owner); subject to org policy member_team_creation | per org policy |
| Teams | GET | `/teams/{team_id}` | Team details | org member (non-guest) OR team member |
| Teams | PATCH | `/teams/{team_id}` | Update team settings | team:owner\|admin |
| Teams | DELETE | `/teams/{team_id}` | Archive team (projects must be archived first) | team:owner OR unit_admin |
| Teams | GET | `/teams/{team_id}/members` | Team members | team member |
| Teams | POST | `/teams/{team_id}/members` | Add members | team:owner\|admin |
| Teams | PATCH | `/teams/{team_id}/members/{user_id}` | Change team role | team:owner (owner/admin) \\| team:admin (member) |
| Teams | DELETE | `/teams/{team_id}/members/{user_id}` | Remove member | team:owner\|admin |
| Projects | GET | `/capabilities` | Capability catalogue (27) | authenticated |
| Projects | GET | `/role-templates` | Role templates with roles, capabilities, gates and agent policy | authenticated |
| Projects | GET | `/projects` | My projects or discoverable projects | org member |
| Projects | POST | `/projects` | Create project draft (status=setup) | team member if team allows, else team:owner\|admin |
| Projects | GET | `/projects/{project_id}` | Project overview (members only; others get discoverable summary) | cap arena.read OR discoverable |
| Projects | PATCH | `/projects/{project_id}` | Update project | cap project.settings |
| Projects | PUT | `/projects/{project_id}/setup/roles` | Setup step: roles (template or custom) | project creator during setup |
| Projects | PUT | `/projects/{project_id}/setup/members` | Setup step: members and role assignment | project creator during setup |
| Projects | PUT | `/projects/{project_id}/setup/gates` | Setup step: stage gate policies | project creator during setup |
| Projects | PUT | `/projects/{project_id}/setup/agent` | Setup step: agent autonomy policy (capped by org ceiling) | project creator during setup |
| Projects | POST | `/projects/{project_id}/setup:validate` | Validate setup (≥1 owner, every approval gate staffed, distinct roles feasible) | project creator during setup |
| Projects | POST | `/projects/{project_id}/setup:complete` | Atomically create roles, members, gates, Arena, cycle #1 and provision the central agent session | project creator during setup |
| Projects | POST | `/projects/{project_id}:archive` | Archive (pauses loop and routines) | cap project.archive |
| Projects | POST | `/projects/{project_id}:restore` | Restore | cap project.archive |
| Projects | POST | `/projects/{project_id}:decommission` | Decommission: ends the SDLC loop permanently | cap project.archive |
| Roles & access | GET | `/projects/{project_id}/roles` | Project roles with capabilities | cap arena.read |
| Roles & access | POST | `/projects/{project_id}/roles` | Create custom role | cap role.manage |
| Roles & access | PATCH | `/projects/{project_id}/roles/{role_id}` | Rename / change capabilities (system roles: name only) | cap role.manage |
| Roles & access | DELETE | `/projects/{project_id}/roles/{role_id}` | Delete custom role (must not leave a gate unstaffed) | cap role.manage |
| Roles & access | GET | `/projects/{project_id}/members` | Members and their roles | cap arena.read |
| Roles & access | POST | `/projects/{project_id}/members` | Add members (respects member_limit, cross-unit policy, guest rules) | cap member.invite (+ role.manage to grant non-observer roles) |
| Roles & access | PATCH | `/projects/{project_id}/members/{user_id}` | Set a member's roles | cap role.manage |
| Roles & access | DELETE | `/projects/{project_id}/members/{user_id}` | Remove member (cannot remove last owner) | cap member.remove OR self (leave) |
| Roles & access | POST | `/projects/{project_id}/access-requests` | Request access to a discoverable project | org member (non-guest), project discoverable to them |
| Roles & access | GET | `/projects/{project_id}/access-requests` | Pending and past requests | cap access.approve |
| Roles & access | POST | `/access-requests/{request_id}:decide` | Approve with roles or reject | cap access.approve (+ role.manage for non-observer roles) |
| Roles & access | GET | `/projects/{project_id}/gates` | Stage gate policies | cap arena.read |
| Roles & access | PUT | `/projects/{project_id}/gates/{stage}` | Update one gate policy | cap project.settings |
| Roles & access | GET | `/projects/{project_id}/agent-policy` | Agent autonomy policy (effective, after org/unit ceiling) | cap arena.read |
| Roles & access | PUT | `/projects/{project_id}/agent-policy` | Change agent autonomy | cap agent.configure |
| Arena | GET | `/projects/{project_id}/arena` | Arena and central-agent session status | cap arena.read |
| Arena | GET | `/projects/{project_id}/arena/messages` | Arena messages (single stream, threads via parent_id) | cap arena.read |
| Arena | POST | `/projects/{project_id}/arena/messages` | Post; @central starts a turn; @user/@role notify | cap arena.post (+agent.invoke for @central, +arena.tag_roles for @role) |
| Arena | PATCH | `/messages/{message_id}` | Edit own message | author |
| Arena | DELETE | `/messages/{message_id}` | Delete own message (soft) | author OR cap project.settings (moderation) |
| Arena | POST | `/projects/{project_id}/arena/turns/{turn_id}:cancel` | Cancel an agent turn | turn requester OR cap project.settings |
| Routines | GET | `/projects/{project_id}/routines` | Routines | cap arena.read |
| Routines | POST | `/projects/{project_id}/routines` | Create routine (min interval 1 hour) | cap routine.manage |
| Routines | PATCH | `/routines/{routine_id}` | Edit / pause routine | cap routine.manage |
| Routines | DELETE | `/routines/{routine_id}` | Delete routine | cap routine.manage |
| Routines | POST | `/routines/{routine_id}:run-now` | Run once now | cap routine.manage |
| Private | GET | `/private/sessions` | My private sessions | owner |
| Private | POST | `/private/sessions` | New private session (optionally bound to a project at creation) | authenticated (+cap arena.read on bind_project_id) |
| Private | GET | `/private/sessions/{session_id}` | Session | owner |
| Private | PATCH | `/private/sessions/{session_id}` | Rename | owner |
| Private | DELETE | `/private/sessions/{session_id}` | Delete session (and its runtime session) | owner |
| Private | GET | `/private/sessions/{session_id}/messages` | Messages | owner |
| Private | POST | `/private/sessions/{session_id}/messages` | Send to personal agent (starts a turn) | owner |
| Private | POST | `/private/sessions/{session_id}:bind` | Bind to exactly one project (write-once) | owner + cap arena.read on project |
| Private | POST | `/private/sessions/{session_id}/bridge/pull-context` | Bring a read-only snapshot of the bound project's context | owner + cap arena.read on bound project |
| Artifacts | GET | `/artifacts` | List artifacts (scope=private: mine; scope=project: needs arena.read) | owner / cap arena.read |
| Artifacts | POST | `/artifacts` | Create artifact (private, or project draft) | owner / cap artifact.edit |
| Artifacts | GET | `/artifacts/{artifact_id}` | Artifact metadata | owner / cap arena.read |
| Artifacts | GET | `/artifacts/{artifact_id}/versions` | Versions | owner / cap arena.read |
| Artifacts | POST | `/artifacts/{artifact_id}/versions` | New version | owner / cap artifact.edit |
| Artifacts | GET | `/artifacts/{artifact_id}/versions/{version_no}/content` | Raw content | owner / cap arena.read (export needs artifact.export) |
| Artifacts | GET | `/artifacts/{artifact_id}/push-preview` | Preview Push to Arena | owner + cap artifact.push on project |
| Artifacts | POST | `/artifacts/{artifact_id}/push` | Push a private artifact version to an Arena (binds the source session) | owner + cap artifact.push (+stage.request_gate if request_gate) |
| Artifacts | POST | `/files` | Pre-signed upload URL | authenticated (+cap on target scope) |
| Artifacts | POST | `/files/{file_id}:complete` | Mark upload complete (virus scan follows) | uploader |
| Tasks | GET | `/projects/{project_id}/tasks` | Tasks | cap arena.read |
| Tasks | POST | `/projects/{project_id}/tasks` | Create task | cap task.create (+task.assign if assignee set) |
| Tasks | GET | `/tasks/{task_id}` | Task | cap arena.read |
| Tasks | PATCH | `/tasks/{task_id}` | Update task (completion only via :verify) | assignee OR cap task.assign |
| Tasks | POST | `/tasks/{task_id}:delegate` | Delegate to a person or a role | cap task.delegate |
| Tasks | POST | `/tasks/{task_id}:assign-agent` | Assign to the AI teammate (needs a human reviewer) | cap agent.assign_task + agent policy assigned_work ≠ off |
| Tasks | POST | `/tasks/{task_id}:verify` | Verify acceptance criteria; close when all verified (human only) | cap task.verify (not the agent; not self if reviewer rule) |
| SDLC loop | GET | `/projects/{project_id}/cycles` | Cycles | cap arena.read |
| SDLC loop | POST | `/projects/{project_id}/cycles` | Open next cycle from MAINTAIN (one active cycle at a time) | cap cycle.open |
| SDLC loop | GET | `/cycles/{cycle_id}` | Cycle detail: gates, artifacts, pending approval, transitions | cap arena.read |
| SDLC loop | POST | `/cycles/{cycle_id}/gate-requests` | Request the current stage's gate | cap stage.request_gate |
| SDLC loop | POST | `/cycles/{cycle_id}:send-back` | Send back to an earlier stage (reason required) | cap stage.approve.<current stage> |
| SDLC loop | GET | `/cycles/{cycle_id}/evidence` | Evidence (commits, PRs, CI, deployments, links) | cap arena.read |
| SDLC loop | POST | `/cycles/{cycle_id}/evidence` | Attach evidence link | cap artifact.edit |
| SDLC loop | POST | `/projects/{project_id}/repo:connect` | Link a GitHub repo (GitHub App installed by org admin) | cap project.settings |
| SDLC loop | GET | `/approvals` | Approvals I can vote on (mine=true) | authenticated |
| SDLC loop | GET | `/approvals/{approval_id}` | Approval | cap arena.read |
| SDLC loop | POST | `/approvals/{approval_id}/votes` | Vote (human only; SoD rules enforced) | cap stage.approve.<stage> (gate) / capability named in approval (agent action) |
| Messaging | GET | `/dms` | My DM threads | authenticated |
| Messaging | POST | `/dms` | Open or reuse a DM thread (guests: only with co-members) | org member |
| Messaging | GET | `/dms/{thread_id}/messages` | DM messages | participant |
| Messaging | POST | `/dms/{thread_id}/messages` | Send DM | participant |
| Notifications | GET | `/notifications` | Notifications (filter by type / requires_action) | authenticated |
| Notifications | PATCH | `/notifications/{notification_id}` | Mark read / resolved | recipient |
| Notifications | POST | `/notifications:mark-all-read` | Mark all read | authenticated |
| Notifications | GET | `/notification-prefs` | Delivery preferences per type | authenticated |
| Notifications | PUT | `/notification-prefs` | Update preferences | authenticated |
| Notifications | POST | `/realtime/token` | 5-minute WebSocket token | authenticated |
| Search | GET | `/search` | Permission-aware search (projects, messages, artifacts, tasks, people, my private sessions) | authenticated |
| Webhooks | POST | `/webhooks/workos` | WorkOS events (SCIM directory sync, connection changes); signature verified | public (signed) |
| Webhooks | POST | `/webhooks/github` | GitHub App events (push, PR, check runs) for evidence; HMAC verified | public (signed) |
