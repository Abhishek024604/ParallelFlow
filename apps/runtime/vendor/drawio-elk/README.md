# drawio-elk (pinned)

`drawio-elk.min.js` is draw.io's ELK layout bundle (`@drawio/elk 0.1.0+commit.ce35b42`, built 2026-10-23), downloaded from `https://viewer.diagrams.net/js/elk/drawio-elk.min.js` on 26 Oct 2026. The runtime's diagram layout (`src/diagram-layout.ts`) evaluates it, so it is pinned here instead of being fetched at runtime, and checked against `ELK_BUNDLE_SHA256` before use.

Licences: draw.io Apache-2.0; Eclipse Layout Kernel EPL-2.0.

To update: download the file again, review the diff, and set `ELK_BUNDLE_SHA256` to the new `sha256sum`.
