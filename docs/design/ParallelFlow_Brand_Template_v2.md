# ParallelFlow brand template v2: monochrome

Status: adopted 23 Oct 2026. It replaces brand template v1 ("calm workspace", cream and sand, 15 Oct) and the violet/Geist theme in doc 09 of Build Pack v2.0.

**The UI reference is the running app.** The old design screens (`docs/design/screens/*.png`) were deleted on 9 Nov 2026: they showed the v1 look and the pre-MVP org layer. A new screen follows the pages already built in `apps/web` and this template.

**Source of truth for code:** `apps/web/src/styles/parallelflow-brand.css` (tokens plus component skin). `docs/design/parallelflow-brand.css` is an identical copy for design work; change both together.

## 1. Principles

1. **Monochrome, so the work stands out.** Solid white (light) or solid black (dark) canvas, neutral greys for structure, 1px hairlines. The conversation and the shared work are the only things that draw the eye.
2. **Colour carries meaning only.** Orange is the one call to action, green is positive, amber is waiting, red is blocked, violet is the AI. Nothing is coloured for decoration.
3. **Collaboration first.** Faces, decisions and tasks come first. Avatars are one neutral grey. Gate and task cards are compact. The AI is visibly a teammate with its own violet identity.

## 2. Colour

Full values for both themes are in the CSS file. The theme follows the system preference unless the person picks Light or Dark in the avatar menu (kept in the `parallelflow-theme` cookie so the server renders the right class).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg`, `--side`, `--panel` | #FFFFFF | #000000 / #000000 / #0A0A0A | Canvas, sidebars, cards |
| `--raise`, `--sand-soft` | #F4F4F5 | #171717 / #1A1A1A | Hover, table heads, avatar well |
| `--line` / `--line2` | #EBEBEB / #D9D9DE | #1F1F1F / #333333 | Hairlines / control borders |
| `--text` / `--muted` / `--faint` | #0A0A0A / #52525B / #6B6B74 | #EDEDED / #A3A3A3 / #8A8A8A | Type |
| `--ink` / `--on-ink` | #000000 / #FFFFFF | #FFFFFF / #000000 | Primary buttons, focus ring |
| `--acc` (orange) | #FF6B1A | #FF7A2E | The single CTA per screen, marker highlight (`--hl`) |
| `--ok`, `--sage` (green) | #15803D, #22A352 | #4ADE80, #22C55E | Positive only |
| `--warn` (amber) | #A16207 | #FACC15 | Waiting |
| `--bad` (red) | #DC2626 | #F87171 | Blocked, destructive |
| `--ai` (violet) | #5B5BD6 | #A5A8FF | The AI only |

Each colour has `-soft` and `-line` variants for chip backgrounds and borders. `.surface-inverse` flips a section to the other theme (e.g. the sign-in hero).

## 3. Type

| Role | Spec |
|---|---|
| UI and body | Figtree 14/1.5, tracking −0.003em; 600 for names |
| Headings | Figtree, tracking −0.018em |
| Labels | 11px, 600, uppercase, +0.07em, `--faint` |
| Mono | Geist Mono for files, IDs, SHAs and paths |

Fonts load through `next/font` at build time (no browser request to Google).

## 4. Shape, elevation and motion

**Radii:** 6 chips · 7 mode buttons · 8 buttons, inputs and nav items · 9 the mode switch · 12 cards.

**Elevation:** buttons have a 1px border and a faint shadow and scale to 0.98 on press. Cards are flat with a hairline. Only popovers and composers get `--shadow` / `--shadow-pop`.

**Motion:** press 80ms · hover 150ms · entry `.rise` 320ms. `prefers-reduced-motion` turns them off. Nothing loops at idle.

## 5. Components (class contract)

- **Buttons:** `.btn` neutral · `.btn.pri` ink, the default primary · `.btn.cta` orange, at most one per screen, for actions that move work between spaces (e.g. **Push to Arena**) · `.btn.ghost` · `.btn.danger` for destructive confirms.
- **Chips:** `.chip` neutral · `.chip.acc` highlight (e.g. approver roles) · `.chip.ok` / `.warn` / `.bad` · `.chip.ai`.
- **Inputs:** `.inp`. **Navigation:** `.nav` rows; `.modes` / `.mode.on` for the Private / Arena / Developer switch.
- **Avatars:** `.av` is a neutral grey well; the AI's avatar uses the violet tint and the spark glyph.
- **Mentions and highlights:** `.hl` draws a marker stroke (orange from 60% height), not a pill.
- **AI messages:** violet tint; human messages sit on the canvas with no bubble. Message bodies render sanitised markdown.
- **Gate card:** amber "waiting" state, required files as `.chip.ok`, approver roles as `.chip.acc`, Send back + Approve (ink).

## 6. Brand assets

- **Logo (23 Oct):** the parcel box (cube) alone, never in a tile. In the app it is `apps/web/public/logo-mark.png` (transparent), drawn in the text colour. Only the favicon (`apps/web/src/app/icon.png`, from `docs/logo2.png`) keeps the black tile so it reads in any browser tab. Name set in Figtree 600, tight tracking.
- **Illustration:** none. The swan is retired; empty states use the logo mark.
- **Spark glyph:** the four-point spark means "AI" only.

## 7. Do and don't

**Do:** ink buttons by default · green only for things that really are good · violet only for the AI · hairlines rather than boxes in boxes · small radii.

**Don't:** gradients, glass or saturated fills behind content · a different colour per person · orange for errors or decoration · idle looping motion · hex values in components (tokens only).

## 8. Engineering notes

- Tokens map 1:1 into Tailwind (`apps/web/src/app/globals.css`); components use them through Tailwind or the skin classes, never hex.
- Contrast is checked for AA on both canvases. `--faint` is the lightest colour allowed for body copy.
