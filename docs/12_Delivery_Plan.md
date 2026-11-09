# 12 — Delivery Plan, YC Demo Slice & Backlog

> Build Pack v2.0 · Start: **Friday 16 Oct 2026** · MVP GA target: **Monday 22 Feb 2027**
> Detailed stories: `ParallelFlow_MVP_Backlog_v2.xlsx` (77 stories · 365 points). Capacity sheet: 6 engineers × 8 pts × 9 sprints = 432 pts → 84% planned utilisation.

---

## 12.1 Timeline

![Roadmap](diagrams/31_roadmap_v2.svg)

| Phase | Dates | Outcome | Exit criteria (demo on staging) |
|---|---|---|---|
| **YC demo slice** | 16 – 30 Oct | Thin end-to-end slice for the application video | Login → org → project with custom roles → Arena chat with `@central` (stub thin-LLM) → Private draft → Push to Arena → gate approve. Recorded 3-min video (doc 01 §1.9) |
| **P0 Foundations** | 16 – 29 Oct | Monorepo, CI, Terraform, schema_v2, RLS harness, request pipeline, outbox, design system, stub runtime | Fresh `terraform apply` + `pnpm dev`; tenant suite green; RIC v0.2 frozen (C1) |
| **P1 Identity, hierarchy, RBAC** | 30 Oct – 12 Nov | WorkOS auth/SSO, orgs & presets, policies, units & unit roles, members/invites/guests/offboarding, teams, authz library, audit | MNC demo: enterprise org with 3 units, Unit Lead, guest with expiry; authz matrix tests ≥95% branches |
| **P2 Projects, roles, Arena** | 13 Nov – 3 Dec | Setup wizard (templates, custom roles, gates, agent), members & roles, observers, Arena realtime, `@central` on stub, App Tools, canary suite v1 | Create "Enterprise product squad" project with custom role; observer read-only; canary 100% |
| **P3 Private, bridge, artifacts, notifications** | 4 – 17 Dec | Private sessions, bind / pull / push, artifacts & versions, delegation, notification centre, DMs | Bind write-once demo; push with gate request; 10 notification types |
| **P4 Loop, AI teammate, routines** | 18 Dec – 14 Jan | Cycles, gates with SoD, evidence, progress.md, AI-teammate tasks, routines, access requests, dashboards | Full cycle with 2-approver DEPLOY, no self-approval; AI task → review → verify; daily digest posts; Unit Lead dashboard |
| **P5 Tau integration** | 15 – 28 Jan | Swap stub → Tau, ambient batching, step drawer, usage & budgets | Conformance ≥95%, canary 100%, p95 first event < 3 s (C3 by 14 Jan) |
| **P6 Hardening & beta** | 29 Jan – 18 Feb | Load, pen test, search, SCIM, observability, email digest, audit UI; design-partner beta from 1 Feb | Launch checklist (§12.6) green |
| **GA** | 22 Feb 2027 | — | — |

The holiday period (late December) is inside P4, so P4 runs 4 weeks.

## 12.2 YC demo slice — day by day (16–30 Oct)

| Day | Date | Backend | Frontend | Platform |
|---|---|---|---|---|
| 1 | Fri 16 | Repo, NestJS skeleton, schema_v2 migration, seed | Next.js shell, tokens, mode switcher | AWS account, Terraform base, CI |
| 2–3 | Mon 19 – Tue 20 | WorkOS login; orgs; teams (minimal) | Login, onboarding (org step) | Staging ECS + RDS |
| 4–5 | Wed 21 – Thu 22 | Projects + setup:complete (templates, roles, gates; no units) | Setup wizard (roles + gates screens) | Stub runtime thin-LLM deployed |
| 6–7 | Fri 23 – Mon 26 | Arena messages, realtime, `@central` turns via adapter | Arena screen (stream, approval card) | Seed demo org/data |
| 8–9 | Tue 27 – Wed 28 | Private sessions, push to Arena, gate request + vote | Private home/session, push dialog | Monitoring basics |
| 10 | Thu 29 | Bug bash; demo script dry-run | Polish | Freeze staging |
| 11 | Fri 30 | **Record demo video**; submit YC application | — | — |

Slice rules:
- Code goes to `main` behind feature flags.
- Shortcuts are listed in `SLICE_DEBT.md` and paid back in P1–P3 (e.g. no units, simplified authz checks enforced by RLS only, single org preset).

## 12.3 Team and ownership

| Role | People | Owns |
|---|---|---|
| Tech lead / backend | 1 | Contracts, authz, loop, adapter, code review of security-critical paths |
| Backend | 2 | Org / units / teams / members; Arena / realtime / DMs; Private / bridge / artifacts / tasks / routines |
| Frontend | 2 | Design system, Private, Arena, setup wizard, loop, dashboards, inbox, settings |
| Platform / QA | 1 | Infra, CI/CD, observability, canary and tenant suites, load tests |
| Product / design (founder) | 1 | Scope, backlog, design canvas, design partners, YC application |
| Tau runtime team | Separate | Tau harness, RIC wrapper, conformance (doc 08 §8.8) |

## 12.4 Ceremonies

- 2-week sprints starting Monday 19 Oct (the YC slice runs inside sprint 1).
- Daily 15-minute standup. **We dogfood:** run ParallelFlow itself in a ParallelFlow Arena as soon as P2 lands, with a daily digest routine.
- Sprint review = staging demo against the phase exit criteria.
- Weekly 30-minute contract sync with the Tau team.
- Architecture decisions recorded in doc 13 (append-only).

## 12.5 Risks

| Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|
| YC slice too ambitious for 2 weeks | M | H | Thin scope, stub runtime, RLS-first authz, explicit slice debt | Tech lead |
| RBAC complexity slows P1–P2 | M | H | Authz as pure library with matrix tests; templates reduce UI surface | Tech lead |
| Tau slips | M | M | Stub thin-LLM is production-capable; checkpoints with fallbacks | Founder + Tau lead |
| Model cost | M | M | Budgets, batching, routine minimum interval, model classes | Backend |
| Enterprise asks (SAML/SCIM) early | M | M | WorkOS covers them; SCIM in P6 | Backend |
| Scope creep (voice, Developer mode, channels) | H | M | Non-goals list (doc 02 §2.2); decision log | Founder |

## 12.6 Launch checklist (GA)

- [ ] Golden-path E2E green for 7 consecutive days on staging
- [ ] Tenant, Private, canary isolation and authz suites 100%
- [ ] Unit Lead and Org Admin cannot read Arena content of non-member projects (verified in a prod-like environment)
- [ ] External pen test: no open High / Critical
- [ ] SLO dashboards and alerts live; runtime-down and isolation runbooks rehearsed
- [ ] Backup restore drill done (RPO ≤ 5 min, RTO ≤ 1 h)
- [ ] Privacy notice, DPA, sub-processor list published
- [ ] Budgets on for every org; billing plan configured
- [ ] Design partners' feedback triaged; P0 issues closed

## 12.7 Decisions to confirm with founders (defaults used in this pack)

| # | Question | Default |
|---|---|---|
| D1 | Can org admins read Arena content of projects they're not in? | No; they request access |
| D2 | Team ↔ project | A team owns many projects; members can come from other teams/units if policy allows |
| D3 | Parallel cycles | No; one active plus operating cycles |
| D4 | Agent replies on someone's behalf | Not in MVP |
| D5 | Rebinding a private session | Never; start a new session |
| D6 | Hosting | AWS ECS Fargate, ap-south-1 |
| D7 | Auth vendor | WorkOS |
| D8 | Plans and prices | After design-partner interviews |
