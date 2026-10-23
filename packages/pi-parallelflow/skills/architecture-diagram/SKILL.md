---
name: architecture-diagram
description: Draw an architecture, system, deployment, data-flow or sequence diagram as a draw.io document with the draw.io tools. Use when someone asks for a diagram, architecture picture, system map, flowchart or "draw how X works".
---

# Draw a diagram with draw.io

1. Gather first. Read what the diagram must show: in an arena, `artifacts_list` / `artifacts_read` (specs, plans, earlier diagrams) and `arena_read_history`; in a private chat, `private_list_artifacts` / `private_read_artifact` and `files_read`. If a diagram with this name exists, read it and save the full new XML under the same name (a new version).
2. Ask at most one question (`ask_user`), and only when the level of detail or the scope would change the diagram. Otherwise state your assumptions in a note shape on the diagram.
3. Choose the format:
   - **draw.io XML** for architecture, deployment, network and cloud diagrams, and anything with containers or icons. This is the default.
   - **Mermaid** only for a plain flowchart, sequence, class, state or ER diagram.
4. Read the reference once per conversation: `mcp__drawio__get_drawio_reference` with `format` `xml` (or `mermaid`).
5. For cloud, network or product icons (AWS, Azure, GCP, Kubernetes, databases…), call `mcp__drawio__search_shapes` and use the exact style it returns. Never invent a style name.
6. Write the diagram:
   - one idea per diagram; group related parts in labelled containers (for example "Frontend", "API", "Data");
   - every shape has a short label; every arrow that carries meaning has a label ("HTTPS", "events", "reads");
   - left to right or top to bottom; leave space between shapes so arrows do not cross them;
   - add a title text at the top and, if needed, a small legend.
7. Check it: call `mcp__drawio__open_drawio_xml` (or `mcp__drawio__open_drawio_mermaid`) with the content. If it returns an error, fix the diagram and check again. Do not paste the link it returns.
8. Save it:
   - XML: `artifacts_create_draft` (arena) or `private_save_artifact` (private chat) with kind `diagram`, the full `<mxfile>` or `<mxGraphModel>` XML as content, and a name ending in `.drawio` (lowercase with hyphens, for example `checkout-architecture.drawio`).
   - Mermaid: the same tools with kind `diagram`, a name ending in `.md`, and the content as a short title line plus one fenced ```mermaid block.
9. Reply with one line only: "Created <name> (draft) — <what it shows>". The diagram opens from the file card, with an Open in draw.io button. Never paste the XML, the Mermaid or the draw.io link into the chat.

Never mark a diagram approved; it is a draft for the team to review.
