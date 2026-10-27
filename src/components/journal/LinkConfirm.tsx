'use client';

/**
 * The confirmation panel: which plan was this trade (REF-107 Stage 3b, §C).
 *
 * NOT A ROUTE, AND THAT IS THE DECISION §C ARGUED HARDEST FOR. `/trades/confirm`
 * would have been a place the trader has to remember to visit, and a queue
 * nobody looks at is a queue that never empties — the same failure §E16 names
 * for the journal as a whole. So the decision lives inside the detail modal the
 * trader already opens, directly under the `מקור` row, which Stage 2 put first
 * in that modal precisely because it changes how every row beneath it reads.
 *
 * The banner on /trades is the other half: it is what makes the trader open the
 * modal in the first place. Between them there is no new screen.
 *
 *
 * EVERY CANDIDATE IS COMPUTED IN THE BROWSER, FROM ROWS ALREADY ON THE PAGE
 * ------------------------------------------------------------------------
 *
 * /trades reads `select('*')` with a thousand-row limit, so the plans are
 * already here. lib/tradovate/match.ts is pure and browser-safe for exactly
 * this: the panel asks the SAME function the import asked, so it cannot offer a
 * candidate the import would have refused, and it costs no query.
 *
 *
 * WHAT IT WRITES, AND WHOSE IDENTITY IT WRITES AS
 * ----------------------------------------------
 *
 * The trader's own session, under the table's own RLS, like every other write
 * this component makes. Stage 3b does not touch the service role at all, which
 * is worth saying out loud because §C12 marks the service role as the central
 * risk of the integration. The one exception is `link_broker_trade`, and it is
 * `SECURITY DEFINER` only to get a transaction — it re-checks `auth.uid()`
 * against both rows in its body. lib/journal/link.ts holds both writes and the
 * guard against sending either of them twice.
 */

import { useState } from 'react';
import { AlertTriangle, Check, Link2, Lock, SkipForward, X } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import {
  confirmLink,
  declineLink,
  proposeFlags,
  proposeStopMoveFlag,
  type FlagProposal,
} from '@/lib/journal/link';
import { brokerStopToShow, readStopHistory } from '@/lib/journal/stopHistory';
import { planCandidates, type CandidatePlan } from '@/lib/tradovate/match';
import { formatMoney } from '@/lib/money';
import { timeOfDay } from '@/lib/datetime';

const GOLD = '#00d2d2';
const SURF2 = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT = 'var(--color-tg-text)';
const TEXT2 = 'var(--color-tg-text-2)';
const MUTED = 'var(--color-tg-muted)';
const RED = '#f87171';

/**
 * The queued broker row, and the plans it might belong to.
 *
 * Both are declared structurally rather than imported from JournalClient: the
 * panel needs eleven fields and the journal's own `Trade` has forty, and a
 * type-level import back into the component that renders this would be a cycle
 * for no gain.
 */
export interface QueuedBrokerRow {
  id: string;
  symbol: string | null;
  direction: 'long' | 'short' | null;
  entry_price: number;
  exit_price: number | null;
  quantity: number | null;
  /** The ENTRY instant on a broker row (§C10.6), which is what the match anchors on. */
  submitted_at: string;
  closed_at: string | null;
  actual_pnl: number | null;
  pnl_amount: number | null;
  status: string;

  // ── What the broker said about the stop (REF-113 Stage 5) ─────────────────
  //
  // Optional: the columns arrive with migration 038 and the journal reads
  // `select('*')`, so on a database without that file they are simply not
  // there. `readStopHistory` answers null for an absent key, the row below is
  // not rendered and the proposal is not offered — which is the panel exactly
  // as it was before this stage.

  /** The initial stop the broker reported. NOT a plan — see migration 038. */
  broker_stop_loss?: number | null;
  /** The evidence, as JSONB. Read only through `readStopHistory`. */
  stop_history?: unknown;
}

/** A plan as the panel reads it: the match's fields plus the intent it shows. */
export interface LinkablePlan extends CandidatePlan {
  strategy?: string | null;
  entry_price?: number;
  stop_loss?: number | null;
  take_profit?: number | null;
  rr_ratio?: number | null;
  trade_reason?: string | null;
  units?: number | null;
  quantity?: number | null;
}

// Pinned to the trader's zone (lib/datetime.ts): this sits beside a broker
// fill time, and the two disagreeing by the server's offset is the whole
// reason a trader would mis-match a plan to the wrong execution.
const timeOf = (iso: string | null): string => timeOfDay(iso) || '—';

const price = (value: number | null | undefined): string =>
  value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';

/** How long before the entry this plan was written, as a trader would say it. */
function distanceLabel(plan: LinkablePlan, openedAtMs: number): string {
  const submitted = Date.parse(String(plan.submitted_at ?? ''));
  if (!Number.isFinite(submitted)) return '—';
  const minutes = Math.round((openedAtMs - submitted) / 60000);
  if (minutes < 1) return 'רגע לפני הכניסה';
  if (minutes < 60) return `${minutes} דקות לפני הכניסה`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${hours} שעות לפני הכניסה`
    : `${hours} שעות ו-${rest} דקות לפני הכניסה`;
}

function Row({ label, value, locked, ltr }: {
  label: string;
  value: string;
  locked?: boolean;
  /**
   * Render the value left-to-right inside this right-to-left panel.
   *
   * FOR RANGES, AND ONLY FOR RANGES. `09:12 – 09:41` is bidirectional text:
   * the digits are strong LTR, the en dash is neutral, and the RTL paragraph
   * direction therefore resolves the neutral run to the right of the first
   * number — so the browser laid it out as `09:41 – 09:12` and the trade read
   * as though it had closed before it opened. The same class of problem the
   * charts solve by setting `dir="ltr"` on their containers (see CLAUDE.md),
   * and the same fix: scope the direction to the run that is genuinely LTR
   * rather than reorder the string.
   *
   * A single price or quantity needs nothing — one strong run has no
   * neighbour to be reordered against.
   */
  ltr?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-[11px] font-semibold shrink-0" style={{ color: MUTED }}>{label}</span>
      <span
        className="text-[11px] text-right"
        {...(ltr ? { dir: 'ltr' as const } : {})}
        style={{ color: locked ? TEXT2 : TEXT, wordBreak: 'break-word' }}
      >
        {value}
      </span>
    </div>
  );
}

export default function LinkConfirm({
  trade,
  plans,
  onResolved,
  onSkip,
}: {
  trade: QueuedBrokerRow;
  /** Every plan on the page. Narrowed here by the matcher, not by the caller. */
  plans: readonly LinkablePlan[];
  /**
   * The row left the queue. The caller refreshes and closes.
   *
   * `linked` carries the plan's id because the trade's row id CHANGES on a
   * link — the broker row is deleted and the plan keeps the trade — so a
   * caller holding the old id has nothing to re-open.
   */
  onResolved: (outcome: { kind: 'linked'; planId: string } | { kind: 'declined' }) => void;
  /**
   * דלג. Nothing was written and nothing is resolved.
   *
   * Separate from {@link onResolved} on purpose: the caller refreshes, closes
   * and triggers a debrief on a resolution, and skipping must do none of
   * those. The row stays in the queue and the banner keeps counting it, which
   * is the whole meaning of the button.
   */
  onSkip: () => void;
}) {
  const supabase = createClient();
  const openedAtMs = Date.parse(trade.submitted_at);

  // ONE CLOCK READ PER MOUNTED PANEL, and that is a correctness requirement
  // rather than a way round the purity rule. The candidate list is computed
  // during render; a clock read on every render could change it between one
  // render and the next, which means the plan under the trader's cursor could
  // move while they are reading it. A lazy initialiser reads it once, when the
  // panel opens, and the list is then fixed for as long as it is on screen.
  const [nowMs] = useState(() => Date.now());

  // The same call the import made, against the rows already on the page. A
  // direction is required by the matcher and a broker row always carries one;
  // `?? 'long'` is unreachable for an imported row and is here so the type is
  // honest rather than asserted.
  const candidates = planCandidates({
    trade: {
      openedAtMs,
      direction: trade.direction ?? 'long',
      symbol: trade.symbol,
    },
    plans,
    nowMs,
  }) as LinkablePlan[];

  const [chosenId, setChosenId] = useState<string | null>(candidates[0]?.id ?? null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'link' | 'decline' | null>(null);
  const [error, setError] = useState('');

  const chosen = candidates.find((plan) => plan.id === chosenId) ?? null;

  const facts = {
    direction: trade.direction,
    entry_price: trade.entry_price,
    exit_price: trade.exit_price,
    quantity: trade.quantity,
  };

  // The broker's stop, for the row beside the planned one. Suppressed for the
  // three cases `brokerStopToShow` names — no document, no stop placed, or an
  // order that cannot have been a protective stop. A `'wrong'` side is the one
  // worth having in mind here: on 19.10 a long stored an initial stop 148 ticks
  // ABOVE its entry, and this panel is precisely where that number would have
  // been printed next to the stop the trader typed.
  const stops = readStopHistory(trade.stop_history);
  const brokerStop = brokerStopToShow(stops, trade.broker_stop_loss);

  // APPENDED RATHER THAN RETURNED BY `proposeFlags`, so a panel with no
  // document renders the list it rendered before Stage 5. It does not need a
  // chosen plan — it is the broker's verdict about the broker's own orders —
  // but it is only offered WITH one, because the flags are written onto the
  // plan the trader is about to confirm and there is nothing to write them to
  // otherwise.
  const stopProposal = chosen ? proposeStopMoveFlag(trade.stop_history) : null;
  const proposals: FlagProposal[] = chosen
    ? [...proposeFlags(chosen, facts), ...(stopProposal ? [stopProposal] : [])]
    : [];

  async function handleLink() {
    if (!chosen) return;
    setBusy('link');
    setError('');

    // Only the boxes still checked, and an unchecked one is NOT written as
    // `false`. Disagreeing with our guess is not the same as telling us the
    // opposite, and all three columns are nullable: the readers that show
    // these figures already filter `!== null` before computing a percentage,
    // so leaving the column alone is how "the trader did not say" is stored.
    const flags: Partial<Record<FlagProposal['column'], boolean>> = {};
    for (const proposal of proposals) {
      if (!unchecked.has(proposal.column)) flags[proposal.column] = proposal.value;
    }

    const outcome = await confirmLink({
      client: supabase,
      brokerRowId: trade.id,
      planId: chosen.id,
      flags,
    });

    setBusy(null);
    if (!outcome.ok) {
      // `busy` means the trader pressed twice and the first press is still in
      // flight — not an error, and not worth a sentence that looks like one.
      if (outcome.reason === 'busy') return;
      setError('לא הצלחנו לשייך את העסקה. נסה שוב בעוד רגע.');
      return;
    }
    onResolved({ kind: 'linked', planId: chosen.id });
  }

  async function handleDecline() {
    setBusy('decline');
    setError('');
    const outcome = await declineLink({ client: supabase, brokerRowId: trade.id });
    setBusy(null);
    if (!outcome.ok) {
      if (outcome.reason === 'busy') return;
      setError('לא הצלחנו לעדכן את העסקה. נסה שוב בעוד רגע.');
      return;
    }
    onResolved({ kind: 'declined' });
  }

  const money = trade.actual_pnl ?? trade.pnl_amount;

  return (
    <div dir="rtl" className="flex flex-col gap-2 p-3 rounded-xl"
      style={{ background: SURF2, border: `1px solid ${BORDER}` }}>
      <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: TEXT }}>
        <Link2 aria-hidden="true" size={13} style={{ color: GOLD }} />
        לאיזו תוכנית שייכת העסקה הזאת?
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* The broker's facts. Locked, and said to be locked (E12): they are
            what was executed, the next sync would restate any edit anyway, and
            an edit that is quietly undone overnight is worse than one that was
            never offered. */}
        <div>
          <p className="text-[11px] font-semibold flex items-center gap-1 mb-1" style={{ color: MUTED }}>
            <Lock aria-hidden="true" size={11} /> עובדות הברוקר
          </p>
          <Row label="נכס" value={trade.symbol ?? '—'} locked />
          <Row label="כיוון" value={trade.direction === 'short' ? 'שורט' : 'לונג'} locked />
          <Row label="כניסה" value={price(trade.entry_price)} locked />
          <Row label="יציאה" value={price(trade.exit_price)} locked />
          <Row label="כמות" value={trade.quantity != null ? String(trade.quantity) : '—'} locked />
          <Row label="שעות" value={`${timeOf(trade.submitted_at)} – ${timeOf(trade.closed_at)}`} locked ltr />
          <Row label="תוצאה" value={money != null ? formatMoney(Number(money)) : '—'} locked />
          {/* THE BROKER'S STOP, ON THE BROKER'S SIDE OF THE PANEL, so that it
              reads across from `סטופ` in the plan rather than inside it
              (REF-113 Stage 5). It is a fact about what was held, like every
              other row in this column, and nothing scores it — which is the
              whole reason migration 038 added its own column instead of filling
              the trader's `stop_loss`. Absent entirely when there is no
              document, rather than a locked dash on every trade. */}
          {brokerStop !== null && <Row label="סטופ בברוקר" value={price(brokerStop)} locked />}
        </div>

        {/* The intent, from the plan under consideration. */}
        <div>
          <p className="text-[11px] font-semibold mb-1" style={{ color: MUTED }}>
            {chosen ? 'התוכנית שתיעדת' : 'לא נמצאה תוכנית תואמת'}
          </p>
          {chosen ? (
            <>
              <Row label="אסטרטגיה" value={chosen.strategy ?? '—'} />
              <Row label="כניסה מתוכננת" value={price(chosen.entry_price)} />
              <Row label="סטופ" value={price(chosen.stop_loss)} />
              <Row label="יעד" value={price(chosen.take_profit)} />
              <Row label="יחס R:R" value={chosen.rr_ratio != null ? String(chosen.rr_ratio) : '—'} />
              <Row label="סיבת כניסה" value={chosen.trade_reason ?? '—'} />
              <Row label="נכתבה" value={distanceLabel(chosen, openedAtMs)} />
            </>
          ) : (
            <p className="text-[11px] leading-relaxed" style={{ color: TEXT2 }}>
              אין תוכנית פתוחה שנכתבה לפני הכניסה ותואמת את העסקה. אם לא תוכננה — סמן זאת, והיא תצא מרשימת ההמתנה.
            </p>
          )}
        </div>
      </div>

      {/* More than one plan could be it, so the trader chooses. Nearest in time
          first (lib/tradovate/match.ts), because that is the one they are most
          likely to mean — but it is never picked for them: §F1 names a wrong
          automatic link as the central risk of this stage. */}
      {candidates.length > 1 && (
        <fieldset className="flex flex-col gap-1 pt-1">
          <legend className="text-[11px] font-semibold mb-1" style={{ color: MUTED }}>
            {candidates.length} תוכניות אפשריות
          </legend>
          {candidates.map((plan) => (
            <label key={plan.id} className="flex items-center gap-2 text-[11px] cursor-pointer"
              style={{ color: plan.id === chosenId ? TEXT : TEXT2 }}>
              <input
                type="radio"
                name={`candidate-${trade.id}`}
                checked={plan.id === chosenId}
                onChange={() => { setChosenId(plan.id); setUnchecked(new Set()); }}
                style={{ accentColor: GOLD }}
              />
              <span>{plan.strategy ?? '—'} · {distanceLabel(plan, openedAtMs)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {/* The proposed flags. Checked, with the comparison beside each one —
          §E's decision, and the reason it is a proposal: most of them are
          judgements, and the trader is the one who gets to make them.

          THE CHECKBOX MEANS "WRITE THIS", NOT "YES", AND IT USED TO BE READ THE
          OTHER WAY. Every proposal arrives checked — including one whose value
          is `false` — so `יציאה מוקדמת: לא` rendered beside a ticked turquoise
          box, and a turquoise tick in this product means yes. A trader scanning
          the panel read "yes, I exited early" off a row that says the opposite.
          The value now carries its OWN icon: a check for כן, an × for לא, in
          the colour each of those deserves. The box keeps its one job, which is
          agreeing or disagreeing with us. */}
      {proposals.length > 0 && (
        <fieldset className="flex flex-col gap-1.5 pt-1 border-t" style={{ borderColor: BORDER }}>
          <legend className="text-[11px] font-semibold mb-1" style={{ color: MUTED }}>
            מה שחישבנו מההשוואה
          </legend>
          {proposals.map((proposal) => {
            // A warning is the proposed value costing the trader something — a
            // stop widened mid-trade, today. It colours the VALUE and not the
            // label, because what is being flagged is the answer.
            const warn = proposal.tone === 'warning';
            const valueColor = warn ? RED : proposal.value ? GOLD : MUTED;
            const ValueIcon = proposal.value ? Check : X;
            return (
              <label key={proposal.column} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!unchecked.has(proposal.column)}
                  onChange={() => setUnchecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(proposal.column)) next.delete(proposal.column);
                    else next.add(proposal.column);
                    return next;
                  })}
                  style={{ accentColor: GOLD, marginTop: 2 }}
                />
                <span className="flex flex-col">
                  <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: TEXT }}>
                    {proposal.label}:
                    <ValueIcon aria-hidden="true" size={12} style={{ color: valueColor }} />
                    <span style={{ color: valueColor }}>{proposal.value ? 'כן' : 'לא'}</span>
                    {warn && <AlertTriangle aria-hidden="true" size={11} style={{ color: RED }} />}
                  </span>
                  <span className="text-[10px]" style={{ color: warn ? RED : MUTED }}>{proposal.reason}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {error && <p className="text-[11px]" style={{ color: RED }}>{error}</p>}

      <div className="flex flex-wrap gap-2 pt-1">
        {chosen && (
          <button
            type="button"
            onClick={handleLink}
            disabled={busy !== null}
            className="flex-1 min-w-[120px] py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all hover:opacity-80 disabled:opacity-50"
            style={{ background: 'rgba(0,210,210,0.18)', color: GOLD, border: `1px solid rgba(0,210,210,0.35)` }}>
            <Check aria-hidden="true" size={13} />
            {busy === 'link' ? 'משייך...' : 'זו העסקה הזו'}
          </button>
        )}
        <button
          type="button"
          onClick={handleDecline}
          disabled={busy !== null}
          className="flex-1 min-w-[100px] py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: SURF2, color: TEXT2, border: `1px solid ${BORDER}` }}>
          {busy === 'decline' ? 'מעדכן...' : 'לא תוכננה'}
        </button>
        {/* Doing nothing is a first-class answer, and it has to look like one:
            the row stays in the queue and the banner keeps counting it. */}
        <button
          type="button"
          onClick={onSkip}
          disabled={busy !== null}
          className="py-2 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: 'transparent', color: MUTED }}>
          <SkipForward aria-hidden="true" size={13} /> דלג
        </button>
      </div>
    </div>
  );
}
