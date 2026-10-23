# ParallelFlow for VS Code

Turns VS Code into the coding environment for ParallelFlow arenas. You sign in to ParallelFlow, link a folder to an arena, and start a task. The Pi coding agent then works on the task's own branch inside that folder. File edits show up as diffs in the sidebar. Every shell command outside a small read-only allowlist waits for your approval. When the work is done, you push the branch to ParallelFlow and open a pull request there.

## Setup

1. Install dependencies from the repo root with `pnpm install`.
2. Build the extension with `pnpm --filter @parallelflow/vscode build`. This writes `apps/vscode/dist/`.
3. Open `apps/vscode` in VS Code and press **F5** (the launch config is "Run ParallelFlow extension"). A second window opens with the extension loaded.
4. In that window, open a project folder, click the ParallelFlow icon in the activity bar, and choose **Sign in**.

Requirements:
- **Node.js 22.19 or newer** on the PATH, or set `parallelflow.nodePath`. VS Code's built-in Node is too old for Pi.
- **git**.
- A ParallelFlow server at `parallelflow.url` that implements the `/v1/ext/*` and `/v1/llm/*` routes.

To build an installable package, run `pnpm --filter @parallelflow/vscode package`. This writes `dist/parallelflow.vsix`; install it with **Extensions › … › Install from VSIX**. The script runs vsce through `npx`, so no global install is needed.

### Settings

| Setting | Default | What it does |
|---|---|---|
| `parallelflow.url` | `http://localhost:3000` | ParallelFlow web address. Sign-in, model calls, pushes and PRs go here. |
| `parallelflow.commandAllowlist` | `git status`, `git diff *`, `git log *`, `ls *`, `dir`, `pwd`, `cat *`, `npm test`, `pnpm test`, `npm run lint`, `pnpm lint`, `tsc --noEmit`, … | Commands that run without asking. An entry ending in ` *` also matches extra arguments, and every argument must be a path inside the folder. |
| `parallelflow.autoApproveEdits` | `true` | When on, edits inside the folder apply without asking. Turn it off to approve every edit. |
| `parallelflow.approvalTimeoutSeconds` | `300` | An approval left unanswered this long is denied. |
| `parallelflow.nodePath` / `parallelflow.piPath` | `node` / bundled | The Node binary and the Pi CLI to use. |
| `parallelflow.model` | empty (ParallelFlow auto) | Empty: the ParallelFlow extension's `parallelflow/auto` router picks the fast or strong model per request. Set a model id from `GET /v1/llm/models` to pin one. |
| `parallelflow.modelSource` | `parallelflow` | `parallelflow`: model calls go through ParallelFlow. `claude`: they go straight to Anthropic on your own Claude Pro or Max subscription. Run **ParallelFlow: Connect Claude Subscription** and paste the token from `claude setup-token`. Auto routes quick requests to `claude-haiku-4-5` and the rest to `claude-sonnet-5-5`. Set `parallelflow.model` (for example `claude-opus-5-5`) to pin one model. Anthropic's consumer terms may not allow subscription use outside Claude Code, so use it only for your own development. |

## Architecture

```
┌──────────────────────────── VS Code (workspace extension host) ────────────────────────────┐
│ Layer 3 · interface                                                                         │
│   ParallelFlow sidebar (webview, strict CSP, theme variables) · status bar · commands · modals     │
│   sign-in, arena link, task, transcript, diffs, approval cards, Push branch / Open PR       │
│        ▲ state                     │ answers                                                │
│        │                           ▼                                                        │
│   ParallelFlowController ── ApprovalBroker (default deny on timeout) ── ParallelFlow API client (zod)     │
│        │ JSONL over stdio (LF-only framing)            ▲ MCP over http://127.0.0.1:<rand>    │
│        ▼                                               │ Bearer <random per start>           │
│ Layer 2 · intelligence (MCP server "parallelflow_ide", hosted in the extension)                    │
│   file_tree · document_symbols · workspace_symbols · search_text · diagnostics · run_check  │
│   dependencies · import_graph · architecture (.parallelflow/architecture.md)                       │
└────────┬────────────────────────────────────────────────▲──────────────────────────────────┘
         │ spawn: node pi/cli.js --mode rpc (cwd = folder, scrubbed env)                        │
┌────────▼─────────────────────────────────────────────────┴──────────────────────────────────┐
│ Layer 1 · Pi (bundled @earendil-works/pi-coding-agent 1.0.1)                                 │
│   agent loop, model calls, read/write/edit/bash/grep/find/ls, built-in MCP client            │
│   parallelflow-guard extension: folder fence · approvals via extension UI · env scrub · ask_user   │
│   parallelflow-agent (@parallelflow/pi-parallelflow, coder profile): rules · skills · /review · parallelflow/auto router │
│   provider "parallelflow" → <parallelflow.url>/v1/llm (OpenAI-compatible, key = your ParallelFlow token)         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why MCP over localhost for Layer 2.** Pi's built-in MCP client is the documented way to add tools. It runs every MCP call through the same `tool_call` hook, so parallelflow-guard sees these calls too. The tools need the running VS Code (language servers, diagnostics), and a stdio MCP server started by Pi could not reach it. So the extension hosts a Streamable HTTP server instead:
- It binds to 127.0.0.1 on a random port and only accepts loopback `Host` headers.
- Each agent start gets a new 32-byte bearer token, compared in constant time.
- parallelflow-guard registers the server with `pi.registerMcpServer(..., { exposure: 'direct' })`, so the model sees the tools directly.

## Security model

**Folder fence (parallelflow-guard).** Pi loads with `--no-extensions --extension builtin:mcp --extension parallelflow-guard.mjs --extension parallelflow-agent.mjs --skill <dist/skills/…> --prompt-template <dist/prompts/…> --no-approve --no-context-files --no-skills --no-prompt-templates`: only the bundled ParallelFlow skills and templates load. Project `.pi/` config and extensions are ignored, and so are context files from parent folders. parallelflow-guard checks every tool call before it runs:
- **Path arguments** (`read`, `ls`, `find`, `grep`, `write`, `edit`) are normalised the way Pi does it: `@` prefix, Unicode spaces, `/c/...` Git Bash paths, `~`, and `file://` URLs. They are then resolved with `realpath` on the deepest existing parent, so symlinks and junctions are followed. The result must be inside the folder. Windows UNC, device (`\\?\`, `\\.\`), drive-relative (`C:foo`) and alternate-data-stream paths, as well as reserved device names, are blocked. So are dangling symlinks.
- **Glob and search patterns** may not contain `..` or be absolute.
- **`.git/` is never writable**, so hooks cannot be planted. Writes to `.vscode/`, `.devcontainer/`, `.github/workflows/`, `.pi/`, `.parallelflow/` and `.husky/` always ask.
- **Any tool not on the list is blocked.** That includes `powershell` and `codemode`, and MCP tools from any server other than `parallelflow_ide`.

**Approvals.**
- **Edits** inside the folder apply automatically, unless `parallelflow.autoApproveEdits` is off. Everything is in git, so they can be undone.
- **Shell commands** ask every time, unless the command matches the allowlist. A command with `;`, `&`, `|`, a backtick, `$`, `<`, `>`, parentheses, braces, `!`, `#`, `%`, `^`, a backslash, a newline or a wildcard is never auto-approved.
- **The approval card** shows the exact command and its working folder. It offers **Approve**, **Approve for this session**, and **Deny** with an optional reason that is sent back to the agent. "Approve for this session" covers only that exact command, and only until the agent restarts. If the sidebar is hidden, a modal asks instead.
- **Timeouts**: an unanswered request is denied when it times out, and so is any reply the guard does not recognise.
- **`run_check`** (the MCP tool that runs typecheck, lint or test) asks the same way.

**Environment.**
- **Pi's environment is allowlisted.** It gets `PATH`, `HOME`/`USERPROFILE`, `LANG`, `SystemRoot`, `ComSpec`, `APPDATA`, … only. Anything that looks like a secret is dropped even if its name is on the list (`*_KEY`, `*TOKEN*`, `*_URL`, `AWS_*`, `GITHUB_*`, `OPENROUTER*`, `DATABASE*`, `NODE_OPTIONS`, `VSCODE_*`, …).
- **`TEMP`, `TMP` and `TMPDIR` point to `.parallelflow/tmp`** inside the folder. `.parallelflow/` has its own `.gitignore` containing `*`.
- **Tokens are removed before any command runs.** The ParallelFlow token (used for model calls), the Claude subscription token (when connected; kept in VS Code's secret storage) and the MCP token reach Pi as environment variables. parallelflow-guard reads them once and deletes them from `process.env`. It also replaces Pi's bash tool with one whose spawn hook scrubs the environment again. Shell commands never see either token.
- **The token never reaches disk in plain text.** It is stored in VS Code SecretStorage. Pi's config lives in the extension's private storage (`PI_CODING_AGENT_DIR`), never in `~/.pi`.

**Honest limits: commands cannot be fully fenced on the host.**
- **On the host, shell commands run as your user.** The fence covers Pi's file tools, but an approved command (or an allowlisted test/lint script, which runs project code the agent may have just edited) can reach anything your account can.
- **Pi's own security notes say the same.** They state that the working folder is not a boundary for commands. Only approve commands you understand.
- **The fence has gaps.** It cannot see hard links, and a symlink swapped between the check and the use (time-of-check/time-of-use) could escape it.
- **Use a Dev Container for real isolation.** The extension is declared `"extensionKind": ["workspace"]`, so in a Dev Container it runs inside the container, and so do Pi and every command. The sidebar shows **Isolated (Dev Container)** in that case, or **Host — commands need approval** otherwise. If the folder has a `.devcontainer/devcontainer.json`, the sidebar offers **Reopen in Container**. **ParallelFlow: Add a Dev Container config** writes a minimal Node 22 one.

## ParallelFlow server contract (client side)

All types live in `src/parallelflow/api.ts` and are validated with zod at runtime.

| Call | Use |
|---|---|
| `POST /v1/ext/device/code`, `POST /v1/ext/device/token` | Device sign-in. The client polls at `interval`, adds 5 s on `slow_down`, and stops on `expired_token` or `access_denied`. |
| `GET /v1/me`, `GET /v1/arenas` | Who you are and your arenas. `id` is the arena's project id. |
| `GET /v1/llm/models` | Model ids. The client accepts `{data}`, `{items}` or `{models}` with optional `name`, `context_window`, `max_tokens` and `reasoning`. |
| `GET /v1/ext/projects/:p/repo/bundle` | **ParallelFlow: Clone arena repo** (a git bundle). It is cloned into an empty folder, or fetched into `refs/remotes/parallelflow/*` if the folder is already linked. |
| `POST /v1/ext/projects/:p/coding-sessions` | Start a task. The response's `{id, branch, base_sha}` is used to create the branch locally. |
| `POST …/coding-sessions/:id/events` | `progress` (debounced to 30 s), `tests`, `blocked` and `done`. Each is one summary of at most 500 characters, with counts and outcomes only and never code or commands. |
| `POST …/coding-sessions/:id/push` | `git bundle create <tmp> <branch> ^<base_sha>`, sent as `application/octet-stream` (50 MB at most). |
| `POST /v1/ext/projects/:p/pulls` | Opens the PR. The sidebar then links to `<parallelflow.url>/arena/<p>?pr=<number>`. |

A 401 response clears the token and asks you to sign in again.

## Limitations

- **Ephemeral sessions.** The agent runs with `--no-session`, so restarting VS Code or the agent starts a fresh conversation (the branch and its commits stay).
- **Task list.** The sidebar shows the current task and earlier tasks from this folder. ParallelFlow has no endpoint yet for listing open arena tasks.
- **Images.** The bundled Pi has no image-resize module (photon), so image attachments are not supported.
- **Dependency parsers.** These are line-based (no full YAML/TOML parsing). The import graph covers TS/JS only and is regex-based.
- **Symbols and diagnostics** come from whatever language servers are installed and running in VS Code.
