/**
 * A shared trading day, as a stranger sees it (REF-125 Stage 2 item 4,
 * redesigned in Stage 3).
 *
 * A SERVER COMPONENT WITH NO INTERACTIVITY. No `'use client'`, no state, no
 * effect — it takes a validated snapshot and renders it. That is what lets the
 * public page be entirely server-rendered, which is the property the whole
 * design rests on: the browser never holds a Supabase client, so there is no
 * `anon` grant anywhere (migration 043).
 *
 *
 * IT IS THE IMAGE'S TWIN, AND THAT IS THE BRIEF
 * ---------------------------------------------
 *
 * Somebody arrives here by clicking a card they saw in a feed. If the page
 * looks like an app screen instead of like the thing they clicked, the link
 * reads as a bait-and-switch — so this carries the same canvas gradient, the
 * same dot grid, the same teal-edged frame with its outer glow, the same
 * mini-cards and the same discipline bars as lib/share/cardImage.tsx. The two
 * import ONE palette (`CARD_PALETTE`) rather than agreeing on hex values twice.
 *
 * WHERE THEY DIFFER, AND WHY EACH DIFFERENCE IS DELIBERATE:
 *
 *   - THIS PAGE IS HEBREW; THE IMAGE IS ENGLISH. Not an inconsistency — it is
 *     the fix for the bug that got the first card rejected. satori has no bidi
 *     engine and rendered every Hebrew string on the image letter-reversed; a
 *     browser has a real bidi implementation and has never had that problem.
 *     The card is the artefact that travels, so it speaks the language that
 *     survives the renderer; the page is where the trader's own language lives.
 *   - THE PAGE CARRIES BEST/WORST. Imri, 27.10 — the card shows the day's
 *     headline only, and the detail belongs where somebody is reading rather
 *     than glancing.
 *   - NO QR CODE. The card's QR exists to get a reader HERE. Printing one on
 *     the destination would be a link to the page you are already on.
 *
 * THE ARTEFACT IS HARD-CODED DARK, THE FOOTER IS NOT. The card is dark in
 * everybody's feed, so this must be dark in everybody's browser — a
 * theme-aware hero would show a light page to a light-theme visitor and look
 * nothing like the image that brought them. But SiteDisclosureFooter is
 * legally-required text with a measured contrast floor (disclosureStyle.ts),
 * and forcing it onto a dark backdrop while the light theme supplied its
 * colours would put #5c6370 on #15151c. So the dark treatment stops at the
 * artefact and the footer keeps the page's own theme tokens.
 *
 *
 * EVERY NUMBER IS LTR-ISOLATED
 * ----------------------------
 *
 * money.ts:23-27 puts the RTL contract on the CALLER: a bare `-$2,000.00`
 * dropped into Hebrew flow has its sign carried to the wrong end, so the minus
 * ends up after the digits and a loss reads as a gain. The `Ltr` wrapper below
 * is TodayContextPanel's, restated locally for the same reason that one is
 * local — there is no shared `Ltr` in components/ui, and this page must not
 * import from a client component.
 *
 * THE FRACTIONS ARE ISOLATED TOO, which is less obvious than the money. "4/5"
 * in an RTL run is reordered to "5/4" by the bidi algorithm, which silently
 * inverts a discipline claim — the one kind of error on this page that a
 * reader cannot spot, because the wrong answer is also a plausible one.
 */

import { formatMoney } from '@/lib/money';
import { CARD_PALETTE } from '@/lib/share/cardImage';
import { shareProvenanceNote } from '@/lib/share/snapshot';
import type { DailyShareSnapshot, ShareAccountRow, ShareFraction } from '@/lib/share/snapshot';
import { tradingDayLabel, type TradingDay } from '@/lib/tradingDay';

const {
  ink: INK,
  muted: MUTED,
  faint: FAINT,
  teal: TEAL,
  green: GREEN,
  red: RED,
  hairline: HAIRLINE,
  well: WELL,
} = CARD_PALETTE;

/** Numbers and symbols isolated from the surrounding Hebrew. */
function Ltr({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span
      dir="ltr"
      style={{ whiteSpace: 'nowrap', unicodeBidi: 'isolate', fontVariantNumeric: 'tabular-nums', ...style }}
    >
      {children}
    </span>
  );
}

/**
 * The Reflect mark, in CSS this time, with the wordmark and tagline beside it.
 *
 * The image has to reconstruct this inside satori's subset; a browser simply
 * has `background-clip: text` and `transform: scaleX(-1)`, so this is the same
 * mark expressed the easy way. Kept visually identical to the card's — it is
 * the first thing a visitor matches against what they clicked. The tagline is
 * `Trading Journal` in both places: it is a wordmark lockup, not body copy, and
 * translating half a logo is how you end up with two logos.
 */
function ReflectMark() {
  return (
    <span dir="ltr" className="inline-flex items-center shrink-0">
      <span
        style={{
          fontSize: 36,
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
      <span
        aria-hidden="true"
        style={{
          width: 2,
          height: 28,
          margin: '0 3px',
          backgroundImage:
            'linear-gradient(to bottom, rgba(0,201,201,0), rgba(0,201,201,0.55), rgba(0,201,201,0))',
        }}
      />
      <span
        style={{
          fontSize: 36,
          fontWeight: 800,
          lineHeight: 1,
          color: CARD_PALETTE.markReflection,
          transform: 'scaleX(-1)',
        }}
      >
        R
      </span>
      <span className="flex flex-col" style={{ marginInlineStart: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 4, lineHeight: 1, color: INK }}>
          REFLECT
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.5, lineHeight: 1, color: FAINT, marginTop: 5 }}>
          Trading Journal
        </span>
      </span>
    </span>
  );
}

/** The card's one label treatment: small, spaced, and quiet. */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.5, color: FAINT }}>{children}</span>
  );
}

/** One of the three bordered mini-cards under the hero figure. */
function MiniCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div
      className="flex-1 min-w-0 flex flex-col gap-2 px-4 sm:px-5 py-4 rounded-2xl"
      style={{ background: WELL, border: `1px solid ${HAIRLINE}` }}
    >
      <Label>{label}</Label>
      <Ltr style={{ fontSize: 26, fontWeight: 800, color: INK, lineHeight: 1 }}>{value}</Ltr>
      {/* Reserved whether filled or not, so the three cards keep one baseline
          — the same reason the image reserves it. */}
      <Ltr style={{ fontSize: 12, fontWeight: 700, color: FAINT, lineHeight: 1, minHeight: 12 }}>
        {sub ?? ''}
      </Ltr>
    </div>
  );
}

/**
 * The mark at the start of an account row.
 *
 * ⚠️ DELIBERATELY NOT THE TRADOVATE LOGO — the card's `AccountMark` carries the
 * full argument. The short version: `PlatformsSection.tsx:76-80` already ruled
 * that permission to show a mark covers NinjaTrader only, Tradovate is a
 * NinjaTrader Group company, and `SiteDisclosureFooter` disclaims any
 * affiliation with them. This rhombus is ours.
 */
function AccountMark({ broker }: { broker: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0"
      style={{
        width: 9,
        height: 9,
        transform: 'rotate(45deg)',
        borderRadius: 2,
        background: broker ? TEAL : 'transparent',
        border: `2px solid ${broker ? TEAL : MUTED}`,
      }}
    />
  );
}

/**
 * One account: mark, name, and that account's money.
 *
 * `dir="ltr"` ON THE ROW, AND IT IS THE ONE THING ON THIS PAGE THAT OPTS OUT
 * (Imri's review, 28.10).
 *
 * The page is Hebrew and RTL, and that is right for every other row on it. But
 * a flex row inside `dir="rtl"` lays its children out RIGHT TO LEFT, so this
 * row rendered as a MIRROR of the same row on the card image: the figure landed
 * on the physical left, the diamond and the name on the right. The card puts
 * the mark and the name on the left and the money at the right-hand end, and
 * the page is meant to be the card's twin — a stranger who follows the link has
 * to arrive somewhere that looks like the image they clicked, and an accounts
 * panel flipped end for end is the one block where it visibly did not.
 *
 * NOT a page-wide change, and not `flex-row-reverse`: the first would flip the
 * Hebrew prose this page is made of, and the second would reverse the ORDER of
 * the children while leaving the row's text direction RTL, which is a different
 * layout that happens to look the same until something wraps.
 *
 * THE NAME KEEPS ITS OWN DIRECTION via `dir="auto"` below. The row only decides
 * where the three boxes sit; `display_name` is free text the trader typed and
 * may be Hebrew, Latin or mixed, so it picks its base direction from its own
 * first strong character rather than inheriting the row's.
 */
function AccountRow({ account }: { account: ShareAccountRow }) {
  return (
    <div dir="ltr" className="flex items-center gap-3 min-w-0">
      <AccountMark broker={account.broker} />
      {/* `min-w-0` + `truncate`: the name is bounded at 22 characters by the
          snapshot, but a narrow phone is narrower than 22 characters and the
          figure beside it must not be pushed off. */}
      <span
        dir="auto"
        className="min-w-0 truncate"
        style={{ fontSize: 15, fontWeight: 800, color: INK }}
      >
        {account.name}
      </span>
      <span className="flex-1" />
      <Ltr
        style={{
          fontSize: 15,
          fontWeight: 800,
          color: account.pnl === null ? MUTED : account.pnl >= 0 ? GREEN : RED,
        }}
      >
        {account.pnl === null ? '—' : formatMoney(account.pnl)}
      </Ltr>
    </div>
  );
}

/** The small secondary pair — on the page only, never on the card. */
function Detail({ label, amount }: { label: string; amount: number }) {
  return (
    <div
      className="flex-1 min-w-0 flex items-baseline justify-between gap-3 px-4 py-3 rounded-xl"
      style={{ background: WELL, border: `1px solid ${HAIRLINE}` }}
    >
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      <Ltr style={{ fontSize: 15, fontWeight: 700, color: amount >= 0 ? GREEN : RED }}>
        {formatMoney(amount)}
      </Ltr>
    </div>
  );
}

/**
 * The teal check badge, matching the card's.
 *
 * ⚠️ IT MAKES NO CLAIM ABOUT IDENTITY — see the card's note at the same spot.
 * Reflect verifies no trader's identity; the provenance line beside it carries
 * the only claim either surface makes, and that line says "before fees" rather
 * than "verified". `aria-hidden` because it is decorative: a screen reader
 * announcing a check here would state exactly the thing it does not mean.
 */
function CheckBadge() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="11" fill={TEAL} fillOpacity="0.16" stroke={TEAL} strokeWidth="1.6" />
      <path
        d="M7.2 12.4l3.1 3.1 6.4-6.9"
        fill="none"
        stroke={TEAL}
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function SharedDayCard({
  snapshot,
  tradingDay,
}: {
  snapshot: DailyShareSnapshot;
  /** The row's own column, which the page trusts over the document's copy. */
  tradingDay: TradingDay;
}) {
  // The same function the dialog's preview and the image call, so a provenance
  // claim cannot differ between what the trader was shown, what a stranger
  // reads, and what a social platform renders. The wording argument lives on
  // that function.
  const note = shareProvenanceNote(snapshot.provenance);
  const pnl = snapshot.pnl;

  // Derived from the two frozen fields, exactly as the image derives it — not
  // stored, so cards minted before Stage 3 still render. Withheld rather than
  // shown as 0% when nothing was counted.
  const winRate = snapshot.trades > 0 ? `${Math.round((snapshot.wins / snapshot.trades) * 100)}%` : '—';

  // Pooled, not averaged — the image's reasoning, restated by using the same
  // arithmetic: averaging a 1/1 and a 2/10 gives 60%, which is not a thing that
  // happened.
  const met = (snapshot.followedPlan?.met ?? 0) + (snapshot.stopHeld?.met ?? 0);
  const answered = (snapshot.followedPlan?.answered ?? 0) + (snapshot.stopHeld?.answered ?? 0);
  const disciplineScore = answered > 0 ? Math.round((met / answered) * 100) : null;
  // The two fractions as the discipline card's evidence line, in the same
  // order and the same `met/answered` shape the image prints.
  const disciplineSub = [snapshot.followedPlan, snapshot.stopHeld]
    .filter((f): f is ShareFraction => f !== null)
    .map((f) => `${f.met}/${f.answered}`)
    .join(' · ');

  return (
    <div
      dir="rtl"
      className="w-full max-w-[1100px] mx-auto rounded-[28px] relative"
      style={{
        backgroundColor: CARD_PALETTE.canvasFlat,
        backgroundImage: CARD_PALETTE.backdrop,
        // The frame, matching the image: a 2px teal edge and a 40px outer
        // bloom, both from the shared palette so neither can drift.
        border: `2px solid ${CARD_PALETTE.frameBorder}`,
        boxShadow: CARD_PALETTE.frameGlow,
      }}
    >
      {/* The dot grid. Real CSS can repeat a radial-gradient, so unlike the
          image this needs no tiled SVG. `pointer-events-none` because it is
          texture laid over the whole artefact, and the rounding is repeated
          here so the texture stops where the frame does. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none rounded-[26px]"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1.7px, transparent 1.7px)',
          backgroundSize: '28px 28px',
        }}
      />

      <div className="relative flex flex-col gap-10 md:gap-12 p-6 md:p-12">
        {/* ── Mark, date, handle ──────────────────────────────────────────── */}
        {/* `flex-row-reverse` UNDER AN RTL CONTAINER, so the mark lands on the
            LEFT and the date on the right — matching the image rather than
            mirroring it.

            This container stays `dir="rtl"` because that is what makes every
            Hebrew string inside it lay out correctly for free, including
            `tradingDayLabel`, which mixes Hebrew with digits in one node and
            would reorder under an LTR base. Only the STRUCTURAL rows are
            reversed. The image reaches the same arrangement from the other
            side — satori has an LTR base and no bidi, so it reverses rows to
            get its layout right; this reverses rows to get the composition
            right. Imri's brief fixes the composition (mark left, date right,
            panel right), and a visitor who clicked a card has to arrive
            somewhere that looks like it. */}
        <div className="flex flex-row-reverse items-center justify-between gap-4 flex-wrap">
          <ReflectMark />
          {/* Larger and heavier than it was — the review's "everything is too thin",
              applied to the page as well as the image so the twins stay twins. */}
          <h1 style={{ fontSize: 18, fontWeight: 800, color: INK }}>{tradingDayLabel(tradingDay)}</h1>
        </div>

        {/* ── The day's money, and the discipline panel ───────────────────── */}
        {/* Stacked on a phone, two columns from `md` — the brief's "full width
            on desktop, stacked on mobile". `items-center` so the headline and
            the panel share a centre line whatever the panel contains, which is
            the same correction the image needed once a withheld fraction made
            the panel shorter. */}
        <div className="flex flex-col md:flex-row-reverse md:items-center gap-8 md:gap-12">
          {/* `text-align: left` inside an RTL container: the money column sits
              on the left of the artefact, as it does on the image, so its
              label and figure hang off the left edge rather than the right. */}
          <div className="flex-1 min-w-0 flex flex-col gap-6" style={{ textAlign: 'left' }}>
            <div className="flex flex-col gap-3">
              <Label>תוצאת היום</Label>
              <Ltr
                style={{
                  // Fluid rather than fixed: a six-figure amount must not clip
                  // on a narrow phone, and this card has no horizontal scroll
                  // to fall back on. The image cannot do this — it has no
                  // viewport — which is why it measures the glyphs instead
                  // (lib/share/cardMetrics.ts).
                  fontSize: 'clamp(40px, 9vw, 76px)',
                  fontWeight: 800,
                  lineHeight: 1.05,
                  letterSpacing: '-0.03em',
                  display: 'inline-block',
                  // `—` when no counted trade recorded an amount. NOT `$0.00`:
                  // a day whose trades carry no money figure is not a breakeven
                  // day, and zero under a "Broker-synced" tag would be a claim
                  // we cannot support. At this size a dash still reads as a
                  // dash, which is why the page keeps it where the image —
                  // where the figure is ~120px and an em dash becomes a bar —
                  // spells it out instead.
                  color: pnl === null ? MUTED : pnl >= 0 ? GREEN : RED,
                }}
              >
                {pnl === null ? '—' : formatMoney(pnl)}
              </Ltr>
            </div>

            {/* THREE mini-cards now: discipline joined them as a score with
                its fractions as a subline, which is what freed the right-hand
                panel for the accounts breakdown. `—` and no subline when
                nothing was answered — never 0%, for the reason REF-125 §2.4
                gives: a zero on a public page would be defamatory of the
                trader's own day.

                The fractions are inside an `Ltr`, which is load-bearing: "4/5"
                in an RTL run is reordered to "5/4" by the browser's bidi
                algorithm, silently inverting a discipline claim. */}
            <div className="flex gap-3 sm:gap-4" style={{ textAlign: 'right' }}>
              <MiniCard label="עסקאות סגורות" value={snapshot.trades} />
              <MiniCard label="אחוז הצלחה" value={winRate} />
              <MiniCard
                label="משמעת"
                value={disciplineScore === null ? '—' : `${disciplineScore}%`}
                sub={disciplineSub || undefined}
              />
            </div>
          </div>

          {/* ── The accounts panel ───────────────────────────────────────────
              Withheld whole when there is nothing to attribute: an empty panel
              headed "תיקים" would be a claim about a DEPLOYMENT state —
              migration 037 unrun, or the import gate shut — dressed up as a
              fact about the day. */}
          {snapshot.accounts.length > 0 && (
            <div
              className="w-full md:w-[380px] shrink-0 flex flex-col gap-4 p-5 md:p-6 rounded-2xl"
              style={{ background: WELL, border: `1px solid ${HAIRLINE}` }}
            >
              <Label>תיקים · תוצאת היום</Label>
              {/* THE PAGE LISTS THEM ALL. The card caps at five and says
                  "+N more" because it is read at a glance in a feed; somebody
                  who followed the link is reading, and the thing they followed
                  it to verify is exactly this breakdown. The snapshot stores at
                  most eight either way. */}
              <div className="flex flex-col gap-3.5">
                {snapshot.accounts.map((account, i) => (
                  <AccountRow key={account.name + i} account={account} />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Best and worst — the page's own block, kept small ───────────── */}
        {/* NOT ON THE CARD, by Imri's 27.10 instruction: the image carries the
            day's headline only, and these two live here, where somebody who
            followed the link is reading rather than glancing. Money-only and
            null together, as the builder emits them. */}
        {snapshot.best !== null && snapshot.worst !== null && (
          <div className="flex flex-col sm:flex-row gap-3">
            <Detail label="העסקה הטובה" amount={snapshot.best} />
            <Detail label="העסקה החלשה" amount={snapshot.worst} />
          </div>
        )}

        {/* ── Identity, provenance, and the link out ──────────────────────── */}
        {/* Reversed for the same reason as the header: the image puts the name
            and provenance bottom-left and the link bottom-right. */}
        <div
          className="flex flex-row-reverse items-center justify-between gap-4 flex-wrap pt-6"
          style={{ borderTop: `1px solid ${HAIRLINE}` }}
        >
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex items-center gap-2.5">
              <CheckBadge />
              {/* The opt-in handle, and the only name this page can print.
                  "סוחר Reflect" when the toggle is off — not blank, which would
                  leave the badge floating beside nothing. Absent-by-default is
                  enforced upstream: buildDailyShareSnapshot applies the
                  visibility document itself, so a nickname only arrives here if
                  the trader both set one and turned the toggle on. */}
              <span
                style={{ fontSize: 16, fontWeight: 800, color: INK, overflowWrap: 'anywhere' }}
              >
                {snapshot.nickname ?? 'סוחר Reflect'}
              </span>
            </div>
            {/* English in an RTL card, so it gets its own direction rather than
                being reordered into the Hebrew flow around it. Rendered only
                when there is a claim — a manual day makes none, and an empty
                element here would leave a stray gap under the name. */}
            {note !== null && (
              <span dir="ltr" style={{ fontSize: 12, color: FAINT, letterSpacing: '0.02em' }}>
                {note}
              </span>
            )}
          </div>

          {/* The only outbound link on the page. A plain <a> and not next/link:
              this is a route out of the app to the marketing apex, so there is
              nothing to prefetch and no client router to involve on a page that
              ships no other interactivity. */}
          <a
            href="https://reflecttrading.app"
            dir="ltr"
            style={{ fontSize: 13, fontWeight: 700, color: TEAL, textDecoration: 'none' }}
          >
            reflecttrading.app
          </a>
        </div>
      </div>
    </div>
  );
}
