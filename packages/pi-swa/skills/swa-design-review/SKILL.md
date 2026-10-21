---
name: swa-design-review
description: SWA phase 3. Review the HLD before it becomes the baseline - traceability, ATAM-lite quality-attribute analysis, a STRIDE threat model, a Well-Architected check and a cost estimate - in arch/reviews/hld-review.md, and feed arch/risks.md. Use for /swa review-design.
---

# SWA HLD review (phase 3, ends at gate G2, the baseline)

1. Call `swa_status`. Read `00-drivers.md`, `inputs/goal.md`, `stack.md`, the ADRs, `model.yaml` and `hld/hld.md`. If `reviews/hld-review.md` or `risks.md` exist, read them: you are updating them.
2. Read the template: `swa_read` with `template: "hld-review.md"` (and `"risks.md"` when the register does not exist yet).
3. **Traceability**: run `swa_trace`. Every gap is a finding.
4. **Quality attributes (ATAM-lite)**: for each priority quality scenario, the decisions that serve it, sensitivity points, trade-offs against other scenarios, and the risk if an assumption is wrong. Be concrete: name the component and the number.
5. **Threat model**: load the swa-threat-model skill and follow it.
6. **Well-Architected**: one line per pillar (operational excellence, security, reliability, performance efficiency, cost optimization, sustainability) with the main finding.
7. **Cost**: a monthly estimate per component from the stack and the expected load in the drivers, against the budget in goal.md. State the assumptions; say so when you cannot estimate without a number from the architect.
8. **Findings**: blocker (must change before the baseline), major (should change), minor. Each cites the FR/NFR/CON/CMP/ADR or governance rule id it rests on, with a recommendation.
9. Write `reviews/hld-review.md`, then add every risk and accepted debt to `risks.md` (`RISK-001`…, `TD-001`…; append, never renumber). Run `swa_validate`.
10. Do not fix the HLD yourself in this phase: the architect decides which findings to act on.
11. Reply in at most five lines: the verdict, the number of blockers, majors and minors, the top risks, and "Fix blockers with /swa hld, or approve the baseline with /swa approve G2".
