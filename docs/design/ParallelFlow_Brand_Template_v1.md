# ParallelFlow brand template v1: calm workspace

Status: adopted 15 Oct 2026. It replaces the violet/Geist theme in doc 09 (UX and design system) of Build Pack v2.0. Reference: the minimalism of posthog.com (warm off-white, thin borders, pressable buttons, small radii, playful illustration used sparingly). ParallelFlow does not copy its palette, mascot or desktop/window chrome.

Source of truth for code: `parallelflow/design/parallelflow-brand.css` (tokens plus component skin). Every design-canvas artboard inlines this file, and the "Brand template v1" artboard is the visual reference.

## 1. Principles

1. **Keep the workspace calm.** Use a cream canvas, white content surfaces, ink type and 1px hairlines. The conversation and the shared work are the only things that should draw the eye.
2. **Make collaboration the focus.**
   - Faces, decisions and tasks come first.
   - Avatars are neutral sand.
   - Decision (gate) and task cards are compact.
   - The AI is visibly a teammate, with its own subtle identity.
3. **Add character through details.** Personality comes from four things, and none of them appears on every component:
   - one small illustration per moment;
   - a marker highlight;
   - a breathing presence dot;
   - pressable buttons.

## 2. Colour

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` Cream | #FDFDF8 | #1A1A16 | Canvas |
| `--sand` Sand | #E1D7C2 | #4A4537 | Outer surfaces (onboarding panel), illustration fills |
| `--side` | #F5F1E6 | #20201B | Sidebars and rails |
| `--panel` White | #FFFFFF | #24241F | Content surfaces and cards |
| `--raise` | #F6F3EA | #2C2C26 | Hover states, table heads, tracks |
| `--line` / `--line2` | #ECE6D8 / #DCD3BF | #33332C / #45443A | Hairlines / control borders and button edges |
| `--text` / `--ink` Ink | #282923 | #F1EFE6 | Type and the primary button |
| `--muted` / `--faint` | #5C5D53 / #727366 | #BEBBAD / #A3A194 | Secondary and tertiary text |
| `--acc` Orange | #E07A2F (ink #A24F17) | #F0955A | Highlights only: mentions, unread, current stage, focus ring, the single CTA |
| `--sage` / `--ok` Sage | #8DAA86 / #4D7A4A | #7F9C78 / #A3C49A | Positive states: approved, online, done, progress |
| `--warn` | #8A5A0B on #FBF1DA | #E3B15C | Waiting (gate pending, in review) |
| `--bad` | #A8402A on #FAE8E2 | #EE8C74 | Blocked or overdue |
| `--ai` Dusk | #56648C on #F1F3F8 | #A9B5DA | AI identity only |

Ratio per screen: cream and white make up about 80%, sand and ink about 16%, and orange, sage and dusk together stay under 5%.

## 3. Type

| Role | Spec |
|---|---|
| UI and body | Figtree: 14/1.5 body, 600 for names |
| Display | Figtree 40–56/700, tracking −0.025em |
| Titles | Figtree 22/700 |
| Labels | 11px, 600, uppercase, +0.07em |
| AI name | Newsreader italic 15/500, Dusk ink (e.g. *Central agent*, *Your agent*) |
| Mono | Geist Mono for files, IDs, SHAs and paths |

## 4. Shape, elevation and motion

**Radii:**
- 6 for chips;
- 7 for controls and buttons;
- 10 for cards;
- 12 for the logo tile.

Pills are kept only for the mode switch.

**Elevation:**
- Buttons have a 2px bottom edge (`box-shadow: 0 2px 0 var(--line2)`). On press the button moves down 2px and the edge disappears, over 80ms.
- Cards are flat with a hairline.
- Only popovers and composers get `--shadow`.

**Motion:**

| Animation | Spec |
|---|---|
| Press | 80ms |
| Hover | 150ms |
| Entry (`.rise`) | 320ms |
| Presence (`.live`) | 2.4s breathe |
| AI typing (`.typing`) | 1.2s |

`prefers-reduced-motion` turns all of these off. Nothing else loops.

## 5. Components (class contract)

**Buttons:**
- `.btn`: neutral.
- `.btn.pri`: ink, the default primary.
- `.btn.cta`: orange. At most one per screen, and reserved for actions that move work between spaces, such as **Push to Arena**.
- `.btn.ghost`.

**Chips:**
- `.chip`: neutral.
- `.chip.acc`: highlight, e.g. approver roles.
- `.chip.ok`, `.chip.warn`, `.chip.bad`.
- `.chip.ai`.

**Status:** `.status.{ok|warn|bad|acc|ai}` is a dot plus a label.

**Avatars:** `.av` is a sand well. `.av.ai` is the dusk tint with the spark glyph. `.live` is the sage breathing dot.

**Mentions:** `.tag` and `.hl` draw a marker stroke (22% orange from 58% height), not a pill. `.hl.sage` is the positive variant.

**AI turn:** `.ai-msg` has the dusk tint and a 4px "speaking" corner, with `.ai-name` in serif italic. Human turns sit directly on the canvas with no bubble.

**Decision card:** an amber "waiting" count, required artifacts as `.chip.ok`, approver roles as `.chip.acc`, and Send back + Approve (ink).

**Task card (AI teammate):** `.chip.ai` + status chip, a sage progress bar, and a reviewer line ("Only a human can verify and close").

## 6. Brand assets

**Logo:**
- An "S" drawn as a swan's neck, with an orange point for the shared agent.
- Cream stroke on an ink tile (12px radius).
- Name set in Figtree 700.

**Illustration:**
- A swan resting on calm water with reeds, a sun and a small dusk spark: ink line 1.7, with white, sand, sage and orange fills.
- Use it only on onboarding, empty states and celebrations (e.g. gate passed), and never more than one per screen.

**Spark glyph:** the four-point spark now means "AI" only. It is no longer the logo.

## 7. Do and don't

**Do:**
- Use ink buttons by default.
- Use sage only for things that really are good.
- Use dusk only for the AI.
- Separate areas with hairlines rather than boxes in boxes.
- Keep radii small.

**Don't:**
- Gradients, glass or saturated fills behind content.
- A different colour for each person's avatar.
- Orange for errors or decoration.
- More than one illustration per screen.
- Idle looping motion.

## 8. Engineering notes

- Map the tokens 1:1 into Tailwind `theme.extend.colors` (e.g. `bg`, `panel`, `ink`, `acc`, `sage`, `ai`) and into shadcn CSS variables. The light and dark sets are complete.
- Fonts come from Google Fonts: Figtree (400/500/600/700), Newsreader italic (400/500) and Geist Mono (400/500).
- Contrast is checked for AA on the cream canvas. Faint text (#727366) is about 4.6:1, so do not go lighter for body copy.
