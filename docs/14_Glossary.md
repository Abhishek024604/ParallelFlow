# 14 — Glossary

| Term | Meaning |
|---|---|
| **Organization (org)** | The tenant: one company or group. Holds identity, policies, billing, audit, org knowledge |
| **Org unit** | Optional node in the org hierarchy (business unit, department, group), up to 5 levels |
| **Unit Lead / Unit Admin** | Unit-scoped roles: status dashboards for the subtree; team administration (Admin) |
| **Org roles** | Owner, Admin, Security & Compliance Admin, Billing Admin, Member, Guest |
| **Guest** | External person with expiring access to specific projects only |
| **Team** | Self-governed group of people that owns projects. Roles: Owner, Admin, Member |
| **Project** | A product, initiative or program. Has exactly one Arena, its own roles, gates, agent policy and routines |
| **Arena** | The project's single shared space: one message stream plus one central-agent session |
| **Private space** | A person's own AI workspace, available on every screen; never visible to others |
| **Bridge** | The only path between Private and an Arena: bind, pull context, push artifact |
| **Bind** | Tying a private session to exactly one project, permanently |
| **Push to Arena** | Copying one artifact version from Private into a project, with preview |
| **Custom role** | A team-named role made of capabilities (e.g. "Backend dev", "Security champion") |
| **Capability** | One of 27 fixed permissions (e.g. `arena.post`, `stage.approve.DEPLOY`) |
| **Project Owner / Observer** | System roles: Owner has every capability; Observer is read-only |
| **Role template** | Starting set of roles, gates and agent policy (7 templates) |
| **Central agent** | The project's AI participant in the Arena (one session per Arena) |
| **Personal agent** | A person's AI in Private, acting only on their behalf |
| **AI teammate** | The central agent working on an assigned task; output goes to human review |
| **Autonomy policy** | Per project, per capability class: off / suggest / approve (needs human approval) / act |
| **Autonomy ceiling** | Org (or unit) maximum autonomy that every project inherits |
| **Routine** | Scheduled AI job (daily digest, standup, gate nudge, weekly report, custom) |
| **SDLC loop** | PLAN → DESIGN → BUILD → TEST → DEPLOY → MAINTAIN → next cycle |
| **Cycle** | One pass through the loop; one active at a time, earlier ones keep "operating" |
| **Gate** | Approval needed to leave a stage; approvers are roles |
| **Separation of duties (SoD)** | Gate rules: minimum approvals, distinct roles, no self-approval |
| **Stage artifact** | goal.md, spec.md, plan.md, test report, release notes |
| **Evidence** | Proof attached to a stage: git commit, PR, CI run, deployment, link |
| **progress.md** | Summary generated from project records; never the source of truth |
| **Tau** | ParallelFlow' agent runtime: a fork of the Pi coding-agent harness |
| **RIC** | Runtime Integration Contract between the app and Tau (v0.2) |
| **App Tools** | MCP tools the app exposes to the runtime, scoped to one session's project |
| **Stub runtime** | App-team implementation of RIC (scripted / thin-LLM) |
| **Canary suite** | Tests that plant unique strings per project / session and prove they never leak |
| **Turn** | One agent run in a session (prompt, system, routine, assignment, …) |
