---
name: swa-intake
description: SWA phase 0. Turn the SRS, goal.md, the meeting summary and the governance rules into arch/00-drivers.md, with requirement IDs, measurable quality scenarios, constraints, conflicts and the architect's answers. Use for /swa intake.
---

# SWA intake (phase 0, ends at gate G0)

1. Call `swa_status`. If `inputs/srs.md` or `inputs/goal.md` is not there, never stop: take the requirements and goals from this conversation and the chat's documents (the `pm › …` documents first: `pm › requirements.md`, `pm › outcomes.md`, `pm › mvp.md`; read them with private_list_artifacts and private_read_artifact), and save them with `swa_write` as `inputs/srs.md` and `inputs/goal.md` (a missing input may be copied in once), citing "architect, this chat". Only if there is nothing to go on at all, ask what to build in one question.
2. Read every input with `swa_read`: `inputs/srs.md`, `inputs/goal.md` (as saved in step 1), and when they exist `inputs/meeting-summary.md` and `inputs/governance.yaml`. If `00-drivers.md` exists, read it too: you are updating it, not starting over.
3. Read the template: `swa_read` with `template: "drivers.md"`.
4. Extract, citing the source section for every row:
   - **Functional requirements** as `FR-001`, `FR-002`, … One requirement per row; split compound ones. Keep IDs stable on an update: never renumber, only append.
   - **Quality scenarios** as `NFR-001`, …: attribute, stimulus, environment, response, and a number in the measure. A vague NFR ("fast", "scalable", "secure") becomes a scenario only with a number the inputs give; otherwise it is a question.
   - **Constraints** as `CON-001`, …: region, data residency, existing systems, budget, deadline, team skills, mandated technology.
   - Actors and integrations.
5. Find what is missing or conflicting:
   - the target cloud, when goal.md does not state it (always ask; "no preference" is a valid answer);
   - quality scenarios without a measure; ranked quality priorities, if goal.md has none;
   - inputs that disagree (the SRS says one thing, the meeting summary another).
6. Ask the architect, at most four questions per round, each with concrete options where you can (`ask_user` if you have it; otherwise list them in your reply and stop). Never fill a gap yourself.
7. Write `00-drivers.md` with `swa_write`: every section of the template, the answers in "Questions and answers", unresolved items in "Open questions" (not invented values). Frontmatter `inputs` lists the input files you read.
8. Run `swa_validate` on `00-drivers.md` and fix what it reports.
9. Reply in at most five lines: how many FRs, NFRs and constraints; the open questions, if any; and "Review arch/00-drivers.md, then /swa approve G0".
