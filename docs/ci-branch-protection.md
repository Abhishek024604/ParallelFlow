# CI and branch protection

CI is defined in `.github/workflows/ci.yml`. It runs on every pull request and every push to `main`.

| Job | Command | What it checks |
|---|---|---|
| lint | `pnpm lint`, `pnpm format:check` | ESLint (strict TS, module boundaries) and Prettier |
| typecheck | `pnpm typecheck` | `tsc` in every workspace (Turborepo) |
| unit | `pnpm test` | Vitest unit project (`*.test.ts`) |
| integration | `pnpm test:integration` | Vitest integration project (`*.int.test.ts`) with Testcontainers: Postgres 16 + pgvector, Redis 7 |
| build | `pnpm build` | Production build (Next.js web) |
| contract | `pnpm contract:lint`, then oasdiff | Redocly lint of `docs/contracts/openapi_v2.yaml` (errors fail, warnings don't). oasdiff fails on ERR-level breaking changes against the base (see below) |
| ci-ok | — | Passes only if every job above passed |

The jobs run in parallel and each has a 10-minute timeout, so a PR is verified in under 10 minutes.

## Contract check (oasdiff)

The `contract` job blocks breaking HTTP API changes (doc 07 §7.1: `/v1` is additive only; a breaking change needs `/v2` and an ADR).

- **Pull requests:** compares the spec at the PR's base commit with the PR head.
- **Pushes to `main`:** compares with the commit `main` pointed to before the push. Merges arrive through PRs, so this is a backstop.
- **Skips (with a notice, never fails)** when there is no base: the spec does not exist on the base yet, the push created the branch, or the base commit is gone after a force push.
- The spec never leaves CI: the oasdiff action runs with `review: false` (no upload to oasdiff.com) and no PR comments.
- Pinned versions: `oasdiff/oasdiff-action/breaking` v0.1.17 (oasdiff v1.32.1), `@redocly/cli` 2.57.0 (root `package.json`).

Locally, `pnpm contract:lint` runs the same Redocly lint. There is no local breaking-change script, because oasdiff is a Go binary. To check by hand, install the [oasdiff CLI](https://github.com/oasdiff/oasdiff) and run `git show main:docs/contracts/openapi_v2.yaml > /tmp/base.yaml && oasdiff breaking /tmp/base.yaml docs/contracts/openapi_v2.yaml --fail-on ERR`.

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
