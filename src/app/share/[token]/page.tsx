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
import { CARD_SIZES } from '@/lib/share/cardImage';
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
 * THE OG IMAGE IS THE POINT OF STAGE 3. `openGraph.images` and the Twitter
 * card both name ./image, the 1200×630 render — so pasting a link into
 * WhatsApp, X or Telegram shows the day's card rather than a text-only
 * preview. The root layout has declared `twitter: { card:
 * 'summary_large_image' }` since before this feature existed and had no image
 * to put in it; `openGraph.images` was the missing piece (REF-125 §1.7).
 *
 * THE URL IS RELATIVE, resolved against `metadataBase` in the root layout
 * (`https://reflecttrading.app`). An absolute URL built here from a request
 * header would be forgeable and would also get the scheme wrong behind the
 * proxy; `metadataBase` is the one place the canonical origin is stated.
 *
 * A REVOKED CARD ADVERTISES NO IMAGE. The `card === null` branch returns
 * metadata with no `openGraph` block at all, so an unfurler is never pointed
 * at a route that will 404 on it — and a platform re-scraping a withdrawn link
 * is told there is nothing to show rather than being handed a broken
 * reference.
 *
 * THE ALT TEXT CARRIES NO FIGURE, for the same reason the title does not: alt
 * text is read aloud and is indexed, and the trader chose to publish a number
 * on a card, not into every surface that quotes the card.
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

  const title = `${tradingDayLabel(card.tradingDay)} — Reflect`;
  const description = 'יום מסחר ששותף מ-Reflect.';
  const image = {
    url: `/share/${token}/image`,
    width: CARD_SIZES.og.width,
    height: CARD_SIZES.og.height,
    alt: 'כרטיס יום המסחר',
  };

  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: 'article',
      locale: 'he_IL',
      siteName: 'Reflect',
      title,
      description,
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = await readSharedCard(token);

  // ONE ANSWER FOR FOUR CASES: no such token, a malformed token, a revoked
  // link, and a snapshot that will not parse. The store filters
  // `revoked_at IS NULL` in the query, so a revoked token is indistinguishable
  // from an invented one and this page cannot be used to probe which tokens
  // are real. `notFound()` gives a real 404 status — see ./not-found.tsx for
  // what a visitor is told, and why it names revocation anyway.
  //
  // THAT BOUNDARY LIVES IN THIS SEGMENT AND NOT IN `share/`, which is a
  // placement that was verified by serving it rather than assumed. At
  // src/app/share/not-found.tsx it did not catch this page's `notFound()` at
  // all: the 404 rendered the root layout with an empty body — no message, no
  // footer — which is both a worse page for the stranger who opened a revoked
  // link and a compliance gap, since the disclosures are required on every
  // page. Keep it beside the page it covers.
  if (card === null) notFound();

  return (
    <>
      {/* The page's own background stays THEMED while the artefact inside it is
          hard-coded dark — see SharedDayCard's header. The card is dark in
          everybody's feed so it must be dark in everybody's browser, but
          SiteDisclosureFooter below is legally-required text with a measured
          contrast floor, and it keeps the viewer's theme. */}
      <main
        id="main-content"
        dir="rtl"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          // Generous, and deliberately not vertically centred any more: the
          // artefact is now up to 1100px wide and tall enough that centring it
          // in the viewport pushed the attribution below the fold on a laptop.
          padding: '40px 16px 28px',
          background: 'var(--color-tg-bg)',
        }}
      >
        <SharedDayCard snapshot={card.snapshot} tradingDay={card.tradingDay} />

        {/* Attribution, under somebody else's day. A plain <a> and not
            next/link: this is a route out of the app to the marketing apex, so
            there is nothing to prefetch and no client router to involve on a
            page that ships no other interactivity. */}
        <a
          href="https://reflecttrading.app"
          className="w-full max-w-[1100px]"
          style={{
            fontSize: 12,
            color: 'var(--color-tg-muted)',
            textDecoration: 'none',
          }}
        >
          מופעל על ידי{' '}
          <span dir="ltr" style={{ fontWeight: 700, letterSpacing: 2 }}>
            REFLECT
          </span>
        </a>
      </main>
      <SiteDisclosureFooter />
    </>
  );
}
