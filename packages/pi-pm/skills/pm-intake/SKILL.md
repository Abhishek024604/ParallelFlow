---
name: pm-intake
description: PM phase 0. Turn an idea brief, goals, customer evidence, meeting notes and constraints into pm › 00-discovery.md, pm › evidence.md and pm › questions.md: problem statement, target users, evidence ledger, assumptions, risks and open questions. Use for /pm intake.
---

# PM intake and discovery (phase 0)

Goal: a shared, reviewable understanding of the problem before any feature list.

1. Gather the inputs: the owner's message, files attached to it, and documents in this chat named `pm › inputs › …` or that look like an idea brief, goal, notes or research. If there is no idea at all, ask for one (what problem, for whom, why now) and stop.
2. If `pm › 00-discovery.md` exists, read it: you are updating it, keep its IDs.
3. Extract and label every item with its source (document and section, or "owner, this chat"):
   - **Problem**: who has it, in what context, what hurts, what they do today, why now.
   - **Target users / segments** (`ACT-*`) and their jobs to be done.
   - **Evidence ledger** (`EVD-*`): verbatim quotes and observations kept apart from your interpretation; source, date, how many people, confidence (high / medium / low).
   - **Goal inputs**: business objective, success metric ideas, target date, budget, capacity, platforms, hard constraints (`CON-*`), ranked quality priorities.
   - **Stakeholder decisions and disagreements**, with owner and date.
   - **Assumptions**, **risks**, **contradictions** between inputs.
4. Ask with ask_user when a missing answer would change the direction (target user, the core problem, a hard constraint, what is out of scope). At most four questions. Everything else goes to questions.md.
5. Save:
   - `pm › 00-discovery.md`: frontmatter, then `## Problem statement` (one paragraph), `## Target users` (table ACT-ID, segment, job, context), `## Why now`, `## Goals and constraints` (table, `unknown` where not given), `## Assumptions` (A-NNN, what would prove it wrong), `## Risks`, `## Decisions so far` (date, who, what), `## Out of scope (stated)`.
   - `pm › evidence.md`: one table EVD-ID, type (quote / observation / metric / opinion), text, source, date, n, confidence, supports (problem or ACT-*).
   - `pm › questions.md`: table Q-ID, question, why it matters, owner, needed by (phase), status (open / answered), answer.
6. Reply: the problem in one sentence, counts (users, evidence, open questions), the questions that block outcomes, and "Review pm › 00-discovery.md, approve it, then /pm outcomes".
