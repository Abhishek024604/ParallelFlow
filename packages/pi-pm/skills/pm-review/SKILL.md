---
name: pm-review
description: PM phase 5. Product quality review: validate IDs, links, completeness, testability, consistency and scope alignment across all pm/ documents, build the evidence to outcome to requirement to story traceability, and report blockers, major and minor issues in pm › reviews › requirements-review.md. Use for /pm review.
---

# PM product review (phase 5)

1. List and read every `pm › …` document in this chat.
2. Check, citing document and section for every finding:
   - **IDs**: unique, stable, every reference points to something that exists.
   - **Frontmatter**: id, status, version, owner, updated_at, inputs present.
   - **Traceability**: EVD, OUT, FR / NFR, EPIC, STORY, AC. List orphans: requirements with no evidence or rationale, in-scope requirements with no story, stories with no parent requirement, outcomes no requirement serves, KPIs with no definition.
   - **Testability**: ambiguous words, NFRs without a measure, acceptance criteria that cannot fail.
   - **Consistency**: scope in mvp.md vs requirement priorities vs stories; contradictions between documents; glossary terms used differently.
   - **Readiness**: open critical questions, stories `ready: no`, decisions still proposed, documents changed since the owner approved them.
3. Grade each finding: **blocker** (prevents handoff), **major**, **minor**, **suggestion**.
4. Save `pm › reviews › requirements-review.md`: frontmatter, `## Verdict` (ready for handoff: yes / no, one line why), `## Blockers`, `## Major`, `## Minor`, `## Suggestions` (each: finding, where, fix), `## Traceability matrix` (FR-ID to EVD, OUT, stories), `## Coverage` (counts).
5. Reply: the verdict, the blocker count with the top three, and what to fix first. Never call it ready while a blocker remains; the owner may accept non-critical risks explicitly.
