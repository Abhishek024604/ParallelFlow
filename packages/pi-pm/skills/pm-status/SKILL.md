---
name: pm-status
description: PM status. Show where the product definition stands: which pm/ documents exist, which version the owner approved, what is stale or missing, and the next command. Use for /pm or /pm status.
---

# PM status

1. Call private_list_artifacts with `this_chat: true`. Keep the documents whose names start with `pm › `.
2. For each phase in the flow (intake, outcomes, requirements, scope, stories, review), say in one line: missing, draft (no approval), approved (approved version = latest), or changed since approval (approved version < latest). Read a document only when you need its frontmatter `status` (for `stale`).
3. Reply in at most eight lines: one line per phase that has documents, then the next command. Nothing yet: say "/pm intake" starts it, and that they can paste the idea, goals, notes or customer evidence with it.
