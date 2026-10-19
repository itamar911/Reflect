'use client';

import { Fragment, useState, useMemo, useId, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Bot, Eye, Inbox, MoreHorizontal, Pencil, Trash2, Unlink, X } from 'lucide-react';
import CloseTrade, { AIDebriefView, type AIDebriefResult } from '@/components/journal/CloseTrade';
import LinkConfirm from '@/components/journal/LinkConfirm';
import { readStoredDebrief } from '@/lib/journal/debrief';
import {
  deleteWarningText,
  isQueuedBrokerRow,
  LINK_STATE_COPY,
  linkState,
  queueBannerText,
  UNLINK_WARNING,
  unlinkPlan,
} from '@/lib/journal/link';
import {
  brokerStopToShow,
  readStopHistory,
  stopMoveSentence,
} from '@/lib/journal/stopHistory';
import { startOfTodayIso } from '@/lib/rules/tradeRuleContext';
import { DAY_START_PARAM, MAX_SINCE_AGE_MS, SINCE_PARAM } from '@/lib/tradovate/trading-day';
import EmotionalStateSlider from '@/components/trade/EmotionalStateSlider';
import { createClient } from '@/lib/supabase/client';
import { formatPnlPoints, calcRR } from '@/lib/utils';
import { formatMoney, TRADING_CURRENCY } from '@/lib/money';
import { tradeMoneyPnl, hasMoneyPnl, isWinningTrade, tradeDirection, tradePointsPnl } from '@/lib/pnl';
import { isTradeTaken, NOT_ENTERED, NOT_ENTERED_LABEL, tradeStatusLabel } from '@/lib/trades/status';
import { useHydrated } from '@/lib/hooks';
import { useModalDialog } from '@/lib/a11y/useModalDialog';
import './journal.css';

// ── Design tokens ─────────────────────────────────────────────────────────────
const GOLD   = '#00d2d2';
const AMBER  = '#f59e0b';
const SURF   = 'var(--color-tg-surface)';
const SURF2  = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';
const MUTED  = 'var(--color-tg-muted)';
const GREEN  = '#4ade80';
const RED    = '#f87171';

// ── Shared form field styling (edit modal) ─────────────────────────────────────
const FIELD_CLASS = 'w-full px-3 py-2 rounded-xl text-sm border outline-none focus:border-tg-primary transition-colors';
const fieldStyle = { background: SURF2, borderColor: BORDER, color: TEXT };
/**
 * A field holding a fact the trader may read and not change (REF-107 E12).
 *
 * Dimmed text on the same surface rather than a different one: the value is
 * real and is worth reading, so it should not look like an empty box. `disabled`
 * on the input is what actually prevents the edit; this is what says so.
 */
const lockedStyle = { background: SURF2, borderColor: BORDER, color: TEXT2, cursor: 'not-allowed' };

// ── Types ─────────────────────────────────────────────────────────────────────
// Every intent column is nullable here (REF-107 stage 4). They are NOT NULL in
// the schema today and the form always fills them, so nothing in the app
// produces such a row yet — but typing them as present is what let `.toFixed()`
// and `String(...)` be written against values a broker row will not carry, and
// those are the call sites that have to be found before stage 2, not after.
interface Trade {
  id: string;
  strategy: string | null;
  symbol: string | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  emotional_state: number | null;
  trade_reason: string | null;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  debrief_answer: string | null;
  submitted_at: string;
  closed_at: string | null;
  plan_score: number | null;
  quantity: number | null;
  units: number | null;
  point_value: number | null;
  direction: 'long' | 'short' | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  pnl_currency: string | null;
  has_rule_violation?: boolean;

  // ── Provenance (REF-107 Stage 2) ──────────────────────────────────────────
  //
  // Optional because the columns arrive with migration 034, which is run by
  // hand: before it, `select('*')` returns rows without these keys. The page
  // normalises them, so what reaches here is `null`/`false` on such a database
  // — which is the truth about every row in it.

  /** 'manual' or 'tradovate'. Null on a database without migration 034. */
  source?: string | null;
  /** A trade that reached the journal with no plan behind it (032, E2). */
  unplanned?: boolean;
  /** Which Tradovate host reported it. Shown nowhere; carried for the badge's title. */
  broker_host?: string | null;
  /** The trader deleted it. Rows that carry `true` never reach this component. */
  hidden?: boolean;

  // ── The stored AI debrief (REF-107 Stage 3a) ──────────────────────────────
  //
  // Optional for the same reason as the four above: the columns arrive with
  // migration 036. Before it, `select('*')` returns rows without these keys
  // and the modal behaves exactly as it did — the debrief is fetched on
  // demand and lost on refresh, which is the bug Stage 3a fixes rather than
  // a state this type needs to forbid.

  /** The four paragraphs, as stored. Read through `readStoredDebrief`. */
  debrief_ai?: unknown;
  /** When they were written. Null means no debrief has ever been generated. */
  debrief_generated_at?: string | null;

  // ── The link bookkeeping (REF-107 Stage 3b) ───────────────────────────────
  //
  // Optional for the third time and for the third identical reason: the
  // columns arrive with migration 035. `linkState` in lib/journal/link.ts
  // reads an absent `link_confirmed_at` on an unplanned broker row as
  // "waiting to be assigned", which is what such a row is.

  /** When the trader (or the matcher) decided. Null means the queue. */
  link_confirmed_at?: string | null;
  /** 'auto', 'confirmed' or 'declined'. Who decided, for an audit of §F1. */
  link_method?: string | null;

  // ── What the broker said about the stop (REF-113 Stage 5) ─────────────────
  //
  // Optional for the FOURTH time and the fourth identical reason: the columns
  // arrive with migration 038, and `select('*')` on a database without it
  // returns no key at all. `readStopHistory` answers null for a missing key, so
  // the modal shows nothing — which is the truth about every row on such a
  // database and about every row that existed before Stage 3 wrote one.
  //
  // THERE IS NO `withHidden`-STYLE GATE HERE AND NONE IS NEEDED, which is worth
  // saying because migration 038's own header warns about exactly this: a
  // component that NAMES `stop_history` in a `select` takes the journal's row
  // list down on a deployment where that file has not run. app/(app)/trades
  // reads `select('*')`, so the columns arrive for free or not at all.

  /** The initial stop the broker reported. NOT scored — see migration 038. */
  broker_stop_loss?: number | null;
  /** The target nearest the entry, as the broker reported it. */
  broker_take_profit?: number | null;
  /** The evidence, as JSONB. Read only through `readStopHistory`. */
  stop_history?: unknown;
}

/**
 * Whether this row came from a broker rather than from the trade form.
 *
 * One predicate, because four things branch on it: the badge, the gross-P&L
 * note, which fields the edit modal locks, and whether "delete" hides or
 * deletes. `source === 'tradovate'` rather than `broker_trade_key != null`,
 * because `source` is the column the product principle is stated in — every
 * trade records its source — and Stage 6 adds a second broker to it.
 */
function isBrokerRow(t: Trade): boolean {
  return t.source === 'tradovate';
}

/**
 * The debrief already written for this row, as the view expects it, or null.
 *
 * Only the four paragraphs and the score are reconstructed here. The
 * breakdown and the corrected flags are NOT — they are derived, the route
 * recomputes them on every request, and inventing empty ones would render a
 * score with an explanation panel that says nothing. Opening the panel on a
 * row that has a stored debrief shows the prose and the score immediately;
 * pressing "נתח מחדש" fetches the full shape.
 */
function storedDebriefResult(t: Trade): AIDebriefResult | null {
  const stored = readStoredDebrief(t.debrief_ai);
  if (!stored || !t.debrief_generated_at) return null;
  return {
    ...stored,
    score: t.plan_score ?? undefined,
    generatedAt: t.debrief_generated_at,
    stored: true,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Direction and points P&L both go through the shared helpers so this page
// cannot drift from the stats page or the dashboard.
const inferDirection = tradeDirection;
const calcPnl = tradePointsPnl;

/** A price as a fixed-2 string, or "—" when the row does not carry it. */
function fmtPriceCell(v: number | null): string {
  return v != null ? v.toFixed(2) : '—';
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

function fmtPnl(v: number) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

// Thousands separators, no trailing .00 on whole numbers (29,450 not 29450.00)
const PRICE_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
function fmtPrice(v: number) {
  return PRICE_FMT.format(v);
}

const PAGE_SIZES = [15, 30, 50, 100];

/**
 * How many owed debriefs one page load will ask for. See the sweep below.
 *
 * Three, because this spends money from a render: at roughly $0.008 a debrief
 * (§D) the worst load costs two cents, and a fourth row simply waits for the
 * next one. The number is here rather than inline because it is the knob
 * somebody will want to turn, and because the reason for its value is the
 * reason it exists at all.
 */
const AUTO_DEBRIEF_PER_LOAD = 3;

/**
 * Ask the server to re-pull the last week, and ignore the answer.
 *
 * ONE CALLER: the unlink. Clearing a trade's key means the next sync imports
 * it afresh, and "the next sync" would otherwise be the cron at 03:30 — a
 * trader who presses בטל שיוך needs the trade back in the queue now, so they
 * can give it to the plan they actually meant.
 *
 * THE WEEK-LONG WINDOW, not the day's, and that is the point of not reusing
 * the automatic trigger's parameters: the trade being released may have closed
 * days ago, and `dayStart` alone would not reach back far enough to re-import
 * it. These are the same two parameters BrokerSyncButton sends on the trigger
 * the trader pressed, for the same reason — §A2 found the pull costs the same
 * for any window and only PRICING grows, so "bring me everything you can"
 * belongs on a deliberate action.
 *
 * At module scope rather than inside the component, because it reads the
 * clock: a clock read during a render is what React's purity rule forbids, and
 * although this only ever runs from a click, the rule cannot see that — and a
 * suppression comment would be the wrong answer to a rule that is right in
 * general. BrokerSyncButton's own `requestSync` sits at module scope for the
 * same reason.
 *
 * Never throws. The unlink has already happened by the time this is called.
 */
async function requestWideSync(): Promise<void> {
  const params = new URLSearchParams({
    [DAY_START_PARAM]: startOfTodayIso(),
    [SINCE_PARAM]: new Date(Date.now() - MAX_SINCE_AGE_MS).toISOString(),
  });
  try {
    await fetch(`/api/tradovate/sync?${params}`, { method: 'POST', cache: 'no-store' });
  } catch {
    // Offline, refused or timed out. The unlink stands either way, and the
    // trade returns on the next sync — page entry or the cron.
  }
}

/**
 * Accessible name for a row's open-detail control.
 *
 * The symbol leads, so the button's visible text is a prefix of its name;
 * everything after it is only what actually tells one row from another —
 * the same asset can be traded twice in a day, in both directions, with
 * opposite outcomes, so direction, date and result all earn their place.
 *
 * Deliberately shorter than the visible row: the money figure is rounded
 * (a screen reader saying "point zero zero" 30 times is noise) and the
 * outcome is the word רווח/הפסד rather than a +/− glyph, which is read
 * inconsistently at default punctuation levels. `formatPnlPoints` is not
 * reused here for exactly that reason — it drops the sign entirely, so a
 * loss and a win of the same size are indistinguishable in speech.
 */
function rowAccessibleName(t: Trade): string {
  const title = t.symbol ?? t.strategy;
  const dir   = inferDirection(t) === 'long' ? 'לונג' : 'שורט';

  // A plan never entered has no outcome to read out, so the name stops at what
  // it is and when it was planned — and says so in the same words as the chip,
  // rather than letting the "פתוחה" branch below describe it as still live.
  if (t.status === NOT_ENTERED) {
    return `${title}, ${dir}, ${NOT_ENTERED_LABEL}, ${fmtDate(t.submitted_at)}`;
  }
  if (t.status !== 'closed') return `${title}, ${dir}, פתוחה, ${fmtDate(t.submitted_at)}`;

  const win  = isWinningTrade(t);
  const date = fmtDate(t.closed_at ?? t.submitted_at);
  // Closed with no exit price recorded — the row shows סגור and no P&L.
  if (win === null) return `${title}, ${dir}, סגורה, ${date}`;

  const amount = hasMoneyPnl(t)
    ? formatMoney(tradeMoneyPnl(t), { decimals: 0, sign: 'none' })
    : `${Math.round(Math.abs(calcPnl(t) ?? 0))} נקודות`;
  return `${title}, ${dir}, ${date}, ${win ? 'רווח' : 'הפסד'} ${amount}`;
}

// ── Mobile trade card (shown instead of table on small screens) ───────────────
function MobileTradeCard({ t, onView, onEdit, onDelete, onClose, onDebrief, hasDebrief }: {
  t: Trade;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  onDebrief: () => void;
  hasDebrief: boolean;
}) {
  const pnl = calcPnl(t);
  const dir = inferDirection(t);
  const isClosed = t.status === 'closed';

  const menuItems: KebabItem[] = [
    { label: 'צפייה', icon: <Eye aria-hidden="true" size={13} />, onClick: onView },
    { label: 'עריכה', icon: <Pencil aria-hidden="true" size={13} />, onClick: onEdit },
    ...(t.status === 'open' ? [{ label: 'סגור עסקה', icon: <X aria-hidden="true" size={13} />, onClick: onClose }] : []),
    ...(hasDebrief ? [{ label: 'ניתוח AI', icon: <Bot aria-hidden="true" size={13} />, color: GOLD, onClick: onDebrief }] : []),
    { label: 'מחיקה', icon: <Trash2 aria-hidden="true" size={13} />, color: RED, onClick: onDelete },
  ];

  return (
    <div
      // Same focus hand-off as the desktop row — see the <tr> handler below.
      onClick={e => {
        e.currentTarget.querySelector<HTMLElement>('.jr-row-open')?.focus();
        onView();
      }}
      style={{ background: SURF, border: `1px solid ${BORDER}`, borderRadius: 14, cursor: 'pointer' }}
    >
      <div className="p-3 flex flex-col gap-2.5">
        {/* Row 1: asset + status + kebab */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* The card's keyboard control. The card <div> keeps its own click
                handler for the mouse; this button is the only thing added. */}
            <button type="button"
              onClick={e => { e.stopPropagation(); onView(); }}
              aria-label={rowAccessibleName(t)}
              aria-haspopup="dialog"
              className="jr-row-open flex items-center gap-1.5 min-w-0">
              <AssetDot symbol={t.symbol} />
              <span className="font-semibold truncate" style={{ fontSize: 16, color: TEXT }}>
                {t.symbol ?? t.strategy}
              </span>
            </button>
            <Chip
              bg={dir === 'long' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)'}
              color={dir === 'long' ? GREEN : RED}>
              {dir === 'long' ? 'לונג' : 'שורט'}
            </Chip>
            <ProvenanceChips t={t} />
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <RowStatusChip t={t} />
            <KebabMenu items={menuItems} />
          </div>
        </div>

        {/* Row 2: date + score | P&L */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>{fmtDate(t.submitted_at)}</span>
            {isClosed && <ScoreRing score={t.plan_score} size={30} />}
            {t.has_rule_violation && (
              <span title="חוק הופר" className="flex items-center">
                <AlertTriangle role="img" aria-label="חוק הופר" size={14} color={AMBER} />
              </span>
            )}
          </div>
          {pnl !== null ? (
            hasMoneyPnl(t) ? (
              <span className="flex items-baseline gap-1.5">
                <span className="jr-num" style={{ fontSize: 16, fontWeight: 700, color: tradeMoneyPnl(t) >= 0 ? GREEN : RED }}>
                  {formatMoney(tradeMoneyPnl(t))}
                </span>
                <span className="jr-num" style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>
                  {formatPnlPoints(pnl)}
                </span>
                {/* E11, beside the figure it qualifies. See GrossPnlNote. */}
                {isBrokerRow(t) && <GrossPnlNote />}
              </span>
            ) : (
              <span className="jr-num" style={{ fontSize: 16, fontWeight: 700, color: pnl >= 0 ? GREEN : RED }}>
                {fmtPnl(pnl)}
              </span>
            )
          ) : t.status === NOT_ENTERED ? (
            // No P&L, and never will be — an em dash, like the desktop row's
            // P&L cell, rather than "פתוח", which would contradict the chip
            // immediately above it.
            <span style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>—</span>
          ) : (
            <span style={{ fontSize: 13, color: GOLD, fontWeight: 600 }}>פתוח</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function JournalClient({
  trades: initialTrades,
  queueCount = 0,
}: {
  trades: Trade[];
  /**
   * How many imported trades are waiting to be assigned to a plan.
   *
   * Derived on the server (trades/page.tsx) so the number is a fact about the
   * render that produced the list, not about this component's local state —
   * which lags by one write after a decline. Defaulted so the prop is additive
   * for anything that renders this without it.
   */
  queueCount?: number;
}) {
  const [trades,       setTrades]       = useState<Trade[]>(initialTrades);
  const [search,       setSearch]       = useState('');
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('desc');
  const [pageSize,     setPageSize]     = useState(30);
  const [page,         setPage]         = useState(1);
  const [showActions,  setShowActions]  = useState(false);
  const [showFilter,   setShowFilter]   = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'closed'>('all');
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [viewTradeId, setViewTradeId] = useState<string | null>(null);
  const [debriefResults, setDebriefResults] = useState<Record<string, AIDebriefResult>>({});
  const [viewDebriefId, setViewDebriefId] = useState<string | null>(null);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  // The unlink confirm, built the same way as the delete one and at the same
  // level: the dialog lives at the root rather than inside the detail modal,
  // so both reversible-but-consequential actions get the same shape and the
  // same focus rule.
  const [unlinkingTradeId, setUnlinkingTradeId] = useState<string | null>(null);
  const [unlinkLoading, setUnlinkLoading] = useState(false);
  const [unlinkError, setUnlinkError] = useState('');
  // Ids for the modal titles below, so each dialog's accessible name comes
  // from the heading the user can already see.
  const uid = useId();
  // Destructive confirm — focus lands on ביטול, never on מחק עסקה.
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const unlinkCancelRef = useRef<HTMLButtonElement>(null);
  // Task-shaped close-trade dialog — focus its first field, the exit price.
  const closeExitPriceRef = useRef<HTMLInputElement>(null);
  // Row open-buttons by trade id, so focus can be placed on a *neighbouring*
  // row after a delete. useModalDialog restores to whatever opened the dialog,
  // which for a delete is the row's ⋯ button — a node that no longer exists
  // once the row is gone, so the hook falls back to #main-content. Correct as
  // a default, but the neighbouring row is the better landing spot here.
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusAfterDeleteRef = useRef<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  // ── Stats ──────────────────────────────────────────────────────────────────
  // This page is the only one that loads 'not_entered' rows (see trades/page.tsx),
  // so it is the only one that has to subtract them from its own figures. Every
  // stat below except "סה״כ עסקאות" is derived from `closed` and excludes them
  // already; that one counted every row it was given.
  const taken = useMemo(() => trades.filter(isTradeTaken), [trades]);
  const closed = useMemo(() =>
    trades.filter(t => t.status === 'closed' && t.exit_price != null), [trades]);
  const pnls        = useMemo(() => closed.map(t => calcPnl(t)!), [closed]);
  const totalPnl    = pnls.reduce((s, p) => s + p, 0); // points fallback when no money data
  // Money aggregates via tradeMoneyPnl (actual_pnl ?? pnl_amount) — same logic as
  // the stats page, so both pages show identical totals and profit factor.
  const winRate     = closed.length > 0
    ? Math.round(closed.filter(t => isWinningTrade(t)).length / closed.length * 100) : 0;
  const moneyClosed = useMemo(() => closed.filter(hasMoneyPnl), [closed]);
  const grossProfit = moneyClosed.filter(t => tradeMoneyPnl(t) > 0).reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const grossLoss   = Math.abs(moneyClosed.filter(t => tradeMoneyPnl(t) < 0).reduce((s, t) => s + tradeMoneyPnl(t), 0));
  const pfNum       = grossLoss > 0 ? grossProfit / grossLoss : null;
  const pfStr       = pfNum !== null ? pfNum.toFixed(2) : grossProfit > 0 ? '∞' : '—';

  // REF-99: this used to collect the set of currencies across the closed
  // trades and fall back to ₪ whenever there was more than one — AFTER having
  // already summed the amounts together. One currency now, so the total is in
  // the currency it claims to be in.
  const totalPnlAmount    = moneyClosed.reduce((s, t) => s + tradeMoneyPnl(t), 0);
  const hasPnlAmount      = moneyClosed.length > 0;

  // ── Filtered + sorted ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = trades;
    // No filter is added for 'not_entered' (REF-82 §5.2): it appears under
    // "הכל" and nowhere else. This needs no code — the comparison is an exact
    // match, so "פתוחות" and "סגורות" exclude it on their own. Keep it that
    // way; `filterStatus` is its own literal union for exactly this reason.
    if (filterStatus !== 'all') r = r.filter(t => t.status === filterStatus);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(t =>
        t.symbol?.toLowerCase().includes(q) || !!t.strategy?.toLowerCase().includes(q)
      );
    }
    return [...r].sort((a, b) => {
      const da = new Date(a.closed_at ?? a.submitted_at).getTime();
      const db = new Date(b.closed_at ?? b.submitted_at).getTime();
      return sortDir === 'desc' ? db - da : da - db;
    });
  }, [trades, search, filterStatus, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageStart  = (page - 1) * pageSize;
  const pageTrades = filtered.slice(pageStart, pageStart + pageSize);

  // ── Selection ─────────────────────────────────────────────────────────────
  const allOnPage = pageTrades.length > 0 && pageTrades.every(t => selected.has(t.id));
  function toggleAll() {
    setSelected(prev => {
      const n = new Set(prev);
      if (allOnPage) pageTrades.forEach(t => n.delete(t.id));
      else pageTrades.forEach(t => n.add(t.id));
      return n;
    });
  }
  function toggleOne(id: string) {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // ── Delete / edit ─────────────────────────────────────────────────────────
  /**
   * Delete a row — or, on a broker row, hide it (REF-107 E12).
   *
   * A DELETE DOES NOT STICK ON AN IMPORTED ROW. The import is idempotent by
   * `broker_trade_key`, so a row the trader deleted is a key the next sync does
   * not find, and it inserts it again — that evening, or the next morning from
   * the cron. The partial UNIQUE in migration 034 prevents a DUPLICATE; it has
   * no memory of a deletion. So the trader's intent is recorded as a flag the
   * import can read, and it skips a hidden key rather than resurrecting it.
   *
   * The UI is identical either way: the row leaves the list, the neighbour takes
   * focus, every reader filters it (lib/trades/visible.ts). What differs is that
   * the broker row is still in the table, which is also the only way "delete"
   * can mean anything here.
   *
   * A MANUAL ROW IS STILL A REAL DELETE. There is nothing to protect it from,
   * the trader created it, and leaving a soft-deleted row behind would be
   * keeping data they asked us to remove.
   */
  async function handleDeleteTrade(id: string) {
    setDeleteLoading(true);
    setDeleteError('');
    const target = trades.find(t => t.id === id);
    const { error } = target && isBrokerRow(target)
      ? await supabase.from('trade_plans').update({ hidden: true }).eq('id', id)
      : await supabase.from('trade_plans').delete().eq('id', id);
    if (error) {
      setDeleteError('שגיאה במחיקה — נסה שוב');
      setDeleteLoading(false);
      return;
    }
    // Read the neighbour off the *current* page before the row disappears:
    // the row below, or the row above when the deleted one was last.
    const i = pageTrades.findIndex(t => t.id === id);
    focusAfterDeleteRef.current = pageTrades[i + 1]?.id ?? pageTrades[i - 1]?.id ?? null;
    setTrades(prev => prev.filter(t => t.id !== id));
    setSelected(prev => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setDeleteLoading(false);
    setDeletingTradeId(null);
    router.refresh();
  }

  // Keyed on `trades` so it runs in the same commit that removes the row.
  // React flushes every passive-effect *cleanup* before any passive effect,
  // so the confirm dialog's restore-to-#main-content has already happened by
  // the time this runs, and this wins. The ref is empty on an edit, and when
  // the deleted row was the only one left there is no neighbour — both cases
  // fall through to the hook's own fallback rather than guessing.
  useEffect(() => {
    const id = focusAfterDeleteRef.current;
    if (!id) return;
    focusAfterDeleteRef.current = null;
    rowRefs.current[id]?.focus();
  }, [trades]);

  /**
   * Ask for the debrief of a row that has just been decided about.
   *
   * ONLY THE ID IS SENT. The route re-reads the authoritative row for the
   * score and the prompt — it has done since Stage 3a — so a payload built
   * here would be ignored for everything except `id`, and sending the
   * client's idea of the row would be the one way to make the two disagree.
   *
   * FIRE AND FORGET, deliberately. The modal is closing and, on a link, the
   * row's id has changed under it, so there is nothing left on screen to put
   * the answer into. The route STORES it (Stage 3a), so it is there the next
   * time the trader opens the row, and the dedupe gate means this request is
   * the only one that will ever be paid for.
   */
  function requestDebrief(tradeId: string) {
    const body = new FormData();
    body.append('trade', JSON.stringify({ id: tradeId }));
    void fetch('/api/ai-debrief', { method: 'POST', body }).catch(() => {
      // The sweep below picks it up on the next load. A failed coaching note
      // is not something to interrupt the trader about.
    });
  }

  /**
   * Undo a link: the plan goes back to being a plan, the trade comes back.
   *
   * TWO STEPS, AND THE SECOND ONE IS WHY THIS IS NOT JUST AN UPDATE. Clearing
   * the key means the next sync does not find the trade in the table and
   * imports it afresh — but "the next sync" could be the cron, tomorrow at
   * 03:30. A trader who presses this needs the trade back NOW, in the queue,
   * so they can assign it to the plan they actually meant. So the write is
   * followed by a sync request, with the week-long window the explicit sync
   * button uses: the released trade may have closed days ago, and the narrow
   * day window would not reach it.
   *
   * THE SYNC IS ALLOWED TO FAIL AND THE UNLINK STILL STANDS. The plan is
   * already back to being a plan, which is the half the trader asked for; the
   * trade returning is the half the next sync will do anyway, on page entry or
   * from the cron. Reporting a failure here would say "the unlink did not
   * work" about an unlink that did.
   */
  async function handleUnlinkTrade(id: string) {
    setUnlinkLoading(true);
    setUnlinkError('');

    const outcome = await unlinkPlan({ client: supabase, rowId: id });

    if (!outcome.ok) {
      setUnlinkLoading(false);
      // A second press while the first is in flight is not an error.
      if (outcome.reason === 'busy') return;
      setUnlinkError('לא הצלחנו לבטל את השיוך — נסה שוב');
      return;
    }

    // The trade comes back. See the doc comment on why a failure here is not
    // reported as a failed unlink.
    await requestWideSync();

    setUnlinkLoading(false);
    setUnlinkingTradeId(null);
    setViewTradeId(null);
    // The row count changed — the plan is still here and a broker row joined
    // it — so trades/page.tsx rebuilds the list on its own `key`.
    router.refresh();
  }

  /**
   * A queued row has been decided about (REF-107 Stage 3b).
   *
   * THE TWO OUTCOMES MOVE THE LIST DIFFERENTLY, and both have to be reflected
   * locally as well as refreshed, because this component seeds `useState` from
   * its prop and only re-reads it when `trades/page.tsx` changes the `key`:
   *
   * - `linked`: the broker row is GONE — the function deleted it and the plan
   *   now carries the trade. So it leaves the list here, and the row count the
   *   server renders changes, which remounts this component with the merged
   *   plan in it.
   * - `declined`: the row stays exactly where it is and only its bookkeeping
   *   moved. Nothing the `key` is built from changes, so there is no remount,
   *   so the two columns are patched in locally — otherwise the `מקור` row
   *   would go on saying "ממתינה לשיוך" about a question already answered.
   *
   * The refresh is what updates the banner's count in both cases.
   */
  function handleLinkResolved(
    rowId: string,
    outcome: { kind: 'linked'; planId: string } | { kind: 'declined' }
  ) {
    if (outcome.kind === 'linked') {
      setTrades(prev => prev.filter(t => t.id !== rowId));
    } else {
      setTrades(prev => prev.map(t => t.id === rowId
        ? { ...t, link_confirmed_at: new Date().toISOString(), link_method: 'declined' }
        : t));
    }

    // §D cases א and ב: the debrief runs the moment the trade has an answer,
    // and on the row that now holds the trade — the PLAN after a link, the
    // broker row after a decline. This is the first time the debrief gets a
    // real stop, a real R:R and a real reason beside real fills, which §D
    // calls the trade it was built for.
    requestDebrief(outcome.kind === 'linked' ? outcome.planId : rowId);

    setViewTradeId(null);
    router.refresh();
  }

  /**
   * The debriefs the cron's auto-links are owed (REF-107 Stage 3b, §G step 7).
   *
   * THE IMPORT NEVER CALLS CLAUDE, and this effect is why it does not have to.
   * The nightly job runs over every connected trader with a 60-second budget;
   * a model call inside its loop would put a third party's latency on the
   * critical path of a job whose whole purpose is to be finished before
   * anybody is awake, and a timeout mid-loop would leave some traders
   * imported and others not.
   *
   * SO THE QUEUE IS THE DATA, NOT A TABLE. "A decided trade with no stored
   * debrief" is already a complete description of the work outstanding — it
   * needs no column, no job table and nothing to keep in sync — and the next
   * time the trader opens their journal, this asks for them. The dedupe gate
   * in the route is what makes that safe to do from a render.
   *
   * THREE BOUNDS, because this spends money from a page load:
   *
   *   1. **Decided in the last day.** The cron ran at 03:30; a trader opening
   *      the journal at 09:00 is inside it. A historical backlog — rows
   *      decided weeks ago, or declined in bulk — is NOT swept, so the cost
   *      of this is bounded by what actually happened yesterday rather than
   *      by how long the trader has used the product.
   *   2. **Three per load.** At roughly $0.008 a debrief (§D), that is two
   *      cents for the worst load, and a fourth row waits for the next one.
   *   3. **Once per mount.** The ref, not the state: `trades` changes on
   *      every edit and delete, and re-running this on each of them would
   *      re-request the rows the first run has not finished storing yet.
   */
  const sweptRef = useRef(false);
  useEffect(() => {
    if (sweptRef.current) return;
    sweptRef.current = true;

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const owed = trades.filter(t => {
      const state = linkState(t);
      if (state !== 'linked' && state !== 'declined') return false;
      if (t.debrief_generated_at) return false;
      const decided = Date.parse(String(t.link_confirmed_at ?? ''));
      return Number.isFinite(decided) && decided >= dayAgo;
    });

    for (const trade of owed.slice(0, AUTO_DEBRIEF_PER_LOAD)) requestDebrief(trade.id);
    // Deliberately not depending on `trades`: see bound 3 above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleTradeUpdated(updated: Trade) {
    setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
    setEditingTradeId(null);
    router.refresh();
  }

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pageNums = useMemo(() => {
    const half  = 2;
    const start = Math.max(1, Math.min(page - half, totalPages - half * 2));
    const end   = Math.min(totalPages, start + half * 2);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }, [page, totalPages]);

  /** The first row still waiting, which is what the banner opens. */
  const firstQueued = useMemo(() => trades.find(isQueuedBrokerRow) ?? null, [trades]);

  return (
    <div dir="rtl" className="flex flex-col gap-4">
      {/* THE BANNER (REF-107 Stage 3b, §C). It exists because a queue nobody
          sees is a queue that never empties, and it is at the top of the page
          the trader already visits rather than on a route they would have to
          remember. It opens the first waiting row, because a banner that only
          announces work is a banner that gets ignored.

          Hidden at zero: the count comes from the server, so an empty queue
          renders nothing at all rather than "0 עסקאות ממתינות". */}
      {queueCount > 0 && firstQueued && (
        <button
          type="button"
          onClick={() => setViewTradeId(firstQueued.id)}
          aria-haspopup="dialog"
          className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold text-right transition-all hover:opacity-80"
          style={{
            background: 'rgba(0,210,210,0.1)',
            border: '1px solid rgba(0,210,210,0.3)',
            color: GOLD,
          }}>
          <Inbox aria-hidden="true" size={15} />
          <span>{queueBannerText(queueCount)}</span>
          <span className="text-xs font-medium" style={{ color: TEXT2 }}>— שייך לתוכנית</span>
        </button>
      )}

      {/* Summary strip — one slim card, internal dividers */}
      <div className="jr-summary">
        <SummaryStat label="סה״כ עסקאות" value={String(taken.length)} />
        <SummaryStat label="אחוז הצלחה" value={`${winRate}%`}
          color={winRate >= 50 ? GREEN : RED} />
        <SummaryStat label="רווח/הפסד כולל"
          value={hasPnlAmount ? formatMoney(totalPnlAmount) : fmtPnl(totalPnl)}
          color={(hasPnlAmount ? totalPnlAmount : totalPnl) >= 0 ? GREEN : RED}
          big />
        <SummaryStat label="פקטור רווח" value={pfStr}
          color={pfNum !== null ? (pfNum >= 1.5 ? GREEN : pfNum >= 1 ? GOLD : RED) : MUTED} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 justify-between flex-wrap gap-y-2">
        <div className="flex items-center gap-2">

          {/* Filter */}
          <div className="relative">
            <button
              onClick={() => { setShowFilter(v => !v); setShowActions(false); }}
              className="flex items-center gap-1.5 px-4 h-11 rounded-xl text-[15px] font-medium"
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
              <FilterIcon />
              סינון
              {filterStatus !== 'all' && (
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: GOLD }} />
              )}
            </button>
            {showFilter && (
              <div className="absolute top-full mt-1 right-0 z-30 rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[130px]"
                style={{ background: SURF, border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                {(['all', 'open', 'closed'] as const).map(s => (
                  <button key={s}
                    onClick={() => { setFilterStatus(s); setShowFilter(false); setPage(1); }}
                    className="px-3 py-1.5 rounded-lg text-sm text-right transition-all"
                    style={{
                      background: filterStatus === s ? 'rgba(0,210,210,0.12)' : 'transparent',
                      color: filterStatus === s ? GOLD : TEXT2,
                      fontWeight: 600,
                    }}>
                    {s === 'all' ? 'הכל' : s === 'open' ? 'פתוחות' : 'סגורות'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="relative">
            <button
              onClick={() => { setShowActions(v => !v); setShowFilter(false); }}
              className="flex items-center gap-1.5 px-4 h-11 rounded-xl text-[15px] font-medium"
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
              פעולות
              <ChevronIcon />
            </button>
            {showActions && (
              <div className="absolute top-full mt-1 right-0 z-30 rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[160px]"
                style={{ background: SURF, border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button
                  onClick={() => { router.refresh(); setShowActions(false); }}
                  className="px-3 py-1.5 rounded-lg text-sm text-right transition-all hover:opacity-80"
                  style={{ color: TEXT2, fontWeight: 600 }}>
                  רענן נתונים
                </button>
                {selected.size > 0 && (
                  <button
                    onClick={() => { setSelected(new Set()); setShowActions(false); }}
                    className="px-3 py-1.5 rounded-lg text-sm text-right transition-all hover:opacity-80"
                    style={{ color: RED }}>
                    בטל בחירה ({selected.size})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <svg aria-hidden="true" className="absolute right-3 top-1/2 -translate-y-1/2" width="15" height="15"
            viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="חפש לפי נכס..."
            className="jr-input w-full pr-9 pl-3 h-11 rounded-xl text-[15px] outline-none"
            style={{ background: SURF2, border: `1px solid ${BORDER}`, color: TEXT, direction: 'rtl' }}
          />
        </div>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden flex flex-col gap-2">
        {pageTrades.length === 0 ? (
          <EmptyState />
        ) : pageTrades.map(t => (
          <MobileTradeCard
            key={t.id}
            t={t}
            onView={() => setViewTradeId(t.id)}
            onEdit={() => setEditingTradeId(t.id)}
            onDelete={() => { setDeletingTradeId(t.id); setDeleteError(''); }}
            onClose={() => { setViewTradeId(null); setClosingTradeId(t.id); }}
            onDebrief={() => setViewDebriefId(t.id)}
            hasDebrief={!!debriefResults[t.id]}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-2xl overflow-hidden"
        style={{ border: `1px solid ${BORDER}`, background: SURF }}>
        <div className="overflow-auto" style={{ maxHeight: '70vh' }}>
          <table className="jr-table">
            {/* Visually hidden: the page's <h1> already names this table on
                screen, and a visible caption would sit above the rounded card
                border, outside the surface it belongs to. */}
            <caption className="sr-only">
              {`טבלת עסקאות — ${filtered.length} עסקאות, עמוד ${page} מתוך ${totalPages}`}
            </caption>
            <thead>
              <tr>
                <TH>
                  <input type="checkbox" checked={allOnPage} onChange={toggleAll}
                    className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: GOLD }} />
                </TH>
                <TH sortable sortDir={sortDir} onSort={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>
                  תאריך סגירה
                </TH>
                <TH>סטטוס</TH>
                <TH>נכס</TH>
                <TH>סוג</TH>
                <TH>תאריך פתיחה</TH>
                <TH>תוצאה</TH>
                <TH>ציון</TH>
                <TH>מחיר כניסה</TH>
                <TH>אסטרטגיה</TH>
                <TH>{''}</TH>
              </tr>
            </thead>
            <tbody>
              {pageTrades.length === 0 ? (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={11}>
                    <EmptyState />
                  </td>
                </tr>
              ) : pageTrades.map(t => {
                const pnl      = calcPnl(t);
                const dir      = inferDirection(t);
                const isClosed = t.status === 'closed';
                const isChecked = selected.has(t.id);

                const menuItems: KebabItem[] = [
                  { label: 'צפייה', icon: <Eye aria-hidden="true" size={13} />, onClick: () => { setClosingTradeId(null); setViewTradeId(t.id); } },
                  { label: 'עריכה', icon: <Pencil aria-hidden="true" size={13} />, onClick: () => setEditingTradeId(t.id) },
                  ...(t.status === 'open'
                    ? [{ label: 'סגור עסקה', icon: <X aria-hidden="true" size={13} />, onClick: () => { setViewTradeId(null); setClosingTradeId(t.id); } }]
                    : []),
                  ...(debriefResults[t.id]
                    ? [{ label: 'ניתוח AI', icon: <Bot aria-hidden="true" size={13} />, color: GOLD, onClick: () => setViewDebriefId(t.id) }]
                    : []),
                  { label: 'מחיקה', icon: <Trash2 aria-hidden="true" size={13} />, color: RED, onClick: () => { setDeletingTradeId(t.id); setDeleteError(''); } },
                ];

                return (
                  <tr key={t.id}
                    // Clicking a bare <td> focuses nothing, so the browser
                    // lands focus on the nearest focusable ancestor — <main
                    // id="main-content" tabIndex={-1}>, which is what the
                    // dialog then captured and restored to. Handing focus to
                    // the row's own control first makes the mouse path restore
                    // to the row like the keyboard one. Whether a ring shows
                    // afterwards is left to the browser's :focus-visible
                    // heuristic — none in a pure mouse session, one if the
                    // user has been on the keyboard, which is the behaviour
                    // you want in both cases.
                    onClick={() => {
                      rowRefs.current[t.id]?.focus();
                      setClosingTradeId(null);
                      setViewTradeId(t.id);
                    }}
                    style={isChecked ? { background: 'rgba(0,210,210,0.06)' } : undefined}>

                    {/* Checkbox */}
                    <TD>
                      <input type="checkbox" checked={isChecked}
                        onChange={() => toggleOne(t.id)}
                        onClick={e => e.stopPropagation()}
                        className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: GOLD }} />
                    </TD>

                    {/* Close date */}
                    <TD>
                      <span className="jr-num" style={{ fontSize: 16, color: TEXT2, fontWeight: 600 }}>
                        {isClosed && t.closed_at ? fmtDate(t.closed_at) : '—'}
                      </span>
                    </TD>

                    {/* Status */}
                    <TD>
                      <RowStatusChip t={t} />
                    </TD>

                    {/* Asset — and the row's keyboard control.
                        A real <button> inside the cell rather than a focusable
                        <tr>: the row keeps role="row", so table navigation and
                        the column/row counts are untouched, and Enter/Space
                        both activate natively. The <tr> onClick above is
                        unchanged, so clicking any cell still opens the detail;
                        this button stops propagation only so a click on the
                        symbol doesn't run the same handler twice. */}
                    <TD>
                      <button type="button"
                        ref={el => { rowRefs.current[t.id] = el; }}
                        onClick={e => { e.stopPropagation(); setClosingTradeId(null); setViewTradeId(t.id); }}
                        aria-label={rowAccessibleName(t)}
                        aria-haspopup="dialog"
                        className="jr-row-open flex items-center gap-2">
                        <AssetDot symbol={t.symbol} />
                        <span className="font-semibold text-base" style={{ color: TEXT }}>
                          {t.symbol ?? '—'}
                        </span>
                      </button>
                    </TD>

                    {/* Direction, and where the row came from */}
                    <TD>
                      <span className="flex items-center gap-1.5 flex-wrap">
                        <Chip
                          bg={dir === 'long' ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)'}
                          color={dir === 'long' ? GREEN : RED}>
                          {dir === 'long' ? 'לונג' : 'שורט'}
                        </Chip>
                        <ProvenanceChips t={t} />
                      </span>
                    </TD>

                    {/* Open date */}
                    <TD>
                      <span className="jr-num" style={{ color: TEXT2, fontWeight: 600 }}>{fmtDate(t.submitted_at)}</span>
                    </TD>

                    {/* P&L — money primary, points sub-value */}
                    <TD>
                      {pnl !== null ? (
                        hasMoneyPnl(t) ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="jr-num" style={{ fontSize: 16, fontWeight: 700, color: tradeMoneyPnl(t) >= 0 ? GREEN : RED }}>
                              {formatMoney(tradeMoneyPnl(t))}
                            </span>
                            <span className="jr-num" style={{ fontSize: 13, color: MUTED, fontWeight: 600 }}>
                              {formatPnlPoints(pnl)}
                            </span>
                            {/* E11, beside the figure it qualifies. */}
                            {isBrokerRow(t) && <GrossPnlNote />}
                          </div>
                        ) : (
                          <span className="jr-num" style={{ fontSize: 16, fontWeight: 700, color: pnl >= 0 ? GREEN : RED }}>
                            {fmtPnl(pnl)}
                          </span>
                        )
                      ) : (
                        <span style={{ color: MUTED, fontWeight: 600 }}>—</span>
                      )}
                    </TD>

                    {/* Score + rule-violation flag */}
                    <TD>
                      <div className="flex items-center gap-1.5">
                        <ScoreRing score={isClosed ? t.plan_score : null} />
                        {t.has_rule_violation && (
                          <span title="חוק הופר" className="flex items-center">
                            <AlertTriangle role="img" aria-label="חוק הופר" size={14} color={AMBER} />
                          </span>
                        )}
                      </div>
                    </TD>

                    {/* Entry price */}
                    <TD>
                      <span className="jr-num" style={{ fontSize: 15, color: TEXT }}>
                        {fmtPrice(t.entry_price)}
                      </span>
                    </TD>

                    {/* Strategy */}
                    <TD>
                      <span className="truncate max-w-[140px] block" style={{ fontSize: 15, color: TEXT2, fontWeight: 600 }}>
                        {t.strategy}
                      </span>
                    </TD>

                    {/* Kebab menu — revealed on row hover */}
                    <TD>
                      <div className="flex justify-end">
                        <KebabMenu items={menuItems} className="jr-kebab" />
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination bar */}
      <div className="flex items-center justify-between flex-col sm:flex-row gap-3 px-4 py-3 rounded-2xl"
        style={{ border: `1px solid ${BORDER}`, background: SURF }}>

        {/* Rows per page */}
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: MUTED, fontWeight: 600 }}>שורות בעמוד:</span>
          <select value={pageSize}
            onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="text-xs rounded-lg px-2 py-1 outline-none"
            style={{ background: SURF2, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {/* Count */}
        <span className="text-xs" style={{ color: MUTED, fontWeight: 600 }}>
          {filtered.length === 0
            ? 'אין עסקאות'
            : `מציג ${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)} מתוך ${filtered.length} עסקאות`}
        </span>

        {/* Page buttons */}
        <div className="flex items-center gap-1">
          <PgBtn onClick={() => setPage(1)}             disabled={page === 1}>«</PgBtn>
          <PgBtn onClick={() => setPage(p => p - 1)}    disabled={page === 1}>‹</PgBtn>
          {pageNums.map(n => (
            <PgBtn key={n} onClick={() => setPage(n)} active={n === page}>{n}</PgBtn>
          ))}
          <PgBtn onClick={() => setPage(p => p + 1)}    disabled={page === totalPages}>›</PgBtn>
          <PgBtn onClick={() => setPage(totalPages)}     disabled={page === totalPages}>»</PgBtn>
        </div>
      </div>

      {closingTradeId && (() => {
        const t = trades.find(tr => tr.id === closingTradeId);
        if (!t) return null;
        return (
          <Modal
            onClose={() => setClosingTradeId(null)}
            labelledBy={`${uid}-close`}
            initialFocusRef={closeExitPriceRef}
          >
            <div className="flex items-center justify-between mb-1">
              <p id={`${uid}-close`} className="text-base font-bold" style={{ color: TEXT }}>סגירת עסקה — {t.strategy}</p>
              <button onClick={() => setClosingTradeId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
            </div>
            <CloseTrade
              tradeId={t.id}
              entryPrice={t.entry_price}
              stopLoss={t.stop_loss}
              takeProfit={t.take_profit}
              rrRatio={t.rr_ratio}
              emotionalState={t.emotional_state}
              strategy={t.strategy}
              tradeReason={t.trade_reason}
              direction={inferDirection(t)}
              units={t.units ?? t.quantity}
              pointValue={t.point_value}
              exitPriceRef={closeExitPriceRef}
              onClosed={() => { setClosingTradeId(null); router.refresh(); }}
              onDebrief={result => setDebriefResults(prev => ({ ...prev, [t.id]: result }))}
            />
          </Modal>
        );
      })()}

      {viewDebriefId && debriefResults[viewDebriefId] && (
        <Modal onClose={() => setViewDebriefId(null)} labelledBy={`${uid}-debrief`}>
          <div className="flex items-center justify-between mb-1">
            <p id={`${uid}-debrief`} className="text-base font-bold" style={{ color: TEXT }}>ניתוח AI על העסקה</p>
            <button onClick={() => setViewDebriefId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
          </div>
          <AIDebriefView result={debriefResults[viewDebriefId]} />
        </Modal>
      )}

      {viewTradeId && (() => {
        const t = trades.find(tr => tr.id === viewTradeId);
        if (!t) return null;
        return (
          <TradeDetailModal
            trade={t}
            plans={trades}
            onClose={() => setViewTradeId(null)}
            onLinkResolved={outcome => handleLinkResolved(t.id, outcome)}
            onUnlink={() => { setUnlinkingTradeId(t.id); setUnlinkError(''); }}
            debriefResult={debriefResults[t.id]}
            onDebrief={result => setDebriefResults(prev => ({ ...prev, [t.id]: result }))}
          />
        );
      })()}

      {unlinkingTradeId && (() => {
        const t = trades.find(tr => tr.id === unlinkingTradeId);
        if (!t) return null;
        return (
          <Modal
            onClose={() => { setUnlinkingTradeId(null); setUnlinkError(''); }}
            labelledBy={`${uid}-unlink`}
            initialFocusRef={unlinkCancelRef}
          >
            <div className="flex items-center justify-between mb-1">
              <p id={`${uid}-unlink`} className="text-base font-bold" style={{ color: TEXT }}>ביטול שיוך</p>
              <button onClick={() => { setUnlinkingTradeId(null); setUnlinkError(''); }}
                style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
            </div>
            {/* THE LAST SENTENCE IS THE ONE THAT MATTERS, and it is not
                boilerplate: the link OVERWROTE the plan's entry price, symbol,
                direction, quantity and submitted_at with the broker's, and
                nothing kept the originals (EXECUTION_FACTS owns all five). So
                an unlink restores the plan's STATE and not its figures, and a
                trader who expects their own typed entry back has to be told
                here rather than discover it afterwards. */}
            <p className="text-sm" style={{ color: TEXT2 }}>
              {UNLINK_WARNING}
            </p>
            {unlinkError && <p className="text-xs" style={{ color: RED }}>{unlinkError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                ref={unlinkCancelRef}
                onClick={() => { setUnlinkingTradeId(null); setUnlinkError(''); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
                style={{ background: SURF2, color: TEXT2 }}>
                ביטול
              </button>
              <button
                onClick={() => handleUnlinkTrade(t.id)}
                disabled={unlinkLoading}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-50 flex items-center justify-center gap-1.5"
                style={{ background: 'rgba(0,210,210,0.18)', color: GOLD, border: '1px solid rgba(0,210,210,0.35)' }}>
                <Unlink aria-hidden="true" size={13} />
                {unlinkLoading ? 'מבטל...' : 'בטל שיוך'}
              </button>
            </div>
          </Modal>
        );
      })()}

      {deletingTradeId && (() => {
        const t = trades.find(tr => tr.id === deletingTradeId);
        if (!t) return null;
        return (
          <Modal
            onClose={() => { setDeletingTradeId(null); setDeleteError(''); }}
            labelledBy={`${uid}-delete`}
            initialFocusRef={deleteCancelRef}
          >
            <div className="flex items-center justify-between mb-1">
              <p id={`${uid}-delete`} className="text-base font-bold" style={{ color: TEXT }}>מחיקת עסקה</p>
              <button onClick={() => { setDeletingTradeId(null); setDeleteError(''); }}
                style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
            </div>
            {/* §F4. On a LINKED row the plan and the broker trade are one
                row, so hiding it hides the trader's own intent with it — the
                strategy, the stop, the reason they wrote. A trader who meant
                to remove a duplicate import would lose the most valuable
                thing this product asked them for, and this dialog is the only
                place left to say so. */}
            <p className="text-sm" style={{ color: TEXT2 }}>
              {deleteWarningText(t)}
            </p>
            {deleteError && <p className="text-xs" style={{ color: RED }}>{deleteError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                ref={deleteCancelRef}
                onClick={() => { setDeletingTradeId(null); setDeleteError(''); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
                style={{ background: SURF2, color: TEXT2 }}>
                ביטול
              </button>
              <button
                onClick={() => handleDeleteTrade(t.id)}
                disabled={deleteLoading}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-50"
                style={{ background: RED, color: '#fff' }}>
                {deleteLoading ? 'מוחק...' : 'מחק עסקה'}
              </button>
            </div>
          </Modal>
        );
      })()}

      {editingTradeId && (() => {
        const t = trades.find(tr => tr.id === editingTradeId);
        if (!t) return null;
        return (
          <EditTradeModal
            trade={t}
            onClose={() => setEditingTradeId(null)}
            onSaved={handleTradeUpdated}
          />
        );
      })()}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function SummaryStat({ label, value, color = TEXT, big }: {
  label: string; value: string; color?: string; big?: boolean;
}) {
  return (
    <div className="flex flex-col justify-center gap-0.5 px-4 py-3 min-w-0" style={{ minHeight: 78 }}>
      <span style={{ fontSize: 14, fontWeight: 600, color: MUTED }}>{label}</span>
      <span className="jr-num truncate" style={{ fontSize: big ? 24 : 21, fontWeight: 700, lineHeight: 1.2, color }}>
        {value}
      </span>
    </div>
  );
}

function TH({ children, sortable, onSort, sortDir }: {
  children: React.ReactNode;
  sortable?: boolean;
  onSort?: () => void;
  sortDir?: 'asc' | 'desc';
}) {
  const inner = sortable ? (
    <button onClick={onSort}
      className="flex items-center gap-1 hover:opacity-80 transition-opacity"
      style={{ color: 'inherit', fontWeight: 600 }}>
      {children}
      <span style={{ color: GOLD, fontSize: 11 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>
    </button>
  ) : children;
  // Every header in this table labels a column; there are no row headers.
  return <th scope="col">{inner}</th>;
}

function TD({ children }: { children: React.ReactNode }) {
  return <td>{children}</td>;
}

/** Post-trade score (0-100) as a small colored ring; muted — when no score. */
function ScoreRing({ score, size = 34 }: { score: number | null; size?: number }) {
  if (score == null) return <span style={{ color: MUTED, fontWeight: 600 }}>—</span>;
  const clamped = Math.min(Math.max(Math.round(score), 0), 100);
  const color = clamped >= 80 ? GREEN : clamped >= 60 ? AMBER : RED;
  const c = size / 2;
  const r = c - 3;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`ציון ${clamped}`} className="shrink-0">
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(128,128,128,0.22)" strokeWidth={2.5} />
      <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={2.5}
        strokeDasharray={`${(clamped / 100) * circ} ${circ}`}
        strokeLinecap="round" transform={`rotate(-90 ${c} ${c})`} />
      <text x={c} y={c + size * 0.14} textAnchor="middle" fontSize={size * 0.4} fontWeight={700} fill={color}
        style={{ fontVariantNumeric: 'tabular-nums' }}>
        {clamped}
      </text>
    </svg>
  );
}

interface KebabItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  color?: string;
}

/** ⋯ row menu — portal-positioned so the table's overflow can't clip it. */
function KebabMenu({ items, className = '' }: { items: KebabItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const r = btnRef.current!.getBoundingClientRect();
    const menuW = 160;
    const menuH = items.length * 36 + 12;
    const top = r.bottom + menuH + 8 > window.innerHeight ? r.top - menuH - 4 : r.bottom + 4;
    const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8);
    setPos({ top, left });
    setOpen(true);
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        data-open={open || undefined}
        className={`hit-40 relative w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:opacity-80 ${className}`}
        style={{ background: SURF2, color: MUTED }}
        title="פעולות"
        aria-haspopup="menu"
        aria-expanded={open}>
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {open && createPortal(
        <div className="fixed inset-0 z-50"
          onClick={e => { e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }}>
          <div dir="rtl"
            className="absolute rounded-xl p-1.5 flex flex-col gap-0.5"
            style={{
              top: pos.top, left: pos.left, width: 160,
              background: SURF, border: `1px solid ${BORDER}`,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            }}
            onClick={e => e.stopPropagation()}>
            {items.map(item => (
              <button key={item.label}
                // Focus goes back to the ⋯ button *before* the item's action
                // runs. Standard menu-button behaviour, and it also gives the
                // modal these items open something live to restore focus to —
                // the item itself unmounts with the menu, so a dialog that
                // captured it would find a detached node on close.
                onClick={e => {
                  e.stopPropagation();
                  setOpen(false);
                  btnRef.current?.focus();
                  item.onClick();
                }}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-right transition-all hover:opacity-80"
                style={{ color: item.color ?? TEXT2, fontWeight: 600 }}>
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 py-16">
      <Inbox aria-hidden="true" size={28} color={MUTED} strokeWidth={1.5} />
      <p className="text-sm" style={{ color: TEXT, fontWeight: 700 }}>לא נמצאו עסקאות</p>
      <p className="text-xs" style={{ color: MUTED, fontWeight: 600 }}>נסה לשנות את החיפוש או הסינון</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold" style={{ color: MUTED }}>{label}</label>
      {children}
    </div>
  );
}

function Chip({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span className="px-3 py-1 rounded-full font-semibold whitespace-nowrap"
      style={{ background: bg, color, fontSize: 13.5 }}>
      {children}
    </span>
  );
}

function StatusBadge({ win }: { win: boolean | null }) {
  if (win === null) return <Chip bg={SURF2} color={MUTED}>סגור</Chip>;
  return <Chip bg={win ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)'} color={win ? GREEN : RED}>
    {win ? 'רווח' : 'הפסד'}
  </Chip>;
}

/**
 * The status chip for one row, all three statuses in one place.
 *
 * 'not_entered' is grey — the same neutral pair StatusBadge already uses for a
 * trade closed without an exit price. Deliberately not turquoise, which on this
 * page means "still open and still live", and deliberately not red: §7 of the
 * build brief reserves red for money lost, and a plan the user decided to stay
 * out of lost them nothing. The word carries the meaning either way.
 */
function RowStatusChip({ t }: { t: Trade }) {
  if (t.status === NOT_ENTERED) return <Chip bg={SURF2} color={MUTED}>{NOT_ENTERED_LABEL}</Chip>;
  if (t.status === 'closed') return <StatusBadge win={isWinningTrade(t)} />;
  return <Chip bg="rgba(0,210,210,0.1)" color={GOLD}>פתוח</Chip>;
}

/**
 * The two chips a broker row carries, and nothing on a manual one.
 *
 * SMALL, AND NOT A WARNING. An imported trade is the normal case this product
 * is moving towards — "manual entry is no longer the source of truth" is the
 * goal on REF-107 — so the badge is a label, in the turquoise the rest of the
 * app uses for a fact, and not an amber flag. "לא תוכננה" sits beside it in
 * muted grey rather than red for the same reason: `unplanned` is a description,
 * and the trader already knows they did not fill the form.
 *
 * Lucide only and no emoji, per CLAUDE.md. There is no icon here at all — a
 * broker's name is a word, and the two chips next to a direction chip and a
 * status chip is already the most a row can carry.
 */
function ProvenanceChips({ t }: { t: Trade }) {
  if (!isBrokerRow(t)) return null;
  return (
    <>
      <Chip bg="rgba(0,210,210,0.1)" color={GOLD}>Tradovate</Chip>
      {t.unplanned && <Chip bg={SURF2} color={MUTED}>לא תוכננה</Chip>}
    </>
  );
}

/**
 * E11, and it is one line of text that keeps the journal honest.
 *
 * The P&L on a broker row is GROSS: `(sell − buy) × qty × valuePerPoint`, with
 * no commissions and no exchange fees, because the chain this comes from has no
 * verified source for them (lib/tradovate/fills.ts, §A1). The figure therefore
 * reads slightly BETTER than the trader's own account statement, always in the
 * same direction, by a few dollars a round trip.
 *
 * In a discipline rule that is tolerable. IN A JOURNAL IT IS NOT, because the
 * trader compares the row to their broker statement — the 15.10 reading of a
 * live account is exactly that: our $270 against Lucid's $268. E11 chose to
 * state the gap rather than guess a fee schedule, and this is where it is
 * stated: next to the number, not in a help page.
 */
function GrossPnlNote() {
  return (
    <span style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>ברוטו, לפני עמלות</span>
  );
}

function AssetDot({ symbol }: { symbol: string | null }) {
  const s = (symbol ?? '?').slice(0, 2).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-bold shrink-0"
      style={{ background: 'rgba(0,210,210,0.12)', color: GOLD }}>
      {s}
    </div>
  );
}

function PgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="hit-40 relative w-7 h-7 rounded-lg text-xs font-semibold flex items-center justify-center transition-all disabled:opacity-30"
      style={{
        background: active ? GOLD : SURF2,
        color:      active ? '#0a0a0f' : TEXT2,
        border:     `1px solid ${active ? GOLD : BORDER}`,
      }}>
      {children}
    </button>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────

// The local open-modal stack this component used to keep (Escape closing only
// the topmost dialog) now lives in useModalDialog, shared with every other
// overlay in the app — including the demo upsell, which can open on top of
// these in demo mode.
function Modal({ onClose, labelledBy, initialFocusRef, initialFocus, children }: {
  onClose: () => void;
  /** Id of the modal's own visible title — becomes its accessible name. */
  labelledBy: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  initialFocus?: 'first-tabbable' | 'container';
  children: React.ReactNode;
}) {
  const mounted = useHydrated();
  const { dialogProps } = useModalDialog({
    open: mounted, onClose, labelledBy, initialFocusRef, initialFocus,
  });

  if (!mounted) return null;

  // Rendered via portal so the fixed overlay covers the full viewport — an
  // ancestor (.page-enter) animates with `transform`, which would otherwise
  // scope position:fixed to that ancestor's box instead of the real viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center overflow-y-auto p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        {...dialogProps}
        className="w-full max-w-lg mx-auto max-h-[90dvh] overflow-y-auto rounded-2xl p-5 flex flex-col gap-3 my-auto"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

function TradeDetailModal({ trade, plans, onClose, onLinkResolved, onUnlink, debriefResult, onDebrief }: {
  trade: Trade;
  /** Every row on the page. The panel narrows them to candidates itself. */
  plans: readonly Trade[];
  onClose: () => void;
  /** The row left the queue. Null while it is not a queued row at all. */
  onLinkResolved: (outcome: { kind: 'linked'; planId: string } | { kind: 'declined' }) => void;
  /** Open the unlink confirmation. Offered on a `linked` row only. */
  onUnlink: () => void;
  debriefResult?: AIDebriefResult;
  onDebrief?: (result: AIDebriefResult) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  // Seeded from the row, so a debrief written in an earlier session is on
  // screen before anything is fetched (REF-107 Stage 3a). Until migration 036
  // this is always null and the modal behaves exactly as it did.
  const [localResult, setLocalResult] = useState<AIDebriefResult | null>(() =>
    storedDebriefResult(trade)
  );
  const [debriefOpen, setDebriefOpen] = useState(debriefResult != null);
  const titleId = useId();

  // Direction from the column, not from take_profit-vs-entry — that guess
  // labelled every profitable short a loss (REF-107 §0ד), including in the
  // כיוון row this modal shows the trader.
  const dir = inferDirection(trade);
  const pnlPoints = calcPnl(trade);
  const result = debriefResult ?? localResult;

  // Same toggle pattern as the other AI panels: opening fetches only if
  // nothing is cached/in-flight; closing never cancels an in-flight request.
  function handleDebriefClick() {
    const willOpen = !debriefOpen;
    setDebriefOpen(willOpen);
    if (willOpen && !result && !analyzing) runAnalysis();
  }

  // `force` is what "נתח מחדש" sends. Without it the route serves whatever
  // is already stored and calls no model — which is the point, and is also
  // why the re-analyse button has to say so explicitly rather than reusing
  // the same request.
  async function runAnalysis(force = false) {
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('trade', JSON.stringify({
        id: trade.id, strategy: trade.strategy, entry_price: trade.entry_price,
        stop_loss: trade.stop_loss, take_profit: trade.take_profit,
        rr_ratio: trade.rr_ratio, emotional_state: trade.emotional_state,
        trade_reason: trade.trade_reason, status: trade.status,
        exit_price: trade.exit_price, exit_reason: trade.exit_reason,
        post_trade_notes: trade.post_trade_notes,
      }));
      if (trade.post_trade_notes) fd.append('description', trade.post_trade_notes);
      const res = await fetch(`/api/ai-debrief${force ? '?force=1' : ''}`, {
        method: 'POST',
        body: fd,
      });
      if (res.ok) {
        const data = await res.json();
        setLocalResult(data);
        onDebrief?.(data);
      }
    } catch {
      // analysis failed — button stays so the user can retry
    } finally {
      setAnalyzing(false);
    }
  }

  // ── The broker's stop, beside the one the trader planned (REF-113 Stage 5) ─
  //
  // Both halves come off the same document so they cannot disagree: the number
  // is suppressed for the three cases `brokerStopToShow` names (no document, no
  // stop placed, an order that cannot have been a protective stop), and the
  // sentence is suppressed only by the first.
  //
  // A ROW WITH NO DOCUMENT ADDS NOTHING AT ALL — not a label with a dash. The
  // modal's rows are a fixed list and a `סטופ בברוקר —` on every manual trade
  // the trader ever logged would be a column announcing a feature that does not
  // apply to it.
  const stops = readStopHistory(trade.stop_history);
  const brokerStop = brokerStopToShow(stops, trade.broker_stop_loss);
  const stopSentence = stopMoveSentence(stops);
  // Whichever of the two stop rows comes LAST, so the sentence sits under both
  // when there is a price and under the planned stop when there is not — which
  // is the `'none'` and `'unknown'` case, and exactly where a trader looking
  // for "what happened to my stop" is already looking.
  const stopSentenceAfter = brokerStop !== null ? 'סטופ בברוקר' : 'Stop Loss';

  const rows: [string, string | number | null][] = [
    // Where the row came from, FIRST, because it changes how every row under it
    // should be read: an imported trade's prices are the broker's and its
    // intent columns are empty because nobody filled a form (REF-107 Stage 2).
    // Absent entirely on a manual row — a journal that labels hand-entered
    // trades "ידני" is a journal that treats its own default as a special case.
    // Three states now, not two (REF-107 Stage 3b). The sentence Stage 2
    // shipped — `Tradovate · לא תוכננה` — was about to be printed over a
    // LINKED trade the moment the merge cleared `unplanned`, which is "not
    // planned" written across a trade the trader planned carefully.
    // lib/journal/link.ts holds the three sentences and the predicate.
    ...(linkState(trade)
      ? ([['מקור', LINK_STATE_COPY[linkState(trade)!]]] as [string, string][])
      : []),
    // An intent column the row does not carry shows "—" — the same answer the
    // trader gets for a missing exit price two rows down — rather than "null",
    // "0.00" or "null/5".
    ['אסטרטגיה', trade.strategy ?? '—'],
    ['נכס', trade.symbol ?? '—'],
    ['כיוון', dir === 'long' ? 'לונג ↑' : 'שורט ↓'],
    ['מחיר כניסה', trade.entry_price.toFixed(2)],
    ['Stop Loss', fmtPriceCell(trade.stop_loss)],
    // DIRECTLY UNDER THE PLANNED STOP, because the comparison is the whole
    // point: "this is the stop I wrote down, and this is the one the broker
    // actually held". Absent entirely when there is no document.
    ...(brokerStop !== null
      ? ([['סטופ בברוקר', brokerStop.toFixed(2)]] as [string, string][])
      : []),
    ['Take Profit', fmtPriceCell(trade.take_profit)],
    ['יחס R:R', trade.rr_ratio ?? '—'],
    ['מצב רגשי', trade.emotional_state != null ? `${trade.emotional_state}/5` : '—'],
    ['סיבת כניסה', trade.trade_reason ?? '—'],
    // Three statuses, one label function — the ternary this replaces read
    // 'not_entered' as "סגור", which is the one thing it is not.
    ['סטטוס', tradeStatusLabel(trade.status)],
    ['מחיר יציאה', trade.exit_price != null ? trade.exit_price.toFixed(2) : '—'],
    ['סיבת יציאה', trade.exit_reason ?? '—'],
    ['הערות', trade.post_trade_notes ?? '—'],
    ['תחקיר עצמי', trade.debrief_answer ?? '—'],
  ];

  return (
    // Read-first: focus the dialog itself so a screen reader starts at the
    // trade's name rather than at the × button that leads the markup.
    <Modal onClose={onClose} labelledBy={titleId} initialFocus="container">
      <div className="flex items-center justify-between">
        <p id={titleId} className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--color-tg-text)' }}>
          {trade.symbol ?? trade.strategy}
          {pnlPoints !== null && (
            hasMoneyPnl(trade) ? (
              <span className="text-sm font-bold" style={{ color: tradeMoneyPnl(trade) >= 0 ? '#22c55e' : '#ef4444' }}>
                {formatMoney(tradeMoneyPnl(trade))}
                <span className="text-xs font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnlPoints)})</span>
                {/* E11. The detail modal is where the trader has the row open
                    beside their broker statement, so the note belongs here most
                    of all. */}
                {isBrokerRow(trade) && <span className="ms-1.5"><GrossPnlNote /></span>}
              </span>
            ) : (
              <span className="text-sm font-bold" style={{ color: pnlPoints >= 0 ? '#22c55e' : '#ef4444' }}>
                {pnlPoints >= 0 ? '+' : ''}{pnlPoints.toFixed(2)} נק׳
              </span>
            )
          )}
        </p>
        <button onClick={onClose} style={{ color: 'var(--color-tg-muted)', fontSize: 20, lineHeight: 1, fontWeight: 600 }}>×</button>
      </div>

      <div className="flex flex-col gap-0">
        {rows.map(([label, value], i) => (
          <Fragment key={label}>
            <div
              className="flex items-start justify-between gap-4 py-2.5"
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--color-tg-border)' : 'none' }}>
              <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--color-tg-muted)', minWidth: 90 }}>{label}</span>
              <span className="text-xs text-right" style={{ color: 'var(--color-tg-text)', wordBreak: 'break-word' }}>{String(value ?? '—')}</span>
            </div>
            {/* WHAT THE BROKER SAW HAPPEN TO THE STOP, in one sentence
                (REF-113 Stage 5). Prose and not a column, because the four
                answers are not comparable figures: "no stop was placed" and
                "we could not read the orders" are findings about the trade and
                about our own reading, and a `—` in a numeric row says neither.
                lib/journal/stopHistory.ts holds the sentences and the tone. */}
            {label === stopSentenceAfter && stopSentence !== null && (
              <div className="flex items-start gap-1.5 pb-2.5 -mt-1">
                {stopSentence.tone === 'warning' && (
                  <AlertTriangle
                    aria-hidden="true"
                    size={12}
                    style={{ color: '#ef4444', marginTop: 2, flexShrink: 0 }}
                  />
                )}
                <span
                  className="text-[11px] leading-relaxed"
                  style={{
                    color: stopSentence.tone === 'warning' ? '#ef4444' : 'var(--color-tg-muted)',
                  }}>
                  {stopSentence.text}
                </span>
              </div>
            )}
            {/* DIRECTLY UNDER THE מקור ROW, which is §C's whole argument: that
                row is first in this modal because it changes how every row
                beneath it reads, and the decision about it belongs with it
                rather than in a screen of its own. */}
            {label === 'מקור' && isQueuedBrokerRow(trade) && (
              <div className="py-2">
                <LinkConfirm
                  trade={trade}
                  plans={plans}
                  onResolved={onLinkResolved}
                  onSkip={onClose}
                />
              </div>
            )}
            {/* The other half of the same row. §F1's reversibility argument
                rests on being able to undo a link, and until now there was no
                way to — a trader who confirmed the wrong plan, or an auto-link
                that guessed wrong, had no route back. Quiet and text-sized:
                this is a correction, not a destructive action, and the dialog
                is where the consequence is spelled out. */}
            {label === 'מקור' && linkState(trade) === 'linked' && (
              <div className="pb-2">
                <button
                  type="button"
                  onClick={onUnlink}
                  className="flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg transition-all hover:opacity-80"
                  style={{ color: 'var(--color-tg-muted)', background: 'var(--color-tg-surface-2)' }}>
                  <Unlink aria-hidden="true" size={12} /> בטל שיוך
                </button>
              </div>
            )}
          </Fragment>
        ))}
      </div>

      {trade.status === 'closed' && (
        <div className="pt-1 border-t" style={{ borderColor: 'var(--color-tg-border)' }}>
          <button
            onClick={handleDebriefClick}
            aria-expanded={debriefOpen}
            className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-1.5"
            style={{
              background: debriefOpen ? 'rgba(0,210,210,0.2)' : 'var(--color-tg-primary-muted)',
              color: 'var(--color-tg-primary)',
              border: '1px solid rgba(0,210,210,0.3)',
            }}>
            <Bot aria-hidden="true" size={14} /> {analyzing && debriefOpen ? 'מנתח...' : debriefOpen ? 'סגור ניתוח AI' : 'נתח עסקה עם AI'}
          </button>
          {(debriefOpen || result != null) && (
            <div className={`ai-collapse ${debriefOpen ? 'ai-collapse-open' : ''}`}>
              <div>
                {analyzing ? (
                  <div className="pt-4 flex flex-col items-center gap-3">
                    <div className="w-7 h-7 rounded-full border-2 border-t-transparent animate-spin"
                      style={{ borderColor: 'var(--color-tg-primary)', borderTopColor: 'transparent' }} />
                    <p className="text-xs text-tg-text-2">מנתח את העסקה עם AI...</p>
                  </div>
                ) : result ? (
                  <div className="pt-3 flex flex-col gap-2">
                    <AIDebriefView result={result} />
                    {/* Only on a debrief that came out of the row. A fresh
                        one is already current, and offering to re-run it the
                        second it arrives invites a second paid call for the
                        same answer. */}
                    {result.stored && (
                      <button
                        onClick={() => runAnalysis(true)}
                        className="self-start text-xs px-2 py-1 rounded-lg"
                        style={{ color: 'var(--color-tg-primary)', background: 'var(--color-tg-primary-muted)' }}
                      >
                        נתח מחדש
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function EditTradeModal({ trade, onClose, onSaved }: {
  trade: Trade;
  onClose: () => void;
  onSaved: (updated: Trade) => void;
}) {
  const supabase = createClient();
  const editTitleId = useId();
  const symbolRef = useRef<HTMLInputElement>(null);
  /**
   * E12: intent is editable, FACTS ARE LOCKED.
   *
   * On an imported row the symbol, direction, entry price, exit price and
   * quantity are what the broker executed. Letting them be typed over would be
   * letting the trader rewrite history — and the next sync would silently
   * restate them anyway, because those are exactly the columns
   * `importBrokerTrades` owns (EXECUTION_FACTS in lib/tradovate/import.ts). An
   * edit that is quietly undone overnight is worse than one that was never
   * offered.
   *
   * What stays editable is the half the broker knows nothing about: strategy,
   * the stop and target the trader had in mind, the reason, the notes, how they
   * felt. That is the boundary §B5 drew between intent and execution, and it is
   * the same boundary in the schema, in the import and here.
   *
   * THE LOCKED FIELDS ARE STILL SHOWN, read-only. Hiding them would make the
   * modal a different form for a broker row; showing them disabled says "this
   * is a fact, and it is not yours to change", which is the true statement.
   */
  const factsLocked = isBrokerRow(trade);
  // `?? ''` on every intent field: `String(null)` is the string "null", which
  // would have appeared in the input box as if the trader had typed it and
  // then been saved back over a genuinely empty column (REF-107 stage 4).
  const [symbol, setSymbol] = useState(trade.symbol ?? '');
  const [direction, setDirection] = useState<'long' | 'short'>(inferDirection(trade));
  const [strategy, setStrategy] = useState(trade.strategy ?? '');
  const [entryPrice, setEntryPrice] = useState(String(trade.entry_price));
  const [stopLoss, setStopLoss] = useState(trade.stop_loss != null ? String(trade.stop_loss) : '');
  const [takeProfit, setTakeProfit] = useState(trade.take_profit != null ? String(trade.take_profit) : '');
  const [quantity, setQuantity] = useState(trade.quantity != null ? String(trade.quantity) : '');
  const [tradeReason, setTradeReason] = useState(trade.trade_reason ?? '');
  const [notes, setNotes] = useState(trade.post_trade_notes ?? '');
  // Null stays null until the trader picks a value. Seeding the slider at 3
  // and saving it back would stamp "felt neutral" on a row whose defining
  // property is that nobody reported a feeling (REF-107 §0ג); the slider is
  // shown at 3 but the column is only written once it is touched.
  const [emotionalState, setEmotionalState] = useState<number | null>(trade.emotional_state);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toggleDirection(next: 'long' | 'short') {
    if (next === direction) return;
    setDirection(next);
    setStopLoss(takeProfit);
    setTakeProfit(stopLoss);
  }

  async function handleSave() {
    const entry = parseFloat(entryPrice);
    // Blank means "not recorded" and saves as null; a value that will not
    // parse is an error. A row that arrived without an SL or a TP can be
    // edited without being made to invent one.
    const num = (text: string): number | null | undefined => {
      if (text.trim() === '') return null;
      const n = parseFloat(text);
      return Number.isFinite(n) ? n : undefined;
    };
    const sl = num(stopLoss);
    const tp = num(takeProfit);
    if (isNaN(entry) || sl === undefined || tp === undefined) {
      setError('מחיר כניסה חייב להיות מספר, ו-SL/TP חייבים להיות מספר או ריקים');
      return;
    }
    // A field the row already carried may not be emptied — clearing it is
    // deleting the trader's own record of their intent, and the column is
    // still NOT NULL in the live schema, so the write would fail anyway with
    // nothing useful to show. A field that arrived empty is allowed to stay
    // empty: that is the broker row this stage exists for.
    const emptied: string[] = [];
    if (trade.strategy != null && !strategy.trim()) emptied.push('אסטרטגיה');
    if (trade.trade_reason != null && !tradeReason.trim()) emptied.push('סיבת כניסה');
    if (trade.stop_loss != null && sl === null) emptied.push('SL');
    if (trade.take_profit != null && tp === null) emptied.push('TP');
    if (emptied.length > 0) {
      setError(`לא ניתן למחוק שדה שכבר מולא: ${emptied.join(', ')}`);
      return;
    }
    const qty = quantity.trim() === '' ? null : parseFloat(quantity);
    if (qty !== null && isNaN(qty)) {
      setError('כמות חייבת להיות מספר');
      return;
    }

    setSaving(true);
    setError('');

    // Two column sets, and the locked one is omitted rather than sent
    // unchanged: an UPDATE that names `entry_price` is an UPDATE that could
    // write it, and the only thing stopping it would be the disabled attribute
    // on an input. See `factsLocked`.
    const facts = factsLocked
      ? {}
      : {
          symbol: symbol.trim() || null,
          entry_price: entry,
          quantity: qty,
        };

    const updates = {
      ...facts,
      strategy: strategy.trim() || null,
      stop_loss: sl,
      take_profit: tp,
      // Recomputed only when both legs are there. Running calcRR against a
      // missing SL or TP would mint a ratio the trader never planned and
      // attach it to a row whose whole point is that it has no plan — which is
      // the silent corruption REF-107 §0ג is about. No legs, no ratio.
      rr_ratio: sl !== null && tp !== null ? calcRR(entry, sl, tp) : null,
      quantity: qty,
      // Rewritten to '$' on every edit rather than preserved: editing a row is
      // the one moment the app is already touching it, and a '₪' label left on
      // a dollar amount is the defect REF-99 closes.
      pnl_currency: TRADING_CURRENCY,
      trade_reason: tradeReason.trim() || null,
      post_trade_notes: notes.trim() || null,
      emotional_state: emotionalState,
    };

    const { error: err } = await supabase.from('trade_plans').update(updates).eq('id', trade.id);

    if (err) {
      setError('שגיאה בשמירה — נסה שוב');
      setSaving(false);
      return;
    }

    onSaved({ ...trade, ...updates });
  }

  return (
    // Task-shaped: focus the first field (נכס). Without the ref this would
    // land on the header's × button, which leads the markup.
    <Modal onClose={onClose} labelledBy={editTitleId} initialFocusRef={symbolRef}>
      <div className="flex items-center justify-between mb-1">
        <p id={editTitleId} className="text-base font-bold" style={{ color: TEXT }}>עריכת עסקה</p>
        <button onClick={onClose} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
      </div>

      {/* One sentence, once, rather than a lock icon on each of four fields.
          It also answers the question the disabled inputs raise — why — which an
          icon cannot (E12). */}
      {factsLocked && (
        <p className="text-xs" style={{ color: MUTED }}>
          נתוני הביצוע הגיעו מ-Tradovate ואינם ניתנים לעריכה. אפשר לערוך את התכנון: אסטרטגיה,
          SL/TP, סיבת כניסה, הערות ומצב רגשי.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="נכס">
          <input ref={symbolRef} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            disabled={factsLocked} aria-readonly={factsLocked || undefined}
            className={FIELD_CLASS} style={factsLocked ? lockedStyle : fieldStyle} />
        </Field>
        <Field label="כיוון">
          <div className="flex rounded-xl overflow-hidden h-[38px]" style={{ border: `1px solid ${BORDER}` }}>
            <button type="button" onClick={() => toggleDirection('long')} disabled={factsLocked}
              className="flex-1 text-sm font-semibold transition-all disabled:cursor-not-allowed"
              style={{
                background: direction === 'long' ? 'rgba(74,222,128,0.12)' : 'transparent',
                color: direction === 'long' ? GREEN : TEXT2,
                opacity: factsLocked && direction !== 'long' ? 0.5 : 1,
              }}>
              לונג
            </button>
            <button type="button" onClick={() => toggleDirection('short')} disabled={factsLocked}
              className="flex-1 text-sm font-semibold transition-all disabled:cursor-not-allowed"
              style={{
                background: direction === 'short' ? 'rgba(248,113,113,0.12)' : 'transparent',
                color: direction === 'short' ? RED : TEXT2,
                opacity: factsLocked && direction !== 'short' ? 0.5 : 1,
              }}>
              שורט
            </button>
          </div>
        </Field>
      </div>

      <Field label="אסטרטגיה">
        <input value={strategy} onChange={e => setStrategy(e.target.value)}
          className={FIELD_CLASS} style={fieldStyle} />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="מחיר כניסה">
          <input type="number" step="any" value={entryPrice} onChange={e => setEntryPrice(e.target.value)}
            disabled={factsLocked} aria-readonly={factsLocked || undefined}
            className={`${FIELD_CLASS} text-center`} style={factsLocked ? lockedStyle : fieldStyle} />
        </Field>
        <Field label="Stop Loss">
          <input type="number" step="any" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
            className={`${FIELD_CLASS} text-center`} style={{ ...fieldStyle, borderColor: 'var(--color-tg-danger)' }} />
        </Field>
        <Field label="Take Profit">
          <input type="number" step="any" value={takeProfit} onChange={e => setTakeProfit(e.target.value)}
            className={`${FIELD_CLASS} text-center`} style={{ ...fieldStyle, borderColor: 'var(--color-tg-success)' }} />
        </Field>
      </div>

      {/* REF-99: this field was "כמות ומטבע" with a ₪/$ pair that could change
          the currency of an already-CLOSED trade. Dollar-only now, so the
          control is gone and the field is what it always really was. */}
      <Field label="כמות">
        <input type="number" step="any" value={quantity} onChange={e => setQuantity(e.target.value)}
          disabled={factsLocked} aria-readonly={factsLocked || undefined}
          className={`${FIELD_CLASS} text-center`} style={factsLocked ? lockedStyle : fieldStyle} />
      </Field>

      <Field label="סיבת כניסה">
        <textarea rows={2} value={tradeReason} onChange={e => setTradeReason(e.target.value)}
          className={`${FIELD_CLASS} resize-none`} style={fieldStyle} />
      </Field>

      <Field label="הערות">
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          className={`${FIELD_CLASS} resize-none`} style={fieldStyle} />
      </Field>

      <EmotionalStateSlider value={emotionalState ?? 3} onChange={setEmotionalState} />

      {error && <p className="text-xs" style={{ color: RED }}>{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={onClose}
          className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
          style={{ background: SURF2, color: TEXT2 }}>
          ביטול
        </button>
        <button onClick={handleSave} disabled={saving}
          className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: GOLD, color: '#0a0a0f' }}>
          {saving ? 'שומר...' : 'שמור שינויים'}
        </button>
      </div>
    </Modal>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function FilterIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}
