# 02 — Product Requirements (PRD)

> Build Pack v2.0 · Owner: Product · Status: **Frozen for MVP** (changes via decision log, doc 13)
> Stories with acceptance criteria and estimates: `ParallelFlow_MVP_Backlog_v2.xlsx` (77 stories, 365 points). Feature IDs (F01–F21) match epic codes there.

---

## 2.1 Goals for the MVP

1. A team can set up a project **with its own roles and approval rules** in under 10 minutes.
2. The team collaborates in **one Arena per project** with a central AI agent that has the whole project's context.
3. Individuals keep their **Private space** and move results into the Arena through the **bridge**, without exposing private conversations.
4. Work moves through a **repeating SDLC loop** with human gates and stage artifacts.
5. AI acts as **knowledge base, brainstormer, employee, agent and routine tasker** within team-set autonomy.
6. An MNC can adopt it safely: **org hierarchy, org roles, SSO, guests, dashboards without content access, audit**.

## 2.2 Non-goals for the MVP

| Not in MVP | Why / when |
|---|---|
| Voice input | Scope; post-MVP |
| Developer mode | Depends on Tau extension model; post-MVP |
| Role extension marketplace (F22) | Coming soon, right after the MVP; see F22 |
| Multiple channels inside an Arena | Single Arena by design |
| Parallel development cycles per project | One active cycle, others operating; post-MVP |
| Agents posting as a person ("reply on my behalf") | Trust model needs usage data; post-MVP |
| Code execution in sandboxes, automated PR review and deploys | Tau runtime phase (post-MVP P7) |
| Monitoring-triggered cycles (alerts → new cycle) | Post-MVP P8 |
| Mobile apps, Slack/Teams integrations, email replies | Post-MVP |
| Multiple data regions, BYO model keys, BYO runtime | Enterprise phase |

## 2.3 Personas

| Persona | Typical title | Main jobs in ParallelFlow |
|---|---|---|
| **Org Owner / Admin** | Founder, CIO office, eng-productivity lead | Create org, connect SSO, structure units, set policies, upload org knowledge |
| **Security & Compliance Admin** | CISO office | Set guest/SSO/agent-ceiling policies, audit, exports |
| **Unit Lead** | VP, Director | Watch portfolio status, request access when needed |
| **Team Owner / Admin** | Engineering manager, team lead | Create teams and projects, manage people |
| **Project Owner** | EM, PM, program manager | Run setup (roles, gates, autonomy, routines), manage access |
| **Contributor** | Engineer, designer, QA, PM, SRE | Private work, Arena collaboration, tasks, push artifacts, vote on gates their role owns |
| **Observer** | Stakeholder, auditor, exec | Read-only Arena |
| **Guest** | Contractor, vendor | Contributor in specific projects, time-bound |

## 2.4 Feature specifications

Each feature lists scope, key rules and acceptance criteria (AC). "Must" = MVP launch blocker.

### F01 Authentication & SSO — Must
- **Scope:** WorkOS AuthKit login (Google, Microsoft, email magic link); enterprise SAML/OIDC via WorkOS admin portal; session management; logout everywhere on offboarding.
- **AC:**
  - Login → callback → session cookie (HttpOnly, Secure, SameSite=Lax).
  - When `require_sso` is set, non-SSO login for that org's domain is refused with a clear message.
  - Offboarding revokes all sessions within 60 s.

### F02 Organization, presets & policies — Must
- **Scope:**
  - Create org (Startup / Enterprise preset).
  - Org profile.
  - Org policies (doc 03 §3.10).
  - Org knowledge upload (principles, guidelines, ways of working, moat) for the central agent.
- **AC:**
  - Creator is Org Owner.
  - Presets fill `org_policies`.
  - Security fields are editable only by Owner / Security admin.
  - Every change is audited.

### F03 Org hierarchy & unit roles — Must
- **Scope:** units tree (≤5 levels, custom level names); Unit Lead and Unit Admin assignments; move teams between units.
- **AC:**
  - A move that would create a cycle is rejected.
  - Units can be deleted only when empty.
  - Unit roles apply to the whole subtree.

### F04 Members, invites, guests, offboarding — Must
- **Scope:**
  - Invites (org, team, project).
  - Directory with search.
  - Org role changes.
  - Guests with expiry.
  - Offboarding.
  - SCIM sync (P1 within MVP window).
- **AC:**
  - Guests must have `guest_access_until`, see only co-members, and are suspended at expiry (warned 7 days before).
  - Offboarding removes team and project memberships.
  - Owner-less projects are flagged.
  - Private content is deleted after the retention period.

### F05 Teams — Must
- **Scope:** create team (per policy), team roles (Owner / Admin / Member), unit assignment, team page, team defaults (template, project creation permission).
- **AC:**
  - Every team keeps ≥1 owner.
  - Team creation is blocked when policy forbids it, with a message naming who can create teams.

### F06 Org & unit dashboards — Must
- **Scope:**
  - KPI tiles.
  - Project table (team, cycle, stage, loop pips, progress, members, attention).
  - Stage distribution.
  - Filters by unit and team.
- **AC:**
  - Responses contain **no** message, artifact or task content (contract test).
  - A Unit Lead sees only their subtree.
  - Loads in < 500 ms for 500 projects.

### F07 Project setup wizard — Must (USP)
- **Steps:**
  1. Basics.
  2. Members.
  3. Roles (7 templates or blank; edit names and capabilities).
  4. Assign members to roles.
  5. Stage gates (mode, approver roles, min approvals, distinct roles, no-self-approval, required artifact; MAINTAIN cycle openers).
  6. Agent autonomy and starter routines.
  7. Review and create.
- **AC:**
  - Validation blocks create when:
    - there is no owner;
    - an approval gate has no staffed role;
    - `min_distinct_roles` is greater than the number of staffed approver roles;
    - autonomy is above the org ceiling.
  - Create is atomic.
  - The Arena opens with a central-agent welcome that lists roles and gates.

### F08 Project roles, members & access — Must
- **Scope:**
  - Manage members, roles and custom roles after setup.
  - Observer role.
  - Discoverability (hidden / team / org).
  - Access requests.
  - Agent autonomy settings.
- **AC:**
  - A role cannot be deleted if a gate would become unstaffed.
  - The last owner cannot be removed.
  - Observers cannot post (UI and database).
  - Member limit is enforced.
  - Cross-unit additions respect org policy.

### F09 Arena — Must
- **Scope:**
  - One Arena per project.
  - Single message stream with threads (replies).
  - `@person`, `@role`, `@central` tags.
  - Attachments, artifact references.
  - Realtime presence, typing and streaming.
  - Loop strip, approval cards, right panel (overview, tasks, artifacts, members).
- **AC:**
  - Messages arrive to all online members p95 < 300 ms.
  - `@role` notifies every holder (requires `arena.tag_roles`).
  - Agent and event messages are visually distinct.

### F10 Central agent (knowledge base & agent) — Must
- **Scope:**
  - One runtime session per Arena, created at setup.
  - `@central` turns with streaming, citations and a step drawer.
  - Ambient messages batched as observations.
  - System notices on stage changes.
- **AC:**
  - The agent only reads its own project, verified by the canary suite.
  - Failures show "agent unavailable"; human chat keeps working.

### F11 Routines (routine tasker) — Must
- **Scope:**
  - Templates: daily digest, standup collector, gate nudge (pending > N hours), weekly progress report, custom prompt.
  - Cron scheduling (≥1 h), timezone, pause, run now, last-run status.
- **AC:**
  - Exactly one run per schedule slot.
  - Output posts to the Arena as the central agent and respects the `post` autonomy level.
  - When the runtime is down, digest and nudge fall back to deterministic templates.

### F12 Private space & personal agent — Must
- **Scope:** Private home, sessions, recent list, search own sessions, model class selector, attachments, artifacts library, dock on every screen.
- **AC:**
  - No other user, admin or agent session can read Private content (verified by RLS tests).
  - Sessions show their project binding when bound.

### F13 Bridge & Push to Arena — Must
- **Scope:**
  - Bind a session to one project (write-once).
  - Pull a read-only context snapshot.
  - Push an artifact version with preview: new vs new version, attach to the active cycle, request gate, notify.
- **AC:**
  - A push never copies the session.
  - Lineage is recorded.
  - The source session binds on first push.
  - Pulling context from a different project returns `BRIDGE_SCOPE_MISMATCH`.

### F14 Artifacts — Must
- **Scope:**
  - Versioned markdown and uploaded files.
  - Statuses (draft, in_review, approved, superseded).
  - Diff, export.
  - Stage artifacts per cycle.
- **AC:**
  - Content is deduplicated by sha256.
  - One approved version per artifact.
  - Export requires `artifact.export`.

### F15 Tasks, delegation & AI teammate — Must
- **Scope:**
  - Tasks with weight, acceptance criteria and dependencies.
  - Delegate to a person or role.
  - Assign to the AI teammate with a required human reviewer.
  - Verify to complete.
- **AC:**
  - Only humans with `task.verify` complete tasks (DB check).
  - AI-teammate tasks move at most to *In review*.
  - Progress % uses the weighted formula.

### F16 SDLC loop — Must
- **Scope:**
  - Cycles (one active, others operating).
  - Stages PLAN → MAINTAIN.
  - Gate requests, votes with separation-of-duties, send-back with reason, decommission.
  - Evidence (GitHub commit of approved stage artifacts, PR/CI/deploy links).
  - `progress.md`.
- **AC:**
  - No double advance under concurrent votes.
  - The required artifact must be approved before the gate can pass.
  - Every transition is append-only with actor and reason.

### F17 Notifications & DMs — Must
- **Types:** artifact push, stage update, delegation, tag, DM, approval request, access request, assignment, routine.
- **Scope:** inbox with filters, "needs action", preferences, realtime toasts; DMs 1:1 and small groups. Email digest is P1.
- **AC:**
  - Every notification deep-links to its source.
  - Nobody is notified about a project they can't read.

### F18 Search — Must
- **Scope:** projects, messages, artifacts, tasks, people, own private sessions.
- **AC:** results are ACL-filtered in SQL; p95 < 400 ms.

### F19 Audit & compliance — Must
- **Scope:** append-only, hash-chained audit log of medium- and high-risk actions; browse; export.
- **AC:** every RBAC change, gate vote, push, access decision, policy change and offboarding is audited.

### F20 Runtime integration — Must
- **Scope:**
  - Runtime adapter (RIC v0.2).
  - App Tools MCP server (20 tools).
  - Stub runtime (scripted and thin-LLM).
  - Canary isolation suite.
  - Tau swap.
  - Usage and budgets.
- **AC:**
  - Conformance ≥95% and canary 100% on the GA runtime.
  - Budgets enforced with alerts at 80% and 100%.

### F21 Platform foundations — Must
- **Scope:** infrastructure, CI/CD, migrations, observability, design system, feature flags, analytics.
- **AC:** see doc 11 Definition of Done.

### F22 Role extensions for the personal agent — Coming soon
Every member's Private space is personal: their personal agent can be extended with the skills of the role they play. A person assigned *Product Manager* in an arena installs the **Product Manager** extension from the platform's **marketplace**, and their personal agent gains PM capabilities (writing PRDs and user stories, prioritising with RICE, planning roadmaps). They can switch it off whenever it isn't needed.
- **Scope:**
  - A **marketplace** in the platform listing **role extensions** (e.g. Product Manager, Designer, Frontend dev, Backend dev, QA, Security champion).
  - An extension is a role pack: skills, prompts, document templates and, where needed, connectors. It adds capabilities to the personal agent; it is not a separate agent (ADR-006).
  - **Anyone** can install any extension. The extensions matching the member's arena roles are shown first as **"Suggested for your role"**.
  - Install, **enable / disable** and uninstall from the marketplace and from Private settings. Several extensions can be active at once.
  - The Private composer shows which extensions are active (e.g. "Your AI · + Product Manager").
- **AC:**
  - An extension only changes the installing member's personal agent in Private. The arena's central agent and other members' agents are unaffected.
  - An extension never grants permissions: what the agent may read or do still follows the member's role capabilities and autonomy policy (doc 03 §3.6–3.8).
  - Disabling an extension takes effect on the member's next message; nothing from it stays loaded.
  - Installs, enables and disables are recorded in the member's activity (no content).

## 2.5 Non-functional requirements

| Area | Requirement |
|---|---|
| Availability | 99.9% monthly for API and realtime (agent features depend on runtime and model providers; degrade gracefully) |
| Latency | API p95 < 250 ms reads / 500 ms writes; Arena fan-out p95 < 300 ms; agent first event p95 < 3 s |
| Scale (MVP year 1) | 100 orgs, 5,000 users, 2,000 projects, 200k messages/day |
| Security | Tenant isolation (RLS), Private isolation, project isolation for agents, SSO, audit (doc 10) |
| Accessibility | WCAG 2.1 AA |
| Browsers | Latest 2 versions of Chrome, Edge, Safari, Firefox; responsive down to 390 px width for reading and approving |
| Data | Region ap-south-1; RPO ≤ 5 min, RTO ≤ 1 h |
| Cost | Model spend metered per project, capped by org budgets |

## 2.6 Analytics events (PostHog)

`org_created`, `team_created`, `project_setup_started`, `project_setup_completed` (template, roles_count, custom_roles_count), `arena_message_posted` (is_agent), `central_invoked`, `private_session_started`, `artifact_pushed`, `gate_requested`, `gate_decided`, `cycle_opened`, `task_assigned_to_agent`, `task_verified`, `routine_created`, `routine_run_posted`, `access_requested`, `dashboard_viewed`.

Rules:
- Events carry ids only.
- No message or artifact text.
- No email addresses.
