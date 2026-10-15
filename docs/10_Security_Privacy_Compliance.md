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
| T4 | Prompt injection makes the agent act beyond intent | Autonomy policy enforced in App Tools (not in the prompt); human-only invariants; approvals for risky classes; org ceiling | Medium → Low |
| T5 | Privilege escalation via custom roles | Only `role.manage` holders edit roles; ≥1 owner; capability catalogue fixed in code; audit of every role change | Low |
| T6 | Self-approval / collusion on releases | `forbid_self_approval`, `min_approvals`, `min_distinct_roles`; votes audited | Low |
| T7 | Stale access after people leave or move | SCIM deprovisioning (sessions revoked < 60 s); guest expiry; mover notices to team owners | Low |
| T8 | Credential / token theft | WorkOS sessions; HttpOnly cookies; tool tokens ≤60 min bound to one session; secrets in AWS Secrets Manager; log redaction | Low |
| T9 | Denial of wallet (runaway agent use) | Per-org budgets, per-user turn rate limits, routine min interval 1 h, ambient batching | Low |
| T10 | Malicious file upload | Pre-signed uploads, type and size checks, virus scan, no inline HTML rendering | Low |
| T11 | Webhook spoofing (WorkOS / GitHub) | Signature verification, delivery-id dedupe | Low |

## 10.3 Identity and access

- **Login and sessions:**
  - WorkOS AuthKit (Google, Microsoft, magic link) and enterprise SSO (SAML / OIDC).
  - `require_sso` policy per org.
  - Sessions: 12 h absolute / 2 h idle. Admin screens require re-authentication after 30 min.
  - **As built (F01-01, ADR-032):** `saras_session` holds the WorkOS sealed session inside an HMAC-signed envelope with our user id, issued-at, last-seen and the session's CSRF token. The API enforces both limits from those timestamps on every request (no session table) and re-issues last-seen at most every 5 min. An expired WorkOS access token is refreshed once and the cookie re-set. Logout revokes the WorkOS session. A login needs an email that WorkOS has verified; deactivated accounts cannot sign in. Admin re-authentication is not built yet.
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

## 10.5 Application security controls

| Control | Implementation |
|---|---|
| Input validation | Zod on every boundary; size limits (message 20 KB, artifact 2 MB, file 100 MB) |
| Output encoding | Markdown sanitised (`rehype-sanitize`); no raw HTML from users or agents |
| CSRF | SameSite=Lax cookies + double-submit token: `X-CSRF-Token` must equal the session's token (also in the readable `saras_csrf` cookie) on POST, PUT, PATCH and DELETE, else 403. The token lives in the signed session, so a cookie planted by a sibling subdomain does not pass. Login uses `state` + PKCE. CORS allows only `WEB_ORIGIN`, with credentials |
| CSP | Strict CSP with nonces; `frame-ancestors 'none'` |
| SSRF | No server-side URL fetch in the MVP app; runtime egress controlled in Tau |
| Dependencies | Renovate, `npm audit`, SBOM per release, signed images |
| Static analysis | Semgrep + CodeQL on PRs; gitleaks |
| Testing | RLS / tenant suite, canary isolation suite, authz matrix tests (release-blocking) |
| Pen test | External test before GA (focus: tenancy, Private, RBAC, App Tools) |

## 10.6 Privacy

- **Data minimisation:** analytics events carry ids, never content.
- **Personal data:** names, emails, titles, levels, reporting lines (directory only).
- **Data-subject requests:** export of a user's Private content and profile (P1), and deletion via offboarding plus retention.
- **India DPDP Act and GDPR readiness:** DPA template, sub-processor list (AWS, WorkOS, model providers via Tau, PostHog, Sentry, GitHub), privacy notice. All before beta.

## 10.7 Compliance roadmap

| Milestone | When |
|---|---|
| Security baseline + policies (access, change, incident, vendor) | Before beta (Feb 2027) |
| SOC 2 Type I (automation via Vanta / Drata) | GA + 3 months |
| SOC 2 Type II | GA + 9–12 months |
| ISO 27001 | When enterprise pipeline requires |

**Customer benefit:** the Saras audit trail (stage artifacts → gate votes → evidence) supports customers' own change-management controls.

## 10.8 Security checklist per feature (Definition of Done)

- [ ] Which plane(s) authorise it? Capability added to `x-required-permission`?
- [ ] RLS covers new tables (tenant + visibility)?
- [ ] Agents: is the action human-only? If not, which autonomy class?
- [ ] Can it leak Private or another project's content (UI, notifications, search, previews)?
- [ ] Audited if risk ≥ medium?
- [ ] Rate-limited / budgeted if it triggers model calls?
