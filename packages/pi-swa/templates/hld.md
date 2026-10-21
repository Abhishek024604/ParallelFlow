---
id: HLD
status: draft
version: 1
owner: architect
inputs: [00-drivers.md, stack.md, model.yaml]
---

# High-level design

## Overview

What the system does and the shape of the solution in one paragraph, naming the architecture style
(ADR-0001).

## Context

The system, its actors and external systems. Diagram: `hld/context.drawio`.

## Containers

One row per component in model.yaml.

| Component | Responsibility | Technology | Satisfies | ADRs |
| --------- | -------------- | ---------- | --------- | ---- |

Diagram: `hld/containers.drawio`.

## Key flows

For each flow in model.yaml: what triggers it, the steps, the quality scenarios it must meet, and
what happens on failure. Diagrams: `hld/flows/*.drawio`.

## Data

The main data entities, which component owns each, and how data moves and is kept (retention,
residency).

## Deployment

Environments, where each component runs, scaling and failover. Diagram: `hld/deployment.drawio`.

## Cross-cutting concerns

Security (identity, trust boundaries, secrets), observability, resilience, and configuration,
each citing the quality scenarios and governance rules it meets.

## Quality scenarios

| Scenario | How the design meets it | Components |
| -------- | ----------------------- | ---------- |

## Open issues

Decisions still to make and what they block.
