# 09 — UX Specification & Design System

> **Superseded visual layer:** colours, type, radii and motion in this doc are replaced by the brand template v2, monochrome (`docs/design/ParallelFlow_Brand_Template_v2.md`, tokens in `apps/web/src/styles/parallelflow-brand.css`). **The UI reference is the running app**; the old design screens and the design canvas below are retired (deleted 9 Nov 2026). Layouts, flows and accessibility rules in this doc still apply where the app has not changed them.

> Build Pack v2.0 · Originally drawn from the design canvas "ParallelFlow App UI" (retired). Kept from it: the pill mode switcher, the rounded composer and the sidebar structure.

---

## 9.1 Information architecture

```
Global header:  [Private | Arena | Developer (soon)]   Search   Notifications   Profile
Private (global, also a dock on every screen)
  ├─ New session · My artifacts · My Arenas · Recent sessions (project tag when bound)
  └─ Session: conversation · bridge (bring context / push) · session context rail
Arena
  ├─ Sidebar: Inbox · New project · My Arenas · Direct messages
  ├─ Project: Arena (single stream) · Loop · Tasks · Artifacts · Routines · Settings (Members & roles, Gates, Agent, Access requests)
  └─ Setup wizard (7 steps)
Organization (by role)
  ├─ Dashboard (org / unit scope)
  ├─ Structure (units, unit roles) · Members & invites · Teams
  ├─ Org knowledge · Policies · SSO & SCIM · Agent usage · Audit log
Inbox & DMs
Onboarding
```

## 9.2 Screen inventory (canvas artboards)

| # | Artboard | Purpose | Key states to build |
|---|---|---|---|
| 1 | Private · Home | Empty state, composer, recent sessions | Empty / with history; model selector; "not bound" chip |
| 2 | Private · Session | Conversation, artifact card, bridge rail | Unbound / bound; agent streaming; failure; long history |
| 3 | Private · Push to Arena | Preview and confirm dialog | New vs new version; gate request; locked destination; error |
| 4 | Arena · Project space | Single stream, loop strip, approval card, right panel | Member / Observer (read-only banner) / agent degraded / empty Arena |
| 5 | Arena · Private dock | Private as slide-over with context picker | Picker; bind warning; existing bound session |
| 6 | Arena · SDLC loop | Cycles, stage cards, gate decision, history, progress.md | Pending / approved / sent back; SoD error; MAINTAIN + open next cycle |
| 7 | Setup · Custom roles | Templates, role × capability matrix, assignment | Template switch; blank; validation errors |
| 8 | Setup · Stage gates | Per-stage mode, approver roles, min approvals | Valid; GATE_UNSTAFFED; DISTINCT_ROLES_UNSATISFIABLE |
| 9 | Org admin · Dashboard | KPIs, project table, stage distribution, knowledge | Org scope / unit scope (Unit Lead); empty org |
| 10 | Notifications & DMs | Filters, action-needed, DM thread | Empty; many unread; DM with guest |
| 11 | Onboarding | Create organization (preset) | Startup / Enterprise preset; slug taken |
| 12 | **Org structure & roles** (v2) | Unit tree, unit roles, org roles, people | Add unit; assign Unit Lead; guest with expiry |
| 13 | **Project settings · Members & access** (v2) | Members with roles, Observer, access requests, agent autonomy | Approve request; last-owner guard; autonomy capped by org |
| 14 | **Routines & AI teammate** (v2) | Routine list with last run, task assigned to AI with reviewer | Routine failed; awaiting approval; task in review |

## 9.3 Design tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F6F6F7 | #0B0B0D | App ground |
| `--side` | #EFEFF1 | #111114 | Sidebars |
| `--panel` | #FFFFFF | #151518 | Cards, panels, composer |
| `--raise` | #F2F2F4 | #1E1E22 | Hover, chips, quiet fills |
| `--line` / `--line2` | #E3E3E7 / #D3D3D9 | #26262B / #36363C | Borders |
| `--text` | #17171B | #F1F1F3 | Body |
| `--muted` | #55555F | #A6A6B0 | Secondary text |
| `--faint` | #6A6A74 | #90909A | Meta text (≥4.5:1 on panel) |
| `--acc` | #6A55E3 | #9B88FF | Primary actions, focus, agent identity |
| `--acc-ink` | #5541D3 | #B6A8FF | Accent text |
| `--acc-soft` / `--acc-line` | #EFECFD / #D7D0FA | #221D3E / #3B3268 | Agent message background, selected states |
| `--on-acc` | #FFFFFF | #100C22 | Text on accent |
| `--ok` / `--ok-soft` | #1B7A46 / #E4F3EA | #4FC48C / #11271B | Approved, verified, online |
| `--warn` / `--warn-soft` | #94570A / #FBF0DC | #E5AB4E / #2A2011 | Waiting on gate, away |
| `--bad` / `--bad-soft` | #B0341D / #FBE6E1 | #F27D65 / #2D1611 | Blocked, rejected |

- **Typography:** Geist (UI), Geist Mono (keys, file names, ids).
- **Type scale:**

  | Use | Size |
  |---|---|
  | Display | 56 px |
  | H1 | 26 px |
  | H2 | 16–19 px |
  | Body | 14 px |
  | Meta | 12 px |

- **Radius:** 10 px (buttons), 14–16 px (cards), 18 px (composer), 999 px (pills, chips, avatars).
- **Spacing:** 4-px base; page gutters 24–40 px; 16 px minimum on mobile.
- **Elevation:** one soft shadow for composer, dialogs and popovers only.

## 9.4 Component inventory

| Component | Variants | Notes |
|---|---|---|
| Mode switcher (pill) | Private / Arena / Developer (disabled "Soon") | Matches inspiration |
| Button | primary, secondary, ghost, icon (44 px target) | Focus ring = `--acc` 2 px |
| Chip | neutral, accent, ok, warn, bad, mono key | Roles, statuses, project keys |
| Avatar | person, agent (sparkle on accent-soft), with presence dot | Agent never uses a human-looking avatar |
| Composer | Private (model selector, bind chip), Arena (tag menu, audience line), DM | No voice button in MVP |
| Message | human, agent (accent-soft bubble, "Agent" chip, cited sources, steps button), event row, routine post, approval card | Agent always labelled |
| Approval card | gate, agent action | Shows approver roles, progress (n of m), SoD hint |
| Artifact card | private, project; version chip; actions | Push to Arena on private cards |
| Loop strip / stage card | 6 stages | Current stage in accent |
| Role chip and role × capability matrix | — | Owner locked to all |
| Notification row | action-needed, info | Deep link |
| Dock (Private slide-over) | — | 460 px, focus-trapped |
| Wizard stepper | 7 steps | Completed / current / upcoming |
| Data table (grid-based) | dashboard projects, members | Horizontal scroll on small screens |

## 9.5 Interaction rules

1. **Always show where you are and who can see it:**
   - composer audience line ("everyone in IPP can see this" / "Only you");
   - project binding chip in Private.
2. **Agent output is never mistaken for a human's:** accent bubble, "Agent" chip, sparkle avatar.
3. **Approvals happen in place:** cards in the Arena and the Loop tab, plus inbox items. Rejecting or sending back requires a reason.
4. **Destructive or crossing actions are previewed:** push to Arena, decommission, remove member, binding a session.
5. **Read-only states are explicit:** the Observer banner replaces the composer and explains how to request a role.
6. **Errors say what to do next:** e.g. "DEPLOY needs an SRE approver, but no one has the SRE role. Add someone to SRE or change the gate."

## 9.6 Copy guidelines

- Use product nouns consistently: **Arena**, **Private**, **Push to Arena**, **central agent** (UI: "Central agent"), **AI teammate**, **cycle**, **gate**, **routine**, **Observer**.
- Sentence case, short verbs ("Request gate", "Assign to AI teammate", "Bring context").
- Never say "public" for Arena.
- Avoid jargon such as "RLS", "capability" or "tenant" in the UI. Say "permission" and "what this role can do".

## 9.7 Accessibility and responsive

- WCAG 2.1 AA: text contrast ≥ 4.5:1 (tokens validated); 44 px touch targets; visible focus; Radix primitives for dialog, menu and tabs; live region for streaming agent text; `aria-label` on icon buttons.
- **Breakpoints:**

  | Width | Layout |
  |---|---|
  | ≥ 1280 px | Three panes |
  | 1024–1279 px | Right panel collapses to a drawer |
  | 768–1023 px | Sidebar collapses to icons |
  | < 768 px | Single column with bottom navigation; reading, approving and messaging supported. Setup wizard and role matrix are desktop-first |
