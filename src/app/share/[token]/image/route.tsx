/**
 * The share card as a PNG (REF-125 Stage 3 item 2).
 *
 * GET /share/<token>/image            → 1200×630, the unfurl card
 * GET /share/<token>/image?size=square → 1080×1080, the download
 *
 * WHY A ROUTE AND NOT `opengraph-image.tsx`. Next's file convention would give
 * the 1200×630 card for free, but only that one: it owns its own URL shape and
 * cannot take a `size` parameter, so the square download would need a second
 * renderer behind a second path. One route serving both sizes from one
 * component is what keeps the downloaded image and the image in somebody's
 * feed from ever disagreeing about the same day.
 *
 * IT READS THE FROZEN SNAPSHOT AND NOTHING ELSE. `readSharedCard` is the same
 * service-role, three-column, `revoked_at IS NULL` read the page uses — no
 * second query, no `trade_plans`, no recomputation at render time. An image
 * that recomputed would be a second answer to "what happened that day", which
 * is the failure Stage 1 and Stage 2 exist to have ended, and it would mean a
 * card could change under a reader after it was published.
 *
 * `/share` IS ALREADY IN `isMarketingRoute` (src/proxy.ts, Stage 2), and the
 * prefix covers this nested path — so an unfurling crawler reaches it without
 * a session. Without that line every social fetch would be redirected to
 * /login and unfurl as the login page.
 */

import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

import { shareCardFonts } from '@/lib/share/cardFonts';
import { CARD_SIZES, ShareCardImage, type ShareCardSize } from '@/lib/share/cardImage';
import { readSharedCard } from '@/lib/share/store';

/**
 * Node, not Edge. `cardFonts.ts` reads the two TTFs off the filesystem, and
 * the two wasm blobs @vercel/og carries (resvg, yoga) are the heavier half of
 * a cold start either way.
 */
export const runtime = 'nodejs';

/**
 * NEVER PRERENDERED. The token is a capability, so there is no build-time set
 * of them to generate, and a statically-rendered image would be a card frozen
 * at deploy time rather than at mint time.
 */
export const dynamic = 'force-dynamic';

/**
 * One hour at the CDN and in the browser, as the ticket specifies — and the
 * trade-off is worth stating plainly rather than leaving in a header.
 *
 * REVOCATION DOES NOT REACH A CACHED IMAGE. The page is `force-dynamic` and
 * 404s on the next visit after a revoke, but a copy of this PNG already in a
 * CDN edge or a social platform's media cache keeps being served until it
 * expires — and platforms cache unfurled images far longer than any header
 * asks. REF-125 §7 is explicit that revocation stops future visits and cannot
 * unpublish what was already fetched, and the dialog says so to the trader in
 * as many words.
 *
 * `immutable` is deliberately NOT set, and `max-age` is deliberately not
 * longer: one hour is the shortest window that still absorbs the burst of
 * fetches a single paste into a group chat produces, which is the entire
 * reason this is cached at all.
 */
const CACHE_CONTROL = 'public, max-age=3600';

/** `?size=square` or nothing. Anything unrecognised is the unfurl card. */
function readSize(value: string | null): ShareCardSize {
  return value === 'square' ? 'square' : 'og';
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = await readSharedCard(token);

  // A REVOKED LINK HAS NO IMAGE, and it is the same 404 as a token that never
  // existed — the store filters `revoked_at IS NULL` in the query, so this
  // route cannot be used to probe which tokens are real any more than the page
  // can. An empty body rather than a placeholder PNG: an unfurler that gets a
  // 404 falls back to no image, whereas a "this link was revoked" graphic
  // would be a picture we had published on the trader's behalf, about a card
  // they withdrew.
  if (card === null) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const size = readSize(request.nextUrl.searchParams.get('size'));

  return new ImageResponse(
    <ShareCardImage snapshot={card.snapshot} tradingDay={card.tradingDay} size={size} token={token} />,
    {
      ...CARD_SIZES[size],
      // Always explicit. REF-125 §5.3 found that an ImageResponse with no
      // `fonts` option silently fetches from fonts.googleapis.com mid-render,
      // because the bundled Geist has zero Hebrew coverage.
      fonts: shareCardFonts(),
      headers: { 'Cache-Control': CACHE_CONTROL },
    }
  );
}
