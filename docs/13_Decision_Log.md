# 13 — Decision Log (ADRs, consolidated)

> Build Pack v2.0 · Append-only. A changed decision gets a new entry that supersedes the old one. Full option analyses for v1 ADRs remain in the v1.0 playbook doc 09.

---

| ID | Decision | Status | Date | Alternatives considered | Revisit when |
|---|---|---|---|---|---|
| ADR-001 | TypeScript modular monolith (NestJS) + separate realtime / worker / app-tools services | Accepted | 12 Oct | Microservices; Python backend | Team > 15 or independent scaling needs |
| ADR-002 | PostgreSQL 16 as system of record (+ pgvector, FTS) | Accepted | 12 Oct | Postgres + OpenSearch + vector DB; MongoDB | > 50M vectors / DB CPU > 60% |
| ADR-003 | Temporal for workflows | **Superseded by ADR-016** | 12 Oct | — | — |
| ADR-004 | Transactional outbox → Redis Streams | **Superseded by ADR-017** | 12 Oct | — | — |
| ADR-005 | Artifacts in S3 (content-addressed); Git as evidence mirror | Accepted | 12 Oct | Git as primary store | — |
| ADR-006 | One personal agent per user, one central agent per org; roles are modes, not identities | Accepted | 12 Oct | Agent per role | Demand for "team agents" |
| ADR-007 | Authz in-house (pure library + Postgres facts + RLS) | Accepted, extended by ADR-020 | 12 Oct | OpenFGA / SpiceDB; OPA / Cedar | Per-resource sharing, cross-org guests |
| ADR-008 | Sandboxes in the app | **Superseded by ADR-014** (runtime owns sandboxes) | 12 Oct | — | — |
| ADR-009 | Own WebSocket gateway; REST is the only write path | Accepted | 12 Oct | Ably / Pusher; SSE-only | Multi-region presence |
| ADR-010 | Hybrid search in Postgres, ACL in SQL | Accepted | 12 Oct | Dedicated search engine | With ADR-002 trigger |
| ADR-011 | Multi-tenancy: shared DB + `org_id` + FORCE RLS | Accepted | 12 Oct | Schema- or DB-per-tenant | Regulated single-tenant deals |
| ADR-012 | Model gateway in the app | **Superseded by ADR-014** | 12 Oct | — | — |
| ADR-013 | Agent runtime is a separate product (Tau) integrated via a contract (RIC) + App Tools MCP | Accepted | 12 Oct | Embed runtime in app | — |
| ADR-014 | Tau owns harness, skills, tools, model routing and sandboxes; app owns identity, permissions, approvals, persistence | Accepted | 12 Oct | Shared ownership | — |
| ADR-015 | One Arena per project = one shared agent session; no channels; private sessions bind to ≤1 project, write-once | Accepted | 12 Oct | Channels; per-user sessions in Arena | Users need sub-spaces (post-MVP threads first) |
| ADR-016 | Long waits (gates, approvals) as DB state machines; jobs and schedules on **pg-boss** | Accepted | 12 Oct | Temporal; Step Functions; Inngest | Complex multi-step orchestration in the app |
| ADR-017 | Outbox → **pg-boss** consumers; Redis pub/sub only for realtime fan-out | Accepted | 15 Oct | Redis Streams; Kafka | > 20 consumers or replay needs |
| ADR-018 | SDLC as a loop of cycles; one active development cycle per project | Accepted | 12 Oct | Parallel intents | Teams need parallel streams |
| ADR-019 | **Four permission planes** (org, unit, team, project) + agent plane; permissions follow responsibility, not seniority; oversight ≠ access | Accepted | 15 Oct | Hierarchy-inherited access; fixed project roles | Enterprise feedback |
| ADR-020 | Project roles = **team-defined bags of a fixed 27-capability catalogue** + system Owner/Observer roles; gate approvers point to roles | Accepted | 15 Oct | Fixed PM/Eng/QA roles; free-form permissions | New capability needs (ship with migration, default off) |
| ADR-021 | Agent **autonomy policy** per project per capability class (off / suggest / approve / act), capped by org and unit ceilings, enforced in App Tools | Accepted | 15 Oct | Prompt-only rules; global switch | Usage data from beta |
| ADR-022 | **Separation of duties** on gates: `min_approvals`, `min_distinct_roles`, `forbid_self_approval` | Accepted | 15 Oct | Single approver | — |
| ADR-023 | **WorkOS** for login, SSO (SAML/OIDC) and SCIM | Accepted | 15 Oct | Auth.js + custom SAML; Auth0; Clerk | Pricing at scale |
| ADR-024 | Hosting on **AWS ECS Fargate** (ap-south-1), Terraform | Accepted | 15 Oct | EKS; Render / Fly | > 30 services or need for k8s-native tooling |
| ADR-025 | **PostHog** for product analytics and feature flags; Sentry for errors; OTel → Grafana Cloud | Accepted | 15 Oct | Unleash + Mixpanel | — |
| ADR-026 | **Routines** run as `mode=routine` turns on the central agent's Arena session, with deterministic fallback | Accepted | 15 Oct | Separate scheduler agent | — |
| ADR-027 | **AI teammate** tasks: agent can reach `in_review` only; human reviewer required; DB check on `verified_by` | Accepted | 15 Oct | Agent self-completion with audit | — |
| ADR-028 | Org **presets** (Startup / Enterprise) set policy defaults; everything stays editable | Accepted | 15 Oct | Single default | — |
| ADR-029 | **MVP has no visible organization layer.** Arena-first onboarding: sign up → empty home → create arena + invite by email → invitees sign up and join from the link. Each arena is backed by a hidden org + team + project created in one transaction | Accepted | 15 Oct | Org-first onboarding (org → teams → projects) | Paying customers ask for org admin, SSO or cross-arena reporting |

### ADR-029 detail: arena-first MVP

- **Why:** first-time users should reach a working arena in under a minute, with no org setup, jargon or extra windows.
- **Data model:** keep `schema_v2.sql` as it is. Creating an arena runs one transaction that inserts:
  - `organizations` (hidden, named after the arena);
  - `teams`;
  - `projects`, with system Owner and Member roles;
  - `arenas`;
  - one central agent session.
  The creator becomes org owner, team owner and project Owner. RLS and session isolation are unchanged.
- **Invites:** use the `invitations` table, with email, arena and a token. They expire after 7 days and are single use. When someone accepts, their org membership (member), team membership and project membership are added together. An invite link needs an account with the same email: sign up first, then join.
- **Hidden in the MVP UI:**
  - org units and unit roles;
  - org dashboard and org policies or presets;
  - SSO/SCIM;
  - guests;
  - access requests;
  - org-level knowledge upload.
  These stay in the schema and API for later phases.
- **Optional in arena settings:** custom roles and stage approvals. The default is a single approver: the arena owner.
- **Copy:** use "arena", "teammates" and "AI". Avoid "org", "unit", "tenant", "bind" and "central agent" in the UI.
