/**
 * A shared trading day, as a stranger sees it (REF-125 Stage 2 item 4).
 *
 * A SERVER COMPONENT WITH NO INTERACTIVITY. No `'use client'`, no state, no
 * effect — it takes a validated snapshot and renders it. That is what lets the
 * public page be entirely server-rendered, which is the property the whole
 * design rests on: the browser never holds a Supabase client, so there is no
 * `anon` grant anywhere (migration 043).
 *
 * MOBILE FIRST AND NARROW ON PURPOSE. This is a link sent in WhatsApp and
 * opened on a phone, so the card is capped at a phone's content width and
 * centred rather than laid out across a desktop viewport.
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
import { shareProvenanceNote } from '@/lib/share/snapshot';
import type { DailyShareSnapshot, ShareFraction } from '@/lib/share/snapshot';
import { tradingDayLabel, type TradingDay } from '@/lib/tradingDay';

const SURFACE = 'var(--color-tg-surface)';
const SURFACE_2 = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT = 'var(--color-tg-text)';
const MUTED = 'var(--color-tg-muted)';
const GREEN = 'var(--color-tg-success)';
const RED = 'var(--color-tg-danger)';

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

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        padding: '10px 12px',
        borderRadius: 12,
        background: SURFACE_2,
        border: `1px solid ${BORDER}`,
      }}
    >
      <p style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>{label}</p>
      <p style={{ fontSize: 16, fontWeight: 700, color: TEXT }}>{children}</p>
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
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: 13, color: MUTED }}>{label}</span>
      <Ltr style={{ fontSize: 14, fontWeight: 700, color: TEXT }}>
        {value.met}/{value.answered}
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
  // The same function the dialog's preview calls, so a provenance claim cannot
  // differ between what the trader was shown and what the page prints. The
  // wording argument lives on that function.
  const note = shareProvenanceNote(snapshot.provenance);
  const pnl = snapshot.pnl;

  return (
    <div
      dir="rtl"
      style={{
        width: '100%',
        maxWidth: 440,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        borderRadius: 20,
        background: SURFACE,
        border: `1px solid ${BORDER}`,
      }}
    >
      {/* ── Who and when ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 15, fontWeight: 700, color: TEXT, letterSpacing: '-0.01em' }}>
          {/* The row's column and not `snapshot.day`. They agree in every row
              this build writes; if they ever disagree, the column is the one
              the owner's dialog and the index are keyed on. */}
          {tradingDayLabel(tradingDay)}
        </h1>
        {/* The opt-in handle, and the only name this page can print. Absent
            unless the trader both set one and turned the toggle on — see
            buildDailyShareSnapshot, which applies the visibility itself. */}
        {snapshot.nickname !== null && (
          <span style={{ fontSize: 13, color: MUTED, minWidth: 0, overflowWrap: 'anywhere' }}>
            {snapshot.nickname}
          </span>
        )}
      </div>

      {/* ── The day's money ───────────────────────────────────────────────── */}
      <div>
        <p style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>תוצאת היום</p>
        <Ltr
          style={{
            // Fluid rather than fixed: a six-figure amount must not clip on a
            // narrow phone, and this card has no horizontal scroll to fall back on.
            fontSize: 'clamp(28px, 11vw, 40px)',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            // `—` when no counted trade recorded an amount. NOT `$0.00`: a day
            // whose trades carry no money figure is not a breakeven day, and
            // zero under a "Broker-synced" tag would be a claim we cannot
            // support. `formatMoney` renders the same dash for a non-finite
            // input, so the two absences look alike by construction.
            color: pnl === null ? MUTED : pnl >= 0 ? GREEN : RED,
          }}
        >
          {pnl === null ? '—' : formatMoney(pnl)}
        </Ltr>
      </div>

      {/* ── Counts ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Stat label="עסקאות סגורות">
          <Ltr>{snapshot.trades}</Ltr>
        </Stat>
        <Stat label="מנצחות / מפסידות">
          <Ltr>
            {snapshot.wins}/{snapshot.losses}
          </Ltr>
        </Stat>
      </div>

      {/* ── Best and worst, money only ────────────────────────────────────── */}
      {snapshot.best !== null && snapshot.worst !== null && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Stat label="העסקה הטובה">
            <Ltr style={{ color: snapshot.best >= 0 ? GREEN : RED }}>
              {formatMoney(snapshot.best)}
            </Ltr>
          </Stat>
          <Stat label="העסקה החלשה">
            <Ltr style={{ color: snapshot.worst >= 0 ? GREEN : RED }}>
              {formatMoney(snapshot.worst)}
            </Ltr>
          </Stat>
        </div>
      )}

      {/* ── Discipline, as fractions ──────────────────────────────────────── */}
      {(snapshot.followedPlan !== null || snapshot.stopHeld !== null) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 12,
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          <FractionRow label="עמד בתוכנית" value={snapshot.followedPlan} />
          {/* "לא הורחק" AND NOT "לא הוזז", which is the one piece of copy on
              this page that departs from the ticket's wording, deliberately.
              The counted predicate treats a TIGHTENING as held — Imri's 19.10
              decision, stopHistory.ts:46-57, "a trader who moves a stop TOWARD
              the profit is managing risk, not breaking discipline" — and a
              tightened stop WAS moved. So "לא הוזז" over this number would be
              false on exactly the trades the product decided to reward.
              "הורחק" is also the vocabulary the journal already uses for it. */}
          <FractionRow label="הסטופ לא הורחק" value={snapshot.stopHeld} />
        </div>
      )}

      {/* ── Provenance ────────────────────────────────────────────────────── */}
      {note !== null && (
        <p
          // English in an RTL card, so it gets its own direction rather than
          // being reordered into the Hebrew flow around it.
          dir="ltr"
          style={{
            fontSize: 11,
            color: MUTED,
            letterSpacing: '0.02em',
            textAlign: 'left',
          }}
        >
          {note}
        </p>
      )}
    </div>
  );
}
