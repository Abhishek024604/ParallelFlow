---
name: plan-cycle
description: Plan the work of an arena cycle or stage as a draft plan with milestones, owners and risks. Use when the team asks for a plan, roadmap, schedule or "what should we do this cycle".
---

# Plan a cycle

1. Ground the plan: `cycle_get_state` (current cycle and stage), `project_get_overview`, `members_list` (people and their roles), `artifacts_list` (goal, specs) and `tasks_list` (work already there). Read the goal and the latest spec.
2. Write Markdown:
   - `# Cycle <n> plan`
   - **Outcome**: what is true at the end of the cycle, in one or two sentences.
   - **Milestones**: for each stage still ahead (Plan, Design, Build, Test, Deploy), what "done" means for that stage's gate.
   - **Work**: a table `| Work | Owner (role) | Stage | Depends on |`. Owners are people by name, picked by their role; write "unassigned" rather than guess.
   - **Risks**: the top three, each with a mitigation.
   - **Open questions** and **Decisions** (with who decided).
3. Save it with `artifacts_create_draft` (kind `plan`, name `cycle-<n>-plan.md`).
4. If the team asked for tasks too and your autonomy allows it, create them with `tasks_create_draft` (drafts only); otherwise list them in the plan.
5. Reply with one line: "Created <name> (draft) — <gist>".

A plan is a proposal for the team. Never say the plan is agreed or a stage is done.
