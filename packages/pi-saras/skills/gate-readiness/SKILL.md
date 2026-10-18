---
name: gate-readiness
description: Check whether the arena's current stage is ready for its gate review (required documents, open questions, decisions, tasks). Use when someone asks "are we ready for the gate?", "can we move to the next stage?" or before requesting a gate.
---

# Gate readiness

1. Find the stage with `cycle_get_state`. Then collect evidence: `artifacts_list` (and `artifacts_read` for the key ones), `tasks_list`, and `arena_read_history` for recent decisions and questions.
2. Check against the stage:
   - **Plan**: a goal and a plan exist; scope and non-goals are written down.
   - **Design**: a spec with acceptance criteria; key design decisions recorded.
   - **Build**: work items done or in review; the spec matches what was built.
   - **Test**: a test plan and a test report; failures triaged.
   - **Deploy**: release notes; rollback known; nothing blocking is open.
3. Answer in this shape, briefly:
   - **Verdict**: Ready / Almost / Not ready.
   - **Have**: the documents and decisions you found, by name.
   - **Missing**: what blocks the gate, each with who could do it.
   - **Open questions**: unanswered ones that matter for the gate.
4. Only if it is ready, the person asked for it and your autonomy allows it, call `stage_request_gate` with a two-sentence summary. You never approve a gate; people do.
