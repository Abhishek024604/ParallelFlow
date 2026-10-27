---
name: pm-requirements
description: PM phase 2. Write testable, traceable requirements (FR-, NFR-, ACT-, CON- IDs) with scenarios, permissions, errors and edge cases, linked to evidence and outcomes, in pm › requirements.md and pm › glossary.md. Use for /pm requirements.
---

# PM requirements (phase 2)

1. Read discovery, evidence, questions, outcomes, and `pm › requirements.md` / `pm › glossary.md` if they exist (keep IDs; append only).
2. Write requirements, one behaviour each:
   - **FR-NNN**: "<actor> can <do what> <under which condition>", with priority (Must / Should / Could / Won't for now), rationale, and traces (EVD-_, OUT-_). One without evidence or rationale gets `trace: rationale needed` and a Q-*.
   - **NFR-NNN**: a quality attribute with a measurable criterion (for example p95 page load under 2 s on 4G). No number given: the criterion is `unknown` and a Q-*.
   - **CON-NNN**: constraints (platform, compliance, accessibility, timeline, dependency).
   - For each FR, the scenarios that matter: happy path, permissions (who may, who may not), errors and failures, empty and loading states, limits, concurrency, data retention and privacy, accessibility, analytics events.
3. Check every requirement and fix or flag it: ambiguous words ("fast", "easy", "etc.", "support", "appropriate"), duplicates, contradictions, a missing actor, untestable wording, a solution posing as a requirement.
4. Save `pm › requirements.md`: frontmatter, `## Actors` (ACT table), `## Functional requirements` (table FR-ID, requirement, priority, rationale, traces, status open / ready), then `### FR-NNN` sections only for requirements that need scenarios and edge cases, `## Non-functional requirements` (table), `## Constraints` (table), `## Open issues` (requirement, problem, Q-ID). Save `pm › glossary.md`: term, meaning, not to be confused with.
5. Add new questions to `pm › questions.md` (append rows; keep the rest).
6. Reply: counts by priority, the requirements still open and why, and "Review pm › requirements.md, then /pm scope".
