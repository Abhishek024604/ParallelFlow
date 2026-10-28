---
name: swa-lld
description: SWA phase 4. The low-level design of one component of the approved HLD - lld.md, component and sequence diagrams, data model, and API/event contracts (OpenAPI, AsyncAPI) in arch/lld/CMP-id/, consistent with its neighbours. Use for /swa lld CMP-id.
---

# SWA LLD (phase 4, one component, ends at gate G3:CMP-id)

1. Call `swa_status` (approvals are optional). Read `model.yaml`, `hld/hld.md`, `stack.md`, the ADRs, and the risks in `risks.md` that cite this component. Read the LLDs of its neighbours (the components model.yaml connects it to) when they exist: you must match their contracts. If `lld/<id>/` already has files, read them: you are updating them.
2. Read the template: `swa_read` with `template: "lld.md"`. Frontmatter `id: LLD-<CMP-id>`, `component: <CMP-id>`.
3. Design inside the HLD, never against it. If the LLD needs the HLD to change (a new component, a different relation), stop and tell the architect: that is `/swa impact`, not this phase.
4. Write the contracts first:
   - `lld/<id>/openapi.yaml` (OpenAPI 3.1) when anything calls it synchronously: every operation, request and response schemas, errors, auth.
   - `lld/<id>/asyncapi.yaml` (AsyncAPI 3) when it publishes or consumes events: channels, message names, payload schemas.
     Every operation and event cites the FR/NFR it serves in its description.
5. Write `lld/<id>/lld.md`: every template section. In "Dependencies", one line per thing it uses from a neighbour, written as "CMP-002 POST /orders" or "CMP-004 event OrderPlaced", so the check can match it.
6. Draw `lld/<id>/component.drawio` (its modules) and one `lld/<id>/sequence-<name>.drawio` per key sequence (drawio-authoring skill). Show them to the architect by naming the files.
7. Decisions made here get ADRs with `gate: G3:<id>` (swa-adr skill).
8. Run `swa_lld_check` with the component and `swa_validate`. Fix every PROBLEM. When a neighbour's contract lacks something this component needs, do not change the neighbour: tell the architect.
9. Reply in at most five lines: the contracts, the diagrams, open questions, and "Review arch/lld/<id>/, then /swa approve G3:<id>".
