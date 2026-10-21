---
name: swa-hld
description: SWA phase 2. Design the high-level architecture from the approved drivers and stack - write arch/model.yaml (components, relations, flows, deployment), generate the context, container, key-flow and deployment diagrams from it, and write arch/hld/hld.md. Use for /swa hld.
---

# SWA HLD (phase 2)

1. Call `swa_status`: G1 must be approved (or the phase overridden). Read `00-drivers.md`, `stack.md`, the ADRs in `decisions/`, and `inputs/goal.md`. If `model.yaml` or `hld/hld.md` exist, read them: you are updating them.
2. Load the c4-modelling skill for how to cut components.
3. Write `model.yaml` first (`swa_read` with `template: "model.yaml"` for the shape):
   - actors and external systems from the drivers (actors, integrations);
   - one component per deployable or independently owned part, ids `CMP-001`, `CMP-002`, … (stable: never renumber, only append); `tech` from stack.md; `satisfies` lists every FR, NFR and CON it serves; `adrs` the decisions that shape it;
   - relations with a protocol label and `sync` or `async`;
   - 3 to 5 key flows: the flows behind the priority quality scenarios and the riskiest FRs;
   - deployment nodes that place every component.
4. Run `swa_validate` on `model.yaml`, then `swa_trace`. Every FR and NFR must map to a component; close the gaps before you go on, or ask the architect when a requirement has no sensible home.
5. Generate the diagrams with `swa_diagram_save` (no arguments: every view as draw.io). If the architect asked for a sketch, or the design is still being talked over, add `format: "excalidraw"`. If it reports that the architect edited a diagram, run `swa_diagram_sync` on it and bring the model in line or ask; never pass `replace` without their yes.
6. A significant new decision (for example sync or async between two components, who owns some data) gets an ADR with `gate: G2` (swa-adr skill).
7. Write `hld/hld.md` from the template (`template: "hld.md"`): every section, every claim citing FR/NFR/CON/CMP/ADR ids, and the diagram paths. Run `swa_validate`.
8. Reply in at most five lines: the components, the flows drawn, the diagram files (the architect opens them in draw.io), open issues, and "Then run /swa review-design".
