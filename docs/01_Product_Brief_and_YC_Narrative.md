# 01 — Product Brief & YC Narrative

> Build Pack v2.0 · Owner: Founders · Use: YC application, investor conversations, onboarding new hires
> Facts not yet known are left as **[placeholders]**. Fill them in; do not invent numbers.

---

## 1.1 One-liner

**Saras is the shared workspace where software teams and AI work together across the entire development cycle.** Today people use AI alone, in private chats. Saras moves that work into a space the whole team shares.

Alternatives for the application form:
- "Multiplayer AI for software teams: one shared space per project where humans and an AI teammate plan, build and ship together."
- "We turn private AI chats into a team's shared, governed AI teammate across the full SDLC."

## 1.2 The problem

1. **AI use at work is private and fragmented.** Every engineer, PM and designer has their own assistant. Ideas, specs and decisions live in individual chat histories. The team doesn't see them, can't build on them, and can't trust where they came from.
2. **The work AI helps with is collaborative.** Requirements, design, implementation, review, release and operations need handoffs, approvals and shared context. Today those happen in a different set of tools than the AI.
3. **Companies can't let AI loose on team work without control.** Large organizations need roles, approvals, audit and isolation between projects before AI can act on shared work. Most AI tools are built for one person, not for a team with structure.

## 1.3 The solution

| Saras surface | What it gives the team |
|---|---|
| **Private space** (per person, available everywhere) | Your own AI workspace: brainstorm, draft, research. Private by default |
| **Bridge** | Push the useful result (a goal, spec or plan) into your team's Arena in one click, with preview. The private conversation is never shared |
| **Arena** (one per project) | The team's shared space: humans plus a central AI agent in **one continuous session** that knows the project |
| **Team-defined roles** | Each team creates the roles it actually has (Frontend dev, Architect, Security champion…) and decides who approves each stage. No fixed org chart is imposed |
| **SDLC loop** | PLAN → DESIGN → BUILD → TEST → DEPLOY → MAINTAIN → next cycle, with stage artifacts and human approval gates. It runs for as long as the product is operated |
| **AI in five roles** | Knowledge base, brainstormer, employee (works assigned tasks), agent (uses tools), routine tasker (digests, standups, nudges). All of it governed by the team's autonomy settings |
| **Organization oversight** | Leaders see status across teams (stages, progress, blockers) without reading team conversations |

## 1.4 Why now

- Teams already use AI daily for individual work. The next step is teams working *with* AI, the way they moved from email to shared channels and from local docs to shared docs.
- Agent harnesses (e.g. the open-source Pi coding agent, which our Tau runtime forks) are now capable enough to do real multi-step work. The missing layer is collaboration, permissions and governance around them.
- Enterprises are deciding how AI may act on shared work. A product that bakes in roles, approvals, isolation and audit from day one can be adopted team by team inside large companies.

## 1.5 Who it's for (initial customer)

| Segment | Why they buy | Entry point |
|---|---|---|
| **Primary: product engineering teams (5–50 people) inside mid-size companies and MNCs** | Already use AI individually. Need shared context and approvals. Can adopt without a company-wide mandate | Team-led: one team sets up a project and invites others |
| Secondary: startups (10–100 people) | Want speed with lightweight structure | Org signs up; every team gets Arenas |
| Later: regulated enterprises | Need governance, audit, data residency | Enterprise preset, SSO/SCIM, BYO runtime (post-MVP) |

**Adoption motion: "controlled by the teams that need it."** A team starts. Its org admin connects SSO when more teams join. Leaders get dashboards for free.

## 1.6 Business model (proposed)

| Plan | Who | Pricing basis |
|---|---|---|
| Team | One or a few teams | Per active member / month + included agent usage |
| Organization | Many teams, units, SSO/SCIM, dashboards | Per member / month, usage pooled, budgets |
| Enterprise | Regulated, large | Annual contract, data residency, BYO runtime/model keys |

Prices: **[to be set after design-partner interviews]**. Agent usage (model cost) is metered per project and capped by org budgets from day one (doc 05, doc 10).

## 1.7 Competition and how we're different

Positioning by category, not feature-by-feature claims:

| Category | Strength | Gap Saras fills |
|---|---|---|
| Personal AI assistants & AI IDEs | Excellent for one person | Private by design. No team space, roles, approvals or SDLC loop |
| Autonomous coding agents | Do multi-step coding tasks | Agent-centric, not team-centric. Little say for the team's own structure |
| Team chat with AI add-ons | Shared conversation | No SDLC structure, stage artifacts, gates or per-project agent session |
| Project management / issue trackers with AI | Planning and tracking | AI is a feature, not a teammate that works in the shared session across stages |

**Our wedge:** the team's own structure (custom roles + gates) combined with a shared AI session per project and a Private → Arena bridge. Isolation and audit are built in, so large companies can let it in.

## 1.8 What exists today and what ships next

| Asset | Status |
|---|---|
| Product & architecture documentation (this Build Pack) | Done |
| Clickable UI design (Private, Arena, setup wizard, loop, dashboards, inbox, onboarding, RBAC screens) | Done, on design canvas |
| Database schema (PostgreSQL, RLS, RBAC) | Done, validated against PostgreSQL 16 |
| API contract (OpenAPI 3.1, permission rule per endpoint) | Done, lint-clean |
| Runtime contract with Tau (our Pi-based agent harness) | Done (v0.2) |
| YC demo slice (working vertical slice on staging) | **Building, 16–30 Oct 2026** |
| MVP GA | **Target 22 Feb 2027** |
| Users / design partners | **[number and names when signed]** |

## 1.9 Three-minute demo script (for the YC video)

| Time | Show | Say |
|---|---|---|
| 0:00 | Private home | "This is where everyone uses AI today, alone. Saras keeps that, and adds the team." |
| 0:20 | Create project → pick "Enterprise product squad" template → rename a role, add "Security champion" → DEPLOY needs 2 approvers | "Every team defines its own roles and who approves what. Nothing is imposed." |
| 0:50 | Arena opens. The central agent greets with the team's roles | "One shared space per project, with one AI that knows the whole project." |
| 1:10 | Private session: "draft goal.md from our discussion" → Push to Arena → PLAN gate requested | "Personal work becomes team work in one click, and only the artifact is shared." |
| 1:40 | Approver votes in the Arena. Loop moves to DESIGN. Routine digest posts | "Humans make the calls. The AI does the routine work." |
| 2:10 | Assign a task to the AI teammate → draft lands in review | "The AI works as a teammate, inside the team's rules." |
| 2:35 | Org dashboard: status across teams, no conversations visible | "Leaders get visibility, teams keep ownership." |
| 2:50 | Close | "Saras: AI moves from private chats into the team." |

## 1.10 Metrics we will report

| Metric | Definition |
|---|---|
| Weekly active Arenas | Projects with ≥3 human posts and ≥1 agent turn in a week |
| Bridge rate | Pushes from Private to Arena per weekly active user |
| Loop velocity | Median time from PLAN to DEPLOY per cycle |
| Agent work accepted | % of AI-teammate tasks verified without rework |
| Team expansion | New teams per org per month after the first |
| Retention | Week-4 retention of teams that complete project setup |

## 1.11 Risks and how we address them

| Risk | Mitigation |
|---|---|
| Agent quality not good enough for real team work | Humans gate every stage. The AI drafts and humans approve. Runtime quality is improved separately (Tau) without blocking the app |
| Enterprises block AI on shared data | Isolation per project, Private never shared, org autonomy ceilings, audit, data region |
| Teams don't change habits | Private stays familiar (same as their current AI use). The bridge is one click. Routines give value without behaviour change |
| Model cost | Per-org budgets, batching of ambient messages, model classes per task |
