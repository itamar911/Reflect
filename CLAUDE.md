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
- **PayPlus** (Israeli clearing company) — chosen, not yet integrated. There is
  no payment code in the repo at all: no provider SDK, no checkout, no webhook,
  no billing table, and no column for a trial or a subscription period. The only
  mentions anywhere are the legal pages, in future tense — `terms` §4.2,
  `privacy` §2.1 and the §6 sub-processor table. Don't assume payment code
  exists; there is none.
- **Plan tiers are not a live mechanism.** `profiles.subscription_tier` and the
  `free` / `basic` / `pro` union in `src/lib/plans/config.ts` are left from a
  tier split we no longer sell. All three tiers resolve to the same unlimited
  limits, so every limit check in the app is a no-op that always passes, and the
  four numeric limits have no readers at all. What used to enforce the caps was
  three hand-made Postgres triggers, dropped by `022_drop_plan_limit_triggers.sql`
  — read that file and the header of `config.ts` before treating any of this as
  working.

## Database — read this before touching SQL

**Never run migrations, and never write to Supabase directly.** All SQL is run
manually by the owner in the Supabase SQL Editor.

**`supabase/migrations/` does not describe the live database.** Objects have been
created by hand in the Supabase dashboard and leave no trace in the repo, so a
grep over that directory will tell you something doesn't exist when it does.
Read `supabase/README.md` before writing a migration, and run
`supabase/queries/schema_drift.sql` if the answer matters.

Two consequences worth knowing without reading that file:

- An event trigger `ensure_rls` turns on RLS for every table created in
  `public`. It is ours, not Supabase's, it is not in any migration, and it is
  the only reason several tables aren't wide open. Don't drop it.
- `notebook_pages`, `rule_violations` and `setups` are used by the app and no
  migration creates them, so the migrations cannot rebuild the database.

Migration files are numbered (`001_…` through `037_…`, with two gaps: `021`
lands on the `ai-usage-accounting` branch, and no branch has an `029`). The
highest number is the newest file, not the state of production — see the caveat
above. When a change needs schema work: write the migration file, then tell the
owner to run it. Do not run `supabase` CLI commands, `psql`, or scripts that POST
to the Supabase REST API — the deny rules in the committed `.claude/settings.json`
block these, and that boundary is deliberate.

That includes the repo's own scripts that reach Supabase with `.env.local`
credentials — `scripts/probe-bucket.mjs`, `scripts/cleanup-orphans.mjs`,
`scripts/repro-upload.mjs`. The owner runs them. Their deny rules are
**enumerated by script name**, not a catch-all: a new script that talks to
Supabase must be added to that deny list in the same change, or nothing stops it.

`src/lib/plans/config.ts` mirrors a DB `CHECK` constraint. Changing the SET of
tier names means changing both in the same migration. Changing what a tier
*means* needs no migration — the column and the union already carry all three
values, so that is an edit to `PLAN_LIMITS` alone.

## Language and direction

The app is **Hebrew, RTL**. `src/app/layout.tsx` sets `lang="he" dir="rtl"`
globally, and most components set `dir="rtl"` on their root as well.

The exception is charts: recharts renders LTR, so chart containers explicitly set
`dir="ltr"` (see `src/components/stats/PnlChart.tsx`). Keep that pattern — don't
"fix" a chart's direction to match the page.

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
- The `.env` deny rules in `.claude/settings.json` are **enumerated, not a
  catch-all** — `.env`, `.env.local`, `.env.*.local`, `.env.development`,
  `.env.production`, `.env.test`, plus `**/` variants. `.env.example` is
  deliberately allowed. A new variant such as `.env.staging` is NOT covered by
  anything: add it to that deny list explicitly, or it is readable and writable.
- **Never put a credential on a command line** — not as an env-var prefix, not
  as an argument. Every approved command is saved verbatim to
  `.claude/settings.local.json` and to the session transcript. Scripts read
  secrets and test logins from `.env.local` (see `loadEnv()` in
  `scripts/probe-bucket.mjs`); the command line stays `node script.mjs`.
