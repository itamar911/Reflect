/**
 * A shared trading day, as a stranger sees it (REF-125 Stage 2 item 4,
 * redesigned in Stage 3 item 4).
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
 * reads as a bait-and-switch — so this carries the same backdrop, the same dot
 * grid, the same single teal accent and the same mark as
 * lib/share/cardImage.tsx. The two import ONE palette (`CARD_PALETTE`) rather
 * than agreeing on hex values twice.
 *
 * Where they deliberately differ: this page is the VERIFICATION surface, so it
 * carries the best/worst block the card does not (Imri, 27.10 — the card shows
 * only the day's headline figures; the detail lives here). It is also real
 * CSS, so it can do the things satori cannot: media queries, `direction: rtl`
 * that actually works, and a dot grid as a repeating background rather than a
 * tiled SVG.
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
import type { DailyShareSnapshot, ShareFraction } from '@/lib/share/snapshot';
import { tradingDayLabel, type TradingDay } from '@/lib/tradingDay';

const { ink: INK, muted: MUTED, teal: TEAL, green: GREEN, red: RED, hairline: HAIRLINE, panel: PANEL } =
  CARD_PALETTE;

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
 * The Reflect mark, in CSS this time.
 *
 * The image has to reconstruct this inside satori's subset; a browser simply
 * has `background-clip: text` and `transform: scaleX(-1)`, so this is the same
 * mark expressed the easy way. Kept visually identical to the card's — it is
 * the first thing a visitor matches against what they clicked.
 */
function ReflectMark() {
  return (
    <span dir="ltr" className="inline-flex items-center shrink-0">
      <span
        style={{
          fontSize: 34,
          fontWeight: 700,
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
          fontSize: 34,
          fontWeight: 700,
          lineHeight: 1,
          color: CARD_PALETTE.markReflection,
          transform: 'scaleX(-1)',
        }}
      >
        R
      </span>
      <span
        style={{ fontSize: 13, fontWeight: 700, letterSpacing: 4, color: INK, marginInlineStart: 14 }}
      >
        REFLECT
      </span>
    </span>
  );
}

/**
 * One label/value row inside the stats panel.
 *
 * `justify-content: space-between` under the page's own `dir="rtl"`, which
 * puts the label at the start (right) and the value at the end (left) — the
 * browser does here what the image has to do by hand with `row-reverse`.
 */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span style={{ fontSize: 15, color: MUTED }}>{label}</span>
      <Ltr style={{ fontSize: 18, fontWeight: 700, color: INK }}>{value}</Ltr>
    </div>
  );
}

/**
 * A discipline fraction, or the row withheld entirely.
 *
 * NULL RENDERS NOTHING RATHER THAN A ZERO. `behaviourDisciplineScore()` returns
 * null and never 0 when no row answered (disciplineAggregate.ts), and REF-125
 * §2.4 names the consequence of losing that distinction here: "rendering that
 * as '0/100 discipline' would be defamatory of the user's own day." The
 * builder already answers null; this is the half that does not print it.
 */
function FractionRow({ label, value }: { label: string; value: ShareFraction | null }) {
  if (value === null) return null;
  return (
    <Row
      label={label}
      value={
        <>
          {value.met}/{value.answered}
        </>
      }
    />
  );
}

/** The small secondary pair — on the page only, never on the card. */
function Detail({ label, amount }: { label: string; amount: number }) {
  return (
    <div
      className="flex-1 min-w-0 flex items-baseline justify-between gap-3 px-4 py-3 rounded-xl"
      style={{ background: PANEL, border: `1px solid ${HAIRLINE}` }}
    >
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      <Ltr style={{ fontSize: 15, fontWeight: 700, color: amount >= 0 ? GREEN : RED }}>
        {formatMoney(amount)}
      </Ltr>
    </div>
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
  const winRate =
    snapshot.trades > 0 ? `${Math.round((snapshot.wins / snapshot.trades) * 100)}%` : null;

  return (
    <div
      dir="rtl"
      className="w-full max-w-[1100px] mx-auto rounded-[28px] overflow-hidden relative"
      style={{
        backgroundColor: CARD_PALETTE.backdropFlat,
        backgroundImage: CARD_PALETTE.backdrop,
        border: `1px solid ${HAIRLINE}`,
      }}
    >
      {/* The dot grid. Real CSS can repeat a radial-gradient, so unlike the
          image this needs no tiled SVG. `pointer-events-none` because it is
          texture laid over the whole artefact. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.05) 1.6px, transparent 1.6px)',
          backgroundSize: '26px 26px',
        }}
      />
      {/* The single teal glow, behind the number it belongs to.
          PHYSICAL `left`, NOT `insetInlineStart`: this container is `dir="rtl"`
          so the logical start edge is the RIGHT one, and the logical property
          put the glow behind the stats panel instead of behind the money. The
          money column is pinned to the left here to match the image, so the
          light that belongs to it is pinned to the left too. */}
      <div
        aria-hidden="true"
        className="absolute pointer-events-none"
        style={{
          left: -200,
          top: -240,
          width: 760,
          height: 760,
          backgroundImage: CARD_PALETTE.glow,
        }}
      />

      <div className="relative flex flex-col gap-10 md:gap-14 p-6 md:p-12">
        {/* ── Mark, date, handle ──────────────────────────────────────────── */}
        {/* `flex-row-reverse` UNDER AN RTL CONTAINER, so the mark lands on the
            LEFT and the date on the right — matching the image rather than
            mirroring it.

            This container stays `dir="rtl"` because that is what makes every
            Hebrew string inside it lay out correctly for free, including
            `tradingDayLabel`, which mixes Hebrew with digits in one node and
            would reorder under an LTR base. Only the three STRUCTURAL rows are
            reversed. The image reaches the same arrangement from the other
            side — satori has an LTR base and no bidi, so it reverses rows to
            get the Hebrew right; this reverses rows to get the composition
            right. Imri's brief fixes the composition (mark left, date right,
            panel right), and a visitor who clicked a card has to arrive
            somewhere that looks like it. */}
        <div className="flex flex-row-reverse items-start justify-between gap-4 flex-wrap">
          <ReflectMark />
          <div className="flex flex-col items-end min-w-0">
            <h1 style={{ fontSize: 17, fontWeight: 700, color: INK, letterSpacing: '-0.01em' }}>
              {/* The row's column and not `snapshot.day`. They agree in every
                  row this build writes; if they ever disagree, the column is
                  the one the owner's dialog and the index are keyed on. */}
              {tradingDayLabel(tradingDay)}
            </h1>
            {/* The opt-in handle, and the only name this page can print.
                Absent unless the trader both set one and turned the toggle on
                — see buildDailyShareSnapshot, which applies the visibility
                itself. */}
            {snapshot.nickname !== null && (
              <span
                style={{ fontSize: 14, color: MUTED, marginTop: 4, overflowWrap: 'anywhere' }}
              >
                {snapshot.nickname}
              </span>
            )}
          </div>
        </div>

        {/* ── The day's money, and the panel ──────────────────────────────── */}
        {/* Stacked on a phone, two columns from `md` — the brief's "full width
            on desktop, stacked on mobile". `items-center` so the headline and
            the panel share a centre line whatever the panel contains, which is
            the same correction the image needed once a withheld fraction made
            the panel shorter. */}
        <div className="flex flex-col md:flex-row-reverse md:items-center gap-8 md:gap-12">
          {/* `text-align: left` inside an RTL container: the money column sits
              on the left of the artefact, as it does on the image, so its
              label and figure hang off the left edge rather than the right. */}
          <div className="flex-1 min-w-0" style={{ textAlign: 'left' }}>
            <p style={{ fontSize: 15, color: MUTED, marginBottom: 6 }}>תוצאת היום</p>
            <Ltr
              style={{
                // Fluid rather than fixed: a six-figure amount must not clip on
                // a narrow phone, and this card has no horizontal scroll to
                // fall back on.
                fontSize: 'clamp(40px, 9vw, 76px)',
                fontWeight: 700,
                lineHeight: 1.05,
                letterSpacing: '-0.03em',
                display: 'inline-block',
                // `—` when no counted trade recorded an amount. NOT `$0.00`: a
                // day whose trades carry no money figure is not a breakeven
                // day, and zero under a "Broker-synced" tag would be a claim we
                // cannot support. At this size a dash still reads as a dash,
                // which is why the page keeps it where the image — where the
                // figure is 112px and an em dash becomes a bar — spells it out.
                color: pnl === null ? MUTED : pnl >= 0 ? GREEN : RED,
              }}
            >
              {pnl === null ? '—' : formatMoney(pnl)}
            </Ltr>
          </div>

          <div
            className="w-full md:w-[380px] shrink-0 flex flex-col gap-4 p-5 md:p-6 rounded-2xl"
            style={{ background: PANEL, border: `1px solid ${HAIRLINE}` }}
          >
            <Row label="עסקאות סגורות" value={snapshot.trades} />
            {winRate !== null && <Row label="אחוז הצלחה" value={winRate} />}

            {(snapshot.followedPlan !== null || snapshot.stopHeld !== null) && (
              <>
                <div style={{ height: 1, background: HAIRLINE }} />
                <FractionRow label="עמד בתוכנית" value={snapshot.followedPlan} />
                {/* "לא הורחק" AND NOT "לא הוזז", which is the one piece of copy
                    on this page that departs from the ticket's wording,
                    deliberately. The counted predicate treats a TIGHTENING as
                    held — Imri's 19.10 decision, stopHistory.ts:46-57, "a
                    trader who moves a stop TOWARD the profit is managing risk,
                    not breaking discipline" — and a tightened stop WAS moved.
                    So "לא הוזז" over this number would be false on exactly the
                    trades the product decided to reward. "הורחק" is also the
                    vocabulary the journal already uses. */}
                <FractionRow label="הסטופ לא הורחק" value={snapshot.stopHeld} />
              </>
            )}
          </div>
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

        {/* ── Provenance, and the link out ────────────────────────────────── */}
        {/* Reversed for the same reason as the header: the image puts the
            provenance bottom-left and the link bottom-right. */}
        <div
          className="flex flex-row-reverse items-center justify-between gap-4 flex-wrap pt-6"
          style={{ borderTop: `1px solid ${HAIRLINE}` }}
        >
          {/* English in an RTL card, so it gets its own direction rather than
              being reordered into the Hebrew flow around it. An empty span
              holds the row when the day is manual and there is no claim. */}
          <span dir="ltr" style={{ fontSize: 12, color: MUTED, letterSpacing: '0.02em' }}>
            {note ?? ''}
          </span>
          {/* The only outbound link on the page. A plain <a> and not next/link:
              this is a route out of the app to the marketing apex, so there is
              nothing to prefetch and no client router to involve on a page that
              ships no other interactivity. */}
          <a
            href="https://reflecttrading.app"
            dir="ltr"
            style={{ fontSize: 13, fontWeight: 600, color: TEAL, textDecoration: 'none' }}
          >
            reflecttrading.app
          </a>
        </div>
      </div>
    </div>
  );
}
