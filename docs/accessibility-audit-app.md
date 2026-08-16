# Accessibility audit — logged-in app

**Standard:** ת"י 5568, which adopts WCAG 2.0 level AA.
**Scope:** the authenticated app, the auth screens, and onboarding. The public
landing page is covered only where a shared component reaches it.
**Baseline commit:** `c8d60b5`. No application code was changed for this audit.
**Method:** automated scan (axe-core 4.x, `wcag2a` + `wcag2aa` tags) against a local
`npm run dev` server, plus manual keyboard, form, contrast, structure and dynamic-content
passes. Both themes measured. Findings are stated per route; the shared-component
findings are consolidated in the prioritised list at the end.

WCAG 2.0 has no success criterion for status messages — that is 4.1.3, introduced in
WCAG 2.1 and therefore outside this target. Where a dynamic update is silent to a
screen reader, this report cites **1.3.1** (the information is present visually but not
programmatically conveyed) and notes the 2.1 criterion for reference only. Counts are
not inflated with out-of-scope criteria.

---

## Routes covered

Twenty routes were enumerated from the App Router and all twenty were audited.

| Group | Routes |
|---|---|
| Authenticated `(app)` | `/dashboard` `/journal` `/trades` `/stats` `/strategies` `/setups` `/rules` `/coach` `/notebook` `/settings` `/feedback` |
| Auth `(auth)` | `/login` `/signup` `/forgot-password` `/reset-password` |
| Protected | `/onboarding` |
| Public | `/` `/terms` `/privacy` `/phone-showcase` |

**Not audited, with reason:**

- `src/app/api/**` (14 route handlers) — JSON/HTML-email endpoints with no user-facing
  DOM. The HTML email templates are rendered by mail clients, not the browser, and are
  outside the scope of a page-level WCAG audit.
- `/auth/callback` — a redirect handler with no rendered UI.
- `/demo/*` — not a separate route. `src/proxy.ts:29-43` rewrites `/demo/<section>` onto
  the real page with an `x-demo-mode: 1` header so the data layer serves fixtures. It
  renders the same components as the authenticated routes and was used only to
  cross-check findings; every finding below was confirmed on the authenticated route.

### Note on `/demo` and `/phone-showcase`

`/demo` is resolved by `src/proxy.ts` — Next.js 16 renamed `middleware.ts` to `proxy.ts`,
which is why a `middleware` search finds nothing. `DEMO_SECTIONS` (`src/proxy.ts:7-10`)
admits ten sections including `phone-showcase`; anything else under `/demo/` redirects to
`/demo/dashboard`. The rewrite sets `X-Robots-Tag: noindex, nofollow`.

`/phone-showcase` is internal tooling — the fixture-fed composition captured for the
phone mockup on the auth screens (`src/app/phone-showcase/page.tsx:6-7`). It is not
linked anywhere in the UI. Bare `/phone-showcase` is auth-gated and redirects to `/login`
when signed out (verified). `/demo/phone-showcase` is publicly reachable with no auth.

**Decision item — answering the two questions asked:**

1. *Would it still be reachable at `/demo/phone-showcase` if removed from `DEMO_SECTIONS`?*
   **No.** `src/proxy.ts:33-35` redirects any `/demo/<section>` not in the set to
   `/demo/dashboard`. The URL would stop serving the showcase. Bare `/phone-showcase`
   would remain reachable, still auth-gated.
2. *Would that break the Playwright screenshot tooling?*
   **Only if the capture runs unauthenticated.** No capture script is committed anywhere
   in the repo — the run is ad hoc. If it drives a logged-in session it can use
   `/phone-showcase` directly and removal changes nothing; if it relies on the
   unauthenticated `/demo` alias, it would break and would need a session.

---

## Cross-cutting findings

These originate in shared components and therefore recur on many routes. They are stated
once here and referenced from the per-route sections rather than repeated.

| # | Criterion | Lvl | What fails | Where | Routes | Effort |
|---|---|---|---|---|---|---|
| X1 | 2.4.1 | A | No skip-to-content link anywhere in the codebase. With the sidebar ahead of content in the tab order, a keyboard user traverses ~14 stops before reaching page content on every route. | `src/app/layout.tsx`, `src/components/layout/AppShell.tsx` | 20 | Small |
| X2 | 1.3.1 | A | No `<main>` landmark in the app shell or the auth shell. `<main>` exists only on `/` and `/phone-showcase`. | `src/components/layout/AppShell.tsx:402+`, `src/components/auth/AuthShell.tsx` | 16 | Small |
| X3 | 4.1.2 | A | A real `ThemeToggle` button sits inside a container marked `aria-hidden` when the sidebar is collapsed. `pointerEvents:none` stops the mouse but not the keyboard, so the control stays in the tab order while being hidden from assistive tech. Confirmed by both axe (`aria-hidden-focus`) and the keyboard walk on all 11 app routes. | `src/components/layout/AppShell.tsx:530-538` | 11 | Small |
| X4 | 1.3.1 | A | **No live regions exist in the app.** `aria-live` appears exactly once in all of `src/` — inside the accessibility widget (`AccessibilityWidget.tsx:143`). Every dynamic update is silent: AI coach streaming, trade save, validation results, save confirmations. (Status-message announcement is 4.1.3 in WCAG 2.1; under 2.0 this is the information-and-relationships failure.) | app-wide | 20 | Medium |
| X5 | 4.1.2, 2.4.3 | A | **No modal in the app is a dialog.** Seven overlay components; none sets `role="dialog"` or `aria-modal`, none traps focus, none moves focus in on open, none restores focus on close. Only `JournalClient` handles Escape. Verified behaviourally on the trade detail modal: focus stayed on `<body>` when it opened and Tab walked straight out into the page behind. | `plans/UpgradeModal.tsx`, `rules/RuleBlockedModal.tsx`, `trade/TradePlanForm.tsx`, `journal/JournalClient.tsx`, `dashboard/DashboardClient.tsx`, `trade/TradingViewChart.tsx`, `demo/DemoGuard.tsx` | 11 | Medium |
| X6 | 1.1.1 | A | Decorative SVGs are correctly `aria-hidden`, but 15–32 per route are bare — neither hidden nor named. `/settings` 32, `/strategies` 24, `/dashboard` 22, `/trades` 18. | Lucide icon usages across app components | 11 | Medium |
| X7 | 1.4.3 | AA | Contrast. See the dedicated section below — **152 failing nodes across 9 routes in the light theme**, 21 across 5 in dark. | see below | 9 | Large |
| X8 | 1.4.4 | AA | **77% of app text does not respond to the widget's text scale** (1,019 of 1,323 measured text nodes). Per-route breakdown below. | `stats.css`, `journal.css`, `DashboardClient.tsx`, plus inline `fontSize` props and `text-[Npx]` classes app-wide | 11 | Large |
| X9 | 2.4.3 | A | The sidebar collapse toggle receives focus before the nav items it sits *below*, on every app route — a consistent −350px upward jump in the tab walk. | `src/components/layout/AppShell.tsx:363` | 11 | Small |

---

## Contrast (1.4.3, AA) — grouped by source

Measured with axe against 4.5:1 for body text and 3:1 for large text, in both themes.
The failures are not 152 independent problems; they come from **three sources**.

### Source A — semantic P&L / status colours applied unchanged on light surfaces

The win/loss/warning palette is tuned for dark surfaces and is reused verbatim on the
light theme's `#f4f6f8` / `#e9ecf0` / `#ffffff` backgrounds. This is the dominant source:
roughly 120 of the 152 light-theme nodes.

| Colour | Where it comes from | Worst ratio seen (light) | Needs |
|---|---|---|---|
| `#4ade80` | inline literal, P&L positives | **1.47** on `#e9ecf0` | 4.5 |
| `#00c853` | inline literal, discipline scores | 1.84–2.06 | 4.5 |
| `#22c55e` | inline literal + `--color-tg-success` (dark) | 1.88–2.10 | 4.5 |
| `#00d2d2` | `--color-tg-primary`, chips and pills | 1.57–1.88 | 4.5 |
| `#26a69a` | `--color-tg-success` (light) | 2.65–2.76 | 4.5 |
| `#f87171` / `#ef4444` | inline literals, P&L negatives | 1.60–3.47 | 4.5 |
| `#f59e0b` | `--color-tg-warning` | 1.95 | 4.5 |

The turquoise cases are a distinct sub-pattern: a 12%-tint chip background
(`#d7f2f3`, `#cff1f2`, `#e0f3f5`) with the full-strength accent as the foreground.

**Likely lever:** theme-aware semantic tokens, and replacing the inline hex literals that
bypass the token layer.

### Source B — `opacity` stacked on an already-compliant token

`--color-tg-muted` itself **passes** in both themes — `#ffffff` at 13.11–14.44:1 in dark,
`#5c6370` at 5.58–6.05:1 in light. The known concern about the dark value being
`#ffffff` is real but it is a visual-hierarchy issue, not a contrast failure: "muted" text
is not dimmed at all in dark mode.

The failures come from `opacity: 0.75` / `0.6` applied *on top* of that compliant colour,
which multiplies it against the surface: `#828892 on #f4f6f8` at 3.29 on `/stats`, and
`#28894e on #303036` at 2.98 / `#a33c3e on #303036` at 2.04 on `/dashboard`.

**Likely lever:** a second, genuinely dimmer token instead of an opacity multiplier.
`DashboardClient.tsx:896,1720` and `stats` 10.5px labels are the concentrations.

### Source C — very small type

Several failures are 8–11px text where even a modest ratio shortfall fails. `/feedback`
carries `#f87171aa` at 9px (2.88 dark, 1.87 light); `/dashboard` has 8px spans.

### Per-route contrast counts

| Route | Dark | Light |
|---|---|---|
| `/dashboard` | 14 | 59 |
| `/trades` | 2 | 39 |
| `/stats` | 3 | 28 |
| `/strategies` | 0 | 10 |
| `/rules` | 0 | 8 |
| `/notebook` | 0 | 4 |
| `/coach` | 1 | 0 |
| `/feedback` | 1 | 2 |
| `/journal` | 0 | 1 |
| `/settings` | 0 | 1 |
| **Total** | **21** | **152** |

The light theme is roughly seven times worse. If effort must be sequenced, the light
theme's semantic palette is the single highest-yield fix in this audit.

---

## Text scale (1.4.4, AA) — measured, by route

Measured directly: every text-bearing element's computed `font-size` at widget scale 100
vs 150, on the authenticated route. This supersedes a static prop count, because Tailwind
`text-[Npx]` classes and the px declarations in `stats.css` / `journal.css` freeze text
just as inline `fontSize` props do.

| Route | Text nodes | Scales | Frozen | **Frozen %** | of which inline `fontSize` |
|---|---|---|---|---|---|
| `/stats` | 204 | 6 | 198 | **97.1%** | 144 |
| `/notebook` | 47 | 4 | 43 | **91.5%** | 41 |
| `/trades` | 356 | 36 | 320 | **89.9%** | 231 |
| `/dashboard` | 303 | 40 | 263 | **86.8%** | 117 |
| `/journal` | 91 | 20 | 71 | **78.0%** | 20 |
| `/setups` | 24 | 8 | 16 | **66.7%** | 16 |
| `/feedback` | 37 | 14 | 23 | **62.2%** | 14 |
| `/strategies` | 61 | 30 | 31 | **50.8%** | 14 |
| `/coach` | 47 | 27 | 20 | **42.6%** | 14 |
| `/rules` | 69 | 50 | 19 | **27.5%** | 14 |
| `/settings` | 84 | 69 | 15 | **17.9%** | 14 |
| **Total** | **1,323** | **304** | **1,019** | **77.0%** | — |

Every route carries a floor of ~14 frozen nodes from the app shell itself
(`AppShell.tsx`, `Logo.tsx`).

The static count of numeric `fontSize` props is **233** (a recount; 234 was reported
earlier). Attributed to the routes that render them:

| Route | Props | Chief contributors |
|---|---|---|
| `/dashboard` | 61 | `DashboardClient.tsx` 53, `TradeHeatmap.tsx` 7 |
| `/stats` | 37 | `KpiHero` 7, `MindStateSection` 6, `PnlChart` 5, `PerformanceTable` 5, others 12 |
| `/notebook` | 27 | `NotebookEditor` 9, `NotebookPageList` 7, `NotebookSidebar` 5, `NotebookClient` 4 |
| `/journal`, `/trades` | 21 each | `JournalClient.tsx` 20 (shared by both) |
| `/setups` | 3 | `SetupsClient` 2 |
| `/feedback` | 3 | `feedback/page.tsx` 2 |
| `/strategies` | 2 | `StrategiesClient` 1 |
| `/rules`, `/coach`, `/settings` | 1 each | app shell only |
| Public / landing | 67 | `HowItWorksSection` 16, `DistinctionSection` 12, feature mocks 39 |
| `/phone-showcase` | 14 | `phone-showcase/page.tsx` |

### The accessibility widget in the app

The widget trigger is **present and operable on every route**, authenticated included —
hit-tested at its rendered position on all 20 routes and it is the topmost element there.
The earlier belief that it was route-gated to `/` and `/terms` was mistaken; the gate
belongs to `FloatingWhatsApp.tsx:21`. All seven settings were exercised in-app:

| Setting | Works in-app? | Reach |
|---|---|---|
| Text scale | Mechanically yes — root goes 16px → 24px | **Reaches only 23% of app text** |
| Contrast: high | Yes | Global (backdrop-filter overlay) |
| Contrast: inverted | Yes | Global |
| Grayscale | Yes | Global |
| Underline links | Yes | **`<a>` only** — 12 anchors vs 29 buttons on `/dashboard`; most in-app controls are `<button>` and are untouched |
| Readable font | Yes | Global |
| Large cursor | Yes | Global |
| Reduce motion | Yes | Global (`accessibility.css:142-149`) |

So no setting is unreachable, but two are substantially ineffective inside the app.

---

## Per-route findings

### `/dashboard`

Title `דשבורד — Reflect` ✓ · h1 ×1 ✓ · headings `1` · axe: 3 rules, 19 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 2.1.1 | A | Recent-trade rows are click-to-open on `<div>`/`<p>` with `cursor:pointer` and no focusable element — 25+ elements, mouse-only. | `DashboardClient.tsx` (`.py-3.cursor-pointer` rows) | Large |
| 4.1.2 | A | 4 buttons with no accessible name (icon-only pagination / period controls). | `DashboardClient.tsx` (`.p-3.rounded-lg`) | Small |
| 1.1.1 | A | The discipline radar (2× 300×300) and the equity/P&L charts (2× 620×183) are hand-rolled SVGs with no `role`, no `aria-label`, no `<title>`/`<desc>`, and no adjacent text alternative. | `DashboardClient.tsx` `RadarCard` | Large |
| 1.4.1 | A | `TradeHeatmap` encodes direction and intensity purely as cell background (`rgba(0,200,83,α)` / red), with no `title`, no `aria-label` and no cell text. Its legend swatches are likewise colour-only. | `TradeHeatmap.tsx:81,85,127,146` | Medium |
| 1.4.3 | AA | 14 nodes dark, **59 light** — sources A and B above. | — | Large |
| 1.4.4 | AA | 86.8% of text frozen. | — | Large |
| — | — | Also X1–X6, X8, X9. | — | — |

The P&L figures themselves are **not** a 1.4.1 failure: they carry `+`/`−` signs and
numeric values alongside the colour. The heatmap is the genuine colour-only case.

### `/journal`

Title `יומן חודשי — Reflect` ✓ · h1 ×1 ✓ · headings `1,2` ✓ · axe: 1 rule, 1 node.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.4.3 | AA | 1 node light (turquoise day marker on `#f4f6f8`, 1.73). | `TradeCalendar.tsx` | Small |
| — | — | X1–X6, X8, X9. | — | — |

The month calendar is **not** colour-only: `TradeCalendar.tsx:57-68` renders a signed
currency label (`+₪120` / `−₪80`) beside the colour. Good as-is.

### `/trades`

Title `כל העסקאות — Reflect` ✓ · h1 ×1 ✓ · axe: 4 rules, 22 nodes. Worst route for forms.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 2.1.1 | A | The whole trades table is mouse-only — rows open the detail modal on `<td>` click; 10 `td` + 6 `.jr-num` + more, none focusable. | `JournalClient.tsx` (`table.jr-table`) | Large |
| 3.3.2, 1.3.1, 4.1.2 | A | **19 of 19 form fields unlabelled**: 17 row checkboxes (no name at all), the search input (placeholder only), and a `<select>` with no accessible name. | `JournalClient.tsx` | Medium |
| 1.3.1 | A | `table.jr-table` has 11 `<th>` but **zero `scope`** attributes and no `<caption>`. | `journal.css` / `JournalClient.tsx` | Small |
| 2.4.7 | AA | The filter `<select>` sets `outline-none` with no replacement focus style. | `JournalClient.tsx` | Small |
| 1.4.3 | AA | 2 nodes dark, **39 light** — status chips and `.jr-num` P&L. | — | Large |
| 1.4.4 | AA | 89.9% of text frozen; 231 inline `fontSize`. | — | Large |
| — | — | X1–X6, X8, X9. | — | — |

### `/stats`

Title `סטטיסטיקה — Reflect` ✓ · h1 ×1 ✓ · headings `1,2×7` ✓ · axe: 2 rules, 4 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.3.1 | A | Two real `<table class="stats-table">` with 5 `<th>` each — but **no `scope`** and no `<caption>`. They *are* real tables, not div-grids. | `PerformanceTable.tsx`, `stats.css` | Small |
| 1.1.1 | A | Two recharts surfaces carry `role="application"` with recharts' default empty `<title>`/`<desc>` and no `aria-label` — present but conveying nothing. No tabular alternative. | `PnlChart.tsx`, `DistributionSection.tsx` | Large |
| 1.4.3 | AA | 3 nodes dark, **28 light** — `.stats-num` on `--color-tg-success`/`danger`, plus the `opacity:0.75` 10.5px labels. | — | Large |
| 1.4.4 | AA | **97.1% frozen — the worst route in the app.** | `stats.css` + 144 inline props | Large |
| — | — | X1–X6, X8, X9. | — | — |

### `/strategies`

Title `אסטרטגיות — Reflect` ✓ · h1 ×1 ✓ · headings `1,2` ✓ · axe: 2 rules, 3 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 4.1.2 | A | 2 icon-only buttons with no accessible name (edit/delete affordances). Both **reached, not activated**. | `StrategiesClient.tsx` | Small |
| 1.4.3 | AA | **10 nodes light** — turquoise chips on tinted backgrounds, `#4ade80` stat values. | — | Medium |
| — | — | X1–X6, X8, X9. | — | — |

### `/setups`

Title `סטאפים ותגיות — Reflect` ✓ · h1 ×1 ✓ · axe: 1 rule, 1 node — cleanest app route.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| — | — | X1–X6, X8, X9 only. Delete affordances **reached, not activated**; focus ring visible on each. | — | — |

### `/rules`

Title `חוקי מסחר — Reflect` ✓ · h1 ×1 ✓ · axe: 3 rules, 5 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 3.3.2, 1.3.1, 4.1.2 | A | 5 of 5 fields unlabelled: 3 `<input type=number>` (rule thresholds) and a `<select>`, none with an accessible name. A user cannot tell which threshold a spinner controls. | `RulesEditor.tsx` | Medium |
| 2.4.7 | AA | **4 controls with no visible focus indicator** — the number inputs, the select, and a button, all `focus:outline-none` with no replacement. Highest concentration in the app. | `RulesEditor.tsx` | Small |
| 1.4.3 | AA | 8 nodes light — turquoise pills and Pro badge. | — | Medium |
| — | — | X1–X6, X8, X9. | — | — |

### `/coach`

Title `יועץ מסחר — Reflect` ✓ · h1 ×1 · axe: 3 rules, 3 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.3.1 | A | **Heading level skip: `1 → 3`.** No `<h2>` on the route. | `coach/page.tsx` | Small |
| 1.3.1 | A | The AI response streams into the page with **no live region anywhere on the route** (0 before and after firing a prompt). A screen-reader user gets no indication that a reply started, streamed, or finished. This is the most user-visible instance of X4. | `AICoachCard.tsx` | Medium |
| 3.3.2, 4.1.2 | A | 2 unlabelled fields: the prompt `<textarea>` (placeholder only) and an `<input type=file>` for chart upload with no accessible name. | `AICoachCard.tsx` | Small |
| 4.1.2 | A | 1 button with no accessible name (the send control, icon-only). | `AICoachCard.tsx` | Small |
| 2.4.7 | AA | The prompt textarea has no visible focus indicator. | `AICoachCard.tsx` | Small |
| 1.4.3 | AA | 1 node dark (`#a78bfa` at 10px, 4.26). | — | Small |
| — | — | X1–X6, X8, X9. | — | — |

### `/notebook`

Title `מחברת — Reflect` ✓ · axe: 2 rules, 2 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.3.1 | A | **No `<h1>` and no headings at all** — the only app route with an empty heading outline. | `NotebookClient.tsx` | Small |
| 3.3.2, 4.1.2 | A | 5 of 5 fields unlabelled — page search ×2, page title, tag input, and the body `<textarea>`, all placeholder-only. | `NotebookEditor.tsx`, `NotebookSidebar.tsx`, `NotebookPageList.tsx` | Medium |
| 2.1.1 | A | 3 click-only elements (page-list affordances). | `NotebookPageList.tsx` | Medium |
| 4.1.2 | A | 1 icon-only button with no accessible name. | `NotebookEditor.tsx` | Small |
| 2.4.7 | AA | Inputs and the textarea have no visible focus indicator. | `NotebookEditor.tsx` | Small |
| 1.4.3 | AA | 4 nodes light — turquoise on tinted chips, `#4ade80` "saved" indicator. | — | Medium |
| 1.4.4 | AA | 91.5% frozen. | — | Large |
| — | — | X1–X6, X8, X9. | — | — |

The `נשמר` ("saved") indicator is green text with no icon or role — combined with X4 it is
never announced, so autosave state is invisible to a screen-reader user.

### `/settings`

Title `הגדרות — Reflect` ✓ · h1 ×1 ✓ · headings `1,2,2,2,3,3,2,3` ✓ · axe: 2 rules, 6 nodes.
**Best route for text scale (17.9% frozen).**

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 4.1.2 | A | **5 toggle switches with no accessible name and no `role="switch"`/`aria-checked`** — a screen-reader user hears an unlabelled button and cannot tell its state. | `settings/AlertsPanel.tsx:154` | Small |
| 1.1.1 | A | 32 bare SVGs — the highest count in the app. | — | Medium |
| 1.4.3 | AA | 1 node light. | — | Small |
| — | — | X1–X6, X8, X9. Account and subscription controls **reached, not activated**; focus ring visible on each. | — | — |

The same toggle pattern appears in `rules/RulesEditor.tsx:237`, so one fix covers both.

### `/feedback`

**Title missing** — falls back to the root title. axe: 2 rules, 2 nodes.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 2.4.2 | A | No `export const metadata` — the page inherits `Reflect — השוק בוחן את האסטרטגיה שלך`. | `src/app/(app)/feedback/page.tsx` | Small |
| 3.3.2, 4.1.2 | A | 3 of 3 fields unlabelled — summary input, description `<textarea>`, and an `<input type=file>` with no accessible name. | `feedback/page.tsx` | Small |
| 2.4.7 | AA | Input and textarea have no visible focus indicator. | `feedback/page.tsx` | Small |
| 1.4.3 | AA | 2 nodes — `#f87171aa` at **9px** (2.88 dark, 1.87 light), the smallest failing text in the app. | `feedback/page.tsx` | Small |
| — | — | X1–X6, X8, X9. | — | — |

### `/login`

Title `התחברות — Reflect` ✓ · axe: **0 violations**.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.3.1 | A | No `<h1>` — the page's purpose (`ברוך הבא! התחבר לחשבונך`) is styled text, not a heading. No `<main>`. | `auth/AuthShell.tsx` | Small |
| 1.3.1 | A | The `אימייל או סיסמה שגויים` error is visible text but is not associated with either field (no `aria-describedby`, no `aria-invalid`) and sits in no live region, so it is never announced. 3.3.1 is arguably met by the visible text; the association and announcement are the gaps. | `auth/AuthScreen.tsx:78` | Small |
| — | — | X1 (skip link), X7 baseline. Both fields carry `label[for]` ✓ and correct `autocomplete` ✓. | — | — |

### `/signup`

Title `הרשמה — Reflect` ✓ · axe: **0 violations**. **The best-built form in the product.**

All three fields have `label[for]`, `required`, and correct `autocomplete`
(`email`, `new-password`). Verified by real submission.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 1.3.1 | A | No `<h1>`, no `<main>` (shared `AuthShell`). | `auth/AuthShell.tsx` | Small |
| 3.3.1 | A | Empty submit falls through to **native browser validation**, which renders in the *browser's* locale — "Please fill out this field." in English on a Hebrew RTL page. Native bubbles are announced, so this is a language/consistency defect rather than a hard failure; flagged because it is the only error path on the route. | `auth/AuthScreen.tsx` | Small |
| — | — | Flow defect, not WCAG: `AuthScreen.tsx:72` shows `בדוק את האימייל שלך לאישור החשבון` after **every** successful signup and never navigates — even though Supabase returned a live session and email confirmation is not actually required. The account signs in normally at `/login`. Worth fixing before launch. | `auth/AuthScreen.tsx:61-73` | Small |

### `/forgot-password` and `/reset-password`

axe: 0 violations on both.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 2.4.2 | A | **Neither route sets a title** — both inherit the root title, so the two are indistinguishable in a tab list or history. | `(auth)/forgot-password/page.tsx`, `(auth)/reset-password/page.tsx` | Small |
| 1.3.1 | A | No `<h1>`, no `<main>`. | `auth/AuthShell.tsx` | Small |

### `/onboarding`

Title `הגדרת פרופיל — Reflect` ✓ · h1 ×1 ✓ · headings `1,2` ✓ · axe: **0 violations**.
All 8 steps walked. **Zero click-only elements** — the choice cards are real `<button>`s.

| Criterion | Lvl | What fails | Where | Effort |
|---|---|---|---|---|
| 4.1.2 | A | The choice cards on steps 2, 3, 4, 6, 7 are buttons with **no `aria-pressed`, `aria-checked`, or `role="radio"`** and no grouping — selection state is invisible to assistive tech, and a single-choice question is not conveyed as one. | `onboarding/OnboardingWizard.tsx` | Small |
| 3.3.2, 1.3.1 | A | Step 5 has **two `<input type="range">` sliders with no label** — announced as "slider, 50" with no indication of what they control. | `onboarding/OnboardingWizard.tsx` | Small |
| 1.3.1 | A | No `<main>`; step progress (`שלב 1 מתוך 8`) is styled text with no `role="progressbar"` or live region, so step changes are silent. | `onboarding/OnboardingWizard.tsx` | Small |
| 2.4.7 | AA | The `המשך` (Continue) button — the primary control on every step — has **no visible focus indicator**. | `onboarding/OnboardingWizard.tsx` | Small |

Step 1's name field is correctly labelled ✓.

### `/`, `/terms`, `/privacy`

Landing: h1 ×1 ✓, `<main>` ✓, heading outline clean, 2 axe rules (`list`/`listitem`
nesting, 10 nodes — 1.3.1 A, small). Terms and privacy: h1 ✓, titles ✓, axe clean, but
**no `<main>`** (X2). These are outside the stated scope and are listed for completeness.

### `/phone-showcase`

Title missing (inherits root, 2.4.2 A) · no `<h1>` · has `<main>` ✓ · 7 contrast nodes.
Internal tooling — see the decision item above. Not user-facing, so its findings are
recorded but excluded from the prioritised list.

---

## Prioritised list, all routes

Level A first, then AA, each ordered by how many routes the finding affects.

### Level A

| # | Criterion | Finding | Routes | Effort |
|---|---|---|---|---|
| 1 | 2.4.1 | No skip-to-content link | **20** | Small |
| 2 | 1.3.1 | No `<main>` landmark (app shell + auth shell) | **16** | Small |
| 3 | 1.3.1 | No live regions anywhere — every dynamic update is silent | **20** | Medium |
| 4 | 4.1.2 | `aria-hidden` container holds a keyboard-focusable `ThemeToggle` | **11** | Small |
| 5 | 4.1.2 / 2.4.3 | No modal is a dialog: no role, no `aria-modal`, no focus trap, no focus restore; Escape on only one of seven | **11** | Medium |
| 6 | 1.1.1 | Bare SVGs — neither `aria-hidden` nor named (15–32 per route) | **11** | Medium |
| 7 | 2.4.3 | Sidebar collapse toggle focuses before the nav it sits below | **11** | Small |
| 8 | 3.3.2 / 1.3.1 / 4.1.2 | Unlabelled form fields — 43 across the app (trades 19, trade form 7, rules 5, notebook 5, feedback 3, coach 2, onboarding 2) | **7** | Medium |
| 9 | 4.1.2 | Buttons with no accessible name — 13 nodes (settings toggles 5, dashboard 4, strategies 2, coach 1, notebook 1) | **5** | Small |
| 10 | 2.1.1 | Click-only controls — table rows and list rows operable by mouse only | **3** | Large |
| 11 | 1.1.1 | Charts with no text alternative — dashboard radar + equity, stats recharts | **2** | Large |
| 12 | 1.3.1 | Real tables with `<th>` but no `scope` and no `<caption>` | **2** | Small |
| 13 | 2.4.2 | Missing page title — feedback, forgot-password, reset-password | **3** | Small |
| 14 | 1.3.1 | Missing `<h1>` — notebook (no headings at all) + 4 auth routes | **5** | Small |
| 15 | 4.1.2 | Onboarding choice buttons expose no selected state | **1** | Small |
| 16 | 1.4.1 | `TradeHeatmap` conveys direction and intensity by colour alone | **1** | Medium |
| 17 | 1.3.1 | Heading level skip `1 → 3` | **1** | Small |
| 18 | 1.3.1 | Login error not associated with its field | **1** | Small |

### Level AA

| # | Criterion | Finding | Routes | Effort |
|---|---|---|---|---|
| 19 | 1.4.3 | Contrast — **152 failing nodes in light, 21 in dark**, from three sources (semantic palette on light surfaces; `opacity` over compliant tokens; sub-11px type) | **9** | Large |
| 20 | 1.4.4 | **77% of app text ignores the widget's text scale**; worst on stats (97%), notebook (92%), trades (90%), dashboard (87%) | **11** | Large |
| 21 | 2.4.7 | No visible focus indicator — `outline-none` with no replacement (rules ×4, notebook, feedback, trades, coach, onboarding's primary button) | **6** | Small |
| 22 | 2.4.6 | Auth routes have no heading to describe their purpose | **4** | Small |

### Sequencing note

Items 1, 2, 4, 7, 9, 12, 13, 14 and 21 are all *small* and together clear nine of the
twenty-two entries, including four that affect eleven or more routes. Items 19 and 20 are
the two large structural ones and are independent of everything else, so they can run in
parallel with the small work rather than blocking it.

---

## Method notes and limitations

- Automated scanning catches roughly a third of real issues. Every axe result here was
  re-checked manually, and the majority of Level A findings above (click-only controls,
  modal behaviour, live regions, colour-only encoding, focus order) came from the manual
  passes, not from axe.
- `NEXTJS-PORTAL` appears as an unfocusable-looking tab stop on every route. It is the
  Next.js dev-tools overlay and does not exist in a production build; it is excluded from
  all counts rather than reported as a false positive.
- `content-visibility: auto` makes `innerText` read empty for offscreen content, so all
  text measurement used `textContent`. Every route was scrolled top-to-bottom before
  measurement so IntersectionObserver-gated components had mounted.
- Wrapping was never inferred from client-rect counts: in this RTL codebase a string
  mixing Hebrew and Latin returns two rects inside a single line box. Vertical position
  was compared instead.
- Destructive controls (settings account/subscription, trade delete, strategy and setup
  delete) were tabbed to and recorded for reachability and focus visibility, then left —
  **reached, not activated**.
- The audit ran against a local dev server. That server authenticates against the hosted
  Supabase project, so the signup performed for this audit created a real row there.
