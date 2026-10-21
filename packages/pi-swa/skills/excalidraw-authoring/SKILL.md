---
name: excalidraw-authoring
description: Whiteboard sketches in Excalidraw for intake and early HLD discussion - generated from model.yaml with swa_diagram_save format excalidraw, saved in arch/hld/sketches/. Use when the architect wants a rough sketch to talk over rather than an approved diagram.
---

# Excalidraw sketches in SWA

- Excalidraw is for thinking out loud, during intake and early HLD, before the model settles. Approved HLD and LLD diagrams are draw.io.
- Make a sketch from the current model with `swa_diagram_save` and `format: "excalidraw"` (one view or all). Files go to `hld/sketches/<view>.excalidraw`; the architect opens them in Excalidraw (excalidraw.com or the VS Code Excalidraw extension) and draws on them freely.
- A sketch is not a source of truth. When the architect draws something on it that should become design, ask them, then put it in `model.yaml` and generate the draw.io views.
- An existing sketch is never overwritten without the architect's yes (`replace: true`).
