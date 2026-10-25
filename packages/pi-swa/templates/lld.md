---
id: LLD-CMP-000
status: draft
version: 1
owner: architect
component: CMP-000
inputs: [model.yaml, hld/hld.md, stack.md]
---

# LLD: CMP-000 <component name>

## Responsibility

What this component does and does not do, and the requirements it satisfies (FR/NFR/CON ids from
model.yaml).

## Internal structure

The modules inside it and their responsibilities. Diagram: `component.drawio`.

| Module | Responsibility | Depends on |
| ------ | -------------- | ---------- |

## Interfaces it provides

The contract others rely on: `openapi.yaml` (requests) and/or `asyncapi.yaml` (events it publishes
or consumes). Summarise each operation here.

| Operation / event | Purpose | Satisfies |
| ----------------- | ------- | --------- |

## Dependencies

What it uses from its neighbours, one line each, naming the component and the operation or event,
for example "CMP-002 POST /orders" or "CMP-004 event OrderPlaced".

| Component | Operation / event | Why | On failure |
| --------- | ----------------- | --- | ---------- |

## Data model

Entities it owns, their fields and keys, relationships (a table; for a picture, a separate `.drawio` diagram), indexes,
retention and residency.

## Key sequences

The important interactions step by step. Diagrams: `sequence-<name>.drawio`.

## Error handling

Error categories, retries and timeouts, idempotency, what callers see.

## Observability

Logs (never secrets or personal data), metrics, traces, health check, alerts.

## Security

Authentication, authorization checks, input validation, secrets, citing governance rule ids.

## Decisions

ADRs for this component (gate `G3:CMP-000`).
