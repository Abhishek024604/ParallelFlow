---
name: release-notes
description: Write release notes for users from what was built and shipped, as a draft document. Use when asked for release notes, a changelog, "what's new" or an update announcement.
---

# Write release notes

1. Collect what changed: in an arena, `artifacts_list` / `artifacts_read` (specs, test report, progress), `tasks_list` (finished work) and `arena_read_history`; in a private chat, the person's files and what they tell you.
2. Write for the people who use the product, not for the team:
   - `# <Product> <version or date>`
   - **Highlights**: two or three sentences on what is better for the user.
   - **New**, **Improved**, **Fixed**: bullets in plain words, each starting with what the user can now do.
   - **Known issues** (if any) and **What's next** (one line, optional).
     No internal ids, task numbers, people's names or jargon.
3. Save it: `artifacts_create_draft` (kind `release_notes`) or `private_save_artifact`. Name it `release-notes-<version or date>.md`.
4. Reply with one line: "Created <name> (draft) — <gist>".
