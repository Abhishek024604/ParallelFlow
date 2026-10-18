---
name: write-spec
description: Write or revise a feature spec (PRD) as a draft document. Use when someone asks for a spec, PRD, requirements, acceptance criteria or "write up how X should work".
---

# Write a spec

1. Gather first. Read what exists before writing: in an arena, `artifacts_list` / `artifacts_read` (goal, earlier specs, plans) and `arena_read_history` for what the team said; in a private chat, `private_list_artifacts` / `private_read_artifact` and `files_list` / `files_read`. If a spec with this name exists, read it and save the full new text under the same name (a new version).
2. Ask at most one question (`ask_user`), and only when the audience or scope would change the spec. Otherwise write your assumptions into the spec.
3. Write Markdown with exactly these sections:
   - `# <Feature> spec`
   - **Problem**: who has it and why it matters (2-4 sentences).
   - **Goals** and **Non-goals** (bullets).
   - **Users and flows**: the main flow step by step, then edge cases.
   - **Requirements**: numbered and testable ("The system shows…", not "should be nice").
   - **Acceptance criteria**: Given / When / Then, one for each requirement that matters.
   - **Open questions**: what is undecided, and who should decide it.
   - **Decisions**: decisions already made in the conversation, with who made them.
4. Save it: `artifacts_create_draft` (arena, kind `spec`) or `private_save_artifact` (private chat). Name it `<feature>-spec.md`, lowercase with hyphens.
5. Reply with one line only: "Created <name> (draft) — <one-line gist>". Never paste the spec into the chat.

Keep it short enough to read in five minutes. Prefer concrete examples to adjectives. Never mark anything approved.
