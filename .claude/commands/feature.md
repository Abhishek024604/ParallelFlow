---
description: Build one product feature from the Phase A build order (product first, hardening later)
argument-hint: <feature, e.g. "Create arena">
---
Build **$ARGUMENTS** as a real, working feature (Phase A in CLAUDE.md).

1. Look at the matching screen in `docs/design/screens/`. Read only the doc sections you need. Never read the big contract files in full.
2. If the feature touches more than 5 files, list them in a short plan and wait for my OK. Otherwise just build it.
3. Use the simplest real path: a thin NestJS controller + Kysely, or a Next.js route handler. Keep RLS and `withTenant` on new tables and queries. Use brand tokens only.
4. Add one smoke test for the main action. Don't loop on tests.
5. Add any shortcut to `SLICE_DEBT.md` (one line). Commit `feat(<area>): <summary> [demo]` and tell me how to try it.
