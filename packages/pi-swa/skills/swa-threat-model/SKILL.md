---
name: swa-threat-model
description: A STRIDE threat model of the HLD - trust boundaries, threats per component and data flow, mitigations tied to governance rules. Use inside the HLD review, or when the architect asks for a threat model.
---

# STRIDE threat model

1. From `model.yaml`, list the **trust boundaries**: internet ↔ edge, edge ↔ internal services, services ↔ data stores, the system ↔ each external system, and admin access.
2. For each component, and each relation that crosses a boundary, walk STRIDE:
   - **S**poofing: can someone pretend to be a user or a service? (authentication)
   - **T**ampering: can data in transit or at rest be changed? (integrity, TLS, signing)
   - **R**epudiation: can an action be denied later? (audit logs)
   - **I**nformation disclosure: can data leak? (encryption, authorization, logs, errors)
   - **D**enial of service: can it be overwhelmed? (rate limits, quotas, autoscaling)
   - **E**levation of privilege: can someone gain rights they should not have? (authorization, least privilege)
3. Record each real threat as `THR-01`, `THR-02`, … with the component or flow, the STRIDE letter, the threat in one sentence, the mitigation (cite the governance rule id, such as `SEC-AUTHZ`, and the component that implements it), and a status: mitigated by design, needs work, or accepted.
4. Threats that need work or are accepted go into `risks.md`.
5. Skip generic threats that do not apply: a short, specific list beats a long, generic one.
