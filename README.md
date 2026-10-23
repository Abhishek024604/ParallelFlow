# ParallelFlow

An AI-native SDLC workspace. Human teams and AI work together in one shared **Arena** per project, backed by a **Private** space for every person, and an SDLC **loop** with team-defined roles and gates.

## Start here
1. Read `CLAUDE.md`. It is the short version of everything and is loaded automatically by Claude Code.
2. Read the full spec in `docs/` (Build Pack v2.0, 00–14). The PDF is the same content for reading offline.
3. Find the target UI in `docs/design/screens/` and the brand rules in `docs/design/ParallelFlow_Brand_Template_v1.md`.
4. Pick work from `docs/backlog/backlog.csv` (77 stories). The YC demo slice plan is in `docs/12_Delivery_Plan.md` §12.2.

## Running it: `pnpm dev` or `pnpm demo`
- `pnpm dev`: for coding. File watchers and hot reload; Next compiles each page the first time you open it (webpack, so the first visit to a page can take a while on a small machine).
- `pnpm demo`: for using or showing the app. Builds the web once (`next build` into `apps/web/.next-demo`, so it never breaks a running `pnpm dev`), then runs web (`next start`), API, App Tools and the AI runtime without watchers. Pages answer in milliseconds once the API cache is warm. `pnpm demo --no-build` reuses the last build; build again after changing web code.
- Both use the same `.env.local` and ports (web 3000, API 4000, App Tools 4200, runtime 7070), so run one at a time.
- Turbopack (`next dev --turbopack`) is not used: it cannot resolve the `./x.js` imports of `.ts` files in `@parallelflow/contracts` (webpack's `extensionAlias`), and Turbopack has no equivalent.
- The API keeps GET responses in memory for up to 30 s, dropped on every write it makes (`apps/api/src/pipeline/read-cache.ts`). Set `API_READ_CACHE=off` to turn it off.

## Using Claude Code
```bash
claude                 # in this folder (VS Code terminal or the Claude Code panel)
/story F21-01          # monorepo + CI scaffold, the first story
/story F21-03          # migrations (schema_v2) + RLS harness
/screen Arena          # build a screen from docs/design/screens
/dod                   # check Definition of Done before committing
/adr "<topic>"         # propose a decision before changing a contract
```

## Layout
- `docs/`: Build Pack v2.0 (00–14), `contracts/`, `design/`, `diagrams/`, `backlog/`
- `apps/`, `packages/`, `infra/`, `tests/`: created by the scaffold stories, following `docs/05_Architecture.md` §5.3
- `.claude/`: project slash commands and permissions for Claude Code
