import Image from 'next/image';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { NinjaTraderAttribution } from '@/components/legal/NinjaTraderAttribution';
import { DISCLOSURE_MEASURE } from '@/components/legal/disclosureStyle';

/**
 * Supported platforms.
 *
 * Plural in the heading and built as a list from the start, so Colmex and
 * whoever follows drop in as another entry rather than as a redesign.
 *
 * Three compliance constraints shape this section, and none of them are
 * cosmetic:
 *
 *   1. Nothing here may imply endorsement, certification, premium status or
 *      partnership. The copy says what is true — Reflect runs alongside the
 *      platform you already trade on — and stops there. No "official",
 *      "certified", "integration partner", no platform mark in a headline.
 *   2. Logos come from the vendor's own media kit and nowhere else, and each
 *      needs at least LOGO_CLEAR_SPACE px of clear space on every side. That
 *      is why the logo sits alone in its own padded box rather than inside the
 *      card's normal padding with text beside it.
 *   3. The trademark attribution renders on every page that mentions
 *      NinjaTrader. It lives here, directly under the card that carries the
 *      mark, rather than in the site footer: it is English-only by
 *      prescription, so it could not be halved the way the footer's bilingual
 *      risk text was, and next to the logo it is more prominent than it was
 *      at the very bottom of the page. Any future page that names NinjaTrader
 *      without rendering this section must render NinjaTraderAttribution
 *      itself.
 *
 * Naming: "NinjaTrader" — one word, capital N, capital T. "Kinetick" — capital
 * K. And no route slug, meta title, product name, social handle or served
 * asset URL may contain either.
 */

/** Media-kit minimum, in px, on all four sides of every logo. */
const LOGO_CLEAR_SPACE = 18;

/** Rendered width cap for a wordmark logo. Height follows the aspect ratio. */
const LOGO_MAX_W = 240;

interface Platform {
  id: string;
  /** Exactly as the trademark owner writes it. */
  name: string;
  /** One line on how Reflect relates to it. Never an endorsement claim. */
  body: string;
  /**
   * Media-kit artwork under /public. Null falls back to the wordmark as plain
   * text, which is what ships until an approved file is in place — always
   * safer than a broken image or a logo pulled from anywhere but the kit.
   */
  logoSrc: string | null;
  /** Intrinsic pixel dimensions of logoSrc — next/image uses them for the
   *  aspect ratio, not for the rendered size (LOGO_MAX_W sets that). */
  logoWidth?: number;
  logoHeight?: number;
  /** The vendor-supplied tracking URL. Null renders a plain card, not a dead
   *  link. */
  href: string | null;
}

const PLATFORMS: Platform[] = [
  {
    id: 'ninjatrader',
    name: 'NinjaTrader',
    body: 'מתכננים ומתעדים ב-Reflect, מבצעים בפלטפורמה שלכם. Reflect אינו ברוקר ואינו מבצע פעולות בחשבון המסחר.',
    // Media-kit PNG: 2376x300, transparent, single opaque colour #FF4200.
    // The filename is deliberately abbreviated — no URL this site serves may
    // contain a NinjaTrader trademark, and an asset path is a URL.
    logoSrc: '/platforms/nt-logo.png',
    logoWidth: 2376,
    logoHeight: 300,
    href: 'https://ninjatraderdomesticvendor.sjv.io/1GKkKd',
  },
];

function PlatformCard({ platform }: { platform: Platform }) {
  const inner = (
    <>
      {/* The logo's own box. Its padding IS the clear-space rule — nothing,
          including the card's border, comes closer than LOGO_CLEAR_SPACE. */}
      <div
        className="flex items-center justify-center w-full"
        style={{ padding: LOGO_CLEAR_SPACE, minHeight: 40 + LOGO_CLEAR_SPACE * 2 }}
      >
        {platform.logoSrc ? (
          <Image
            src={platform.logoSrc}
            alt={platform.name}
            width={platform.logoWidth ?? 200}
            height={platform.logoHeight ?? 40}
            // The source is ~10x the rendered width, so `sizes` is what stops
            // next/image shipping a 2376px file to a 240px slot. Capped by
            // max-width rather than a hard width so it shrinks with the card
            // on narrow screens instead of overflowing its clear space.
            sizes={`${LOGO_MAX_W}px`}
            className="w-full h-auto"
            style={{ maxWidth: LOGO_MAX_W }}
          />
        ) : (
          <span dir="ltr" className="text-2xl font-bold" style={{ color: 'var(--color-tg-text-2)' }}>
            {platform.name}
          </span>
        )}
      </div>

      <p className="text-base leading-relaxed text-tg-muted">{platform.body}</p>
    </>
  );

  const className = 'glass-card rounded-2xl p-6 flex flex-col gap-3 h-full';

  return platform.href ? (
    <a
      href={platform.href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} card-hover`}
    >
      {inner}
    </a>
  ) : (
    <div className={className}>{inner}</div>
  );
}

export function PlatformsSection() {
  return (
    <section id="platforms" className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading sub="Reflect עובד לצד פלטפורמת המסחר שלכם, בלי תלות בברוקר. התכנון והתיעוד קורים כאן; הביצוע נשאר אצלכם.">
          פלטפורמות נתמכות
        </SectionHeading>

        {/* Centred flex-wrap rather than a grid, because the list is currently
            one item long and a two-column grid leaves a card stranded in one
            half of the row with the other half empty. Wrapping centres a lone
            card, pairs two, and rows three — no per-count special case, and no
            relayout when the second platform lands. */}
        <div className="flex flex-wrap justify-center gap-6 max-w-[820px] mx-auto">
          {PLATFORMS.map((platform, i) => (
            <ScrollReveal
              key={platform.id}
              delay={(i % 2) * 120}
              className="w-full sm:w-[calc(50%-0.75rem)] max-w-[380px]"
            >
              <PlatformCard platform={platform} />
            </ScrollReveal>
          ))}
        </div>

        {/* Required wherever the mark appears. Fine print, on the same measure
            as every other disclosure, directly under the card carrying it. */}
        <div className="flex justify-center mt-8">
          <NinjaTraderAttribution className={DISCLOSURE_MEASURE} />
        </div>
      </div>
    </section>
  );
}
