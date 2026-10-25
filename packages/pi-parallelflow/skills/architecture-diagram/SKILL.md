---
name: architecture-diagram
description: Draw an architecture, system, deployment, data-flow or sequence diagram as a draw.io document with the draw.io tools. Use when someone asks for a diagram, architecture picture, system map, flowchart or "draw how X works".
---

# Draw a diagram with draw.io

1. Gather first. Read what the diagram must show: in an arena, `artifacts_list` / `artifacts_read` (specs, plans, earlier diagrams) and `arena_read_history`; in a private chat, `private_list_artifacts` / `private_read_artifact` and `files_read`. If a diagram with this name exists, read it and save the full new XML under the same name (a new version).
2. Ask at most one question (`ask_user`), and only when the level of detail or the scope would change the diagram. Otherwise state your assumptions in a note shape on the diagram.
3. Choose the format. Mermaid is laid out automatically, so prefer it:
   - **Mermaid (the default):** flowcharts, processes, pipelines, data flow, sequence, state, class and ER diagrams, and architecture or system maps that are boxes and arrows (group parts with `subgraph`).
   - **draw.io XML** only when the diagram needs cloud, network or product icons (AWS, Azure, GCP, Kubernetes…) or nested containers that Mermaid cannot show.
4. Read the reference once per conversation: `mcp__drawio__get_drawio_reference` with `format` `xml` (or `mermaid`).
5. For cloud, network or product icons (AWS, Azure, GCP, Kubernetes, databases…), call `mcp__drawio__search_shapes` and use the exact style it returns. Never invent a style name.
6. Write the diagram:
   - one idea per diagram, at most about 15 shapes; group related parts (a Mermaid `subgraph`, a draw.io container) such as "Frontend", "API", "Data";
   - every shape has a short label; every arrow that carries meaning has a label ("HTTPS", "events", "reads");
   - Mermaid: `flowchart LR` (left to right) unless the flow is a top-down hierarchy; short node ids, labels in quotes (`api["Orders API"]`); no styling or `classDef` colours;
   - draw.io XML: rough positions are enough, the layout is fixed on save (step 8); add a title text at the top and, if needed, a small legend.
7. Check it: call `mcp__drawio__open_drawio_xml` (or `mcp__drawio__open_drawio_mermaid`) with the content. If it returns an error, fix the diagram and check again. Do not paste the link it returns.
8. Save it:
   - Mermaid: `artifacts_create_draft` (arena) or `private_save_artifact` (private chat) with kind `diagram`, a name ending in `.md`, and the content as a `# Title` line, one sentence on what it shows, and one fenced ```mermaid block.
   - XML: the same tools with kind `diagram`, the full `<mxfile>` or `<mxGraphModel>` XML as content, a name ending in `.drawio`, and `layout`: `route` (the default: keeps your boxes, routes the arrows around them; for architecture and containers) or `flow` (lays the whole diagram out left to right; for pipelines and processes).
   - Names: lowercase with hyphens; in an arena, a standard name such as `architecture-checkout.md` or `hld-checkout.drawio`.
9. Reply with one line only: "Created <name> (draft) — <what it shows>". The diagram opens from the file card, with an Open in draw.io button. Never paste the XML, the Mermaid or the draw.io link into the chat.

Never mark a diagram approved; it is a draft for the team to review.
