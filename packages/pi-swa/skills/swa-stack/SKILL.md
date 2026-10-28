---
name: swa-stack
description: SWA phase 1. Choose the architecture style and the technology per layer from the approved drivers, goal.md and the governance rules; write arch/stack.md and one ADR per significant choice, starting with the architecture style. Use for /swa stack.
---

# SWA stack (phase 1, ends at gate G1)

1. Call `swa_status` (nothing blocks this phase: when earlier files are missing, work from the conversation and say what you assumed). Read `00-drivers.md`, `inputs/goal.md` and, if present, `inputs/governance.yaml`; read `stack.md` and `decisions/` if they exist (you are updating them).
2. Read the templates: `swa_read` with `template: "stack.md"` and `template: "adr.md"`.
3. **Architecture style first** (the most expensive decision to reverse). Weigh at least three styles against the ranked quality priorities, team size and skills, deadline and budget. Record it in `decisions/ADR-0001-architecture-style.md`.
4. **Technology per layer** (for example client, API, compute, data, messaging, identity, observability, CI/CD, hosting). For each layer:
   - pick what the quality scenarios, constraints and team skills point to, citing their IDs;
   - prefer what the team already runs (goal.md) unless a scenario rules it out;
   - stay cloud-agnostic unless the drivers name a target cloud; then use its managed services where they fit.
5. One ADR per significant choice: hard to reverse, costly, or a trade-off between quality scenarios (for example the primary database, messaging, the hosting model). Number them `ADR-0002`, `ADR-0003`, … after the highest existing one; file name `decisions/ADR-000N-short-title.md`; frontmatter `id` = `ADR-000N`, `gate: G1`. An ADR that replaces an approved one sets `supersedes: ADR-000M`; leave the old file as it is.
6. Write `stack.md` with `swa_write`: frontmatter `style` and `stack` (one `{layer, tech, adr}` entry per technology, the name as the governance file would spell it), and every template section. In "Standards", cite each governance rule id and say how the stack meets it.
7. Run `swa_governance_check`. Fix every FORBIDDEN, NOT ON THE ALLOWED LIST and REQUIRED BUT MISSING item, and address every listed rule; when a rule can't be met, say so in stack.md and ask the architect. Run it again until it reports no violations.
8. Run `swa_validate` and fix what it reports (every cited ID must exist).
9. Reply in at most five lines: the style, the main choices, open trade-offs that need the architect's decision, and "Review arch/stack.md and arch/decisions/, then /swa approve G1".
