import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dev-only overlay. It defaults to the bottom-left corner, which is where
  // the accessibility trigger now lives — locally it sat on top of the
  // trigger and swallowed the click. Not present in production builds;
  // moved purely so the control is operable while developing.
  devIndicators: { position: 'top-left' },

  /**
   * The four TTFs the share card is rasterised with (REF-125 Stage 3) — two
   * Nunito weights for the card's own type, two Rubik weights carried only so a
   * Hebrew nickname has glyphs to fall back to.
   *
   * They are read at runtime with `readFileSync` (src/lib/share/cardFonts.ts),
   * which no bundler can follow into a file list — so without this entry they
   * are simply absent from the serverless bundle, and the route throws ENOENT
   * in production while working perfectly in `next dev`.
   *
   * This is the DECLARED form of something that was previously happening by
   * accident: writing the path as `new URL(..., import.meta.url)` made
   * Turbopack give up on static analysis and trace the WHOLE PROJECT into this
   * route's bundle ("Encountered unexpected file in NFT list"). The fonts were
   * included, but only because everything was. Naming them here is what makes
   * their presence a fact rather than a side effect of over-tracing.
   *
   * Keyed by route, so only the image route carries them.
   */
  outputFileTracingIncludes: {
    '/share/[token]/image': ['./src/lib/share/fonts/*.ttf'],
  },

  /**
   * Keep a navigated route in the client router cache for 30 seconds
   * (REF-129 item 5).
   *
   * The default for a dynamic route is `0`, which means the router cache holds
   * nothing: every soft navigation re-fetches the route from the server, and a
   * prefetched payload is thrown away before it can be used — the app paid for
   * the prefetch and then fetched again on the click. Every route in the (app)
   * group is dynamic, so that was all of them, and it is why "מעבר בין סעיפי
   * הסיידבר מרגיש איטי" survived having prefetch on at all.
   *
   * 30s is chosen to match FRESH_MS in lib/rules/brokerDayContext.ts, which is
   * this product's existing answer to the same question — how long a figure
   * stands before it is re-read — and the reasoning carries: long enough that
   * clicking between the dashboard and the journal and back reuses what it
   * already has, short enough that a trade closed while the trader is reading
   * another page is picked up on the next visit.
   *
   * WHAT IS NOT AFFECTED, and why this is safe for a journal whose numbers
   * change: this is the SOFT-navigation cache only. A hard load, a reload, and
   * `router.refresh()` all bypass it — and `router.refresh()` is what the app
   * already calls after every write (AppShell's onSuccess for a submitted
   * plan, the auth-state listener, DashboardClient's realtime refetch), so the
   * screen a trader has just changed is still re-rendered from the server
   * immediately. What this caches is the route they did NOT change.
   */
  experimental: {
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
