---
description: Build or update a UI screen from the design screens and brand template
argument-hint: <screen name e.g. Arena>
---
Build the **$ARGUMENTS** screen.

1. Look at the matching image in `docs/design/screens/` (light, plus the dark version if there is one). Read `docs/design/Saras_Brand_Template_v1.md` and `docs/09_UX_and_Design_System.md` for flows and accessibility.
2. Use components from `packages/ui` and tokens from `docs/design/saras-brand.css` (mapped to Tailwind and shadcn variables). Never hard-code colours.
3. Implement the loading, empty, error, read-only and dark states. Every interactive element must be a real button, link or input.
4. Wire the data through TanStack Query against the OpenAPI client. Mock only where the endpoint doesn't exist yet, and note those mocks in `SLICE_DEBT.md`.
5. Compare the result with the screen image and list any differences you made on purpose.
