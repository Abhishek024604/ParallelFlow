---
name: review-pr
description: Review a code change (diff or pull request) for correctness, security and tests, with concrete findings. Use when asked to review a PR, a diff, a patch or "check my code".
---

# Review a change

Read the whole change before commenting. If the diff or files are in the arena, read them (`files_read`, `artifacts_read`); if only part of the change is available, say what you could not see.

Look for, in this order:

1. **Correctness**: logic errors, wrong conditions, off-by-one, null or undefined paths, error handling, concurrency and ordering, data loss.
2. **Security**: injection (SQL, shell, HTML), missing authorisation or tenant checks, secrets in code or logs, unsafe input handling, unsafe defaults.
3. **Tests**: is the new behaviour tested, including the failure path? Name the missing test cases.
4. **Simplicity**: dead code, duplication, misleading names. Only when it matters.

Reply format:

- A one-line verdict: "Looks good", "Good with fixes" or "Needs changes".
- **Findings**: a numbered list, most severe first. Each: file and line (or function), what is wrong, why it matters, and the fix in one or two lines (a small snippet if it helps).
- **Tests to add**: bullets.

Be specific and calm: no praise padding, no style nits unless asked. If nothing is wrong, say so in one line. Never approve or merge; a person does.
