# CI and branch protection

CI is defined in `.github/workflows/ci.yml`. It runs on every pull request and every push to `main`.

| Job | Command | What it checks |
|---|---|---|
| lint | `pnpm lint`, `pnpm format:check` | ESLint (strict TS, module boundaries) and Prettier |
| typecheck | `pnpm typecheck` | `tsc` in every workspace (Turborepo) |
| unit | `pnpm test` | Vitest unit project (`*.test.ts`) |
| integration | `pnpm test:integration` | Vitest integration project (`*.int.test.ts`) with Testcontainers: Postgres 16 + pgvector, Redis 7 |
| build | `pnpm build` | Production build (Next.js web) |
| ci-ok | — | Passes only if every job above passed |

The jobs run in parallel and each has a 10-minute timeout, so a PR is verified in under 10 minutes.

## Make a failing check block merge

A repo admin sets this once in GitHub → Settings → Branches → branch protection rule for `main`:

1. Require a pull request before merging, with 1 approval (doc 11 §11.3).
2. Require status checks to pass before merging, and require branches to be up to date. Add **`ci-ok`** as the required check.
3. Do not allow bypassing these settings.

Or with the GitHub CLI:

```bash
gh api -X PUT repos/<org>/saras/branches/main/protection \
  -F required_status_checks[strict]=true \
  -f required_status_checks[contexts][]=ci-ok \
  -F enforce_admins=true \
  -F required_pull_request_reviews[required_approving_review_count]=1 \
  -F restrictions=null
```

Only `ci-ok` needs to be required. Any job added to its `needs:` list is covered automatically.
