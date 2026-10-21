---
name: swa-adr
description: Record one architecture decision as an ADR in arch/decisions/ (context with requirement IDs, options, decision, consequences), or supersede an earlier one. Use for /swa adr, or when a design phase makes a significant decision.
---

# SWA ADR

1. Call `swa_status` and read the decisions that exist (`swa_read` on each `decisions/ADR-*.md` that relates). If the decision is already recorded, update that ADR while it is a draft, or supersede it when it is approved.
2. Read the template: `swa_read` with `template: "adr.md"`.
3. Number it after the highest existing ADR (`ADR-0004` after `ADR-0003`). File name `decisions/ADR-000N-short-title.md` (lowercase, hyphens); frontmatter `id: ADR-000N`.
4. Set `gate` to the phase it belongs to: `G1` (stack), `G2` (HLD), or `G3:CMP-003` (a component's LLD). Set `supersedes: ADR-000M` when it replaces one; never edit the approved one.
5. Context cites the FR, NFR, CON and CMP IDs that drive it. List at least two real options with pros and cons. The decision is one or two sentences. Consequences include what must now be true and any new risk (add it to `risks.md` when that exists).
6. Write it with `swa_write`, then `swa_validate` on it.
7. Reply with one line: "Recorded ADR-000N: <title> (draft)" and the gate that must approve it.
