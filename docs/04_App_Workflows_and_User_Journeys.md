# 04 — App Workflows & User Journeys

> Build Pack v2.0 · How the product behaves end to end: who does what, what the system does, which notifications fire.
> Screens referenced are on the design canvas "Saras App UI" (doc 09).

---

## 4.1 End-to-end flow

![End-to-end journey](../diagrams/png/30_end_to_end_journey.png)

## 4.2 Journey A — Organization onboarding (Org Owner)

| # | User does | System does | Screen |
|---|---|---|---|
| 1 | Signs in with Google / Microsoft / SSO | WorkOS AuthKit; creates `users` row | Login |
| 2 | Creates org: name, address, preset (Startup / Enterprise) | `organizations` + `org_policies` from preset; user = Org Owner; personal agent identity; Private space | Onboarding step 2 |
| 3 | Uploads org knowledge (optional) | Files → S3 → indexing job → `knowledge_sources` ready; central agents use them | Onboarding step 3 |
| 4 | Invites people or connects SSO/SCIM (Enterprise) | Invites emailed; or WorkOS portal link; SCIM creates members and home units | Onboarding step 4 / Org settings |
| 5 | (Enterprise) builds the unit tree, assigns Unit Leads/Admins | `org_units`, `unit_role_assignments`; audit | Org structure |
| 6 | Lands on the Org dashboard | Empty state: "Teams create projects. You'll see their status here." | Org dashboard |

## 4.3 Journey B — Team and project setup (Team Owner → Project Owner)

![Project setup flow](../diagrams/png/21_project_setup_flow.png)

| # | User does | System does |
|---|---|---|
| 1 | Creates a team (if policy allows) and adds teammates | Team Owner role; members notified |
| 2 | Clicks **New project**: key, name, goal, discoverability | Project `status=setup` |
| 3 | Picks a role template (e.g. *Enterprise product squad*), renames roles, adds "Security champion", ticks capabilities | Roles kept in setup draft; Owner role always present |
| 4 | Assigns members to roles (many-to-many); adds a Stakeholder as Observer | Draft memberships |
| 5 | Configures gates: approver roles, min approvals, distinct roles, no-self-approval on DEPLOY, required artifacts; MAINTAIN cycle openers | Live validation (doc 02 F07 AC) |
| 6 | Sets agent autonomy (defaults from template, capped by org ceiling); enables starter routines (daily digest 09:30, gate nudge 24 h) | Draft policy and routines |
| 7 | Reviews and clicks **Create** | One transaction: roles, capabilities, members, gates, agent policy, routines, **Arena**, **cycle #1 at PLAN**. Then the runtime adapter provisions the **central agent session** (`org/{o}/project/{p}/arena`) |
| 8 | Arena opens | Central agent welcome message lists roles, gates and routines; members get a "you were added" notification |

## 4.4 Journey C — Daily collaboration in the Arena

| Action | Rule | Effect |
|---|---|---|
| Post a message | `arena.post` | Persisted → realtime to members → ambient batch to the agent (every 20 messages / 60 s) |
| Tag `@Karan` | `arena.post` | `tag` notification to Karan |
| Tag `@Backend dev` | `arena.tag_roles` | `tag` notification to every role holder |
| Ask `@central …` | `agent.invoke` | Turn (`mode=prompt`) → streamed answer with citations; steps visible in the drawer |
| Reply in thread | `arena.post` | `parent_id` set; thread counter updated |
| Attach a file | `arena.post` | Pre-signed upload → scan → attachment |
| Observer opens Arena | `arena.read` only | Read-only banner instead of composer |

## 4.5 Journey D — Private → Arena (the bridge)

![Session isolation](../diagrams/png/20_session_isolation.png)

1. In **Private**, the user brainstorms with the personal agent. Optionally, they **bring context** from one project they're a member of. This binds the session to that project for good.
2. The agent drafts `goal.md` (a private artifact).
3. The user clicks **Push to Arena** and sees a preview: destination (locked if bound), new vs new version, diff, "request PLAN gate", "notify members", and what will be shared ("only goal.md v3").
4. On confirm, the system:
   - creates the project artifact version with lineage;
   - binds the session if it wasn't bound;
   - writes a `bridge_events` audit row;
   - optionally creates the gate approval;
   - sends `artifact_push` notifications.
5. Trying to pull context from another project in the same session → `BRIDGE_SCOPE_MISMATCH`, with the hint "start a new session".

## 4.6 Journey E — SDLC loop and gates

![SDLC loop](../diagrams/png/19_sdlc_loop_v11.png)

| Step | Who | Rule | Effect |
|---|---|---|---|
| Request gate | Holder of `stage.request_gate` | Required artifact must have an approved or in-review version | `approval_requests` routed to approver roles; `approval_request` notifications; card in Arena |
| Vote | Holder of `stage.approve.<STAGE>` | Human only; no self-approval if set; reject needs reason | `approval_votes`; when `min_approvals` and `min_distinct_roles` are met → advance (row lock) |
| Advance | System | — | `stage_transitions` (append-only); `stage_update` notifications; deterministic stage summary; `progress.md` regenerated; system turn to the agent; evidence commit (if repo linked) |
| Send back | Approver | Reason required | Back to the chosen earlier stage |
| MAINTAIN | — | Product is operating | Cycle status `operating` |
| Open next cycle | Holder of `cycle.open` | No other active cycle | New cycle at PLAN with reason (feedback / bug / incident / enhancement) |
| Decommission | Holder of `project.archive` | Reason | Loop ends; routines stop; Arena read-only |

## 4.7 Journey F — AI teammate (AI as employee)

![AI teammate](../diagrams/png/28_ai_teammate_sequence.png)

Rules:
- Needs `agent.assign_task` and agent policy `assigned_work ≠ off`.
- A human reviewer (not the assigner if self-approval rules require it) must be named.
- The agent can create drafts, comment and move the task to *In review*. It can never verify or complete the task.

## 4.8 Journey G — Routines (AI as routine tasker)

![Routine sequence](../diagrams/png/27_routine_sequence.png)

| Template | Default schedule | What it posts |
|---|---|---|
| Daily digest | Weekdays 09:30 team timezone | Yesterday's decisions, artifact pushes, stage changes, blocked tasks, open gates |
| Standup collector | Weekdays 10:00 | Asks members for updates in-thread; compiles a summary at 12:00 |
| Gate nudge | Hourly check | Tags approvers of gates pending > N hours (default 24) |
| Weekly report | Fridays 16:00 | `progress.md` summary + next 3 actions |
| Custom | Any cron ≥ 1 h | Result of the team's prompt over the last window |

## 4.9 Journey H — Oversight and access (Unit Lead)

![Access request](../diagrams/png/29_access_request_flow.png)

## 4.10 Journey I — People lifecycle

| Event | Steps |
|---|---|
| Joiner | Invite or SCIM → org member → shows in directory → teams add them → projects add them with roles |
| Guest | Invite with expiry → added to specific projects only → warning 7 days before expiry → suspended |
| Mover | Home unit changes → dashboards follow → team owners notified to review memberships |
| Leaver | Offboard → sessions revoked → removed everywhere → owner-less projects flagged → Private deleted after retention |

## 4.11 State machines (implementation reference)

| Entity | States and transitions |
|---|---|
| Org membership | `invited → active → suspended → active` · `active → deprovisioned` (terminal) |
| Project | `setup → active ⇄ archived` · `active → decommissioned` (terminal) |
| Cycle | `active` (stage PLAN…DEPLOY) → `operating` (MAINTAIN) → `closed`; `active → abandoned` |
| Approval | `pending → approved / rejected / expired / cancelled` |
| Task | `backlog → ready → in_progress → in_review → completed` (verify only); `blocked` (reason) ⇄ previous; `cancelled` |
| Private session | `unbound → bound(project)` (write-once) → `archived` |
| Agent session | `provisioning → ready ⇄ degraded → archived / failed` |
| Turn | `queued → running → (awaiting_approval) → completed / failed / cancelled` |
| Routine run | `queued → running → posted / skipped / failed / awaiting_approval` |
| Access request | `pending → approved / rejected / cancelled` |
| Invite | `pending → accepted / revoked / expired` |

## 4.12 Notification matrix

| Type | Trigger | Recipients | Needs action |
|---|---|---|---|
| `artifact_push` | Push / new version in Arena | Project members (or `notify_role_ids`) | No |
| `stage_update` | Gate requested, passed, sent back; cycle opened | Project members | No |
| `approval_request` | Gate requested; agent action needs approval | Holders of the capability | Yes |
| `delegation` | Task delegated to person or role | Delegatee(s) | Yes |
| `assignment` | AI-teammate task ready for review | Reviewer | Yes |
| `tag` | `@person` / `@role` | Tagged users | No |
| `dm` | Direct message | Participants | No |
| `access_request` | Request to join a project | Holders of `access.approve` | Yes |
| `routine` | Routine failed or awaits approval | Holders of `routine.manage` | Sometimes |
| `system` | Guest expiry warning, member moved units, owner-less project | Owners / admins | Sometimes |
