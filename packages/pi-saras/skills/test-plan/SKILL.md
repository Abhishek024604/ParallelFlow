---
name: test-plan
description: Write a test plan for a feature or release as a draft document, from its spec and acceptance criteria. Use when asked for a test plan, QA plan, test cases or "how should we test this".
---

# Write a test plan

1. Read the spec (arena: `artifacts_list` / `artifacts_read`; private chat: `private_list_artifacts` / `private_read_artifact` or `files_read`). Every acceptance criterion must map to at least one test.
2. Write Markdown:
   - `# <Feature> test plan`
   - **Scope**: what is tested and what is not.
   - **Test cases**: a table `| # | Case | Steps | Expected | Type |`, Type one of unit, integration, end-to-end, manual. Cover the happy path, edge cases, errors, permissions (someone who must not see or do it) and data limits.
   - **Environments and data**: what is needed to run them.
   - **Risks**: what is hardest to test and how to reduce the risk.
   - **Exit criteria**: when testing is done.
3. Save it: `artifacts_create_draft` (kind `plan`, name `<feature>-test-plan.md`; kind `test_report` is for results) or `private_save_artifact` in a private chat.
4. Reply with one line: "Created <name> (draft) — <gist>".
