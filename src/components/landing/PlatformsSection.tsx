import Image from 'next/image';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

/**
 * Supported platforms, as a logo grid.
 *
 * Everything visible here is driven by PLATFORMS and CATEGORIES below — adding
 * a platform is one array entry, never a layout change, and a category with no
 * entries renders nothing at all rather than an empty heading.
 *
 * Compliance constraints that shape this section, none of them cosmetic:
 *
 *   1. Nothing may imply endorsement, certification, premium status or
 *      partnership. The copy says what is true — your trades sync, or you
 *      import them — and stops there.
 *   2. Logos come from the vendor's own media kit and nowhere else, and only
 *      where we hold permission to display the mark. A platform we support but
 *      cannot show a logo for is named in text instead (see the category note),
 *      never given a tile.
 *   3. Each logo keeps at least LOGO_CLEAR_SPACE px of clear space on all four
 *      sides — which is why the tile's padding is that figure and the logo is
 *      the only thing inside it.
 *   4. No served URL, filename or CSS class may contain a platform trademark.
 *      Hence /platforms/nt-logo.png, and no bespoke class names here at all.
 *
 * The trademark attribution is NOT repeated in this section: FooterDisclosures
 * carries it, and the footer renders on every route, so this page already has
 * it once. A second copy beside the grid would print the same paragraph twice.
 */

/** Media-kit minimum, in px, on all four sides of every logo. */
const LOGO_CLEAR_SPACE = 18;

type CategoryId = 'auto' | 'csv';

interface Platform {
  id: string;
  /** Exactly as the trademark owner writes it. */
  name: string;
  logoSrc: string;
  /** Intrinsic pixel dimensions — next/image uses them for the aspect ratio,
   *  not for the rendered size, which the tile decides. */
  logoWidth: number;
  logoHeight: number;
  /** Vendor-supplied tracking URL, or null for an unlinked tile. */
  href: string | null;
  category: CategoryId;
}

const PLATFORMS: Platform[] = [
  {
    id: 'nt',
    name: 'NinjaTrader',
    // Media-kit PNG: 2376x300, transparent, single opaque colour #FF4200.
    logoSrc: '/platforms/nt-logo.png',
    logoWidth: 2376,
    logoHeight: 300,
    href: 'https://ninjatraderdomesticvendor.sjv.io/1GKkKd',
    category: 'auto',
  },
  // TODO(owner): CSV import is not built yet, so the 'csv' category is empty
  // and renders nothing. Do not list a platform here before import actually
  // works for it — a logo in this grid is a claim that we support it.
];

/**
 * The distinction is the product one, not a filing detail: an automatic
 * connection is what lets Reflect check a trade against your rules *before*
 * you enter it. A CSV uploaded afterwards can only ever be a record, so a
 * platform in the second group gets the journal and the debrief but not the
 * real-time enforcement.
 */
const CATEGORIES: { id: CategoryId; heading: string; note?: string }[] = [
  {
    id: 'auto',
    heading: 'חיבור אוטומטי',
    // Named in text, not shown as a logo: the connection genuinely covers
    // these accounts, but permission to display the mark covers NinjaTrader
    // only. Naming a platform to say what works is nominative use; putting up
    // its logo would not be.
    note: 'אותו חיבור משרת גם חשבונות המבוססים על Tradovate, כולל חברות פרופ הפועלות עליה.',
  },
  {
    id: 'csv',
    heading: 'ייבוא נתמך',
  },
];

/**
 * One tile: a dark rounded rectangle with the logo centred inside it, the
 * platform name beneath. The tile is the logo's clear-space box — nothing,
 * including the tile's own border, comes within LOGO_CLEAR_SPACE of the mark.
 *
 * 3:2 rather than square. The clear space caps a logo's width, and a wordmark
 * this wide (7.9:1) is then only ~19px tall — in a square that left the mark
 * covering 8% of the tile, reading as an empty box with a stripe in it. The
 * shorter tile does not change the logo at all; it removes the dead height
 * above and below it, roughly halving the tile's area and lifting the mark to
 * ~12% of it. Anything shorter starts crowding the 18px floor at this width.
 */
function PlatformTile({ platform }: { platform: Platform }) {
  const tile = (
    <>
      <div
        className="w-full aspect-[3/2] rounded-2xl border flex items-center justify-center"
        style={{
          padding: LOGO_CLEAR_SPACE,
          borderColor: 'rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
        }}
      >
        <Image
          src={platform.logoSrc}
          alt={platform.name}
          width={platform.logoWidth}
          height={platform.logoHeight}
          // The source is many times the rendered width, so `sizes` is what
          // stops next/image shipping the full-size file to a ~150px slot.
          sizes="200px"
          className="w-full h-auto"
        />
      </div>
      <p
        dir="ltr"
        className="mt-2.5 text-sm font-semibold text-center"
        style={{ color: 'var(--color-tg-text-2)' }}
      >
        {platform.name}
      </p>
    </>
  );

  // The tile and the name are one link, so the accessible name comes from the
  // logo's alt plus the caption rather than from a wrapper with no text.
  return platform.href ? (
    <a href={platform.href} target="_blank" rel="noopener noreferrer" className="block card-hover">
      {tile}
    </a>
  ) : (
    <div>{tile}</div>
  );
}

/**
 * Flex-wrap with justify-center rather than CSS grid, deliberately.
 *
 * A grid's last row is start-packed: with one platform in a five-column track
 * the tile lands hard against the start edge with four empty cells beside it,
 * which reads as missing content rather than as a short list. Wrapping and
 * centring makes any count — one, three, seven — look like the whole set,
 * which is what it is.
 *
 * The basis calculations are the column counts: 2 up to sm, 3 to lg, 5 above,
 * each subtracting the gap the row spends between its tiles. max-width keeps a
 * lone tile from inflating toward a fifth of the container.
 */
function PlatformGrid({ platforms }: { platforms: Platform[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-4 max-w-[900px] mx-auto">
      {platforms.map((platform) => (
        <div
          key={platform.id}
          className="basis-[calc((100%-1rem)/2)] sm:basis-[calc((100%-2rem)/3)] lg:basis-[calc((100%-4rem)/5)] grow-0 shrink-0 max-w-[190px]"
        >
          <PlatformTile platform={platform} />
        </div>
      ))}
    </div>
  );
}

export function PlatformsSection() {
  // A category with nothing in it renders nothing — no heading, no empty row.
  const groups = CATEGORIES.map((category) => ({
    category,
    platforms: PLATFORMS.filter((p) => p.category === category.id),
  })).filter((group) => group.platforms.length > 0);

  if (groups.length === 0) return null;

  return (
    <section id="platforms" className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading sub="העסקאות שלך מסונכרנות אוטומטית, בלי הזנה ידנית.">
          פלטפורמות נתמכות
        </SectionHeading>

        <div className="flex flex-col gap-12">
          {groups.map(({ category, platforms }, i) => (
            <ScrollReveal key={category.id} delay={i * 120}>
              {/* Small heading, no rule: the grouping has to be legible without
                  turning two short lists into two sections. */}
              <h3 className="text-sm font-bold text-center mb-5" style={{ color: 'rgba(0,210,210,0.9)' }}>
                {category.heading}
              </h3>

              <PlatformGrid platforms={platforms} />

              {category.note && (
                <p className="mt-5 text-base leading-relaxed text-center text-tg-muted max-w-[620px] mx-auto">
                  {category.note}
                </p>
              )}
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
