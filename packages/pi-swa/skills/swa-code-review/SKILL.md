---
name: swa-code-review
description: SWA phase 5. Review the code for conformance with the approved architecture - model.yaml components and relations, stack.md and its ADRs, the LLD contracts and the governance rules - in arch/reviews/code-<date>.md, and generate fitness-function tests in arch/fitness/ for CI later. Use for /swa review-code.
---

# SWA code review (phase 5)

This is a conformance review against the architecture, not a linter: every finding cites the rule, ADR, contract or component it breaks.

1. Call `swa_status`: G2 must be approved. Read `model.yaml`, `stack.md`, the ADRs, `inputs/governance.yaml` if present, and the LLD contracts (`lld/*/openapi.yaml`, `lld/*/asyncapi.yaml`) of the components in scope.
2. You need the code. Read it with your file tools (read, grep, find). If you have none (for example in an arena chat), tell the architect that code review runs in the coding agent in VS Code, and stop.
3. Scope: the components the architect named, or all. Map each component to its code with the `code` paths in model.yaml; a component with no paths is a finding (traceability), and you ask the architect where it lives.
4. Check, per component:
   - **Dependencies**: imports and calls between components follow model.yaml relations. A call model.yaml does not have, or a direct read of another component's database, is a blocker.
   - **Stack**: dependencies in package manifests (package.json, pom.xml, go.mod, requirements.txt, …) match stack.md; anything forbidden by governance is a blocker, anything not in the stack is a major finding unless an ADR covers it.
   - **Contracts**: implemented routes, payloads and events match openapi.yaml and asyncapi.yaml (paths, methods, required fields, status codes).
   - **Governance and quality**: the SEC-* and STD-* rules (secrets in code, unvalidated input, missing authorization checks, logs with personal data, missing health checks), and the NFR scenarios the code clearly breaks (for example no timeout on a call an NFR depends on).
5. Severity: **blocker** (breaks a decision, contract or security rule), **major** (drift that will cost later), **minor** (local). Each finding: file and line, what is wrong, the id it breaks (ADR, CMP relation, contract operation, governance rule), and the fix.
6. Fitness functions: for each rule that can be checked automatically, write a test file in `fitness/` for the project's own test runner or a standard tool (dependency-cruiser rules for TypeScript, ArchUnit for Java, import-linter for Python, a contract test against openapi.yaml). Each file names the ADR or rule it guards in a comment. They are not run now; they are ready for CI.
7. Write the report with `swa_write` to `reviews/code-<YYYY-MM-DD>.md` (frontmatter `inputs`: model.yaml, stack.md and the contracts you used): summary, findings table, fitness functions written. Add new risks or accepted debt to `risks.md`.
8. If a finding shows the design itself is wrong (not the code), say so: that is `/swa impact`, the architect decides.
9. Reply in at most five lines: counts by severity, the top blockers, the fitness files, and the report path.
