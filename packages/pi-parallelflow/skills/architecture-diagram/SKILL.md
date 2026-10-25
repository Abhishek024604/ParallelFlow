---
name: architecture-diagram
description: Draw an architecture, system, deployment, data-flow or process diagram as a real draw.io diagram. Use when someone asks for a diagram, architecture picture, system map, flowchart or "draw how X works".
---

# Draw a diagram

Every diagram is a real draw.io diagram saved as a `.drawio` file. People open it in ParallelFlow and can edit it there. Never draw diagrams in Markdown, Mermaid or ASCII art.

1. Gather first. Read what the diagram must show: in an arena, `artifacts_list` / `artifacts_read` (specs, plans, earlier diagrams) and `arena_read_history`; in a private chat, `private_list_artifacts` / `private_read_artifact` and `files_read`. If a diagram with this name exists, read it and save the new one under the same name (a new version).
2. Ask at most one question (`ask_user`), and only when the level of detail or the scope would change the diagram. Otherwise state your assumptions in a `note` node.
3. Write a **diagram spec**: JSON that lists the boxes, groups and arrows, with no positions. ParallelFlow builds the drawing and lays it out, so you never place anything yourself.

   ```json
   {
     "title": "Checkout architecture",
     "direction": "right",
     "groups": [
       { "id": "client", "label": "Client" },
       { "id": "backend", "label": "Backend" }
     ],
     "nodes": [
       { "id": "shopper", "label": "Shopper", "type": "user" },
       { "id": "web", "label": "Web app", "group": "client" },
       { "id": "api", "label": "Orders API", "group": "backend" },
       { "id": "db", "label": "Orders DB (Postgres)", "type": "database", "group": "backend" },
       { "id": "stripe", "label": "Stripe", "type": "external" }
     ],
     "edges": [
       { "from": "shopper", "to": "web", "label": "browses" },
       { "from": "web", "to": "api", "label": "HTTPS" },
       { "from": "api", "to": "db", "label": "SQL" },
       { "from": "api", "to": "stripe", "label": "charge", "dashed": true }
     ]
   }
   ```

   - `direction`: `right` (left to right, the default; architecture and pipelines) or `down` (top to bottom; processes, decision flows, hierarchies).
   - Node `type`: `service` (the default), `database`, `queue`, `cache`, `storage`, `user`, `external` (a third party), `decision`, `start`, `end`, `document`, `note`.
   - `groups` are labelled boxes around related nodes ("Frontend", "API", "Data"); a group can sit inside another with `parent`.
   - Ids: short, letters, digits, `-` or `_`, each used once. Labels: short, the name people use; `\n` for a second line.
   - One idea per diagram, at most about 20 nodes. Label every arrow that carries meaning ("HTTPS", "events", "reads"); `dashed` for async or optional links.

4. Save it with `artifacts_create_draft` (arena) or `private_save_artifact` (private chat): kind `diagram`, the spec JSON as `content`, and a name ending in `.drawio` (lowercase with hyphens; in an arena a standard name such as `architecture-checkout.drawio` or `hld-orders.drawio`). If the save returns an error about the spec, fix what it names and save again.
5. Only when the diagram needs cloud, network or product icons (AWS, Azure, GCP, Kubernetes…): write draw.io XML instead. Read `mcp__drawio__get_drawio_reference` (`format` `xml`) once per conversation, find each icon with `mcp__drawio__search_shapes` and use the exact style it returns (never invent one), and check the XML with `mcp__drawio__open_drawio_xml` (do not paste the link it returns). Save it the same way with the full `<mxfile>` or `<mxGraphModel>` as `content` and `layout` `route` (keeps your boxes, routes the arrows around them) or `flow` (lays it all out again).
6. Reply with one line only: "Created <name> (draft) — <what it shows>". The diagram opens from the file card. Never paste the spec, the XML or a link into the chat.

Never mark a diagram approved; it is a draft for the team to review.
