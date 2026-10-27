/**
 * The public share page — the one route in this product a stranger can read
 * (REF-125 Stage 2 item 4).
 *
 * A SERVER COMPONENT, AND THAT IS THE SECURITY DESIGN RATHER THAN A
 * PREFERENCE. The read happens here with the service role (see
 * lib/share/store.ts), so the visitor's browser never holds a Supabase client,
 * never holds a key, and never issues a PostgREST request. That is what lets
 * migration 043 grant `anon` nothing at all and keep the repo's standing
 * invariant — and the nightly /api/cron/security-assertions sweep — intact.
 *
 * `/share` MUST BE IN `isMarketingRoute` IN src/proxy.ts, and this comment is
 * the second place that is written down because the failure is silent: without
 * it the proxy redirects every logged-out visitor to /login, the page renders
 * fine for the one person who is signed in, and the translation suite would
 * test the LOGIN page and pass green. REF-125 §1.2 calls it "the most likely
 * silent failure in the whole build".
 *
 * IT MOUNTS `SiteDisclosureFooter` ITSELF. This route sits outside `(app)`,
 * `(auth)` and `(protected)`, so it inherits no footer from any layout —
 * SiteDisclosureFooter.tsx:20-27 lists where the footer is mounted and why it
 * is mounted at layout level, and a standalone page is the case that falls
 * through. NinjaTrader compliance requires the prescribed wording on every
 * page, so this file is in `MOUNTS` in scripts/footer-copy-check.tsx, added in
 * the same change. That is exactly the shape of the F4 regression the check
 * exists to catch.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SiteDisclosureFooter } from '@/components/legal/SiteDisclosureFooter';
import SharedDayCard from '@/components/share/SharedDayCard';
import { readSharedCard } from '@/lib/share/store';
import { tradingDayLabel } from '@/lib/tradingDay';

export const runtime = 'nodejs';
/**
 * NEVER STATICALLY RENDERED AND NEVER CACHED AT THE EDGE.
 *
 * Revocation has to take effect, and a cached HTML response would keep serving
 * a withdrawn card until it expired. REF-125 §7 is explicit that revocation
 * stops FUTURE VISITS and cannot retract what a social platform already
 * fetched — the least this page can do is make "future visits" mean the next
 * one rather than the next one after a TTL.
 */
export const dynamic = 'force-dynamic';

/**
 * Per-card metadata, and the first `generateMetadata` in this codebase.
 *
 * NO `openGraph.images` YET. The image is Stage 3, and a card pointing at an
 * image route that does not exist would unfurl worse than one with no image at
 * all — `twitter: { card: 'summary_large_image' }` in the root layout degrades
 * to a plain summary on its own, which is the current behaviour everywhere
 * else in the app and is the honest state until there are bytes to serve.
 *
 * `index: false`, `follow: false` — AND THE PAGE IS STILL FETCHABLE, which is
 * the distinction robots.ts:5-11 already reasons about for /demo: blocking the
 * fetch is the weaker guarantee. An unfurling crawler must be able to GET this
 * page to read these tags at all, so nothing is added to the robots disallow
 * list; what is asserted is that one trader's day must not end up in a search
 * index. sitemap.ts is deliberately untouched — tokens are per-user.
 *
 * THE TITLE CARRIES NO NAME AND NO FIGURE. It is the day, and that is all: a
 * title is what a link preview shows in a chat list, which is a surface the
 * trader did not choose to put a number on.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const card = await readSharedCard(token);
  if (card === null) {
    return { title: 'Reflect', robots: { index: false, follow: false } };
  }
  return {
    title: `${tradingDayLabel(card.tradingDay)} — Reflect`,
    description: 'יום מסחר ששותף מ-Reflect.',
    robots: { index: false, follow: false },
    openGraph: {
      type: 'article',
      locale: 'he_IL',
      siteName: 'Reflect',
      title: `${tradingDayLabel(card.tradingDay)} — Reflect`,
      description: 'יום מסחר ששותף מ-Reflect.',
    },
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = await readSharedCard(token);

  // ONE ANSWER FOR FOUR CASES: no such token, a malformed token, a revoked
  // link, and a snapshot that will not parse. The store filters
  // `revoked_at IS NULL` in the query, so a revoked token is indistinguishable
  // from an invented one and this page cannot be used to probe which tokens
  // are real. `notFound()` gives a real 404 status — see share/not-found.tsx
  // for what a visitor is told, and why it names revocation anyway.
  if (card === null) notFound();

  return (
    <>
      <main
        id="main-content"
        dir="rtl"
        style={{
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          padding: '32px 16px',
          background: 'var(--color-tg-bg)',
        }}
      >
        <SharedDayCard snapshot={card.snapshot} tradingDay={card.tradingDay} />

        {/* The mark, and the only outbound link on the page. A plain <a> and
            not next/link: this is a route out of the app to the marketing
            apex, so there is nothing to prefetch and no client router to
            involve on a page that ships no other interactivity. */}
        <a
          href="https://reflecttrading.app"
          style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}
          aria-label="Reflect — reflecttrading.app"
        >
          <ReflectMark />
        </a>
      </main>
      <SiteDisclosureFooter />
    </>
  );
}

/**
 * The wordmark, reconstructed small.
 *
 * NOT `components/ui/Logo` — that mark is pinned at 38px because it is sized
 * for the landing nav and the sidebar (its own comment says the px must stay
 * px), and at that size it is the loudest thing on a card this narrow. This is
 * the attribution at the foot of somebody else's day, so it is the letterspaced
 * wordmark alone, which is the same reduction src/lib/email/template.ts:151
 * already makes for the one other surface that cannot use the real logo.
 *
 * Rubik rather than Montserrat, because it is the font this page already
 * loaded from the root layout and a second webfont for seven letters is not
 * worth a request on a link opened over mobile data.
 */
function ReflectMark() {
  return (
    <span
      dir="ltr"
      style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: 4,
        color: 'var(--color-tg-muted)',
      }}
    >
      REFLECT
    </span>
  );
}
