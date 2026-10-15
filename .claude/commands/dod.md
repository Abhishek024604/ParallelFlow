---
description: Check the current changes against the Definition of Done (doc 11 §11.4)
---
Review the uncommitted changes (`git diff` and `git status`) against `docs/11_Engineering_Handbook.md` §11.4. Report pass/fail with file:line evidence for each item:

- [ ] Acceptance criteria of the story are met
- [ ] API matches `docs/contracts/openapi_v2.yaml`; `x-required-permission` is enforced
- [ ] Authz is tested for allowed and denied paths, including the agent principal where relevant
- [ ] New tables have RLS; tenant and session-isolation tests pass
- [ ] Audit events exist for medium/high-risk actions, and notifications are wired
- [ ] UI has loading, empty, error, read-only and dark states, uses brand tokens only (no hex), and has at most one orange CTA
- [ ] Analytics events carry IDs only; no content, prompts or tokens are logged
- [ ] Docs are updated if behaviour differs from the Build Pack

Fix anything that fails before committing. If a gap is a deliberate slice shortcut, add it to `SLICE_DEBT.md`.
