# 10 — Security, Privacy & Compliance

> Build Pack v2.0 · Supersedes v1.0 doc 07 where they differ.

---

## 10.1 Security principles

1. **The backend and database enforce boundaries.** The UI and prompts never do.
2. **Private is private.** No role, admin or agent can read another person's Private space.
3. **Oversight is not access.** Dashboards show status, never content.
4. **AI is a least-privileged delegate.** Agent permission = human ∩ project autonomy ∩ org ceiling ∩ invariants.
5. **Every consequential action is attributable.** Actor, on-behalf-of, decision, reason. Append-only.

## 10.2 Threat model (top risks)

| # | Threat | Mitigations | Residual |
|---|---|---|---|
| T1 | Cross-tenant data leak | FORCE RLS on 41 tables; org-prefixed cache keys; tenant suite in CI | Low |
| T2 | Private content exposed (to team, admin or agent) | RESTRICTIVE RLS; bridge is the only path; push copies the artifact only; canary suite | Low |
| T3 | Agent reads or acts on the wrong project | Session keys, write-once bind, scoped tool tokens, App Tools scope check, canary suite | Low |
| T4 | Prompt injection makes the agent act beyond intent | Autonomy policy enforced in App Tools (not in the prompt); human-only invariants; approvals for risky classes; org ceiling. As built: Pi's built-in file and shell tools are off in the app runtime; content reaches the model as fenced data; autonomy is checked in the harness and again in App Tools; connectors expose only catalogued read-only tools (doc 08 §8.6) | Medium → Low |
| T5 | Privilege escalation via custom roles | Only `role.manage` holders edit roles; ≥1 owner; capability catalogue fixed in code; audit of every role change | Low |
| T6 | Self-approval / collusion on releases | `forbid_self_approval`, `min_approvals`, `min_distinct_roles`; votes audited | Low |
| T7 | Stale access after people leave or move | SCIM deprovisioning (sessions revoked < 60 s); guest expiry; mover notices to team owners | Low |
| T8 | Credential / token theft | WorkOS sessions; HttpOnly cookies; tool tokens ≤60 min bound to one session; secrets in AWS Secrets Manager; log redaction. As built: extension bearer tokens stored only as SHA-256; own AI keys and connection credentials sealed with AES-256-GCM; GitHub tokens never stored (§10.4.1) | Low |
| T9 | Denial of wallet (runaway agent use) | Per-org budgets, per-user turn rate limits, routine min interval 1 h, ambient batching. As built: 30 AI turns per minute per person (in memory), an `llm` rate-limit bucket for the extension's model proxy, a 15-minute default turn limit; budgets not built | Low |
| T10 | Malicious file upload | Pre-signed uploads, type and size checks, virus scan, no inline HTML rendering. As built: type allowlist, magic-byte sniffing, 10 MB cap, safe download headers; no virus scan yet (SLICE_DEBT) | Low |
| T11 | Webhook spoofing (WorkOS / GitHub) | Signature verification, delivery-id dedupe. As built for GitHub: `X-Hub-Signature-256`, then a credential scope that sees only that repo or installation, and each delivery id processed once (ADR-040) | Low |
| T12 | A connector or third-party MCP server leaks data or keys | draw.io runs pinned from the lockfile in a Node permission sandbox with an empty environment; remote connectors get only their own key as a header; only catalogued tools are allowed; the code Semgrep scans is sent to Semgrep (stated in `.env.example`) | Medium |

## 10.3 Identity and access

- **Login and sessions:**
  - WorkOS AuthKit (Google, Microsoft, magic link) and enterprise SSO (SAML / OIDC).
  - `require_sso` policy per org.
  - Sessions: 12 h absolute / 2 h idle. Admin screens require re-authentication after 30 min.
  - **As built (F01-01, ADR-032):** `parallelflow_session` holds the WorkOS sealed session inside an HMAC-signed envelope with our user id, issued-at, last-seen and the session's CSRF token. The API enforces both limits from those timestamps on every request (no session table) and re-issues last-seen at most every 5 min. An expired WorkOS access token is refreshed once and the cookie re-set. Logout revokes the WorkOS session. A login needs an email that WorkOS has verified; deactivated accounts cannot sign in. Admin re-authentication is not built yet.
- **VS Code extension (ADR-037):** signs in with a device code that the person approves in the web app; the API then issues a bearer token valid 30 days and revocable. The device code and the bearer token are stored only as **SHA-256 hashes** (`ext_device_codes`, `ext_access_tokens`) and looked up under a transaction-local credential scope (`app.credential` = the hash, or the short user code the person types), never by a SECURITY DEFINER function. The extension's model calls go through the API (`/v1/llm/*`), so no provider key sits on a laptop. Phase A gaps (SLICE_DEBT): tokens have no scopes, expired device codes are never deleted, and a revoke takes up to 30 s on other API instances.
- **Arena roles in Phase A:** owner/member checks plus project-role capabilities (ADR-036 for gate approvers); the full authz library is Phase B.
- **SCIM via WorkOS Directory Sync:** users, deprovisioning, groups → units (P1 within the MVP window).
- **RBAC:** org roles, unit roles, team roles and project roles with 27 capabilities, as defined in doc 03.
- **Break-glass:** there is no admin path to Private content in the MVP. Legal-hold export requires two org owners and is post-MVP.

## 10.4 Data protection

| Data | At rest | In transit | Notes |
|---|---|---|---|
| PostgreSQL | RDS encryption (KMS) | TLS 1.2+ | PITR 14 days |
| S3 artifacts / files | SSE-KMS, versioning | TLS | Audit archive in Object Lock |
| Redis | Encryption at rest + in transit | TLS | No content, ids only |
| Secrets | AWS Secrets Manager | — | Rotated quarterly |
| Model traffic | — | TLS | Runtime uses providers with zero-retention terms; content never used for training |

Data region: ap-south-1 (Mumbai) for the MVP. Others on demand.

The table above is the production target. In Phase A the data is in Neon Postgres (dev) and file bytes are in Postgres (`blobs.content`), not S3; there is no Redis; secrets are environment variables (`.env.local`, or `.env.production` on the demo VM, never committed).

### 10.4.1 Secrets and credentials at rest (as built)

| Secret | How it is kept | Decision |
|---|---|---|
| Own AI provider keys (per person or per arena) | Checked once with the provider, then sealed by the API with **AES-256-GCM** under a key derived (HKDF-SHA256) from `WORKOS_COOKIE_PASSWORD`; only the last 4 characters are readable. A person's key is owner-only under RLS; an arena's key is readable as provider/model/last 4 by members and writable only by the owner. Passed to the runtime per turn and held in memory only | ADR-043 |
| Connection credentials (Linear key for the PM extension) | Sealed the same way in `user_connections`, owner-only RLS | ADR-039 |
| Extension device codes and bearer tokens | SHA-256 hash only (30-day, revocable tokens) | ADR-037 |
| GitHub: the person's OAuth token at connect | Used once to check the person can use the installation, then dropped. Never stored | ADR-040 |
| GitHub: the developer's token in VS Code | VS Code's own GitHub session. Never sent to or stored by ParallelFlow, passed to git only as `GIT_CONFIG_*` environment of that one process (never argv, remote URL or `.git/config`), never given to the Pi agent or its shell | ADR-042 |
| GitHub App installation tokens | Minted on demand, limited to one repo, cached in memory until 5 min before expiry, never stored or logged, given to git only through `GIT_CONFIG_*` | ADR-040 |
| GitHub connect state and repo grants | HMAC-signed with a key derived from `WORKOS_COOKIE_PASSWORD`, 15 minutes | ADR-040 |
| OpenRouter pool keys, `SENTRY_AUTH_TOKEN`, `VERCEL_TOKEN` | Runtime environment only; never written to disk, never in a prompt, event or log. Connectors run with an environment built from nothing, so they never see these keys | ADR-035 |
| Service-to-service | `RUNTIME_JWT_KEY` (API → runtime, short-lived HS256 JWT) and `TOOL_TOKEN_KEY` (session-scoped tool tokens ≤ 60 min, API signs, App Tools verifies) | ADR-035 |

Known gaps (SLICE_DEBT): rotating `WORKOS_COOKIE_PASSWORD` orphans every sealed key and connection; a secret store or KMS replaces the derived key in Phase B. One server-wide Sentry and Vercel account serves every arena.

### 10.4.2 Deletion and the audit trail

- **Soft delete (ADR-038, migration 0009):** files (`artifacts`) and arenas (`projects`) get `deleted_at` / `deleted_by`. RESTRICTIVE `FOR SELECT` policies hide deleted rows from app roles; system jobs still see them, and history is kept for audit. Only the arena owner archives (reversible, read-only), unarchives, renames or deletes an arena and deletes arena files; a person deletes their own private files. Deleting a private project moves its chats to Recent. There is no restore UI or retention purge yet.
- **Hash-chained activity log (ADR-044, migration 0016):** every API change to an arena writes one `audit_events` row. A BEFORE INSERT trigger chains each arena's rows (org-level rows per org) under an advisory lock and sets `hash = sha256(prev_hash || canonical row)` with fixed keys and UTC times; the app never computes or sends a hash, so it cannot forge one, and the existing append-only trigger forbids updates and deletes. A RESTRICTIVE SELECT policy lets only the arena's members and system jobs read its rows. Metadata is ids, names, counts and refs only, never message or file content. A verify-chain job and export are Phase B.
- **Memory (ADR-045):** the knowledge graph tables have no DELETE grant and are written only by system jobs; reads are members-only. STATE.md goes to a GitHub repo only when the repo is private.

## 10.5 Application security controls

| Control | Implementation |
|---|---|
| Input validation | Zod on every boundary; size limits (message 20 KB, artifact 2 MB, file 100 MB) |
| Output encoding | Markdown sanitised (`rehype-sanitize`); no raw HTML from users or agents |
| CSRF | SameSite=Lax cookies + double-submit token: `X-CSRF-Token` must equal the session's token (also in the readable `parallelflow_csrf` cookie) on POST, PUT, PATCH and DELETE, else 403. The token lives in the signed session, so a cookie planted by a sibling subdomain does not pass. Login uses `state` + PKCE. CORS allows only `WEB_ORIGIN`, with credentials |
| CSP | Strict CSP with nonces; `frame-ancestors 'none'` |
| SSRF | The app fetches only fixed hosts: WorkOS, GitHub's API, the AI provider's own API (once, to check an own key), OpenRouter's model catalog, and the vendors' MCP servers and Vercel's API from the runtime. No user-supplied URL is fetched. The draw.io connector's network stays open (its shape search fetches an index) |
| Dependencies | Renovate, `npm audit`, SBOM per release, signed images |
| Static analysis | Semgrep + CodeQL on PRs; gitleaks |
| Testing | RLS / tenant suite, canary isolation suite, authz matrix tests (release-blocking) |
| Pen test | External test before GA (focus: tenancy, Private, RBAC, App Tools) |

## 10.6 Privacy

- **Data minimisation:** analytics events carry ids, never content.
- **Personal data:** names, emails, titles, levels, reporting lines (directory only).
- **Data-subject requests:** export of a user's Private content and profile (P1), and deletion via offboarding plus retention.
- **India DPDP Act and GDPR readiness:** DPA template, sub-processor list (AWS, WorkOS, model providers via the runtime, PostHog, Sentry, GitHub), privacy notice. All before beta.
- **Sub-processors in use today (Phase A):** Neon (database), WorkOS (sign-in), OpenRouter and the models it routes to (AI content), GitHub (only for arenas connected to a repo), the SMTP provider for invite emails, and the demo VM host (Azure). When enabled by the operator: Sentry and Semgrep (hosted MCP connectors; Semgrep receives the code it scans), Vercel (deployment metadata), Linear (a person's own PM connection). A person or arena that brings its own AI key sends its content to that provider instead. These must appear in the sub-processor list before beta.

## 10.7 Compliance roadmap

| Milestone | When |
|---|---|
| Security baseline + policies (access, change, incident, vendor) | Before beta (Feb 2027) |
| SOC 2 Type I (automation via Vanta / Drata) | GA + 3 months |
| SOC 2 Type II | GA + 9–12 months |
| ISO 27001 | When enterprise pipeline requires |

**Customer benefit:** the ParallelFlow audit trail (stage artifacts → gate votes → evidence) supports customers' own change-management controls.

## 10.8 Security checklist per feature (Definition of Done)

- [ ] Which plane(s) authorise it? Capability added to `x-required-permission`?
- [ ] RLS covers new tables (tenant + visibility)?
- [ ] Agents: is the action human-only? If not, which autonomy class?
- [ ] Can it leak Private or another project's content (UI, notifications, search, previews)?
- [ ] Audited if risk ≥ medium?
- [ ] Rate-limited / budgeted if it triggers model calls?
- [ ] Any new secret sealed (AES-256-GCM) or hashed at rest, never logged, never in a prompt or event?
- [ ] Arena change writes one activity event (ADR-044) with ids and names only?
