# Reflect (TradeGuard)

A trading-discipline app: traders submit a plan before entering a trade, the app
checks it against their rules, and an AI coach reviews their behaviour over time.

## Stack

- **Next.js 16** (App Router, React 19, TypeScript) deployed on **Vercel**
- **Supabase** — Postgres, auth, RLS. Clients live in `src/lib/supabase/`:
  `client.ts` (browser), `server.ts` (RSC/route handlers), `admin.ts` (service-role,
  server-only — never import it into anything that reaches the browser)
- **Claude API** via `@anthropic-ai/sdk` — every AI feature is a route under
  `src/app/api/` (`ai-coach`, `ai-debrief`, `ai-patterns`, `ai-trade-review`, …)
- **Tailwind v4** + `recharts` for charts, `lucide-react` for icons
- **Stripe** — planned, not yet integrated. Plan tiers (`free` / `basic` / `pro`)
  already exist in `src/lib/plans/config.ts` and in the DB as
  `profiles.subscription_tier`, but no payment processor is wired up yet. Don't
  assume Stripe code exists; there is currently none in the repo.

## Database — read this before touching SQL

**Never run migrations, and never write to Supabase directly.** All SQL is run
manually by the owner in the Supabase SQL Editor.

Migration files live in `supabase/migrations/` and are numbered (`001_…` through
`016_…`). When a change needs schema work: write the migration file, then tell the
owner to run it. Do not run `supabase` CLI commands, `psql`, or scripts that POST
to the Supabase REST API — the permission rules in `.claude/settings.local.json`
deny these, and that boundary is deliberate.

`src/lib/plans/config.ts` mirrors a DB `CHECK` constraint. If you change plan tiers
in one place, the other must change in the same migration.

## Language and direction

The app is **Hebrew, RTL**. `src/app/layout.tsx` sets `lang="he" dir="rtl"`
globally, and most components set `dir="rtl"` on their root as well.

The exception is charts: recharts renders LTR, so chart containers explicitly set
`dir="ltr"` (see `src/components/stats/PnlChart.tsx`,
`src/components/dashboard/TradeHeatmap.tsx`). Keep that pattern — don't "fix" a
chart's direction to match the page.

## Visual conventions

- **Turquoise accent: `#00d2d2`.** Used for values, focus rings, and highlights.
  See `.value-accent` / `.stat-value-accent` in `src/app/globals.css`.
- **No emojis anywhere in the UI.** Not in labels, not in headings, not in empty
  states.
- **Icons are Lucide only** (`lucide-react`). No inline SVG icon sets, no icon fonts.
- Dark surfaces throughout; the app shell and landing page share tokens defined in
  `src/app/globals.css` (`--color-tg-*`).

## Landing page

Lives in `src/components/landing/`, rendered from `src/app/page.tsx`. Section
components are self-contained; shared styling is in `landing.css`.

**Feature mocks** — `src/components/landing/feature-mocks/` — are the small
animated product previews shown in the features section. They are hand-built fake
UI, not screenshots, and they carry most of the landing page's visual weight.

`CalendarMock.tsx` is the current quality bar. When adding or reworking a mock,
match it: real data structure behind the visual, considered spacing and density,
no placeholder greys, no emoji, Lucide icons only, and readable at the size it
actually renders. `MockFrame.tsx` provides the shared chrome.

## Working notes

- Typecheck with `npx tsc --noEmit`. Lint with `npm run lint`.
- The `verify` skill (`.claude/skills/verify/SKILL.md`) has the build/launch/Playwright
  recipe for driving the app end-to-end.
- Primary shell on this machine is PowerShell; the Bash tool is also available.
