---
title: "Saras — MVP Build Pack v2.0"
subtitle: "Everything needed to start implementation: product, RBAC, workflows, architecture, contracts, UX, security, engineering, delivery"
date: "15 October 2026 · implementation starts 16 October 2026"
---

# 00 — Start Here

**Saras moves AI from private chats into a shared team space.** Humans and AI work together across the whole development cycle. The AI acts as knowledge base, brainstormer, employee, agent and routine tasker. Teams control it: they define their own roles, approvals and how much the AI may do. Organizations of any size, up to MNCs, get structure, oversight and safety without taking control away from teams.

This Build Pack is the **single source of truth** for the MVP. It supersedes the v1.0 Architecture Playbook and the v1.1 Implementation Plan wherever they differ (decision log, doc 13).

## Reading order

| # | Document | Read if you are… |
|---|---|---|
| 01 | Product Brief & YC Narrative | Everyone. YC application material |
| 02 | Product Requirements (PRD) | Everyone. Feature specs F01–F21, non-goals, NFRs |
| 03 | **Organization Hierarchy & RBAC** | Everyone. MNC mapping, four permission planes, 27 capabilities, templates, agent autonomy |
| 04 | App Workflows & User Journeys | Product, design, engineering |
| 05 | Architecture | Engineering |
| 06 | Data Model | Backend |
| 07 | API Reference | Backend, frontend |
| 08 | Agent Runtime Integration (Tau) | Backend, Tau team |
| 09 | UX Specification & Design System | Design, frontend |
| 10 | Security, Privacy & Compliance | Everyone touching data or permissions |
| 11 | Engineering Handbook | Engineering. **Day-1 setup is here** |
| 12 | Delivery Plan, YC Demo Slice & Backlog | Everyone. **What we build tomorrow** |
| 13 | Decision Log | Leads |
| 14 | Glossary | Everyone |
| 15 | SWA Extension: Workflow Specification | Engineering. The software-architect Pi extension (`pi-swa`) |

## Machine-readable artifacts

| File | What | Verified |
|---|---|---|
| `contracts/schema_v2.sql` | PostgreSQL 16 schema: 45 tables, RLS, RBAC, routines | Applied to PG 16.15 + pgvector; RBAC smoke tests pass (doc 06 §6.3) |
| `contracts/openapi_v2.yaml` | REST API: 132 operations, permission rule on each | Redocly lint: 0 errors |
| `contracts/runtime-integration-contract_v0.2.yaml` | App ↔ Tau contract | Redocly lint: valid |
| `contracts/app-tools_v0.2.mcp.json` | 20 App Tools for the runtime, with autonomy classes | Parsed |
| `contracts/role_templates_v2.json` | 7 role templates (roles, capabilities, gates, agent policy) | Every approval gate's roles hold the matching capability (script-checked) |
| `Saras_MVP_Backlog_v2.xlsx` | 77 stories, 365 points, phase / track summary, capacity | Formulas recalculated, 0 errors |
| `diagrams/` | 16 diagrams (Mermaid source + SVG + PNG) | Rendered |
| Design canvas "Saras App UI" | 14 artboards, light and dark | — |

## The ten rules every engineer must know

1. **Teams own their structure.** Roles are team-defined bags of 27 fixed capabilities. Gate approvers are roles.
2. **Permissions follow responsibility, not seniority.** Job level never grants access.
3. **Oversight ≠ access.** Org and unit dashboards show status only. Content requires project membership (Observer at least).
4. **Private is private.** The bridge (bind, pull, push) is the only crossing. Push copies one artifact, never the session.
5. **One Arena per project, one agent session per Arena.** A private session binds to ≤1 project, forever.
6. **AI never exceeds the human it acts for.** Autonomy policy ∩ org ceiling ∩ invariants, enforced in App Tools.
7. **Humans vote on gates and verify tasks.** Agents never do. Separation-of-duties rules apply.
8. **The database is the last line.** FORCE RLS for tenant, Private and Arena visibility, plus capability-checked Arena writes.
9. **Contracts first.** Change `packages/contracts` before code. The runtime is reached only through RIC v0.2.
10. **Everything consequential is audited.** Append-only, hash-chained.
