# 03 — Organization Hierarchy & Role-Based Access Control

> Build Pack v2.0 · Owner: Tech lead · Status: **Approved for implementation** · Supersedes: v1.0 doc 03 §3.4 and v1.1 plan §2.1–2.2
> Contracts: `contracts/schema_v2.sql` (tables, RLS), `contracts/openapi_v2.yaml` (`x-required-permission` on every operation)

---

## 3.1 Design stance

ParallelFlow is **controlled by the teams that use it**. The organization provides identity, policy and oversight. Teams decide how they work: how many people they have, which roles exist, who approves what, and how much the AI is allowed to do.

Three rules follow from that stance and drive every permission decision:

1. **Permissions follow responsibility on the work, not seniority in the company.** A Director is not automatically an approver on a project. A junior engineer can be the approver for BUILD if the team says so. Job level is profile metadata. It never grants access.
2. **Oversight is not access.** People higher in the hierarchy (unit leads, org admins) see *status* (stages, progress, blockers, gate wait times) for their part of the organization. They see *content* (Arena messages, artifacts, tasks) only if they are members of that project, at least as Observers.
3. **AI never exceeds the humans it works for.** An agent's effective permission is the intersection of: what the project lets the agent do, what the human it acts for may do, and platform invariants (humans approve gates, push from Private, and manage membership).

## 3.2 How an MNC is organized, and how ParallelFlow maps it

![MNC hierarchy mapping](../diagrams/png/24_org_hierarchy_mapping.png)

| Real-world MNC layer | Typical people | ParallelFlow construct | What it is used for |
|---|---|---|---|
| Group / company (legal entity, region) | CEO, CXOs | **Organization** (tenant) | Identity, SSO/SCIM, org policies, billing, audit, org-wide knowledge for the central agent |
| Business unit / division | VP, BU head | **Org unit** (level 1) | Portfolio dashboard scope, policy overrides (allowed models, cross-unit invites), team grouping |
| Department / function (Engineering, Product, Design, SRE, Security) | Director, Head of | **Org unit** (level 2–3) | Same as above, narrower scope |
| Group / tribe | Senior manager | **Org unit** (level 3–5, optional) | Same |
| Team / squad (5–12 people, cross-functional) | Engineering manager, PM, engineers, QA, designer | **Team** | Self-governed group that owns projects. Team owners and admins manage it |
| Product / initiative / program | The people doing the work, plus stakeholders | **Project** with exactly one **Arena** | Collaboration, SDLC loop, artifacts, AI teammate. All content lives here |
| Cross-team program | Program manager + members of several teams | **Project** owned by one team, with members invited from other teams or units | Matrix collaboration without restructuring teams |
| Contractors, vendors, auditors | External people | **Guest** org members (time-bound) and/or project **Observers** | Least-privilege, expiring access to specific projects only |
| Individual | Everyone | **Private space** (global, owner-only) | Personal AI work. Crosses into Arenas only through the bridge |

Org units are **optional**. A 20-person startup uses Organization → Teams → Projects. An MNC can model up to **5 unit levels** with its own level names (e.g. "Business unit → Department → Group"). Units are synced from the IdP via SCIM groups or edited by org admins.

**Matrix organizations.** People have one *home unit* (from HR/IdP) but can be members of any number of teams and projects. Project membership never depends on reporting lines. This supports functional reporting (e.g. QA department) alongside product squads.

## 3.3 Four permission planes

![Permission planes](../diagrams/png/25_permission_evaluation_v2.png)

### Plane 1 — Organization roles (system-defined, fixed)

| Org role | Who in an MNC | Can | Cannot |
|---|---|---|---|
| **Org Owner** (≥1) | Founder, CIO, platform owner | Everything an Org Admin can, plus: transfer ownership, delete the org, manage billing owners | — |
| **Org Admin** | IT / engineering-productivity / PMO admin | Members, invites, guests, org units, unit role assignments, SSO/SCIM, org policies, integrations, org knowledge, full-org dashboard (metadata) | Read Arena content of projects they are not members of; act inside a team's project settings |
| **Security & Compliance Admin** | CISO office, GRC | Audit log + export, retention settings, security policies (SSO required, guest expiry, allowed model classes, data region), full-org dashboard (metadata) | Manage members or teams; read Arena content |
| **Billing Admin** | Finance | Plan, invoices, seat counts, agent-usage budgets | Anything else |
| **Member** (default) | Every employee | Use Private space; create teams (if policy allows); join projects by invite or access request; see the org directory | Org settings |
| **Guest** | Contractors, vendors, external auditors | Only the projects they are explicitly added to; Private space | See the org directory beyond co-members, create teams, be added as project owner. Access **expires** (default 90 days, policy-controlled) |

A user holds exactly one org role. Org Owner ⊃ Org Admin. Security and Billing admin are separate (separation of duties).

### Plane 2 — Unit roles (scoped to a subtree of org units)

| Unit role | Who | Can (within the unit and its descendants) |
|---|---|---|
| **Unit Lead** | VP, Director, Head of | Portfolio dashboard for the subtree (projects, stages, progress, blockers, gate wait times, agent usage); approve team creation in the unit (if the org requires it); assign Unit Admins |
| **Unit Admin** | Ops lead, PMO, chief of staff | Create teams in the unit, move teams between child units, manage team ownership when an owner leaves, view the subtree dashboard |

Unit roles **never** grant Arena content access. A Unit Lead who needs content asks to join a project (as Observer or a working role). The project owner decides.

### Plane 3 — Team roles (system-defined, simple)

| Team role | Can |
|---|---|
| **Team Owner** (≥1) | Everything a Team Admin can + delete/archive the team, transfer ownership |
| **Team Admin** | Add/remove team members; create projects; set team defaults (preferred role templates, default gate policies, default agent autonomy) |
| **Team Member** | Be added to the team's projects; create projects if the team allows it (default: on) |

Team size is unlimited by design. Plans may cap seats, not team structure.

### Plane 4 — Project roles (the USP: team-defined)

Every project has two **system roles** plus any number of **custom roles**:

| Role | Kind | Capabilities |
|---|---|---|
| **Project Owner** | System, ≥1 required, not deletable | All project capabilities |
| **Observer** | System, optional | `arena.read`, `artifact.export`. For stakeholders, execs, auditors. Cannot post, push, approve or invoke agents |
| *Custom roles* | Created by the team (from templates or blank) | Any subset of the capability catalogue (§3.4) |

A member can hold several roles. Their capabilities are the union of those roles.

**Membership size is fully flexible.** A project can have 1 person or 200. The plan's soft limit is 200 members per project in MVP, configurable per org. Stage gates require approvers only for stages the team enables.

## 3.4 Project capability catalogue (enforced by the system)

| Group | Capability | Meaning | Risk |
|---|---|---|---|
| Arena | `arena.read` | Read messages, artifacts, tasks, loop state | low |
| | `arena.post` | Post, reply, tag people | low |
| | `arena.tag_roles` | Tag a whole role (`@Backend dev`), which notifies every holder | low |
| AI | `agent.invoke` | Ask `@central` in the Arena | low |
| | `agent.assign_task` | Assign a task to the AI teammate | medium |
| | `agent.configure` | Change the project's agent autonomy policy | high |
| | `routine.manage` | Create, edit, pause and run routines | medium |
| Artifacts | `artifact.push` | Push from Private into this Arena | low |
| | `artifact.edit` | Create new versions of project artifacts | low |
| | `artifact.export` | Download artifacts / progress.md | low |
| Tasks | `task.create` | Create tasks | low |
| | `task.assign` | Assign or reassign tasks to people | low |
| | `task.delegate` | Delegate to a person or a whole role (sends a delegation notification) | low |
| | `task.verify` | Mark acceptance criteria verified and close tasks | medium |
| Loop | `stage.request_gate` | Ask approvers to move the cycle forward | low |
| | `stage.approve.PLAN` … `stage.approve.DEPLOY` | Vote on that stage's gate (5 capabilities) | medium / high (DEPLOY) |
| | `cycle.open` | Open the next cycle from MAINTAIN | medium |
| People | `member.invite` | Add members (and Observers) | high |
| | `member.remove` | Remove members | high |
| | `role.manage` | Create, edit and delete custom roles; assign roles | high |
| | `access.approve` | Approve access requests | high |
| Project | `project.settings` | Name, goal, discoverability, gate policies, repo link | high |
| | `project.archive` | Archive, restore, decommission | high |

There are 27 capabilities. The catalogue is fixed in code and seeded into `capabilities`. New capabilities ship with migrations and default to **off** for existing custom roles.

## 3.5 Role templates for MNC and startup teams

Templates are starting points. Every field is editable during setup and later by anyone with `role.manage`.

| Template | Roles created (★ = Project Owner) | Default gate approvers |
|---|---|---|
| **Enterprise product squad** | ★ Engineering Manager, Product Manager, Tech Lead, Software Engineer, QA Engineer, Designer, SRE, Security Champion, Stakeholder (Observer) | PLAN: PM · DESIGN: Tech Lead + PM (2) · BUILD: Tech Lead · TEST: QA Engineer · DEPLOY: Engineering Manager + SRE (2, no self-approval) |
| **Platform / infrastructure** | ★ Platform Lead, Platform Engineer, SRE, Security Champion, Consumer team rep (Observer) | PLAN/DESIGN: Platform Lead · BUILD: Platform Engineer · TEST: SRE · DEPLOY: Platform Lead + Security Champion |
| **Cross-team program** | ★ Program Manager, Workstream Lead, Architect, Engineer, Stakeholder (Observer) | PLAN: Program Manager · DESIGN: Architect · BUILD: Workstream Lead · TEST: Workstream Lead · DEPLOY: Program Manager |
| **Frontend / Backend split** | ★ Lead, Frontend dev, Backend dev, Designer | DESIGN: Lead + Designer · BUILD: FE + BE · TEST/DEPLOY: Lead |
| **Lean squad** | ★ Owner, Builder | PLAN/DESIGN/DEPLOY: Owner · BUILD/TEST: Builder |
| **Research / prototype** | ★ Lead, Researcher | All gates: Lead; TEST: skip |
| **Blank** | ★ Owner only | Must configure every enabled gate |

**Default capabilities per template role:** the matrix in `contracts/role_templates_v2.json` (generated from the same source the API serves at `GET /v1/role-templates`).

## 3.6 Agent plane: what the AI teammate may do

The **central agent** (one session per project Arena) and each **personal agent** (Private) act inside permissions. Every project has an **agent autonomy policy**, set at setup and editable with `agent.configure`:

| Capability class | Off | Suggest | Act with approval | Act |
|---|---|---|---|---|
| Answer and summarise (knowledge base, brainstormer) | | | | **default** |
| Post in the Arena (replies, digests, routine output) | | | | **default** |
| Draft artifacts (new draft versions only) | | | | **default** |
| Create / update tasks | | **default** | | |
| Request a stage gate | | | **default** | |
| Work on assigned tasks (AI employee) | | | **default** (output goes to review) | |
| Tag / notify people | | | | **default** |

- **Suggest** = the agent proposes; a human clicks to apply.
- **Act with approval** = the agent's action creates an approval card routed to holders of the relevant capability.
- **Act** = allowed directly, but only where the human the agent acts for could do the same.

**Never allowed for any agent (platform invariants):**
- approve or vote on gates;
- verify/close a task it worked on;
- invite, remove or change roles of members;
- push from someone's Private space;
- change agent policy;
- archive projects;
- read projects outside its session scope.

**Org ceiling:** org policy `agent_max_autonomy` (Security admin) caps every project. For example, a regulated BU may set "Act with approval" as the maximum.

## 3.7 The five AI roles and where each lives

![AI roles](../diagrams/png/26_ai_roles_map.png)

| AI role (product language) | What it does | Surface | Permission path |
|---|---|---|---|
| **Knowledge base** | Answers questions grounded in the Arena, artifacts, tasks and org knowledge, with citations | `@central` in Arena; Private with bound context | `agent.invoke`; retrieval limited to session scope |
| **Brainstormer** | Explores ideas, drafts goal.md / options, challenges assumptions | Private sessions (personal agent); Arena threads | Private: owner only; Arena: `agent.invoke` |
| **Employee (AI teammate)** | Takes an assigned task, produces drafts and updates, moves the task to *In review*; a human verifies | Task panel "Assign to AI teammate" | `agent.assign_task`, autonomy "Work on assigned tasks" |
| **Agent** | Uses tools (App Tools now, repo / CI tools via Tau later) to complete multi-step work | Arena and Private | Autonomy policy ∩ invariants |
| **Routine tasker** | Runs scheduled routines: daily digest, standup collection, gate nudges, weekly progress report, custom prompts | Project → Routines | `routine.manage`; output posts as the central agent |

**Role extensions (coming soon, doc 02 F22).** A member can extend their own personal agent with a role extension from the marketplace (e.g. *Product Manager*), and switch it off at any time. Extensions add skills, never access: the personal agent still acts only on the member's behalf and within the same capabilities and autonomy policy. The central agent is not extended this way.

## 3.8 Permission evaluation (exact algorithm)

```
can(principal, action, resource):
  0. Tenant: resource.org_id == principal.org_id                       else DENY (also enforced by Postgres RLS)
  1. Org policy denies (guest restrictions, SSO required, expiry)      → DENY
  2. Platform invariant (human-only action and principal is agent)     → DENY
  3. Plane by resource:
     org settings/members/units/policies → org role table (§3.3 P1)
     unit dashboard/teams-in-unit        → unit role on unit or any ancestor (P2) OR org admin/security admin
     team settings/members               → team role (P3) OR unit admin of team's unit OR org admin (membership only)
     project content and actions         → project membership required, then capability ∈ ∪(member's roles) (P4)
     private resources                   → owner only (no override for any role)
  4. If principal is an agent:
       require human_on_behalf_of passes step 3 for the same action
       require project agent policy class ≥ needed autonomy (Suggest → draft only; Approval → create approval)
       require org agent_max_autonomy ≥ that autonomy
  5. Gate votes: if policy.forbid_self_approval and voter == requester → DENY
  6. ALLOW → audit if action.risk ≥ medium
```

Implementation:
- `packages/authz` is a pure function library: (principal, action, resource, facts) → decision + reason.
- **Facts** (memberships, roles, capabilities, policies) are loaded per request and cached in Redis keyed by `membership_version`.
- The **database** adds RLS for tenant isolation, Private ownership and Arena-membership visibility. It also checks the `arena.post` capability on message insert (`schema_v2.sql`), so a missing app check cannot leak or write data.

## 3.9 Access lifecycle (joiner, mover, leaver, guest)

| Event | Source | What ParallelFlow does |
|---|---|---|
| **Joiner** | SCIM user created / invite accepted | Org membership (role Member, home unit from IdP group), personal agent identity, Private space. No project access until added or approved |
| **Mover** (changes unit/team) | SCIM group change / admin | Home unit updated → dashboards follow. Team and project memberships are **not** removed automatically. Team owners get a "member moved units" notice to decide |
| **Leaver** | SCIM deprovision / admin offboard | Sessions and tokens revoked within 60 s. Removed from teams and projects. Owned projects without another owner are flagged to the team admin (Unit Admin fallback). **Private content is retained per policy (default 30 days), then deleted.** Never transferred without a two-admin export request (post-MVP) |
| **Guest expiry** | Scheduled job | Access suspended at `expires_at`. Project owners notified 7 days before |
| **Access request** | Member finds a discoverable project | Request with reason → holders of `access.approve` decide and pick role(s) → requester notified |

Project **discoverability:**
- `hidden` (invite only — default for Security-tagged projects);
- `team` (visible to the owning team);
- `org` (listed in the org directory, requestable).

## 3.10 Separation of duties and enterprise controls (MVP)

| Control | Setting | Default |
|---|---|---|
| No self-approval of gates | Per stage (`forbid_self_approval`) | ON for DEPLOY, OFF otherwise |
| Minimum approvals | Per stage | 1 (2 for DEPLOY in enterprise templates) |
| Distinct roles for approval | `min_distinct_roles` per stage | 1 |
| Guest expiry | Org policy | 90 days |
| Cross-unit project membership | Org policy | Allowed |
| Member team creation | Org policy | Allowed (MNC preset: Unit Admins only) |
| Agent autonomy ceiling | Org policy | Act |
| SSO required | Org policy | Off for startups / On for MNC preset |
| Data region | Org setting at creation | ap-south-1 (MVP only region) |

**Org presets at onboarding:**
- **Startup** (flat, permissive).
- **Enterprise** (units on, SSO required, team creation by Unit Admins, DEPLOY needs 2 approvals with no self-approval, guests expire in 30 days, agent ceiling "Act with approval").

Admins can change any setting afterwards.

## 3.11 Worked examples

1. **VP of Payments (Unit Lead) asks: "How is the refunds revamp going?"** The VP sees the Payments subtree dashboard: REF is in Cycle 3 · BUILD, 54%, two tasks blocked, the DESIGN gate took 2 days. The VP has no Arena access. They click *Request access → Observer*. The project owner approves. The VP can now read the Arena, but cannot post or approve.
2. **Contractor joins for 6 weeks.** The Org Admin invites them as Guest (expires in 42 days). The team adds them to project PAY with the custom role "Frontend dev". They see only PAY. Access is suspended automatically on day 42.
3. **Junior engineer approves BUILD.** The team's custom role "Builder" holds `stage.approve.BUILD`. Seniority is irrelevant, as long as the role holder is not the requester when `forbid_self_approval` is on.
4. **AI teammate assigned "Draft API spec for refunds."** The agent acts on behalf of the assigner. It reads goal.md and Arena context, then writes `spec.md` as a draft and moves the task to *In review*. It cannot mark the task done. Someone with `task.verify` checks the acceptance criteria and closes it.
5. **Security admin sets agent ceiling to "Act with approval" for the Healthcare BU.** Every project in that subtree now gets approval cards for actions that were "Act", such as posting routine output.
