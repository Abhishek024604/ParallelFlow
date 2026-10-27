---
name: pm-scope
description: PM phase 3. Agree a deliverable first release and an intentional sequence: explicit in and out scope, transparent prioritization (MoSCoW or impact vs effort), release slices, dependencies, risks and decision records, in pm › mvp.md, pm › roadmap.md and pm › decisions. Use for /pm scope.
---

# PM MVP scope and roadmap (phase 3)

1. Read requirements, outcomes, discovery (constraints, capacity, dates) and the existing mvp / roadmap if any.
2. Agree the method with the owner if not stated: MoSCoW (default) or impact vs effort. Effort belongs to the delivery team: use their estimates if given, else label effort `provisional` or `unknown`. Never invent estimates or dates.
3. Decide the MVP: the smallest set of FR / NFR that moves the first OUT-* for the primary ACT-*. List in scope and out of scope explicitly; every Must is in, or has a written reason.
4. Slice the rest into releases (MVP, v1, later): each slice names its goal (OUT-_), its requirements, dependencies (internal, external, CON-_), risks, and what would change the order.
5. Record each significant choice as `pm › decisions › PM-ADR-NNNN.md`: context, decision, options considered and why rejected, owner, date, status proposed.
6. Ask the owner (ask_user) where priorities conflict or a Must does not fit the date, with the trade-off as options.
7. Save `pm › mvp.md` (frontmatter, `## MVP goal`, `## In scope` table FR / NFR and why, `## Out of scope` table with reason and when, `## Prioritization method`, `## Risks and assumptions`) and `pm › roadmap.md` (frontmatter, `## Release slices` one section per slice, `## Dependencies`, `## Rejected and deferred`). A roadmap is internal: never word it as an external promise.
8. Reply: the MVP in three lines, what was deferred, the decisions to confirm, and "Review pm › mvp.md, then /pm stories".
