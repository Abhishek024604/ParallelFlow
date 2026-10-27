---
name: pm-outcomes
description: PM phase 1. Define success before features: an outcome tree from business objective to user outcomes and product measures, with KPI definitions (calculation, baseline, target, timeframe, source, owner, caveats) in pm › outcomes.md. Use for /pm outcomes.
---

# PM outcomes and measurement (phase 1)

1. Read `pm › 00-discovery.md`, `pm › evidence.md`, `pm › questions.md` (and `pm › outcomes.md` if it exists). No discovery: offer /pm intake first.
2. Build the outcome tree: one business objective, then user outcomes (`OUT-*`, a change in what users can do), then product measures (`KPI-*`). Each OUT cites the EVD-* or ACT-* it serves.
3. For each KPI: definition, calculation (numerator / denominator, unit), baseline (or `unknown`), target and timeframe (only if the owner or an input gave one; else ask), data source, owner, caveats.
4. Flag in `## Measurement issues`: vanity metrics (counts that cannot fall), missing baselines, goals that conflict, KPIs that today's data cannot measure (say what instrumentation is needed), leading vs lagging.
5. Ask for targets you do not have (ask_user; offer two or three plausible ranges and "set later" as options). Never invent a number.
6. Save `pm › outcomes.md`: frontmatter, `## Business objective`, `## Outcome tree` (nested list OBJ, OUT, KPI), `## KPI definitions` (table KPI-ID, name, definition, calculation, baseline, target, timeframe, source, owner, caveats), `## Measurement issues`, `## Guardrail metrics` (what must not get worse).
7. Reply: the objective, outcomes and KPIs in a few lines, the unknown baselines and targets, and "Review pm › outcomes.md, then /pm requirements".
