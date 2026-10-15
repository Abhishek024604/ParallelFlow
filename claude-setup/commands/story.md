---
description: Implement one backlog story end to end
argument-hint: <story-id e.g. F21-03>
---
Implement backlog story **$ARGUMENTS**.

1. Find the row for $ARGUMENTS in `docs/backlog/backlog.csv`. Read its user story, acceptance criteria and "Depends on". If a dependency is not done, stop and tell me.
2. Read the docs, contract sections and screens it touches: schema tables, OpenAPI operations with their `x-required-permission`, RIC/App Tools sections, `docs/design/screens/*.png`.
3. Propose a plan, then **wait for my OK**. The plan should cover:
   - files to create or change;
   - migrations;
   - endpoints;
   - UI states (loading, empty, error, read-only, dark);
   - tests for allowed AND denied paths;
   - any contract question.
4. Implement it. Write the tests first where practical.
5. Run `pnpm lint && pnpm typecheck && pnpm test` and fix until green.
6. Run the `/dod` checklist. Then summarise what changed and commit as `feat(<module>): <summary> [$ARGUMENTS]` on branch `feat/$ARGUMENTS-<short-name>`.
