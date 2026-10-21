---
id: HLD-REVIEW
status: draft
version: 1
owner: architect
inputs: [00-drivers.md, stack.md, model.yaml, hld/hld.md]
---

# HLD review

## Summary

The verdict in two or three sentences: ready for the baseline, or what must change first.

## Traceability

The swa_trace result: coverage, and every gap with what closes it.

## Quality attribute analysis (ATAM-lite)

For each priority quality scenario: the design decisions that serve it, sensitivity points (where a
small change has a big effect), trade-offs against other scenarios, and risks.

| Scenario | Decisions | Sensitivity points | Trade-offs | Risk |
| -------- | --------- | ------------------ | ---------- | ---- |

## Threat model (STRIDE)

Trust boundaries, then threats per component and data flow.

| ID     | Component / flow | STRIDE | Threat | Mitigation | Status |
| ------ | ---------------- | ------ | ------ | ---------- | ------ |
| THR-01 |                  |        |        |            |        |

## Well-Architected check

Operational excellence, security, reliability, performance efficiency, cost optimization,
sustainability: one line each with the main finding.

## Cost

Monthly cost estimate per component against the budget in goal.md, with the assumptions.

## Findings

| #   | Severity (blocker / major / minor) | Finding | Cites | Recommendation |
| --- | ---------------------------------- | ------- | ----- | -------------- |
