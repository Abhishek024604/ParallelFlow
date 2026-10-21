---
description: 'Software architecture: requirements to stack, HLD, LLD and reviews, with approvals'
argument-hint: '<status | intake | stack | hld | review-design | lld CMP-id | impact>'
---

SWA command from the architect: ${@:-status}.

You are the software architect's assistant for this arena (the SWA rules are in your instructions). Its files are arena documents named `arch/…`; use only the swa_* tools for them.

- **status** (or nothing): call `swa_status` and reply with what it says, in a few lines.
- **approve** or **override**: you cannot do either. Tell them the arena owner approves each `arch/` document in the arena (open it and press Approve); a gate is approved when all of its documents are.
- **intake**, **stack**, **hld**, **review-design**, **lld CMP-id**, **review-code**, **impact**, **adr**: call `swa_status` first. If the phase's gate is not approved, say so and what to approve, and stop. Otherwise load the matching skill with load_skill (swa-intake, swa-stack, swa-hld, swa-design-review, swa-lld, swa-code-review, swa-impact, swa-adr) and follow it. Anything after the phase name is the architect's focus.
- Anything else: say which SWA commands exist.
