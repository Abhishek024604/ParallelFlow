# 08 — Agent Runtime Integration (Pi today, Tau later)

> Build Pack v2.0 · Contracts:
> - `contracts/runtime-integration-contract_v0.2.yaml` (OpenAPI 3.1, Redocly-valid; at v0.2.1, every addition optional)
> - `contracts/app-tools_v0.2.mcp.json` (20 tools in v0.2; 26 listed today)
>
> Supersedes RIC v0.1.

---

## 8.0 Where we are (Nov 2026)

- **Today the runtime is the Pi harness in `apps/runtime`**, owned by the app team (ADR-035, 17 Oct). It wraps `@earendil-works/pi-coding-agent` in a thin HTTP service on `:7070/v1` that implements RIC v0.2. Models come from **OpenRouter**, chosen per request by the `parallelflow/auto` router (FAST / STRONG tiers plus fallbacks), sent through a pool of OpenRouter keys. A person or an arena can bring their own provider key (ADR-043).
- Everything the AI does that is ParallelFlow-specific is a **Pi extension**: `packages/pi-parallelflow` (always loaded), and the private extensions `packages/pi-swa` (SWA, doc 15) and `packages/pi-pm` (Product Manager), loaded only in the private chats of people who installed them (ADR-039).
- **Tau** (the separate team's fork of Pi) is a later drop-in behind the same contract. Switching is a change of `RUNTIME_URL` once Tau passes the conformance kit (§8.7). The scripted / thin-LLM stub runtime this doc used to describe was not built: the `apps/stub-runtime` placeholder was replaced by the Pi runtime (ADR-035).
- The app still owns everything on the left of the boundary below; nothing in the app depends on Pi directly.

## 8.1 Boundary

![App and runtime boundary](diagrams/17_app_runtime_boundary.svg)

| Owned by the app | Owned by the runtime (Pi today, Tau later) |
|---|---|
| Who the agent is, which session it is in, which project it may touch | Harness, prompts, skills, model routing, compaction |
| Permissions, autonomy policy, approvals, audit | Bundled tools (read/write/edit/bash, disabled in the app runtime), sandboxes (post-MVP) |
| Persistence of messages, artifacts, tasks, turns, usage | Session state (tree), memory inside a session |
| Session keys and tool tokens | Honouring keys, tokens and isolation rules |

**Pi** is an open-source coding-agent harness: interactive, print/JSON, RPC (JSONL over stdio) and SDK modes, tree-structured sessions with compaction, extensions, skills and prompt templates. `apps/runtime` uses the SDK mode; the VS Code extension uses RPC mode (§8.10). **Tau** is the team's fork of Pi; the Tau team will wrap it in its own HTTP service that implements RIC.

Model routing is the runtime's business. The app sees only usage and, when the person chose one, passes their own key (`model_key`, §8.6.4).

## 8.2 RIC v0.2 at a glance

| Operation | Endpoint | Notes |
|---|---|---|
| Health / capabilities | `GET /health`, `GET /capabilities` | Contract version, profiles (`central_arena`, `personal_private`), features (steering, follow-up queue, compaction, approvals, routines, assignments) |
| Create session | `POST /sessions` | Idempotent on `session_key`; `context_seed` = org brief, project brief, members with custom roles, gate summary; tool token |
| Bind private session | `POST /sessions/{id}:bind` | Write-once; new token scoped to the project |
| Rotate token | `PUT /sessions/{id}/token` | On membership change (immediately) and before expiry |
| Compact | `POST /sessions/{id}:compact` | Arena sessions are long-lived; the runtime also compacts automatically (Pi, with ParallelFlow's compaction focus, §8.6.5) |
| Turn | `POST /sessions/{id}/turns` | `turn_id` idempotent; `mode` = prompt / steer / follow_up / system / **routine** / **assignment**; `autonomy` (effective policy); `task_ref` / `routine_ref`; `app_state` (cycle, stage) |
| Events | `GET …/turns/{turn}/events` (SSE) | `turn.started`, `message.delta`, `message.completed`, `step`, `tool.called`, `tool.result`, `approval.requested`, `artifact.proposed`, `context.compacted`, `turn.completed` (usage), `turn.failed`, `turn.cancelled` |
| Cancel | `POST …/turns/{turn}:cancel` | — |
| Resolve approval | `POST /sessions/{id}/approvals/{aid}` | Human decision relayed by the app |

**Isolation rules (MUST, certified by the conformance kit):**
1. No state, memory, cache or compaction shared between sessions.
2. A session never receives content for any project other than its scope or binding.
3. A token is used by one session only.
4. `turn_id` is idempotent.
5. No secrets or tokens appear in events.

**Additive fields since v0.2 (v0.2.1 in the YAML, all optional; older apps and runtimes ignore them):**
- Capabilities: `profiles[].commands` (slash commands the profile accepts), `profiles[].skills`, and the feature flags `ephemeral_fork`, `commands`, `questions`, `connectors`; a `connectors` list of external MCP servers the harness runs per profile.
- CreateTurnRequest: `skill` (run one of the profile's skills on the input), `ephemeral_fork` (run on an in-memory copy of the session's history: nothing is written to the session, and it may run beside another turn) with its own optional read-only tool token, `task_ref`, `routine_ref`, `context` (arena brief, members, bridge text).
- Event: `question.asked` (the AI asks a multiple-choice question; the app shows a question card).
- ParallelFlow additions carried by `packages/runtime-client` types but **not yet written into the YAML**: `extensions` (private turns: installed extension keys and, for PM, the Linear key; ADR-039) and `model_key` ({provider, model, api_key}, or null = pool, absent = keep; ADR-043).

## 8.3 Turn modes

| Mode | Sent when | Runtime must |
|---|---|---|
| `prompt` | `@central`, Private message | Answer; may use tools within autonomy |
| `steer` / `follow_up` | User adds input while a turn runs | Inject now / queue next |
| `system` | Stage changed, member joined/left, routine config changed, ambient batch (`reply_expected=false`) | Update context; reply only if `reply_expected` |
| `routine` | Scheduler | Call `routine.context`, then post the result with `arena.post_message` (respect `post` autonomy) |
| `assignment` | Task assigned to the AI teammate | Work on `task_ref`. Produce drafts and comments, then `tasks.update_status(in_review)`. Never claim completion |

**As built (Phase A):** the app sends `prompt` (`@AI` in an arena, every private message) and `system` (gate decisions, send-backs, new members). A person's message sent while a turn runs waits in the runtime's per-session follow-up queue (in memory). Summaries, STATE.md and the nightly memory run as `ephemeral_fork` turns with a skill. `routine` and `assignment` are not used yet.

## 8.4 App Tools v0.2 (20)

| Tool | Autonomy class | Side effect | Notes |
|---|---|---|---|
| `arena.read_history`, `project.get_overview`, `members.list`, `cycle.get_state`, `artifacts.list`, `artifacts.read`, `tasks.list`, `knowledge.search`, `routine.context` | answer | read | Scoped to `token.project_id` |
| `arena.post_message` | post | write | Central agent only |
| `notify.tag` | notify | write | Tags members or roles |
| `artifacts.create_draft` | draft_artifacts | write | Drafts never auto-approve |
| `private.save_artifact` | — | write | Personal agent, Private only |
| `bridge.propose_push` | — | write-confirm | Creates a confirmation card; the user pushes |
| `tasks.create_draft`, `delegation.suggest` | tasks | write / confirm | A human accepts |
| `tasks.update_status`, `tasks.comment` | assigned_work | write | `update_status` only on the agent's own assignment; never `completed` |
| `stage.request_gate` | request_gate | write | Creates approval; humans vote |
| `approval.request` | (any) | write | For actions the policy marks `approve` |

**Added since v0.2 (in the contract file, 26 tools in all):** `files.list`, `files.read` (arena and private file text, including PDF text), `private.list_artifacts`, `private.read_artifact`, `ask.question` and `memory.recall` (read-only search of the arena's knowledge graph, ADR-045; class `answer`). The Pi runtime hides `ask.question` from the model: questions go through the extension's own `ask_user` tool instead (§8.6.5).

**Never exposed to any agent:**
- vote on approvals;
- verify or complete tasks;
- manage members, roles or access requests;
- change gate or agent policy;
- manage routines;
- push to an Arena without user confirmation;
- archive projects;
- send DMs.

## 8.5 Autonomy enforcement (two layers)

1. **Runtime layer:** the turn carries the effective `autonomy`. The runtime should not attempt actions above it and should call `approval.request` for `approve`. In Pi this is the ParallelFlow extension's `tool_call` hook (`packages/pi-parallelflow/src/autonomy.ts`): a tool the turn's policy forbids is blocked before App Tools sees the call, with a reason the model reads and explains.
2. **App layer (authoritative):** App Tools re-check every call against the same policy and the on-behalf-of user's capabilities. Above-policy calls get `APPROVAL_REQUIRED` (with an approval created) or `FORBIDDEN`. A buggy or manipulated runtime therefore cannot exceed policy.

## 8.6 The runtime: Pi behind RIC (app-team owned, ADR-035)

`apps/runtime` is the Pi harness (`@earendil-works/pi-coding-agent`, which Tau forks) behind a thin HTTP service implementing RIC v0.2 on `:7070/v1`. Every call from the API carries a short-lived HS256 service JWT (`RUNTIME_JWT_KEY`, audience `parallelflow-runtime`). Pi needs Node ≥ 22.19 (`.nvmrc`); on an older Node the service still answers RIC calls and every turn fails fast with `RUNTIME_UNAVAILABLE`. The port opens before Pi finishes loading, so health checks answer at once.

### 8.6.1 Sessions and isolation

| Part | What it does |
|---|---|
| Sessions | One Pi session per `session_key`, each with its own session file, empty cwd and agent dir under `RUNTIME_DATA_DIR` (no global `~/.pi` config); reloaded lazily after a restart. Each session has its own model runtime and its own extension closure, so two sessions (two arenas, or an arena and a private chat) share nothing |
| Discovery off | No repo files, AGENTS.md, context files, themes or other discovery. The only extensions are ParallelFlow's (and SWA / PM when installed, private chats only); the only skills and prompt templates are theirs |
| Tools | Pi's built-in tools (read, write, edit, bash, …) are never enabled. The AI gets exactly the App Tools the server lists for the session's tool token, called over MCP with that token, plus the extension's `ask_user` and `load_skill`, SWA's `swa_*` tools when installed, the allowed tools of the enabled connectors, and the Vercel tools (arena) |
| Profiles | `central_arena` (the arena's AI teammate) and `personal_private` (a person's private assistant). Context and arena content arrive in delimited blocks as data; autonomy is stated every turn (layer 1). The `coder` profile runs in VS Code, not here |
| Ephemeral forks | Summaries, STATE.md and the nightly memory read the parent session file into an in-memory session: nothing is written, the parent's history is untouched, and connectors are not started |
| Turn limits | 15 minutes by default (`limits.timeout_s`, at most 30 min), so long design runs finish. Turn event logs stay in memory 15 min after the turn ends (resume buffer; lost on restart, SLICE_DEBT) |

### 8.6.2 Events

Pi `text_delta` → `message.delta` (through the stream sanitizer, §8.6.6); the turn's assistant text → one `message.completed`; tool start/end → `tool.called` (argument keys only) / `tool.result` (status + code); compaction → `context.compacted`; `agent_settled` → `turn.completed` with usage; errors → `turn.failed`; abort → `turn.cancelled`. An accepted `artifacts.create_draft` / `private.save_artifact` call becomes `artifact.proposed` and the app stores the document. `ask_user` becomes `question.asked`. Tool arguments and results never reach an event.

### 8.6.3 Models and routing (OpenRouter)

- **Provider:** OpenRouter, reached through Pi's own OpenRouter provider. Models come from the environment only, with no built-in defaults. Models newer than Pi's bundled list get their real limits from OpenRouter's live catalog (a generated `models.json` in the data folder).
- **`parallelflow/auto`**, a Pi virtual model (`packages/pi-parallelflow/src/router.ts`), picks per request:
  - `RUNTIME_MODEL` set → that one model for everything (forced);
  - otherwise `RUNTIME_MODEL_FAST` for quick conversational replies and `RUNTIME_MODEL_STRONG` for documents, specs, plans, code, summaries, reviews and long or tool-heavy requests (a tier left unset uses the other);
  - a continuation stays on the model that handled the turn (prompt cache), except that a FAST turn that turns tool-heavy moves to STRONG once; compaction and other one-off calls use STRONG;
  - on overload, rate limit, 5xx or timeout, the next model in the chain, ending with `RUNTIME_FALLBACK_MODELS` in order (unset = no fallback); other errors retry on the same model;
  - thinking level per job: chat off, documents/code/review high, summaries medium, clamped to what the model supports; models that refuse reasoning off get it on.
- **Key pool:** with several keys in `OPENROUTER_API_KEYS` (plus `OPENROUTER_API_KEY`), Pi is pointed at a relay on 127.0.0.1 (`apps/runtime/src/key-relay.ts`) that sends each request on with the next key that is not rate limited and streams the answer back. Pi holds only a stand-in key. Bodies, prompts and keys are never logged, only a key's position in the pool. A model's refusal does not rest every key.
- **No key, no model:** sessions work and every AI turn fails fast saying so (`RUNTIME_UNAVAILABLE`; the web shows "AI isn't connected yet").

### 8.6.4 Own AI keys (ADR-043)

A reply turn may carry `model_key` ({provider, model, api_key}). The runtime sets it on that session's model runtime in memory only (an OpenRouter key gets a provider of its own, so the pool and the key relay are untouched), routes every request to it first and, when the provider refuses it, answers with the pool chain for the rest of that request, logging only provider and status. `null` = back to the pool; absent = keep the current choice.

### 8.6.5 Pi extensions, skills and slash commands

**`packages/pi-parallelflow`** (every session, and the VS Code coder): one factory call per session, all state in its closure.

| Hook / tool | What it does |
|---|---|
| `before_agent_start` | System prompt sections: identity, how to work, house rules, arena brief, team, cycle and stage, autonomy, bridge snapshot, skill list, this turn's context |
| `tool_call` | Autonomy layer 1 (§8.5); also checks connector calls against the catalog's allowed tools |
| `tool_result` / `message_end` | Remembers the documents saved this run; replaces the final message with a cleaned one (guardrails) |
| `session_before_compact` | Pi's compaction with ParallelFlow instructions: keep decisions (who, when, exact wording), owners, open questions, current cycle and stage, and every document name; never ids, tokens or keys |
| `ask_user` | Multiple-choice questions (2–5 options, an optional "Other…" typed answer, question ≤ 300 characters). In the runtime the UI bridge turns it into `question.asked` and ends the turn; the person's answer from the question card arrives as their next message. In VS Code it is answered live |
| `load_skill` | Loads a skill's instructions on demand |
| `parallelflow/auto` | The virtual model (§8.6.3) |

**Skills** (`packages/pi-parallelflow/skills`): arena: `write-spec`, `plan-cycle`, `gate-readiness`, `review-pr`, `test-plan`, `release-notes`, `summarize-state`, `extract-memory`, `narrate-day`, `progress-entry`, `architecture-diagram`; private: `write-spec`, `test-plan`, `release-notes`, `architecture-diagram`; coder: `review-pr`, `test-plan`.

**Slash commands** (prompt templates, typed in the composer as `/name args`): arena `/spec`, `/plan`, `/review`, `/summarize`, `/tasks`, `/gate`, `/diagram`; private `/spec`, `/summarize`, `/tasks`, `/diagram`, plus `/swa` and `/pm` when those extensions are installed; coder `/review`. The runtime lists them in Capabilities (`profiles[].commands`) for the web's menu.

**Private extensions (ADR-039).** A person installs an extension once for all their private chats from the Private sidebar; each private turn carries the installed keys (`extensions`), and the runtime rebuilds the session's harness when they change. The arena's AI never loads one.
- **`packages/pi-swa`** — SWA, the software architect's assistant (doc 15): intake, stack, HLD with `model.yaml` and generated diagrams, LLD per component, conformance review and change impact. In a private chat its `arch/` files are the chat's documents, read and written only through that session's App Tools. Also runs in the VS Code coder (Architect mode).
- **`packages/pi-pm`** — the Product Manager: workflows and phase skills only (the agent proposes and documents, the product owner decides; no gate enforced in code). `pm/` files are the chat's documents. Linear is its connector, with the person's own sealed key, after the person confirms.

### 8.6.6 Guardrails

Ported from the API's output filter and paste guard (which stay in the API as a backstop), they run inside the harness:
- the AI's text never shows internal ids (UUIDs), secrets, tool names or field names: the stream sanitizer holds back live deltas until such a token can be seen whole, and `message_end` cleans the final message;
- a document the AI saved is shown as a file card; a reply that pastes the saved document's content is replaced by a one-line "created" note (paste guard);
- arena and private content reach the model as fenced data, never as instructions;
- Pi's built-in file and shell tools are off, so the AI acts only through App Tools under the two autonomy layers.

### 8.6.7 Connectors and deploy tools

External MCP servers run through Pi's own MCP client, one per session, with only the catalog's tools allowed (`RUNTIME_CONNECTORS`; catalog `packages/pi-parallelflow/src/connectors.ts`): **draw.io** (default; a pinned package run with the runtime's Node in a sandbox: Node permission model, no child processes, an environment built from nothing), **Sentry** and **Semgrep** (vendors' hosted servers over HTTP, arena AI only, read-only), and **Linear** (PM extension). The arena's AI also gets three read-only **Vercel** REST tools (`apps/runtime/src/vercel.ts`, `VERCEL_TOKEN`). Ephemeral forks get no connectors. Doc 05 §5.15 has the details.

### 8.6.8 Moving to Tau

Tau must implement the same RIC (including the v0.2.1 optional fields it advertises in Capabilities), honour the isolation rules, and call back only through App Tools. The ParallelFlow behaviour above lives in Pi extensions, skills and prompt templates, so it can be loaded into Tau (a Pi fork) unchanged. The switch is `RUNTIME_URL`, after §8.7 and the §8.8 checkpoints.

## 8.7 Conformance and isolation certification

| Suite | Contents | Gate |
|---|---|---|
| RIC conformance | Lifecycle, idempotency, SSE resume, cancel, approval round-trip, bind write-once, token rotation, error codes, latency | ≥95% before staging; 100% before GA |
| Canary isolation | Unique canary strings per project, private session and DM; adversarial prompts ("list other projects", "what did Alice write privately?"); output scan across every other session | 100%, release-blocking |
| Autonomy | Each tool at each autonomy level, including `approve` round-trips | 100% |

**Status (Nov 2026):** none of these suites is built yet (Phase B). Today the runtime has unit tests and one isolation integration test (`apps/runtime/src/isolation.int.test.ts`). The suites will certify the Pi runtime first, then Tau.

## 8.8 Integration checkpoints with the Tau team

"The Pi runtime" below means `apps/runtime`, which plays the role the stub was planned to play.

| Checkpoint | Date | Criterion | If missed |
|---|---|---|---|
| C1 Contract frozen | 29 Oct 2026 | RIC v0.2 + App Tools v0.2 signed by both leads | App continues on the Pi runtime; changes go through an RFC. (Status: the app has since added optional v0.2.1 fields and tools, listed in §8.2 and §8.4; they need to be agreed with the Tau team) |
| C2 Tau conformance vs App Tools | 17 Dec 2026 | ≥95% conformance, 100% canary | P5 slips; the Pi runtime continues |
| C3 Tau alpha on staging | 14 Jan 2027 | Golden path on Tau | Beta launches on the Pi runtime; Tau follows in MVP+1 |
| C4 Tau beta | 5 Feb 2027 | 7 days on staging within SLOs | GA on whichever runtime is certified |

## 8.9 Runtime configuration

| Variable | Meaning |
|---|---|
| `RUNTIME_URL` (API side, includes `/v1`), `RUNTIME_PORT` (default: the port of `RUNTIME_URL`, else 7070) | Where the runtime listens. Unset `RUNTIME_URL` in the API = AI not connected |
| `RUNTIME_JWT_KEY` | ≥ 32 chars, same value in the API and the runtime |
| `OPENROUTER_API_KEY`, `OPENROUTER_API_KEYS` | One key, or a comma-separated pool (key relay) |
| `RUNTIME_MODEL`, `RUNTIME_MODEL_FAST`, `RUNTIME_MODEL_STRONG`, `RUNTIME_FALLBACK_MODELS` | OpenRouter model ids (`<vendor>/<model>`); §8.6.3 |
| `RUNTIME_DATA_DIR` | Session files (default `apps/runtime/.data`; `/data` volume in the demo deploy) |
| `RUNTIME_CONNECTORS` | Comma-separated connectors (default `drawio`); `SENTRY_AUTH_TOKEN` for Sentry |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Vercel deploy tools (empty = none) |
| `APP_TOOLS_URL` | The MCP endpoint handed to Pi as the tool token's `mcp_url` |

## 8.10 The coding agent in VS Code

The VS Code extension (`apps/vscode`, ADR-037, ADR-042) runs Pi locally in RPC mode with the `coder` profile of `pi-parallelflow` (and SWA in Architect mode), inside a folder fence with approval cards. Unlike the app runtime, this agent has file and shell tools, limited to the open folder. Its model calls go through the API's `/v1/llm/*` proxy with ParallelFlow's key pool and the same `parallelflow/auto` routing, or through the developer's own Claude subscription. It never receives the developer's GitHub token: the extension, not the agent, pushes branches and opens pull requests.
