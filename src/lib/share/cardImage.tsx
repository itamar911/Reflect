/**
 * The share card, as pixels (REF-125 Stage 3 item 2).
 *
 * This is JSX for SATORI, not for the DOM. It never hydrates, never reaches a
 * browser, and must stay inside the flexbox subset satori implements — so no
 * `grid`, no `position: sticky`, no `gap` on anything that is not a flex
 * container, and every element that has more than one child says
 * `display: flex` explicitly (satori's default is flex, but being explicit is
 * what keeps a later edit from silently relying on block layout that is not
 * there).
 *
 * ONE RENDERER FOR BOTH SIZES. The 1200×630 unfurl card and the 1080×1080
 * download are the same component under a different `layout`, because they
 * make the same claims about the same day. Two components would be two places
 * for the provenance line to drift, and the provenance line is the one piece
 * of text on this card that a reputational problem could come from.
 *
 *
 * SATORI HAS NO BIDI ENGINE, AND THAT SHAPES EVERY ROW
 * ----------------------------------------------------
 *
 * REF-125 §5.4 verified it by rendering three identical panels differing only
 * in `direction` (unset / rtl / ltr) and getting three PIXEL-IDENTICAL images.
 * Re-verified here against the real committed Rubik rather than the system
 * font the investigation stood in. Two consequences, and they are not
 * stylistic:
 *
 *   1. `direction: 'rtl'` DOES NOTHING. A row whose Hebrew label must sit on
 *      the right gets `flexDirection: 'row-reverse'` instead. Every label/value
 *      row below uses {@link Row}, which is the one place that is written.
 *
 *   2. HEBREW AND LATIN NEVER SHARE A TEXT NODE. A single node holding
 *      "היום שלי — Reflect" lays out with an LTR base direction and puts the
 *      Latin run on the wrong side, with nothing to override it. So the date,
 *      the money, the fractions and the provenance line are each their own
 *      element, ordered explicitly by the layout rather than by an algorithm
 *      that is not running.
 *
 * Intra-run Hebrew ordering IS correct — satori reverses within a run — which
 * is why a Hebrew label on its own needs no special handling at all.
 *
 *
 * WHAT IS ON THE CARD IS A PRODUCT DECISION, NOT A LAYOUT ONE
 * -----------------------------------------------------------
 *
 * Imri, 27.10: the card carries ONLY the day's P&L, the two discipline
 * fractions, the closed-trade count and win rate, the logo, the date, the
 * optional nickname, the provenance line and the link. BEST AND WORST TRADE
 * ARE DELIBERATELY ABSENT — they stay on the verification page as a secondary
 * block. A card is read at a glance and in a feed; five numbers compete, seven
 * are noise.
 *
 * The WIN RATE is derived here (`wins / trades`) rather than added to the
 * stored snapshot. It is arithmetic over two frozen fields, so deriving it
 * costs nothing and keeps `SHARE_SNAPSHOT_VERSION` where it is — a new field
 * would mean every card minted before this deploy renders a blank where a
 * reader expects a number. Its denominator is `trades`, the counted set, which
 * is the honest-denominator rule snapshot.ts states; a zero there withholds the
 * figure rather than printing 0%.
 */

import { formatMoney } from '@/lib/money';
import { cardDateLabel } from '@/lib/share/cardFonts';
import { shareProvenanceNote, type DailyShareSnapshot, type ShareFraction } from '@/lib/share/snapshot';
import type { TradingDay } from '@/lib/tradingDay';

/** The two sizes the route serves. */
export type ShareCardSize = 'og' | 'square';

export const CARD_SIZES: Record<ShareCardSize, { width: number; height: number }> = {
  /** Open Graph / Twitter / LinkedIn. The size every unfurler crops to. */
  og: { width: 1200, height: 630 },
  /** Instagram and the download button. */
  square: { width: 1080, height: 1080 },
};

// ── Palette ─────────────────────────────────────────────────────────────────
//
// Hard-coded hex, NOT `var(--color-tg-*)`. satori resolves no cascade and no
// custom properties — a `var()` here renders as nothing at all, silently. These
// are the dark-theme values of the tokens in globals.css, and the card is
// always dark regardless of the viewer's theme because it is an image in
// somebody else's feed, not a page with a theme to inherit.

/**
 * EXPORTED, BECAUSE THE PAGE USES IT TOO.
 *
 * /share/[token] is the card's twin — a stranger who follows the link has to
 * arrive somewhere that looks like the image they clicked. Importing one
 * palette is what stops "the teal" from becoming two slightly different teals
 * the first time either side is touched. The page can resolve `var()` and the
 * image cannot, so the shared thing is the VALUES.
 */
export const CARD_PALETTE = {
  ink: '#f1f5f9', // --color-tg-text
  muted: '#a8adb8', // --color-tg-muted
  teal: '#00d2d2', // --color-tg-primary, the one accent (CLAUDE.md)
  green: '#22c55e', // --color-tg-success
  red: '#ef4444', // --color-tg-danger
  hairline: 'rgba(255,255,255,0.10)',
  panel: 'rgba(255,255,255,0.035)',
  /** Deep charcoal into navy; the teal only arrives in the far corner. */
  backdrop: 'linear-gradient(135deg, #15151c 0%, #1b1b26 48%, #10222a 100%)',
  backdropFlat: '#15151c',
  glow: 'radial-gradient(circle, rgba(0,210,210,0.16) 0%, rgba(0,210,210,0) 70%)',
  /** The mark's own two colours, from components/ui/Logo.tsx. */
  markGradient: 'linear-gradient(135deg, #00c9c9, #0a4f6e)',
  markReflection: '#15535f',
} as const;

const INK = CARD_PALETTE.ink;
const MUTED = CARD_PALETTE.muted;
const TEAL = CARD_PALETTE.teal;
const GREEN = CARD_PALETTE.green;
const RED = CARD_PALETTE.red;
const HAIRLINE = CARD_PALETTE.hairline;
const PANEL = CARD_PALETTE.panel;
const MARK_GRADIENT = CARD_PALETTE.markGradient;
const MARK_REFLECTION = CARD_PALETTE.markReflection;

/**
 * The dot grid, as ONE image rather than several hundred divs.
 *
 * The SVG tiles itself with `<pattern>`, so satori sees a single `<img>` and
 * resvg does the repetition. The alternative — a div per dot — is ~1,150
 * elements at this spacing on the og card, which is a real cost on a route a
 * social platform may hit in bursts.
 *
 * `fill-opacity` and not an `opacity` on the whole rect: the grid has to stay
 * under the content without washing the gradient out, and 0.05 is the point at
 * which it reads as texture rather than as dots.
 */
function dotGridUri(width: number, height: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="d" width="26" height="26" patternUnits="userSpaceOnUse">` +
    `<circle cx="1.6" cy="1.6" r="1.6" fill="#ffffff" fill-opacity="0.05"/>` +
    `</pattern></defs><rect width="100%" height="100%" fill="url(#d)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * The P&L type size, chosen from the string's own length.
 *
 * SATORI DOES NOT SHRINK TEXT TO FIT. There is no `text-overflow`, no
 * auto-sizing and no measurement available before layout, so a six-figure loss
 * at a fixed size does not ellipsise — it overflows the column and collides
 * with the panel beside it. A trader's worst day is exactly when the number is
 * longest, which makes "it fits in testing" the wrong assurance. The steps are
 * measured against the real font at the real widths.
 */
function moneyFontSize(text: string, base: number): number {
  if (text.length <= 10) return base;
  if (text.length <= 13) return Math.round(base * 0.84);
  return Math.round(base * 0.72);
}

// ── Pieces ──────────────────────────────────────────────────────────────────

/**
 * The Reflect mark: an R, a gradient hairline, and the R reflected.
 *
 * REF-125 §1.6 concluded this mark "cannot be reused as-is" because it leans
 * on `background-clip: text` and `transform: scaleX(-1)`, both listed as
 * unsupported — so the investigation recommended a letterspaced wordmark
 * instead. THAT FINDING IS WRONG, and it was wrong because it was read rather
 * than run: both properties render correctly in the version of satori this
 * repo has (verified by rendering them, Stage 3). So the card carries the
 * actual mark rather than a reduction of it.
 *
 * The letterform is Rubik Bold and not Poppins, which is the one genuine
 * compromise: Poppins is latin-only and committing a second family for two
 * glyphs is not worth ~100 KB on a route that already carries two faces. Rubik
 * is also the family every other Reflect surface uses.
 */
function Mark({ scale }: { scale: number }) {
  const size = Math.round(62 * scale);
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <span
        style={{
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1,
          backgroundImage: MARK_GRADIENT,
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          color: 'transparent',
        }}
      >
        R
      </span>
      <div
        style={{
          width: Math.max(2, Math.round(2 * scale)),
          height: Math.round(size * 0.82),
          margin: `0 ${Math.round(3 * scale)}px`,
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,201,201,0), rgba(0,201,201,0.55), rgba(0,201,201,0))',
        }}
      />
      {/* The reflection. `scaleX(-1)` is the whole idea of the mark and the
          thing §1.6 said could not be done here. */}
      <span
        style={{
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1,
          color: MARK_REFLECTION,
          transform: 'scaleX(-1)',
        }}
      >
        R
      </span>
      <span
        style={{
          fontSize: Math.round(19 * scale),
          fontWeight: 700,
          letterSpacing: Math.round(6 * scale),
          color: INK,
          marginLeft: Math.round(20 * scale),
        }}
      >
        REFLECT
      </span>
    </div>
  );
}

/**
 * One label/value row, Hebrew label to the RIGHT.
 *
 * `row-reverse` IS THE RTL. See the header: `direction: 'rtl'` is a verified
 * no-op in satori, so the reversal is done by the flex container. Children are
 * written in logical order — label first, value second — and the container
 * puts the label on the right, which means a reader of this file sees the same
 * order a reader of the card does.
 */
function Row({
  label,
  value,
  scale,
  accent,
}: {
  label: string;
  value: string;
  scale: number;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row-reverse',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <span style={{ fontSize: Math.round(23 * scale), color: MUTED }}>{label}</span>
      <span
        style={{
          fontSize: Math.round(27 * scale),
          fontWeight: 700,
          color: accent ?? INK,
        }}
      >
        {value}
      </span>
    </div>
  );
}

/** "4/5" — its own element so bidi cannot reorder it into "5/4". */
const fractionText = (f: ShareFraction): string => `${f.met}/${f.answered}`;

// ── The card ────────────────────────────────────────────────────────────────

export interface ShareCardProps {
  snapshot: DailyShareSnapshot;
  /** The row's own column, which the page and the image both trust over the document. */
  tradingDay: TradingDay;
  size: ShareCardSize;
}

export function ShareCardImage({ snapshot, tradingDay, size }: ShareCardProps) {
  const { width, height } = CARD_SIZES[size];
  const square = size === 'square';
  // One multiplier rather than two sets of numbers, so the square card cannot
  // drift into being a different design.
  const scale = square ? 1.18 : 1;
  const pad = Math.round(58 * scale);

  const pnl = snapshot.pnl;

  /**
   * THE ABSENT DAY GETS WORDS, NOT A DASH.
   *
   * SharedDayCard renders `—` for a null P&L and that is right on the page,
   * where the figure is ~34px and a dash reads as a dash. At 112px an em dash
   * is a 75px horizontal BAR — it rendered as what looks exactly like a
   * missing-glyph box, which was found by looking at the output rather than by
   * reasoning about it. A card that appears broken is worse than one that says
   * nothing, and this is a public artefact with no caption to explain it.
   *
   * Still NOT `$0.00`: a day whose closed trades recorded no amount is not a
   * breakeven day, and a zero under a broker tag is a claim we cannot support.
   * The sentence says the true thing instead.
   */
  const moneyAbsent = pnl === null;
  const money = moneyAbsent ? 'לא נרשם סכום' : formatMoney(pnl);
  const moneyColour = moneyAbsent ? MUTED : pnl >= 0 ? GREEN : RED;
  const moneySize = moneyAbsent
    ? Math.round((square ? 132 : 112) * 0.42)
    : moneyFontSize(money, square ? 132 : 112);

  // Withheld rather than printed as 0% when nothing was counted — the same
  // honest-denominator rule the two fractions already follow.
  const winRate = snapshot.trades > 0 ? `${Math.round((snapshot.wins / snapshot.trades) * 100)}%` : null;

  const note = shareProvenanceNote(snapshot.provenance);

  const stats = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: square ? '100%' : 430,
        padding: Math.round(30 * scale),
        borderRadius: Math.round(22 * scale),
        background: PANEL,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <Row label="עסקאות סגורות" value={String(snapshot.trades)} scale={scale} />
      <div style={{ display: 'flex', height: Math.round(16 * scale) }} />
      {/* NO ACCENT ON THE WIN RATE. The teal is the card's single accent and
          it is decorative — it marks the brand and the link. Putting it on a
          figure makes it read as praise, and a 29% win rate highlighted in the
          brand colour on a losing day is the card congratulating a trader on
          their worst number. Semantic colour on this card is green and red,
          and it belongs to the P&L alone. */}
      {winRate !== null && <Row label="אחוז הצלחה" value={winRate} scale={scale} />}

      {/* The discipline half, separated by a hairline — and the whole block is
          withheld when neither fraction answered. snapshot.ts returns null and
          never {met:0,answered:0}, and REF-125 §2.4 names the cost of losing
          that distinction: "0/100" on a public page would be defamatory of the
          trader's own day. */}
      {(snapshot.followedPlan !== null || snapshot.stopHeld !== null) && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              height: 1,
              width: '100%',
              background: HAIRLINE,
              margin: `${Math.round(20 * scale)}px 0`,
            }}
          />
          {snapshot.followedPlan !== null && (
            <Row label="עמד בתוכנית" value={fractionText(snapshot.followedPlan)} scale={scale} />
          )}
          {snapshot.followedPlan !== null && snapshot.stopHeld !== null && (
            <div style={{ display: 'flex', height: Math.round(16 * scale) }} />
          )}
          {/* "לא הורחק" and not "לא הוזז" — Stage 2's one deliberate departure
              from the ticket's wording. The counted predicate treats a
              TIGHTENING as held (Imri 19.10), and a tightened stop was moved,
              so "לא הוזז" over this number would be false on exactly the
              trades the product decided to reward. */}
          {snapshot.stopHeld !== null && (
            <Row label="הסטופ לא הורחק" value={fractionText(snapshot.stopHeld)} scale={scale} />
          )}
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        fontFamily: 'Rubik',
        backgroundColor: CARD_PALETTE.backdropFlat,
        backgroundImage: CARD_PALETTE.backdrop,
      }}
    >
      {/* Texture, under everything. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- satori JSX, not the DOM: this tree is rasterised server-side and never hydrates, so next/image has nothing to optimise and its output would not render here at all. */}
      <img src={dotGridUri(width, height)} width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }} alt="" />

      {/* A single teal glow, behind the number it belongs to. */}
      <div
        style={{
          position: 'absolute',
          top: Math.round(-200 * scale),
          left: Math.round(-160 * scale),
          width: Math.round(820 * scale),
          height: Math.round(820 * scale),
          backgroundImage: CARD_PALETTE.glow,
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: pad,
          position: 'relative',
        }}
      >
        {/* ── Top: mark left, date right ──────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%' }}>
          <Mark scale={scale} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {/* Digits only, pinned to the trading day string — never a Date, so
                there is no server timezone for it to be wrong about. */}
            <span style={{ fontSize: Math.round(24 * scale), fontWeight: 700, color: INK }}>
              {cardDateLabel(tradingDay)}
            </span>
            {/* The opt-in handle: the only name this card can carry, and absent
                unless the trader both set one and turned the toggle on. */}
            {snapshot.nickname !== null && (
              <span style={{ fontSize: Math.round(19 * scale), color: MUTED, marginTop: Math.round(6 * scale) }}>
                {snapshot.nickname}
              </span>
            )}
          </div>
        </div>

        {/* ── Middle: the number, and the panel ───────────────────────────── */}
        {/* `flex: 1` AND CENTRED, rather than a third child of a
            space-between column. Letting the outer column distribute three
            rows pushed the money to wherever the panel's height left it — so
            a day with one discipline fraction and a day with two composed
            differently, and the left column drifted down the card as the
            panel shrank. Giving the middle band the leftover height and
            centring inside it makes the composition identical whatever the
            panel contains, which is what "nothing cramped" needs to survive
            the withheld-field cases. */}
        <div
          style={{
            display: 'flex',
            flex: 1,
            flexDirection: square ? 'column' : 'row',
            alignItems: square ? 'stretch' : 'center',
            // Spread on the landscape card (money left, panel right, as the
            // design asks); stacked and centred on the square one.
            justifyContent: square ? 'center' : 'space-between',
            width: '100%',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', marginBottom: square ? Math.round(44 * scale) : 0 }}>
            <span style={{ fontSize: Math.round(26 * scale), color: MUTED, marginBottom: Math.round(10 * scale) }}>
              תוצאת היום
            </span>
            <span
              style={{
                fontSize: moneySize,
                fontWeight: 700,
                lineHeight: 1,
                letterSpacing: Math.round(-3 * scale),
                color: moneyColour,
              }}
            >
              {/* "—" and not "$0.00" when no counted trade carried an amount.
                  A day of closed trades that recorded no money is not a
                  breakeven day, and a zero under a broker tag is a claim we
                  cannot support. */}
              {money}
            </span>
          </div>
          {stats}
        </div>

        {/* ── Bottom: provenance left, link right ─────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          {/* English, LTR, and its own element. "before fees" is not optional
              on the broker case: a broker row's P&L is GROSS and reads
              systematically better than the trader's own statement
              (JournalClient.tsx:1617-1627). Neither string says "verified" —
              the discipline fractions are intent-side and backed by nothing a
              broker knows. An empty span holds the row's layout when the day
              is manual and there is no claim to make. */}
          <span style={{ fontSize: Math.round(19 * scale), color: MUTED, letterSpacing: 0.4 }}>
            {note ?? ''}
          </span>
          <span style={{ fontSize: Math.round(19 * scale), color: TEAL, letterSpacing: 0.4 }}>
            reflecttrading.app
          </span>
        </div>
      </div>
    </div>
  );
}
