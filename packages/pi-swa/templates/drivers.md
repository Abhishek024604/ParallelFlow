---
id: DRIVERS
status: draft
version: 1
owner: architect
inputs: [inputs/srs.md, inputs/goal.md]
---

# Architecture drivers

## Context

What the system is, who uses it, and the systems around it (two or three sentences, from the SRS).

## Actors

| Actor | Kind (person / system) | What they do |
| ----- | ---------------------- | ------------ |

## Functional requirements

One row per requirement the SRS states. Source = the section of the input it comes from.

| ID     | Requirement | Priority (must / should / could) | Source      |
| ------ | ----------- | -------------------------------- | ----------- |
| FR-001 |             |                                  | srs.md §2.1 |

## Quality scenarios

Every NFR as a measurable scenario. "Must be scalable" is not a scenario; "10k concurrent users
place orders with p95 under 300 ms" is.

| ID      | Quality attribute | Stimulus | Environment | Response | Measure | Priority | Source |
| ------- | ----------------- | -------- | ----------- | -------- | ------- | -------- | ------ |
| NFR-001 |                   |          |             |          |         |          |        |

## Constraints

| ID      | Constraint | Source |
| ------- | ---------- | ------ |
| CON-001 |            |        |

## Integrations

| System | Direction | Protocol / data | Source |
| ------ | --------- | --------------- | ------ |

## Conflicts

Inputs that disagree, each with how the architect resolved it (or "open").

## Questions and answers

Every question asked during intake with the architect's answer, including the target cloud.

| #   | Question | Answer | Asked |
| --- | -------- | ------ | ----- |

## Open questions

What is still unknown and which phase it blocks.
