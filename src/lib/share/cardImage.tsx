/**
 * The share card, as pixels (REF-125 Stage 3, redesigned).
 *
 * This is JSX for SATORI, not for the DOM. It never hydrates, never reaches a
 * browser, and must stay inside the flexbox subset satori implements — so no
 * `grid`, no `position: sticky`, no `gap` on anything that is not a flex
 * container, and every element that has more than one child says
 * `display: flex` explicitly (satori's default is flex, but being explicit is
 * what keeps a later edit from silently relying on block layout that is not
 * there).
 *
 *
 * THE CARD IS ENGLISH ONLY, AND THAT IS THE FIX FOR TWO SEPARATE PROBLEMS
 * -----------------------------------------------------------------------
 *
 * The first cut of this file was rejected twice over, and one decision answers
 * both rejections.
 *
 *   1. EVERY HEBREW STRING ON IT WAS LETTER-REVERSED. `תוצאת היום` rasterised
 *      as `םויה תאצות`. The previous version of this docblock asserted that
 *      "intra-run Hebrew ordering IS correct — satori reverses within a run".
 *      It does not. satori has NO bidi engine whatsoever: it lays glyphs out in
 *      logical order, left to right, which is right for Latin and exactly
 *      backwards for Hebrew. The claim survived because it lived in a comment,
 *      where nothing could contradict it — see `scripts/share-card-check.ts`,
 *      which is the assertion that would have caught it.
 *
 *   2. IT READ LIKE A REPORT RATHER THAN A PRODUCT. Four label/value rows in a
 *      grey box is a table, and a table is what somebody screenshots from a
 *      spreadsheet, not what they paste into a group chat.
 *
 * Making the card English removes the first problem at the root: there is no
 * RTL text left on the image to lay out wrongly, so no amount of satori's
 * missing bidi can hurt it. `/share/[token]` — the page a reader lands on — is
 * still Hebrew, because it is a real browser page with a real bidi
 * implementation and has never had this problem.
 *
 * THE ONE EXCEPTION is the trader's nickname, which is user data and may be
 * Hebrew. It goes through `toVisualOrder()` (src/lib/share/cardBidi.ts), which
 * is grapheme-aware, keeps embedded Latin and digits in their own order, and is
 * covered by assertions. Nothing else on this card may take Hebrew text.
 *
 *
 * WHAT IS ON THE CARD IS A PRODUCT DECISION, NOT A LAYOUT ONE
 * -----------------------------------------------------------
 *
 * The card carries ONLY the day's P&L, the closed-trade count, the win rate,
 * the two discipline fractions, the logo, the date, the optional nickname, the
 * provenance line and a QR to the page. BEST AND WORST TRADE ARE DELIBERATELY
 * ABSENT — they stay on the verification page as a secondary block. A card is
 * read at a glance and in a feed; five numbers compete, seven are noise.
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
import { toVisualOrder } from '@/lib/share/cardBidi';
import { cardDateLabel } from '@/lib/share/cardFonts';
import { fitFontSize } from '@/lib/share/cardMetrics';
import { qrSvgDataUri, shareUrlForToken } from '@/lib/share/cardQr';
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
// custom properties — a `var()` here renders as nothing at all, silently. The
// card is always dark regardless of the viewer's theme because it is an image
// in somebody else's feed, not a page with a theme to inherit.

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
  ink: '#F2F7FA',
  muted: '#8FA3B0',
  /** Dimmer than `muted`, for the small-caps labels that must not compete. */
  faint: '#6B7F8C',
  /**
   * The one accent. `#00d2d2` and not the `#2DD4BF` the design sketch named:
   * CLAUDE.md fixes the product's turquoise at `#00d2d2`, and a share card is
   * the single most-seen Reflect surface to get the brand colour wrong on.
   */
  teal: '#00d2d2',
  /** Softer than the app's `#22c55e`/`#ef4444`: a feed is not a dashboard. */
  green: '#3DDC97',
  red: '#FF5C5C',
  /**
   * Canvas: Reflect navy into a teal-tinted dark, as ONE gradient string
   * because the page draws the same one.
   *
   * The midpoint stop is not decorative — a straight two-stop ramp from the
   * navy to the teal-tinted dark passes through a muddy blue across the middle
   * third, which is exactly where the hero number sits.
   */
  backdrop: 'linear-gradient(135deg, #0B1220 0%, #0C1C26 52%, #0E2A2E 100%)',
  /** The flat fallback under the gradient, and the QR's module colour. */
  canvasFlat: '#0B1220',
  /** The frame's teal edge and its outer bloom, shared with the page. */
  frameBorder: 'rgba(0,210,210,0.55)',
  frameGlow: '0 0 40px rgba(0,210,210,0.40)',
  /** The framed surface, a touch lighter than the canvas behind it. */
  surface: 'rgba(255,255,255,0.028)',
  /** Mini-card and panel fills, and the hairlines that bound them. */
  well: 'rgba(255,255,255,0.04)',
  hairline: 'rgba(255,255,255,0.09)',
  /** The mark's own two colours, from components/ui/Logo.tsx. */
  markGradient: 'linear-gradient(135deg, #00c9c9, #0a4f6e)',
  markReflection: '#15535f',
} as const;

const INK = CARD_PALETTE.ink;
const MUTED = CARD_PALETTE.muted;
const FAINT = CARD_PALETTE.faint;
const TEAL = CARD_PALETTE.teal;
const HAIRLINE = CARD_PALETTE.hairline;
const WELL = CARD_PALETTE.well;

/**
 * The outer glow the design asks for, as a real shadow.
 *
 * satori implements `box-shadow`, so this is a 40px teal bloom around the card
 * frame rather than the absolutely-positioned radial-gradient div the previous
 * version faked one with. The fake had to be hand-placed and drifted out from
 * behind the number it belonged to the moment the layout changed; a shadow is
 * attached to the thing casting it and cannot.
 */
const FRAME_GLOW = CARD_PALETTE.frameGlow;

// ── Generated artwork ───────────────────────────────────────────────────────

/**
 * The dot grid, as ONE image rather than several hundred divs.
 *
 * The SVG tiles itself with `<pattern>`, so satori sees a single `<img>` and
 * resvg does the repetition. The alternative — a div per dot — is ~1,150
 * elements at this spacing on the og card, which is a real cost on a route a
 * social platform may hit in bursts.
 *
 * `fill-opacity` and not an `opacity` on the whole rect: the grid has to stay
 * under the content without washing the gradient out.
 */
function dotGridUri(width: number, height: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="d" width="28" height="28" patternUnits="userSpaceOnUse">` +
    `<circle cx="1.7" cy="1.7" r="1.7" fill="#ffffff" fill-opacity="0.06"/>` +
    `</pattern></defs><rect width="100%" height="100%" fill="url(#d)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * The teal check badge beside the nickname.
 *
 * An SVG data URI rather than a Lucide component: `lucide-react` returns React
 * elements built for the DOM, and satori's SVG support does not cover the
 * `currentColor` inheritance and prop spreading they rely on. One flat data URI
 * rasterises identically every time, which is what a logo-adjacent mark needs.
 *
 * ⚠️ THIS BADGE MAKES NO CLAIM ABOUT IDENTITY. It is the design's "this came
 * from Reflect" mark, sitting above a provenance line that states exactly what
 * is and is not broker-backed. See the note at the call site: a check beside a
 * name is read as account verification on every social platform, and Reflect
 * verifies no trader's identity.
 */
function checkBadgeUri(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="11" fill="${TEAL}" fill-opacity="0.16" stroke="${TEAL}" stroke-width="1.6"/>` +
    `<path d="M7.2 12.4l3.1 3.1 6.4-6.9" fill="none" stroke="${TEAL}" stroke-width="2.4" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * How much of the hero column the number is allowed to occupy.
 *
 * Not 100%: a figure that ends exactly on the column edge reads as clipped even
 * when it is not, and the 4% keeps a descender-free gap between the longest
 * loss and the discipline panel beside it.
 */
const HERO_WIDTH_RATIO = 0.96;

// ── Pieces ──────────────────────────────────────────────────────────────────

/**
 * The Reflect mark: an R, a gradient hairline, and the R reflected — with the
 * wordmark and tagline stacked beside it.
 *
 * REF-125 §1.6 concluded this mark "cannot be reused as-is" because it leans on
 * `background-clip: text` and `transform: scaleX(-1)`, both listed as
 * unsupported, and recommended a letterspaced wordmark instead. THAT FINDING IS
 * WRONG, and it was wrong because it was read rather than run: both properties
 * render correctly in the version of satori this repo has. So the card carries
 * the actual mark rather than a reduction of it.
 *
 * The letterform is NUNITO EXTRABOLD and not Poppins. Poppins is latin-only and
 * committing a third family for two glyphs is not worth the bytes, and Nunito's
 * rounded terminals are closer to the product mark than Rubik's were.
 */
function Mark({ u }: { u: (n: number) => number }) {
  const size = u(44);
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <span
        style={{
          fontSize: size,
          fontWeight: 800,
          lineHeight: 1,
          backgroundImage: CARD_PALETTE.markGradient,
          backgroundClip: 'text',
          WebkitBackgroundClip: 'text',
          color: 'transparent',
        }}
      >
        R
      </span>
      <div
        style={{
          width: Math.max(2, u(2)),
          height: Math.round(size * 0.78),
          margin: `0 ${u(3)}px`,
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,201,201,0), rgba(0,201,201,0.55), rgba(0,201,201,0))',
        }}
      />
      {/* The reflection. `scaleX(-1)` is the whole idea of the mark and the
          thing §1.6 said could not be done here. */}
      <span
        style={{
          fontSize: size,
          fontWeight: 800,
          lineHeight: 1,
          color: CARD_PALETTE.markReflection,
          transform: 'scaleX(-1)',
        }}
      >
        R
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', marginLeft: u(18) }}>
        <span
          style={{
            fontSize: u(21),
            fontWeight: 800,
            letterSpacing: u(5),
            lineHeight: 1,
            color: INK,
          }}
        >
          REFLECT
        </span>
        <span
          style={{
            fontSize: u(14),
            fontWeight: 600,
            letterSpacing: u(2),
            lineHeight: 1,
            color: FAINT,
            marginTop: u(7),
          }}
        >
          Trading Journal
        </span>
      </div>
    </div>
  );
}

/**
 * A small-caps label. The card has exactly one label treatment and this is it.
 *
 * Written uppercase in the source rather than set with `text-transform`: satori
 * supports the property, but a literal is what makes the string in the file the
 * string on the image, which matters when the next person greps for a label
 * they saw in a render.
 */
function Label({ children, u }: { children: string; u: (n: number) => number }) {
  return (
    <span style={{ fontSize: u(15), fontWeight: 600, letterSpacing: u(2), color: FAINT }}>
      {children}
    </span>
  );
}

/** One of the two bordered mini-cards under the P&L. */
function MiniCard({
  label,
  value,
  u,
  grow,
}: {
  label: string;
  value: string;
  u: (n: number) => number;
  grow?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: grow ? 1 : 0,
        padding: `${u(16)}px ${u(20)}px`,
        borderRadius: u(16),
        background: WELL,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <Label u={u}>{label}</Label>
      <span style={{ fontSize: u(34), fontWeight: 800, color: INK, marginTop: u(8), lineHeight: 1 }}>
        {value}
      </span>
    </div>
  );
}

/**
 * One discipline row: a name, a fraction, and a bar.
 *
 * THE BAR IS WHY THIS CARD STOPPED LOOKING LIKE A SPREADSHEET. "4/5" on its own
 * is a table cell; the same number with a filled track is a product telling you
 * how the day went. The fill is the only place teal touches a figure, and it is
 * deliberately not green — green and red on this card are semantic and belong
 * to the P&L alone, so a bar that turned red on a bad discipline day would be
 * the card passing judgement in the P&L's own colours.
 */
function DisciplineRow({
  label,
  fraction,
  u,
}: {
  label: string;
  fraction: ShareFraction;
  u: (n: number) => number;
}) {
  // `answered` is the honest denominator and snapshot.ts never returns a zero
  // one, but the guard is kept: a division by zero here would render a bar of
  // width `NaN%`, which satori lays out as a full-width teal block — i.e. a
  // perfect score, drawn on a day nobody answered anything about.
  const pct = fraction.answered > 0 ? Math.round((fraction.met / fraction.answered) * 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', width: '100%' }}>
        <span style={{ fontSize: u(20), fontWeight: 600, color: MUTED }}>{label}</span>
        <span style={{ fontSize: u(22), fontWeight: 800, color: INK }}>
          {`${fraction.met}/${fraction.answered}`}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: u(7),
          marginTop: u(11),
          borderRadius: u(4),
          background: 'rgba(255,255,255,0.07)',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: `${pct}%`,
            height: '100%',
            borderRadius: u(4),
            background: TEAL,
          }}
        />
      </div>
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

export interface ShareCardProps {
  snapshot: DailyShareSnapshot;
  /** The row's own column, which the page and the image both trust over the document. */
  tradingDay: TradingDay;
  size: ShareCardSize;
  /** The card's own token — the QR points at the page this image unfurls for. */
  token: string;
}

export function ShareCardImage({ snapshot, tradingDay, size, token }: ShareCardProps) {
  const { width, height } = CARD_SIZES[size];
  const square = size === 'square';

  /**
   * ONE MULTIPLIER, applied through `u()`, rather than two sets of numbers.
   *
   * The 1200×630 unfurl card and the 1080×1080 download are the same component
   * under a different scale, because they make the same claims about the same
   * day. Two components would be two places for the provenance line to drift,
   * and that line is the one piece of text here a reputational problem could
   * come from. Only the ARRANGEMENT branches on `square`; no size, colour or
   * string does.
   */
  const scale = square ? 1.16 : 1;
  const u = (n: number) => Math.round(n * scale);

  const pnl = snapshot.pnl;

  /**
   * THE ABSENT DAY GETS WORDS, NOT A DASH.
   *
   * SharedDayCard renders `—` for a null P&L and that is right on the page,
   * where the figure is ~34px. At 120px an em dash is an 80px horizontal BAR —
   * it rendered as what looks exactly like a missing-glyph box, which was found
   * by looking at the output rather than by reasoning about it. A card that
   * appears broken is worse than one that says nothing, and this is a public
   * artefact with no caption to explain it.
   *
   * Still NOT `$0.00`: a day whose closed trades recorded no amount is not a
   * breakeven day, and a zero under a broker tag is a claim we cannot support.
   * English now, like everything else on the card.
   */
  const moneyAbsent = pnl === null;
  const money = moneyAbsent ? 'No amount recorded' : formatMoney(pnl);
  const moneyColour = moneyAbsent ? MUTED : pnl >= 0 ? CARD_PALETTE.green : CARD_PALETTE.red;

  /**
   * The geometry the hero has to fit inside, derived rather than written down.
   *
   * These are the same numbers the JSX below uses, computed once so the fitted
   * font size and the actual column cannot disagree. The landscape card gives
   * the number a fixed 536px and the panel a fixed 424px — FIXED on both sides,
   * because a panel that grew with its contents would move the hero, and a
   * one-fraction day and a two-fraction day must compose identically.
   */
  const canvasPad = u(square ? 26 : 22);
  const framePad = u(square ? 52 : 36);
  const contentWidth = width - 2 * canvasPad - 4 /* the frame's 2px border */ - 2 * framePad;
  const panelWidth = 400;
  const heroColumn = square ? contentWidth : 600;

  const heroTracking = u(-3);
  // MEASURED, not guessed. See cardMetrics.ts: the previous length-based steps
  // put a 643px number in a 536px column and the card folded.
  const moneySize = fitFontSize(
    money,
    heroColumn * HERO_WIDTH_RATIO,
    u(square ? 132 : 120),
    heroTracking
  );

  // Withheld rather than printed as 0% when nothing was counted — the same
  // honest-denominator rule the two fractions already follow.
  const winRate =
    snapshot.trades > 0 ? `${Math.round((snapshot.wins / snapshot.trades) * 100)}%` : '—';

  const note = shareProvenanceNote(snapshot.provenance);

  /**
   * The handle, reordered for a renderer with no bidi — and ONLY the handle.
   *
   * `toVisualOrder` is a no-op on Latin text, so a trader called "Index Trader"
   * goes through it untouched; a Hebrew handle comes back in the visual order
   * satori will actually paint. This is the single call site on the card, and
   * it must stay that way: everything else here is a literal we control.
   *
   * "Reflect trader" when the toggle is off. Not an empty space and not the
   * word "Anonymous" — the first leaves the badge floating next to nothing, and
   * the second sounds like something withheld rather than something not asked.
   */
  const displayName = toVisualOrder(snapshot.nickname ?? 'Reflect trader');

  /**
   * The discipline score: both fractions pooled, not averaged.
   *
   * Pooling counts every answered question once; averaging two percentages
   * would let a 1/1 and a 2/10 average to 60%, which is not a thing that
   * happened. Withheld entirely when nothing was answered — see the panel.
   */
  const met = (snapshot.followedPlan?.met ?? 0) + (snapshot.stopHeld?.met ?? 0);
  const answered = (snapshot.followedPlan?.answered ?? 0) + (snapshot.stopHeld?.answered ?? 0);
  const disciplineScore = answered > 0 ? Math.round((met / answered) * 100) : null;

  // ── Blocks, composed differently by the two sizes ────────────────────────

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <Mark u={u} />
      {/* Digits only, pinned to the trading day string — never a Date, so there
          is no server timezone for it to be wrong about. */}
      <span style={{ fontSize: u(20), fontWeight: 600, color: MUTED, letterSpacing: u(1) }}>
        {cardDateLabel(tradingDay)}
      </span>
    </div>
  );

  const hero = (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Label u={u}>TODAY&apos;S P&amp;L</Label>
      {/* `nowrap` IS LOAD-BEARING, not tidiness. Without it the fitted size is
          only a suggestion: satori breaks the string at the column edge and
          `+$1,240.50` becomes a `+` on one line and the amount on the next,
          which is what the first render of this design did. */}
      <span
        style={{
          fontSize: moneySize,
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: heroTracking,
          color: moneyColour,
          marginTop: u(14),
          whiteSpace: 'nowrap',
        }}
      >
        {money}
      </span>
    </div>
  );

  const miniCards = (
    <div style={{ display: 'flex', width: '100%' }}>
      <MiniCard label="TRADES" value={String(snapshot.trades)} u={u} grow />
      <div style={{ display: 'flex', width: u(16) }} />
      <MiniCard label="WIN RATE" value={winRate} u={u} grow />
    </div>
  );

  /**
   * The discipline panel — withheld whole when neither fraction was answered.
   *
   * snapshot.ts returns null rather than `{met:0,answered:0}`, and REF-125 §2.4
   * names the cost of losing that distinction: "0/100" on a public page would
   * be defamatory of the trader's own day. An empty bordered panel saying
   * DISCIPLINE with nothing under it makes the same claim more quietly, so the
   * whole block goes.
   */
  const hasDiscipline = snapshot.followedPlan !== null || snapshot.stopHeld !== null;
  const discipline = hasDiscipline ? (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        padding: u(26),
        borderRadius: u(20),
        background: WELL,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <Label u={u}>DISCIPLINE</Label>
        {disciplineScore !== null && (
          <div
            style={{
              display: 'flex',
              padding: `${u(5)}px ${u(13)}px`,
              borderRadius: u(999),
              background: 'rgba(0,210,210,0.12)',
              border: `1px solid rgba(0,210,210,0.35)`,
            }}
          >
            <span style={{ fontSize: u(17), fontWeight: 800, color: TEAL }}>{`${disciplineScore}%`}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', height: u(22) }} />
      {snapshot.followedPlan !== null && (
        <DisciplineRow label="Followed plan" fraction={snapshot.followedPlan} u={u} />
      )}
      {snapshot.followedPlan !== null && snapshot.stopHeld !== null && (
        <div style={{ display: 'flex', height: u(20) }} />
      )}
      {/* "Stop held" — the counted predicate treats a TIGHTENING as held
          (Imri 19.10), so this says the stop HELD rather than that it was never
          moved, which would be false on exactly the trades the product decided
          to reward. */}
      {snapshot.stopHeld !== null && <DisciplineRow label="Stop held" fraction={snapshot.stopHeld} u={u} />}
    </div>
  ) : null;

  /**
   * 104px, and the size is a SCANNING constraint rather than a visual one.
   *
   * A 43-character token makes the share URL 76 bytes, which at error level M
   * is a version 5 symbol — 37×37 modules. At the 88px this started out as,
   * each module rasterised to 2.38 device pixels (measured off the PNG, not
   * estimated), which is under the ~3px a camera wants and leaves nothing for
   * the resampling a social platform does on the way to a feed. 104px puts it
   * at 2.81. Bigger would start to read as a white block on a dark card.
   *
   * The printed `reflecttrading.app` under it is the fallback, and the page is
   * a tap away from the unfurl itself — the QR is a convenience for somebody
   * looking at the card on another person's screen, not the only way in.
   */
  const qrModule = u(104);
  const footer = (
    // CENTRED against the QR, not bottom-aligned. The QR column is ~140px tall
    // and the name block ~75px, so pinning both to the baseline left a visible
    // hole above the nickname while the right-hand side was full.
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* ⚠️ A CHECK BESIDE A NAME READS AS ACCOUNT VERIFICATION on every
              social platform there is, and Reflect verifies no trader's
              identity. It is here because the design calls for it; the line
              directly under it is what carries the only claim this card
              actually makes, and that line says "before fees" rather than
              "verified". Flagged for Imri in the Stage 3 report. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- satori JSX, not the DOM. */}
          <img src={checkBadgeUri()} width={u(28)} height={u(28)} alt="" />
          <span style={{ fontSize: u(23), fontWeight: 800, color: INK, marginLeft: u(12) }}>
            {displayName}
          </span>
        </div>
        {/* English, LTR, and its own element. "before fees" is not optional on
            the broker case: a broker row's P&L is GROSS and reads
            systematically better than the trader's own statement
            (JournalClient.tsx:1617-1627). Neither string says "verified" — the
            discipline fractions are intent-side and backed by nothing a broker
            knows. An empty span holds the block's height when the day is manual
            and there is no claim to make. */}
        <span style={{ fontSize: u(17), fontWeight: 600, color: FAINT, marginTop: u(10) }}>
          {note ?? ''}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* A WHITE TILE, not light modules on the dark card. Inverted QR codes
            are decoded by most modern scanners and not by all of them, and this
            is the one element on the card a reader has to ACT on. The 12px
            padding is the four-module quiet zone a scanner needs, expressed as
            layout so it cannot disagree with the tile's rounding. */}
        <div
          style={{
            display: 'flex',
            padding: u(12),
            borderRadius: u(14),
            background: '#FFFFFF',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- satori JSX, not the DOM. */}
          <img
            src={qrSvgDataUri(shareUrlForToken(token), CARD_PALETTE.canvasFlat)}
            width={qrModule}
            height={qrModule}
            alt=""
          />
        </div>
        <span style={{ fontSize: u(16), fontWeight: 600, color: TEAL, marginTop: u(12), letterSpacing: u(1) }}>
          reflecttrading.app
        </span>
      </div>
    </div>
  );

  /**
   * The middle band.
   *
   * `flexGrow: 1` AND CENTRED, rather than a third child of a space-between
   * column. (`flexGrow`, never the `flex` shorthand — satori does not expand
   * it, so `flex: 1` silently leaves the band at its content height and the
   * whole composition collapses upward. The mini-cards grew correctly while
   * this band did not, which is what gave the difference away.)
   * Letting the outer column distribute three rows pushed the money to wherever
   * the panel's height left it — so a day with one discipline fraction and a
   * day with two composed differently, and the hero drifted down the card as
   * the panel shrank. Giving the middle band the leftover height and centring
   * inside it makes the composition identical whatever the panel contains,
   * which is what "nothing cramped" needs to survive the withheld-field cases.
   */
  const middle = square ? (
    // `paddingTop` AND centring. Without the padding the stack centres so
    // close under the header that "TODAY'S P&L" and the mark's "Trading
    // Journal" tagline — both small, both muted — read as one smudged line.
    <div
      style={{
        display: 'flex',
        flexGrow: 1,
        flexDirection: 'column',
        justifyContent: 'center',
        width: '100%',
        paddingTop: u(30),
      }}
    >
      {hero}
      <div style={{ display: 'flex', height: u(30) }} />
      {miniCards}
      {discipline !== null && <div style={{ display: 'flex', height: u(22) }} />}
      {discipline}
    </div>
  ) : (
    <div style={{ display: 'flex', flexGrow: 1, alignItems: 'stretch', width: '100%' }}>
      {/* SPREAD, not stacked-and-centred. With the two blocks pushed to the top
          and bottom of the band, the hero sits directly under the header and
          the mini-cards sit directly above the footer — which is what closes
          the dead strip the centred version left down the left-hand side while
          the taller QR column filled the same height on the right. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: heroColumn,
          paddingTop: u(14),
          paddingBottom: u(2),
        }}
      >
        {hero}
        {miniCards}
      </div>
      <div style={{ display: 'flex', flexGrow: 1 }} />
      {/* The panel takes a fixed width rather than growing: a two-fraction day
          and a one-fraction day must put the hero in the same place, and a
          growing panel would move it. Centred in the band so the withheld-field
          cases do not leave it hanging off the top. */}
      <div style={{ display: 'flex', width: panelWidth, alignItems: 'center' }}>{discipline}</div>
    </div>
  );

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        position: 'relative',
        padding: canvasPad,
        fontFamily: 'Nunito',
        backgroundColor: CARD_PALETTE.canvasFlat,
        backgroundImage: CARD_PALETTE.backdrop,
      }}
    >
      {/* Texture, under everything. ONE grid across the whole canvas, drawn
          before the frame so it reads through the frame's translucent surface
          as well as around it — that continuity is what makes the frame look
          like a pane laid on a textured backdrop rather than a drawn rectangle
          sitting on flat colour. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- satori JSX, not the DOM: this tree is rasterised server-side and never hydrates, so next/image has nothing to optimise and its output would not render here at all. */}
      <img
        src={dotGridUri(width, height)}
        width={width}
        height={height}
        style={{ position: 'absolute', top: 0, left: 0 }}
        alt=""
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: framePad,
          borderRadius: u(28),
          border: `2px solid ${CARD_PALETTE.frameBorder}`,
          // The surface is DELIBERATELY TRANSLUCENT (2.8% white) rather than an
          // opaque panel: it lifts the framed area off the canvas by a hair
          // while letting the gradient and the dot grid carry straight through
          // it. An opaque fill here flattened the card into two stacked
          // rectangles.
          background: CARD_PALETTE.surface,
          boxShadow: FRAME_GLOW,
          position: 'relative',
        }}
      >
        {header}
        {middle}
        {footer}
      </div>
    </div>
  );
}
