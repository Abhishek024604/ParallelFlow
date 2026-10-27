---
name: pm-stories
description: PM phase 4. Turn approved scope into epics and user stories with Given / When / Then acceptance criteria covering happy path, errors, permissions, empty and loading states, accessibility and analytics, linked to requirements and outcomes, plus a handoff bundle for the architect. Use for /pm stories.
---

# PM stories and acceptance criteria (phase 4)

1. Read mvp.md (the slice to break down: the owner's focus, else the MVP), requirements.md, outcomes.md and existing `pm › backlog › …` documents (keep IDs).
2. Group in-scope requirements into epics (`EPIC-NNN`: goal, the OUT-* it moves, the FR / NFR it covers).
3. Write stories (`STORY-NNN`): "As <ACT>, I want <capability>, so that <outcome>". Small enough for one team in one iteration; split by workflow step, rule or data variation, never by layer (no "backend story").
4. Acceptance criteria per story (`AC-NNN-n`), Given / When / Then, testable with concrete values: the happy path, then errors, permissions, empty and loading states, limits, accessibility (keyboard, screen reader, contrast) and analytics events where they apply.
5. Each story lists its parent FR-_, OUT-_, dependencies (other stories, external), open questions (Q-*), and `ready: yes / no`. A story with an open critical question is `ready: no`.
6. Save one document per epic, `pm › backlog › EPIC-NNN.md` (frontmatter; goal; stories table STORY-ID, title, FR, ready), and one per story, `pm › backlog › STORY-NNN.md` (frontmatter with `epic`, `requirements`, `outcomes`; the story; acceptance criteria; notes; dependencies; questions). Write `pm › handoff.md` for the architect: outcomes and KPIs, the FR / NFR / CON, MVP and slices, the stories, evidence and assumptions, open questions and decisions, each with its document name.
7. Check coverage: every in-scope FR has at least one story (or a written exception); every story has a parent FR or an explicit operational reason.
8. Reply: epics and story counts, stories not ready and why, coverage gaps, and "Run /pm review before handoff; /pm sync puts them in Linear".
