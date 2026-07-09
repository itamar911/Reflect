---
name: verify
description: Build/launch/drive recipe for verifying changes in this Next.js + Supabase app (TradeGuard/Reflect) end-to-end with Playwright.
---

# Verifying changes in this repo

Next.js 16 app (`npm run dev`, port 3000) backed by a remote Supabase project.
Credentials live in `.env.local` (anon key + `SUPABASE_SERVICE_ROLE_KEY`).

## Launch

```bash
npm run dev   # background; ready when GET / returns 200
```

## Auth handle (no fixed test password)

Login is Supabase email/password (`/login`, `input[type=email]` /
`input[type=password]`). Create a throwaway user with the service-role key,
drive the real login form, and **delete the user afterwards** (FK cascade
removes profiles + trade_plans):

- `admin.auth.admin.createUser({ email, password, email_confirm: true })`
- set `profiles.onboarding_completed = true` for the new id, or the app
  layout redirects every page to `/onboarding`
- seed `trade_plans` rows directly (schema: `supabase/schema.sql:123`);
  a closed trade needs `status='closed'`, `exit_price`, `closed_at`
- cleanup: `admin.auth.admin.deleteUser(id)`

Do NOT touch the existing `seince33@gmail.com` test user — its password is
not known here and resetting it would break the owner's login.

## Driving with Playwright

Playwright is not a repo dep; it lives in the npx cache
(`~/.npm/_npx/*/node_modules/playwright`, chromium already installed).

Gotchas:

- The app is RTL Hebrew; match on Hebrew text (e.g. row action menu is
  `button[title="פעולות"]`, close-trade item is `סגור עסקה`).
- Modals portal to `document.body` with `div.fixed.inset-0.z-50`. Scope
  selectors to `.z-50` — AppShell always mounts an invisible
  `div.fixed.inset-0.z-30` mobile-sidebar backdrop that otherwise matches.
- Every page is wrapped in `.page-enter`, which retains a `transform`
  (fill-mode both) — any `position: fixed` element rendered inline in the
  page tree is scoped to the page box, not the viewport. Overlays must
  portal to body (see `Modal` in `src/components/journal/JournalClient.tsx`).
- All-trades table: `table.jr-table`, rows open the detail modal on click.
