---
name: drawio-authoring
description: How SWA diagrams are made and changed in draw.io - generated from model.yaml, edited by the architect, read back with swa_diagram_sync - and how to hand-draw LLD diagrams. Use for any .drawio file in arch/.
---

# draw.io in SWA

- **HLD views are generated, not drawn.** Change `model.yaml`, then run `swa_diagram_save`. Shape ids are the model's ids (`CMP-003`, actor and external ids), so the file can be compared with the model later.
- **The architect may edit any diagram in draw.io**: layout, colours, notes, even new shapes. After an edit, `swa_diagram_save` keeps their file and reports the differences. Read them with `swa_diagram_sync`, then either update `model.yaml` to adopt the change and save again, or ask the architect. Never overwrite their edits without a yes (`replace: true`).
- **LLD diagrams** (component and sequence diagrams inside one container) are drawn by hand: write draw.io XML (an `<mxfile>` with one `<diagram>` holding an `<mxGraphModel>`) and save it with `swa_write` under `lld/CMP-…/`. When the draw.io tools are available, read their reference once (`mcp__drawio__get_drawio_reference`), use `mcp__drawio__search_shapes` for cloud and product icons, and check the XML with `mcp__drawio__open_drawio_xml`; never paste the link it returns.
- Shapes: one idea per diagram, short labels, every meaningful arrow labelled, left to right or top to bottom, a title at the top.
- In hand-drawn diagrams, use the model's ids as cell ids for things the model has, so traceability holds.
