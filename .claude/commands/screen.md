---
description: Build or update a UI screen in the style of the running app and the brand template v2
argument-hint: <screen name e.g. Arena>
---
Build the **$ARGUMENTS** screen.

1. Look at the related pages already built in `apps/web` (the running app is the UI reference; there are no design images). Read `docs/design/ParallelFlow_Brand_Template_v2.md` and `docs/09_UX_and_Design_System.md` for flows and accessibility.
2. Use the skin classes and tokens from `apps/web/src/styles/parallelflow-brand.css` (mapped to Tailwind). Never hard-code colours.
3. Implement the loading, empty, error, read-only and dark states. Every interactive element must be a real button, link or input.
4. Wire the data to the real API. Mock only where the endpoint doesn't exist yet, and note those mocks in `SLICE_DEBT.md`.
5. Match the look of the neighbouring pages and list any differences you made on purpose.
