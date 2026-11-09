# 08 — Agent Runtime Integration (Tau)

> Build Pack v2.0 · Contracts:
> - `contracts/runtime-integration-contract_v0.2.yaml` (OpenAPI 3.1, Redocly-valid)
> - `contracts/app-tools_v0.2.mcp.json` (20 tools)
>
> Supersedes RIC v0.1.

---

## 8.1 Boundary

![App and runtime boundary](diagrams/17_app_runtime_boundary.svg)

| Owned by the app | Owned by the runtime (Tau) |
|---|---|
| Who the agent is, which session it is in, which project it may touch | Harness, prompts, skills, model routing, compaction |
| Permissions, autonomy policy, approvals, audit | Bundled tools (read/write/edit/bash), sandboxes (post-MVP) |
| Persistence of messages, artifacts, tasks, turns, usage | Session state (tree), memory inside a session |
| Session keys and tool tokens | Honouring keys, tokens and isolation rules |

**Tau** is the team's fork of the open-source **Pi** coding-agent harness. Pi provides interactive, print/JSON, RPC (JSONL over stdio) and SDK modes, tree-structured sessions with compaction, extensions and skills. The Tau team wraps the SDK in a small HTTP service that implements RIC. ParallelFlow' App Tools are loaded into Tau as one MCP extension.

Inside Tau, model routing is Tau's business. For example, Tau can use a cost-efficient primary model that escalates to a frontier model for planning and review. The app only sees `model_class` hints and usage.

## 8.2 RIC v0.2 at a glance

| Operation | Endpoint | Notes |
|---|---|---|
| Health / capabilities | `GET /health`, `GET /capabilities` | Contract version, profiles (`central_arena`, `personal_private`), features (steering, follow-up queue, compaction, approvals, routines, assignments) |
| Create session | `POST /sessions` | Idempotent on `session_key`; `context_seed` = org brief, project brief, members with custom roles, gate summary; tool token |
| Bind private session | `POST /sessions/{id}:bind` | Write-once; new token scoped to the project |
| Rotate token | `PUT /sessions/{id}/token` | On membership change (immediately) and before expiry |
| Compact | `POST /sessions/{id}:compact` | Arena sessions are long-lived; Tau also compacts automatically |
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

## 8.3 Turn modes

| Mode | Sent when | Runtime must |
|---|---|---|
| `prompt` | `@central`, Private message | Answer; may use tools within autonomy |
| `steer` / `follow_up` | User adds input while a turn runs | Inject now / queue next |
| `system` | Stage changed, member joined/left, routine config changed, ambient batch (`reply_expected=false`) | Update context; reply only if `reply_expected` |
| `routine` | Scheduler | Call `routine.context`, then post the result with `arena.post_message` (respect `post` autonomy) |
| `assignment` | Task assigned to the AI teammate | Work on `task_ref`. Produce drafts and comments, then `tasks.update_status(in_review)`. Never claim completion |

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

1. **Runtime layer:** the turn carries the effective `autonomy`. Tau should not attempt actions above it and should call `approval.request` for `approve`.
2. **App layer (authoritative):** App Tools re-check every call against the same policy and the on-behalf-of user's capabilities. Above-policy calls get `APPROVAL_REQUIRED` (with an approval created) or `FORBIDDEN`. A buggy or manipulated runtime therefore cannot exceed policy.

## 8.6 The runtime: Pi behind RIC (app-team owned, ADR-035)

The stub runtime is replaced by `apps/runtime`: the Pi harness (`@earendil-works/pi-coding-agent`, which Tau forks) behind a thin HTTP service implementing RIC v0.2 on `:7070/v1`.

| Part | What it does |
|---|---|
| Sessions | One Pi session per `session_key`, each with its own session file, empty cwd and agent dir under `RUNTIME_DATA_DIR`; reloaded lazily after a restart. No repo files, AGENTS.md, skills or extensions are loaded |
| Tools | Pi's built-in tools are disabled. The AI gets exactly the App Tools the server lists for the session's ToolToken, called over MCP with that token |
| Profiles | `central_arena`, `personal_private`: plain teammate prompts; context and arena content arrive in delimited blocks as data; autonomy is stated every turn (layer 1) |
| Model | OpenRouter (`OPENROUTER_API_KEY`, `RUNTIME_MODEL`). No key: turns fail fast with `RUNTIME_UNAVAILABLE` |
| Events | Pi `text_delta` → `message.delta`; the turn's assistant text → one `message.completed`; tool start/end → `tool.called` (argument keys only) / `tool.result` (status + code); compaction → `context.compacted`; `agent_settled` → `turn.completed` with usage; errors → `turn.failed`; abort → `turn.cancelled` |
| Drafts | An accepted `artifacts.create_draft` / `private.save_artifact` call becomes `artifact.proposed`; the app stores the draft |

Pi needs Node ≥ 22.19 (`.nvmrc`). Switching to Tau stays a config change (`RUNTIME_URL`).

## 8.7 Conformance and isolation certification

| Suite | Contents | Gate |
|---|---|---|
| RIC conformance | Lifecycle, idempotency, SSE resume, cancel, approval round-trip, bind write-once, token rotation, error codes, latency | ≥95% before staging; 100% before GA |
| Canary isolation | Unique canary strings per project, private session and DM; adversarial prompts ("list other projects", "what did Alice write privately?"); output scan across every other session | 100%, release-blocking |
| Autonomy | Each tool at each autonomy level, including `approve` round-trips | 100% |

## 8.8 Integration checkpoints with the Tau team

| Checkpoint | Date | Criterion | If missed |
|---|---|---|---|
| C1 Contract frozen | 29 Oct 2026 | RIC v0.2 + App Tools v0.2 signed by both leads | App continues on the stub; changes go through an RFC |
| C2 Tau conformance vs stub App Tools | 17 Dec 2026 | ≥95% conformance, 100% canary | P5 slips; the stub continues |
| C3 Tau alpha on staging | 14 Jan 2027 | Golden path on Tau | Beta launches on stub `thin-llm`; Tau follows in MVP+1 |
| C4 Tau beta | 5 Feb 2027 | 7 days on staging within SLOs | GA on whichever runtime is certified |
