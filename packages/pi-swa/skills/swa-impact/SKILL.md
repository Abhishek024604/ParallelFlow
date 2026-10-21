---
name: swa-impact
description: SWA phase 6. When an input or an approved artifact changes (a new SRS version, an answered question, a code-review finding that the design is wrong), find every affected artifact, mark them stale, and report where the architect re-enters the flow, in arch/reviews/impact-<date>.md. Use for /swa impact.
---

# SWA change impact (phase 6)

1. Call `swa_impact` (without `mark`). It lists the inputs that changed since the artifacts were built from them, every affected artifact, and the earliest gate to re-enter.
2. If the architect described a change that is not in the files yet (for example "the client now needs EU data residency"), ask them to put it in the inputs first (an input is theirs to change); do not record requirements yourself.
3. Read what changed (the input, or the changed artifact) and the affected artifacts. For each one, say concretely what is now wrong or doubtful: the requirement ids, components, ADRs and contracts touched. Some affected files only need a re-check; say which.
4. Decisions that no longer hold: propose a new ADR that supersedes the old one (swa-adr skill) only after the architect agrees; never edit an approved ADR.
5. Write the report with `swa_write` to `reviews/impact-<YYYY-MM-DD>.md`: what changed, the affected artifacts with what to do in each, superseded decisions, and the phases to re-run from the earliest gate.
6. Mark the affected artifacts stale: call `swa_impact` with `mark: true`. Their gates reopen; this is how the flow re-enters.
7. Reply in at most five lines: what changed, how many artifacts are affected, the earliest gate, and the command to re-run (for example "/swa intake, then /swa stack").
