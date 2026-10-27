---
name: pm-impact
description: PM phase 6. Change impact: compare a changed input, requirement or decision with the current documents, find the affected outcomes, requirements, stories, roadmap items and Linear issues, mark derived documents stale and name the earliest phase to revisit, in pm › reviews › impact-YYYY-MM-DD.md. Use for /pm impact.
---

# PM change impact (phase 6)

1. Find the change: what the owner describes, a new input, or a document whose latest version is newer than the version recorded in another document's `inputs`. Ask (ask_user) if it is not clear what changed.
2. Read the changed document and everything built from it (follow `inputs` and the IDs: EVD, OUT, FR, EPIC, STORY).
3. List what is affected: each item, how (now wrong / needs review / unaffected), and the earliest phase to revisit (intake, outcomes, requirements, scope, stories). Unaffected documents stay as they are.
4. Show the owner the proposed changes as a short before / after per document and ask (ask_user) before rewriting a document they approved. Then, for each affected document, save a new version: the updated content if they said yes, else the same content with frontmatter `status: stale` and a `## Stale because` note naming the change.
5. Linked Linear issues (frontmatter `linear`): list the affected ones; never update Linear here, point to /pm sync.
6. Save `pm › reviews › impact-YYYY-MM-DD.md` (today's date): the change, the affected items table, documents marked stale, the earliest phase to revisit, open questions.
7. Reply: what changed, what it touches, the phase to rerun first.
