'use client';

import { useState, useEffect, useCallback, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Check, AlertTriangle, X, LineChart, EyeOff, ChevronDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { validateTradePlan, DEFAULT_PRESET_RULES } from '@/lib/validators/RulesetValidator';
import { useModalDialog } from '@/lib/a11y/useModalDialog';
import { useHydrated } from '@/lib/hooks';
import { calcRR } from '@/lib/utils';
import { TRADING_CURRENCY } from '@/lib/money';
import ValidationResultBanner from './ValidationResultBanner';
import EmotionalStateSlider from './EmotionalStateSlider';
import ConfidenceLevelSlider from './ConfidenceLevelSlider';
import OpenPlanPrompt, { type OpenPlanFromPreviousDay } from './OpenPlanPrompt';
import TodayContextPanel from './TodayContextPanel';
import CloseTrade from '@/components/journal/CloseTrade';
import dynamic from 'next/dynamic';
const TradingViewChart = dynamic(() => import('./TradingViewChart'), { ssr: false });
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import type { TradePlanInput, PresetRules, RulesetValidationResult, TradeStrategy, RuleContextSource, Timeframe } from '@/lib/types';
import type { PersonalStrategy } from '@/components/strategies/StrategiesClient';
import { getPlanLimits, type PlanTier } from '@/lib/plans/config';
import { fetchActiveRuleViolation } from '@/lib/rules/fetchActiveRuleViolation';
import { loadBrokerDayPull } from '@/lib/rules/brokerDayContext';
import { loadTodayTradeLines } from '@/lib/rules/brokerTradeList';
import type { TodayTradeLine } from '@/lib/rules/todayLines';
import { logRuleViolations, overrideRuleViolations, type RuleViolationLogInput } from '@/lib/rules/logRuleViolation';
import {
  loadTradeRuleContext,
  startOfTradingDayIso,
  type TodayClosedSummary,
} from '@/lib/rules/tradeRuleContext';
import { tradeDirection } from '@/lib/pnl';
import { NOT_ENTERED } from '@/lib/trades/status';
import {
  NEW_PORTFOLIO_VALUE,
  PORTFOLIO_COPY,
  UNASSIGNED_VALUE,
  portfolioLabel,
  shownPortfolios,
  sortPortfolios,
  statusLabel,
  type Portfolio,
} from '@/lib/portfolios/portfolio';
import {
  ensureManualPortfolio,
  readLastUsedPortfolioId,
  readPortfolios,
} from '@/lib/portfolios/read';

// Saved TP/SL input unit preference, read during render via
// useSyncExternalStore (null on the server / until a valid value is saved).
const emptySubscribe = () => () => {};
const getServerNull = () => null;
const getSavedPnlMode = (): 'points' | 'percent' | null => {
  const saved = localStorage.getItem('trade-plan-pnl-mode');
  return saved === 'points' || saved === 'percent' ? saved : null;
};

// REF-99: there was a `getSavedCurrency()` here reading a per-browser
// localStorage key, 'trade-plan-pnl-currency'. It was the user's default
// currency and it lived in the browser, so the same trader got one default on
// their phone and another on their desktop, and no rule knew about either. The
// product is dollar-only now; the key is simply no longer read. Nothing clears
// it — a stale value does no harm and a cleanup pass would be a write to every
// user's browser for no visible gain.

// The app's focus convention (see TradovateConnectionCard / AccessibilityWidget):
// a turquoise ring on keyboard focus only. A ring, not an outline, because the
// shared Button sets `focus:outline-none` in its base classes and a
// `focus-visible:outline-*` would be arguing with it.
const CHART_TOGGLE_FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary';

// Downgrades a "blocked" verdict to a warning when hard blocking is off.
// Nothing turns it off today — every plan has realTimeBlocking — but the policy
// is kept so the behaviour has one place to live if that ever changes again.
//
// NOT IN THIS PASS: that makes the whole downgrade branch below unreachable.
// lib/plans/config.ts maps free, basic and pro to the same FULL_LIMITS with
// realTimeBlocking: true, and nothing anywhere sets it false.
function applyRealTimeBlockingPolicy(result: RulesetValidationResult, realTimeBlocking: boolean): RulesetValidationResult {
  if (realTimeBlocking || result.status !== 'blocked') return result;
  return {
    status: 'warning',
    blockedReasons: [],
    warningReasons: [...result.warningReasons, ...result.blockedReasons],
    violations: result.violations.map((v) => (v.severity === 'block' ? { ...v, severity: 'warn' as const } : v)),
  };
}

const STRATEGIES: TradeStrategy[] = [
  'Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom',
  'ICT', 'SMC', 'VWAP', 'Supply & Demand', 'Price Action', 'Scalping',
  'Gap & Go', 'Elliott Wave', 'Fibonacci', 'Moving Average', 'RSI Divergence', 'Order Flow',
];

/**
 * The generic strategies shown without asking (REF-123). The rest of
 * `STRATEGIES` is one tap away behind "עוד".
 *
 * All seventeen in a flex-wrap is four to five rows — roughly 180px on a phone
 * — for a field answered with a single tap, and it was the largest vertical
 * cost in Step 1. This list is the broad-category end of that set: the four
 * families almost every other name on the list is a flavour of.
 *
 * FOUR AND NOT SEVEN, which is one rendered row rather than two (the chips
 * wrap three to a row in Hebrew at 390px). 'Custom', 'Price Action' and
 * 'Scalping' moved behind "עוד" with the named methodologies — a trader
 * reaching for any of them is reaching for something specific and will open
 * the list, while the trader whose answer is one of these four taps once.
 *
 * Deliberately a constant and not the trader's own most-used: their personal
 * strategies already render as their own group below, which is the
 * trader-specific half of this field, and a frequency query would make the
 * chips move around under them between form opens.
 */
const COMMON_STRATEGIES: TradeStrategy[] = [
  'Breakout', 'Trend Follow', 'Reversal', 'Range',
];

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', 'Daily', 'Weekly'];

// REF-123: a `PRE_TRADE_CHECKLIST` of four self-report checkboxes sat here —
// 'בדקתי R:R', 'הגדרתי Stop Loss', 'גודל הפוזיציה תואם לסיכון שהגדרתי',
// 'אין לי עסקאות פתוחות סותרות'. They are gone, and nothing replaces them,
// because they wrote to NO COLUMN and never had: the only state was a local
// Set, no `trade_plans` column could hold it, and `TradeScoreInput` has no
// checklist field — so a submission with all four ticked and one with none
// were byte-identical in the database and scored the same.
//
// Not to be confused with `strategy_conditions_checked` below, which is a
// different feature, really persisted and really scored. Three of the four are
// enforced mechanically anyway (the `min_rr_ratio` rule, `stop_loss` being
// required, the broker's own size comparison) and the fourth — conflicting open
// positions — is answered by TodayContextPanel + LivePositions, which sits
// directly above where these used to render.
const REASON_TAGS = [
  'בריקאאוט מתנגדות',
  'תנועת מומנטום',
  'תיקון לתמיכה',
  'דפוס גרף',
  'פריצת נפח',
  'רמת פיבונאצ\'י',
  'כניסה ב-VWAP',
  'Trend Follow בטרנד ברור',
  'היפוך בתמיכה מרכזית',
  'Range — גבול ערוץ',
  'אינדיקטור מאשר כיוון',
];

const EMPTY_FORM: TradePlanInput = {
  strategy: '',
  symbol: '',
  entry_price: '',
  stop_loss: '',
  take_profit: '',
  trade_reason: '',
  emotional_state: 3,
  confidence_level: 3,
  timeframe: '',
  direction: null,
  point_value: '1',
};

// REF-123: 'validating' was a state of its own while the mandatory rules
// pre-check existed. The check is part of the submit now and the button's own
// `loading` flag covers it, so there is no screen left for it to describe.
type FormState = 'empty' | 'editing' | 'warning' | 'blocked' | 'success' | 'error';

/** Before the first load. Paired with `contextLoaded`, which is what the panel
 *  actually keys off — these zeros are never shown to the user as fact. */
const EMPTY_TODAY_CLOSED: TodayClosedSummary = { count: 0, losingCount: 0, money: null };

// Mirrors the required-field conditions in isFormFilled below — one entry per condition,
// used to tell the user exactly what's missing instead of just disabling the button.
type RequiredFieldKey =
  | 'symbol'
  | 'direction'
  | 'strategy'
  | 'entry_price'
  | 'stop_loss'
  | 'take_profit'
  | 'trade_reason';

const REQUIRED_FIELD_LABELS: Record<RequiredFieldKey, string> = {
  symbol: 'סימול',
  direction: 'כיוון עסקה',
  strategy: 'אסטרטגיה',
  entry_price: 'מחיר כניסה',
  stop_loss: 'סטופ לוס',
  take_profit: 'טייק פרופיט',
  trade_reason: 'סיבת הכניסה',
};

// ── Plans left open from a previous day (REF-82 §5.2) ────────────────────────
//
// Everything OpenPlanPrompt shows, plus everything CloseTrade needs, so
// "סגרתי אותה" can open the journal's close dialog without a second fetch.

const OPEN_PLAN_SELECT =
  'id, symbol, strategy, direction, submitted_at, entry_price, stop_loss, take_profit, '
  + 'rr_ratio, emotional_state, trade_reason, units, quantity, point_value, pnl_currency';

interface OpenPlanRow {
  id: string;
  symbol: string | null;
  strategy: string;
  direction: 'long' | 'short' | null;
  submitted_at: string;
  entry_price: number | string;
  stop_loss: number | string;
  take_profit: number | string;
  rr_ratio: number | string;
  emotional_state: number | string;
  trade_reason: string;
  units: number | string | null;
  quantity: number | string | null;
  point_value: number | string | null;
  pnl_currency: string | null;
}

function mapOpenPlan(r: OpenPlanRow): OpenPlanFromPreviousDay {
  return {
    id: r.id,
    symbol: r.symbol ?? null,
    strategy: r.strategy,
    // Via tradeDirection(), not r.direction — rows written before the direction
    // column existed have it null, and that helper is the one place that knows
    // the take_profit-vs-entry fallback. status/exit_price are passed only
    // because its parameter type asks for them; it reads neither.
    direction: tradeDirection({
      status: 'open',
      entry_price: r.entry_price,
      exit_price: null,
      take_profit: r.take_profit,
      direction: r.direction,
    }),
    submitted_at: r.submitted_at,
    entry_price: Number(r.entry_price),
    stop_loss: Number(r.stop_loss),
    take_profit: Number(r.take_profit),
    rr_ratio: Number(r.rr_ratio),
    emotional_state: Number(r.emotional_state),
    trade_reason: r.trade_reason,
    // units ?? quantity — the same precedence the journal passes to CloseTrade,
    // because `units` is the newer column and older rows only have `quantity`.
    units: r.units != null ? Number(r.units) : r.quantity != null ? Number(r.quantity) : null,
    point_value: r.point_value != null ? Number(r.point_value) : null,
    pnl_currency: r.pnl_currency ?? null,
  };
}

interface TradePlanFormProps {
  userId: string;
  plan: PlanTier;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  /** A "warn"-action personal rule that's currently triggered — shown as a persistent banner, doesn't block submission. */
  initialWarning?: string | null;
  disciplineAlertsEnabled: boolean;
  /**
   * Migration 037 has been run, so `accounts` and `trade_plans.account_id`
   * exist (REF-110 Stage 3).
   *
   * A prop and not a call, for `withHidden`'s reason: the answer is
   * `isImportEnabled()`, which reads `process.env` in a server-only module.
   * The layout evaluates it and AppShell passes it down. False means the
   * "תיק" field is not rendered and `account_id` is not named by the insert —
   * which makes the insert byte-identical to the one that shipped before this
   * stage.
   */
  portfoliosEnabled?: boolean;
  /**
   * The trader has a broker view: the allowlist AND migration 037
   * (REF-108 Stage 3).
   *
   * A stricter gate than `portfoliosEnabled` and a different question — that
   * one asks whether the `accounts` table exists, this asks whether there is
   * anything to poll for. Evaluated in the layout, because `isUserAllowed`
   * reads process.env and is server-only. False means the day panel never
   * mounts the poll, which is the difference between one wasted request per
   * form open and none.
   */
  liveEnabled?: boolean;
}

export default function TradePlanForm({ userId, plan, isOpen, onClose, onSuccess, initialWarning, disciplineAlertsEnabled, portfoliosEnabled = false, liveEnabled = false }: TradePlanFormProps) {
  const limits = getPlanLimits(plan);
  const titleId = useId();
  const symbolRef = useRef<HTMLInputElement>(null);

  // Ids for the field labels and help text (REF-82, §9 of the build brief).
  // Generated rather than hardcoded for the same reason PriceInput generates
  // its own: the sheet is one component but there is no guarantee it is only
  // ever mounted once, and a duplicated id silently breaks the association
  // it exists to make.
  //
  // The two chip groups and the direction pair are labelled with a <span> +
  // role="group" rather than <fieldset>/<legend>, because a legend cannot be
  // laid out inside the flex column these sit in without fighting its
  // default rendering — and the accessible result is the same.
  const symbolId = useId();
  const directionLabelId = useId();
  const strategyLabelId = useId();
  const personalStrategyLabelId = useId();
  const reasonId = useId();
  const sizingNoteId = useId();

  // "הגדרות מתקדמות" — the one field in Step 2 that is not a price (REF-123).
  // Not reset by handleClose or by the post-submit reset: a trader who had to
  // open it once is the trader who will need it again, and the value behind it
  // does go back to its default of 1 with the rest of the form.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRegionId = useId();

  // "הוסף הערה" — the free-text entry reason, optional since REF-123. Same
  // no-reset reasoning as the disclosure above; the text itself is cleared
  // with the rest of the form.
  const [noteOpen, setNoteOpen] = useState(false);
  const noteRegionId = useId();
  const reasonTagsLabelId = useId();

  // "עוד" — whether the full generic strategy list is on screen (REF-123).
  const [strategiesExpanded, setStrategiesExpanded] = useState(false);

  // The chart is opt-in (REF-70): until the trader asks for it, TradingViewChart
  // isn't rendered at all, so neither its dynamic() chunk nor
  // s3.tradingview.com/tv.js is fetched and no symbol leaves the page.
  const [chartVisible, setChartVisible] = useState(false);
  const chartRegionId = useId();

  // ── Plans left open from a previous day (REF-82 §5.2) ──────────────────────
  //
  // Declared above handleClose because, like chartVisible, some of it is reset
  // on the way out.
  const openPlansHeadingId = useId();
  const [openPlans, setOpenPlans] = useState<OpenPlanFromPreviousDay[]>([]);
  /**
   * The plans "אחר כך" has hidden, for THIS opening of the sheet only.
   *
   * Component state and deliberately not localStorage: a dismissal that
   * survived a reload would let the question be answered by silence, which is
   * the failure this card exists to prevent ("without this, 'how many trades
   * today' breaks within a week"). Cleared in handleClose below, so the next
   * open asks again.
   */
  const [dismissedPlanIds, setDismissedPlanIds] = useState<Set<string>>(new Set());
  /** The plan whose 'not_entered' write is in flight. */
  const [markingPlanId, setMarkingPlanId] = useState<string | null>(null);
  const [openPlanError, setOpenPlanError] = useState('');
  /** The plan whose close dialog is open, if any. */
  const [closingPlanId, setClosingPlanId] = useState<string | null>(null);

  // ── The portfolio this trade belongs to (REF-110 Stage 3) ──────────────────
  //
  // Declared here, above handleClose, for the same reason the block above is:
  // the trader's choice is reset on the way out.
  //
  // THREE VALUES, NOT TWO. The select holds a UUID, UNASSIGNED_VALUE ('') for
  // "ללא תיק", or NEW_PORTFOLIO_VALUE while the trader is naming a new manual
  // portfolio. The third is form state and never reaches the database: on
  // submit it is exchanged for a real id by `ensureManualPortfolio`, and the
  // row is created THEN — so a sheet opened, typed into and abandoned writes
  // nothing.
  //
  // Unassigned is a real choice and not a missing one, which is why this
  // field is not in `missingFieldKeys`: a trade without a portfolio is
  // complete, and blocking a submit on it would let a bookkeeping question
  // gate recording a trade. A trader who has not decided files it with no
  // portfolio and assigns it later from the "ללא תיק" card on /accounts —
  // the same bucket every pre-REF-110 row is already in.
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [newPortfolioName, setNewPortfolioName] = useState('');
  /**
   * The default and the trader's override, held apart — and `null` is the
   * difference between "has not chosen" and "chose ללא תיק".
   *
   * One value would not do. `loadContext` runs on open AND AGAIN whenever a
   * leftover plan is closed from the open-plan prompt, and it applies the
   * last-used default; with a single value, closing yesterday's plan would
   * silently reset a portfolio the trader had just picked. That is the kind
   * of defect nobody reports, because from the outside it looks like having
   * mis-clicked.
   *
   * Two states rather than a "touched" ref because the ref would have to be
   * mutated from an event handler after being captured by `handleClose`'s
   * useCallback, which the React Compiler rejects — and is right to: the
   * state it would describe is derived, so it should be derived.
   */
  const [defaultPortfolioId, setDefaultPortfolioId] = useState<string>(UNASSIGNED_VALUE);
  const [portfolioChoice, setPortfolioChoice] = useState<string | null>(null);
  const portfolioId = portfolioChoice ?? defaultPortfolioId;

  // Closing the sheet puts the chart back behind the button, so the next open
  // starts opted out again. It needs its own reset: the sheet keeps the rest of
  // its state across a plain close (only a successful submit clears the form),
  // and it stays mounted while closed — `if (!isOpen) return null` below renders
  // nothing but unmounts nothing. Every close path goes through the `onClose`
  // prop, so wrapping it here covers Escape, the backdrop and the X button.
  //
  // The open-plan prompt resets here for the same reason and on the same path:
  // "אחר כך" lasts one opening, and a half-finished close or a stale error
  // message must not be waiting when the sheet comes back.
  const handleClose = useCallback(() => {
    setChartVisible(false);
    setDismissedPlanIds(new Set());
    setClosingPlanId(null);
    setOpenPlanError('');
    // A portfolio choice lasts one opening, like "אחר כך" above it: the next
    // time the sheet opens, the last-used default applies again (REF-110).
    setPortfolioChoice(null);
    setNewPortfolioName('');
    onClose();
  }, [onClose]);

  // Task-shaped dialog: focus the symbol field, the first thing you fill in,
  // rather than the close button. The sheet has no trigger element to hand
  // back to — it opens from the sidebar CTA, from EmptyStateButton, or from a
  // bare `open-trade-form` event — so useModalDialog captures whatever had
  // focus at open time and restores that.
  const { dialogProps } = useModalDialog({
    open: isOpen, onClose: handleClose, labelledBy: titleId, initialFocusRef: symbolRef,
  });
  const [form, setForm] = useState<TradePlanInput>(EMPTY_FORM);
  const [formState, setFormState] = useState<FormState>('empty');
  const [validationResult, setValidationResult] = useState<RulesetValidationResult | null>(null);
  const [presetRules, setPresetRules] = useState<PresetRules | null>(null);
  const [todayCount, setTodayCount] = useState(0);
  const [lossCount, setLossCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [todayLossAmount, setTodayLossAmount] = useState(0);

  // ── The context panel's view of today (REF-82 §2.1) ────────────────────────
  //
  // All of it comes off the SAME loadTradeRuleContext result as the three rule
  // inputs above. No second query and no second arithmetic: the panel tells the
  // user what the rules are about to act on, so a figure of its own would be a
  // way for the two to disagree — see the header of lib/rules/tradeRuleContext.ts.
  const [todayClosed, setTodayClosed] = useState<TodayClosedSummary>(EMPTY_TODAY_CLOSED);
  const [contextSource, setContextSource] = useState<RuleContextSource>('reflect_only');
  /**
   * Whether the broker's view of today was incomplete (REF-112-C item 3).
   *
   * A SECOND FLAG BESIDE `contextSource` AND NOT A FIFTH VALUE IN IT: the four
   * `RuleContextSource` values are a CHECK constraint in migration 032, so a
   * fifth would be a migration for something that is a different question
   * anyway. `source` says whether the broker answered; this says whether the
   * answer covered the whole day.
   */
  const [contextPartial, setContextPartial] = useState(false);
  /** False until the first load returns, so the panel never states zeros as fact. */
  const [contextLoaded, setContextLoaded] = useState(false);
  /**
   * Today's closes itemised, for the panel's list (REF-107).
   *
   * THE ONE THING IN THIS PANEL THAT DOES NOT COME OFF `loadTradeRuleContext`
   * — and it is not a figure, it is the detail behind one. The rule engine's
   * route answers with scalars and will not carry rows: api/tradovate/today's
   * header states that split and the regression suite asserts it. So the list
   * comes from api/tradovate/trades, the route built to send a trader their
   * own positions, whose header records the bounds of that decision.
   *
   * Fetched AFTER the day pull and only when that pull reported closes — see
   * lib/rules/brokerTradeList.ts on why the second request is conditional — so
   * the panel renders its sentences immediately and grows the list a moment
   * later, and a quiet day costs nothing extra at all.
   */
  const [todayLines, setTodayLines] = useState<TodayTradeLine[] | null>(null);
  const todayContextHeadingId = useId();
  const [personalStrategyRows, setPersonalStrategyRows] = useState<PersonalStrategy[]>([]);
  // Session override wins over the saved preference, which wins over the default
  const [pnlModeOverride, setPnlModeOverride] = useState<'points' | 'percent' | null>(null);
  const [slInput, setSlInput] = useState('');
  const [tpInput, setTpInput] = useState('');
  /**
   * The entry-reason chips the trader has picked (REF-123).
   *
   * THE REQUIRED FIELD IN STEP 4 IS THIS SET, not the textarea. The chips used
   * to append their own text into the textarea and the textarea was what the
   * form demanded, so the cheapest path through the section was still typing a
   * sentence. Now the set is the answer and `form.trade_reason` holds only the
   * optional note; the two are composed into the one `trade_reason` column on
   * submit — see `composedTradeReason`.
   */
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [strategyConditionsChecked, setStrategyConditionsChecked] = useState<Record<string, boolean>>({});
  const [fetchedStrategyTradeCount, setFetchedStrategyTradeCount] = useState(0);
  const [chartSymbol, setChartSymbol] = useState('');
  const [chartTimeframe, setChartTimeframe] = useState('');

  // The "תיק" field's ids. Its state lives above handleClose, with the rest
  // of what the sheet resets on the way out (REF-110 Stage 3).
  const portfolioFieldId = useId();
  const portfolioHintId = useId();
  const newPortfolioFieldId = useId();

  // Stable client identity so it can appear in hook deps without refiring
  // them every render (in demo mode createClient returns a fresh Proxy).
  const supabase = useMemo(() => createClient(), []);

  const savedPnlMode = useSyncExternalStore(emptySubscribe, getSavedPnlMode, getServerNull);
  const pnlMode = pnlModeOverride ?? savedPnlMode ?? 'points';

  function toggleConditionChecked(condition: string) {
    setStrategyConditionsChecked((prev) => ({ ...prev, [condition]: !prev[condition] }));
  }

  function changePnlMode(mode: 'points' | 'percent') {
    setPnlModeOverride(mode);
    localStorage.setItem('trade-plan-pnl-mode', mode);
  }

  const entryNum = parseFloat(form.entry_price);
  const hasEntry = form.entry_price !== '' && !isNaN(entryNum);

  const pointValueParsed = parseFloat(form.point_value);
  const pointValueNum = form.point_value.trim() !== '' && !isNaN(pointValueParsed) && pointValueParsed > 0
    ? pointValueParsed
    : 1;

  // נק׳ mode: the field holds the actual target price directly (no conversion).
  // % mode: the field holds a percentage offset from the entry price —
  // SL = entry × (1 − pct/100), TP = entry × (1 + pct/100).
  function inputToPrice(inputStr: string, kind: 'sl' | 'tp'): number | null {
    if (!hasEntry || inputStr.trim() === '') return null;
    const val = parseFloat(inputStr);
    if (isNaN(val)) return null;
    if (pnlMode === 'points') return val;
    return kind === 'sl' ? entryNum * (1 - val / 100) : entryNum * (1 + val / 100);
  }

  const slPrice = inputToPrice(slInput, 'sl');
  const tpPrice = inputToPrice(tpInput, 'tp');

  /**
   * What goes into the `trade_reason` column (REF-123): the chosen chips, then
   * the optional note, comma-joined.
   *
   * Comma-joined and in that order deliberately — it is the same shape the
   * column has always held, because the chips used to write themselves into
   * the textarea with `', '`. Every reader of this column is a pass-through
   * (the journal, the CSV export, two AI prompts); nothing splits it back
   * apart, so changing the separator would change what traders read with no
   * upside.
   *
   * With one chip required this is never empty, which is what satisfies
   * `trade_reason NOT NULL` in the live schema without a migration.
   */
  const composedTradeReason = useMemo(
    () => [...selectedTags, form.trade_reason.trim()].filter((p) => p !== '').join(', '),
    [selectedTags, form.trade_reason],
  );

  function fmtPrice(n: number): string {
    return parseFloat(n.toFixed(6)).toString();
  }

  const loadContext = useCallback(async () => {
    setLoading(true);

    // Trade history through loadTradeRuleContext, the same function the
    // open-the-form gate uses. This used to be worked out here with its own
    // arithmetic — price distance instead of money, and "the stop was hit"
    // instead of "money was lost" — which meant the gate and this form could
    // disagree about the same two preset rules for the same user at the same
    // moment. See lib/rules/tradeRuleContext.ts.
    //
    // Today as the broker reports it (REF-90). The gate in AppShell pulled this
    // a moment ago, on its way to opening this form, and loadBrokerDayPull()
    // holds a pull briefly — so this is normally the SAME object the gate
    // judged, rather than a second look at a day that may have moved. Started
    // inside the Promise.all so the pull overlaps the three queries.
    // The trader's portfolios and the one their last plan was filed under
    // (REF-110 Stage 3). Both inside the existing Promise.all rather than
    // after it, so the field costs no added latency on a form open — and both
    // issue ZERO statements when migration 037 has not been run, which is
    // what `portfoliosEnabled` is for.
    const [rulesRes, personalRes, history, openPlansRes, portfolioRows, lastUsedId] = await Promise.all([
      supabase.from('preset_rules').select('*').eq('user_id', userId).single(),
      supabase.from('personal_strategies').select('*').eq('user_id', userId).order('created_at'),
      loadBrokerDayPull(userId).then((broker) => loadTradeRuleContext(userId, broker, supabase)),
      // Plans still open from BEFORE today (REF-82 §5.2).
      //
      // The day boundary is startOfTradingDayIso() from tradeRuleContext — the same
      // seam loadTradeRuleContext uses for "trades taken today", and
      // deliberately not a second calculation. With two, a plan submitted just
      // after local midnight could be counted against today's limit AND
      // offered here as yesterday's leftover, and the user would be asked what
      // happened to a plan they are still in.
      //
      // Oldest first: the plan that has been waiting longest is the one most
      // likely to have gone unreported, so it leads.
      supabase
        .from('trade_plans')
        .select(OPEN_PLAN_SELECT)
        .eq('user_id', userId)
        .eq('status', 'open')
        .lt('submitted_at', startOfTradingDayIso())
        .order('submitted_at', { ascending: true }),
      readPortfolios(supabase, userId, portfoliosEnabled),
      readLastUsedPortfolioId(supabase, userId, portfoliosEnabled),
    ]);

    // Hidden portfolios are dropped here and not on the screen: hiding one
    // means "stop offering me this", and a form that still listed it would
    // make the hide read as cosmetic. A trade already filed under a hidden
    // portfolio keeps it — nothing here rewrites an existing row.
    const choosable = sortPortfolios(shownPortfolios(portfolioRows));
    setPortfolios(choosable);

    // The default (REF-110 §B): the portfolio of the trader's most recent
    // plan. It is only applied when that portfolio is still CHOOSABLE — a
    // trader who hid it, or whose last plan predates a rename, gets no
    // default rather than a selection they cannot see in the list. A
    // first-time trader gets none either, which is the correct degradation.
    //
    // Deliberately reasserted on every form open rather than only the first:
    // the whole point of "last used" is that it tracks what the trader has
    // been doing, and a session that opened the form before their first sync
    // would otherwise keep the empty answer all day.
    setDefaultPortfolioId(
      lastUsedId !== null && choosable.some((p) => p.id === lastUsedId)
        ? lastUsedId
        : UNASSIGNED_VALUE,
    );

    if (personalRes.data) setPersonalStrategyRows(personalRes.data as PersonalStrategy[]);
    if (rulesRes.data) setPresetRules(rulesRes.data as PresetRules);

    setTodayCount(history.todayTradeCount);
    setTodayLossAmount(history.todayLossAmount);
    setLossCount(history.lossStreak);

    // The panel's figures, off the same object the three rule inputs above came
    // from — so when `source` is 'broker_verified' the sentence the user reads
    // describes the broker's closes, which are the closes the rules just acted
    // on, and when it is anything else both describe Reflect's.
    setTodayClosed(history.todayClosed);
    setContextSource(history.source);
    // REF-112-C item 3. Off the SAME object as the figures, for the reason
    // above: on a partial day `loadTradeRuleContext` has already fallen back to
    // Reflect's own rows, so this flag and `todayClosed` have to move together
    // or the panel would call the broker's data partial while displaying it.
    setContextPartial(history.partial);
    setContextLoaded(true);

    // `?? []` rather than the `if (data)` guard the two above use: an empty
    // list is the honest state when the query failed, and showing nothing is
    // better than leaving a card on screen that may already be answered.
    setOpenPlans(((openPlansRes.data ?? []) as unknown as OpenPlanRow[]).map(mapOpenPlan));

    setLoading(false);

    // ── The panel's itemised list, and ONLY when there is one to draw ───────
    //
    // After `setLoading(false)` deliberately: the form is usable and the panel
    // is already showing the day's figures, so this cannot delay either. And
    // behind both gates, because `/api/tradovate/trades` makes a full broker
    // pull — eight to ten upstream reads plus pricing (§A2) — and the day pull
    // above has just made one. Asking unconditionally would double the
    // upstream cost of opening the trade form against a rate-limited third
    // party, on the most-used surface in the product.
    //
    // `closedCount === 0` is most form opens, including every one before the
    // first trade of the day, and there is nothing to itemise then anyway.
    // AND NOT ON A PARTIAL DAY (REF-112-C item 3). The list comes from
    // /api/tradovate/trades — the BROKER's rows — while on a partial day
    // `todayClosed` has fallen back to Reflect's. `showsLineList` would usually
    // decline to draw them anyway, because the two counts will not match; but
    // "usually" is not good enough here, since its one condition is an equal
    // count and two different sets can be the same size. Then it would render
    // the broker's rows under a net the rules computed from Reflect's, which is
    // exactly the self-contradicting panel that check exists to prevent.
    //
    // It also saves the second eight-to-ten-request pull on a day we already
    // know we will not draw a list for.
    if (history.source === 'broker_verified' && !history.partial && history.todayClosed.count > 0) {
      setTodayLines(await loadTodayTradeLines());
    } else {
      // A reload after the day moved — the trader closed the last open plan —
      // must not leave yesterday's list on screen.
      setTodayLines(null);
    }
  }, [supabase, userId, portfoliosEnabled]);

  useEffect(() => {
    // loadContext flips the loading flag synchronously to mark the fetch this
    // effect itself starts — deferring it would blank the spinner for a frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the in-flight state of the fetch started here
    if (isOpen) loadContext();
  }, [isOpen, loadContext]);

  // ── The open-plan prompt's behaviour ───────────────────────────────────────

  const visibleOpenPlans = useMemo(
    () => openPlans.filter((p) => !dismissedPlanIds.has(p.id)),
    [openPlans, dismissedPlanIds],
  );

  const closingPlan = useMemo(
    () => openPlans.find((p) => p.id === closingPlanId) ?? null,
    [openPlans, closingPlanId],
  );
  const closePlanTitleId = useId();
  const closePlanExitPriceRef = useRef<HTMLInputElement>(null);

  // The first button of each card, so focus can be placed on a SURVIVING card
  // after one leaves. This matters more here than it does in the journal: the
  // control that had focus is inside a card that no longer exists, and
  // useModalDialog's fallback for a vanished restore target is #main-content —
  // which sits outside this sheet, so letting it fire would drop the user out
  // of the dialog they are still working in.
  const planButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // undefined — nothing pending. A string — focus that card. null — focus the
  // symbol field, which is where someone who came to write a plan wants to be.
  const focusAfterPlanActionRef = useRef<string | null | undefined>(undefined);

  const registerPlanButton = useCallback((planId: string, el: HTMLButtonElement | null) => {
    planButtonRefs.current[planId] = el;
  }, []);

  /** The card that should take focus once `planId`'s card is gone. */
  function focusTargetAfterRemoving(planId: string): string | null {
    const i = visibleOpenPlans.findIndex((p) => p.id === planId);
    return visibleOpenPlans[i + 1]?.id ?? visibleOpenPlans[i - 1]?.id ?? null;
  }

  // Keyed on the rendered list so it runs in the same commit that removes the
  // card — the same ordering the journal relies on after a row delete.
  useEffect(() => {
    const target = focusAfterPlanActionRef.current;
    if (target === undefined) return;
    focusAfterPlanActionRef.current = undefined;
    if (target !== null) planButtonRefs.current[target]?.focus();
    else symbolRef.current?.focus();
  }, [visibleOpenPlans]);

  function dismissPlan(plan: OpenPlanFromPreviousDay) {
    setOpenPlanError('');
    focusAfterPlanActionRef.current = focusTargetAfterRemoving(plan.id);
    setDismissedPlanIds((prev) => new Set(prev).add(plan.id));
  }

  async function markPlanNotEntered(plan: OpenPlanFromPreviousDay) {
    setMarkingPlanId(plan.id);
    setOpenPlanError('');

    // status and nothing else. No closed_at, no exit price, no P&L — there was
    // no trade, and writing a closing timestamp would make one up. Note that
    // the status CHECK from migration 032 has to be applied for this to
    // succeed; until it is, Postgres rejects the value and the user sees the
    // error below.
    const { error } = await supabase
      .from('trade_plans')
      .update({ status: NOT_ENTERED })
      // Guards against the plan having been closed in another tab since this
      // card was drawn: then the update matches nothing and the close stands,
      // rather than this overwriting a real exit price and its P&L.
      .eq('id', plan.id)
      .eq('status', 'open');

    setMarkingPlanId(null);

    if (error) {
      setOpenPlanError('לא הצלחנו לשמור את התשובה. אפשר לנסות שוב.');
      return;
    }

    focusAfterPlanActionRef.current = focusTargetAfterRemoving(plan.id);
    setOpenPlans((prev) => prev.filter((p) => p.id !== plan.id));

    // No reload of the rule context. This plan was submitted before today, so
    // it was never in todayTradeCount, and lossStreak/todayLossAmount read only
    // closed rows — marking it 'not_entered' changes none of the three.
  }

  function handlePlanClosed(planId: string) {
    setClosingPlanId(null);
    focusAfterPlanActionRef.current = focusTargetAfterRemoving(planId);
    setOpenPlans((prev) => prev.filter((p) => p.id !== planId));

    // A reload, unlike the 'not_entered' path: CloseTrade wrote closed_at = now,
    // so this plan has just joined TODAY's closed set. todayLossAmount and
    // lossStreak both change, and they are what the gate on submit is about to
    // judge the new plan against — stale numbers here mean a max_daily_loss or
    // cooldown_after_losses rule silently fails to fire.
    loadContext();
  }

  // Debounced so the chart doesn't chase every keystroke. Symbol and timeframe
  // only: the price fields used to feed this too, but nothing downstream reads
  // them any more now that the level lines are gone, so editing a price leaves
  // the widget alone.
  useEffect(() => {
    const t = setTimeout(() => {
      setChartSymbol(form.symbol.trim());
      setChartTimeframe(form.timeframe);
    }, 800);
    return () => clearTimeout(t);
  }, [form.symbol, form.timeframe]);

  const rr = hasEntry && slPrice !== null && tpPrice !== null
    ? calcRR(entryNum, slPrice, tpPrice)
    : null;

  /**
   * The generic chips on screen (REF-123): the common ones, plus whichever
   * chip is currently chosen.
   *
   * That second clause is what keeps the field honest. A trader who picked
   * 'Fibonacci', then changed the symbol, must still see their own answer
   * selected — if the chip it lives on were hidden, the form would be holding
   * a strategy it is not showing, and `missingFieldKeys` would say nothing is
   * missing while the section looked unanswered. Expanding is one-way within a
   * sheet opening, so this only ever matters before the first expand.
   */
  const shownStrategies = useMemo(
    () => (strategiesExpanded
      ? STRATEGIES
      : STRATEGIES.filter((s) => COMMON_STRATEGIES.includes(s) || form.strategy === s)),
    [strategiesExpanded, form.strategy],
  );
  const hiddenStrategyCount = STRATEGIES.length - shownStrategies.length;

  const selectedStrategy = useMemo(
    () => personalStrategyRows.find((s) => s.name === form.strategy) ?? null,
    [personalStrategyRows, form.strategy],
  );

  // Reset checklist state whenever the selected strategy changes — every
  // condition is explicitly seeded to false, never true, so a freshly selected
  // strategy always starts fully unchecked. Adjusted during render (the
  // documented compare-and-set pattern) instead of an effect, so the seeded
  // checklist and the strategy land in the same commit.
  const [seededStrategyId, setSeededStrategyId] = useState<string | null | undefined>(undefined);
  if (seededStrategyId !== (selectedStrategy?.id ?? null)) {
    setSeededStrategyId(selectedStrategy?.id ?? null);
    const initial: Record<string, boolean> = {};
    for (const condition of selectedStrategy?.entry_conditions ?? []) {
      initial[condition] = false;
    }
    setStrategyConditionsChecked(initial);

    // REF-123: Timeframe now lives behind "הגדרות מתקדמות", and a personal
    // strategy can make it a condition — `complianceChecks` reports
    // "טיים-פריים" against `allowed_timeframes`. A trader told they fail a
    // criterion whose field is not on screen has been given a problem without
    // its control, so picking such a strategy opens the disclosure. Set here
    // rather than derived into `open`, so the trader can still close it: this
    // reveals the field once, it does not pin it open.
    if ((selectedStrategy?.allowed_timeframes.length ?? 0) > 0) setAdvancedOpen(true);
  }

  // Live count of today's trades logged under this strategy (for the
  // daily-trade-limit check). The fetched number only applies while a
  // limit-bearing strategy is selected; otherwise the count is 0 by definition.
  const todayStrategyTradeCount =
    !selectedStrategy || selectedStrategy.max_daily_trades == null
      ? 0
      : fetchedStrategyTradeCount;

  useEffect(() => {
    if (!selectedStrategy || selectedStrategy.max_daily_trades == null) return;
    const todayStart = startOfTradingDayIso();
    let cancelled = false;
    supabase
      .from('trade_plans')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('strategy', selectedStrategy.name)
      // The strategy's own daily limit, and the same exclusion
      // loadTradeRuleContext makes for the preset one: a plan the user never
      // entered must not eat into the allowance.
      .neq('status', 'not_entered')
      .gte('submitted_at', todayStart)
      .then(({ count }) => {
        if (!cancelled) setFetchedStrategyTradeCount(count ?? 0);
      });
    return () => { cancelled = true; };
  }, [selectedStrategy, userId, supabase]);

  const complianceChecks = useMemo(() => {
    if (!selectedStrategy) return [];
    const checks: { label: string; passed: boolean }[] = [];

    if (selectedStrategy.min_rr != null) {
      checks.push({ label: 'R:R', passed: rr !== null && rr >= selectedStrategy.min_rr });
    }

    if (selectedStrategy.trading_hours_start && selectedStrategy.trading_hours_end) {
      const now = new Date();
      const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const start = selectedStrategy.trading_hours_start;
      const end = selectedStrategy.trading_hours_end;
      const withinHours = start <= end
        ? current >= start && current <= end
        : current >= start || current <= end;
      checks.push({ label: 'שעות מסחר', passed: withinHours });
    }

    if (selectedStrategy.allowed_timeframes.length > 0) {
      checks.push({
        label: 'טיים-פריים',
        passed: form.timeframe !== '' && selectedStrategy.allowed_timeframes.includes(form.timeframe),
      });
    }

    if (selectedStrategy.direction !== 'both') {
      checks.push({ label: 'כיוון', passed: form.direction !== null && form.direction === selectedStrategy.direction });
    }

    if (selectedStrategy.max_daily_trades != null) {
      checks.push({ label: 'עסקאות היום', passed: todayStrategyTradeCount < selectedStrategy.max_daily_trades });
    }

    return checks;
  }, [selectedStrategy, rr, form.timeframe, form.direction, todayStrategyTradeCount]);

  const entryConditions = selectedStrategy?.entry_conditions ?? [];
  const complianceTotal = complianceChecks.length + entryConditions.length;
  const compliancePassed = complianceChecks.filter((c) => c.passed).length
    + entryConditions.filter((c) => strategyConditionsChecked[c] === true).length;
  const complianceFailed = complianceTotal - compliancePassed;

  const missingFieldKeys = useMemo<RequiredFieldKey[]>(() => {
    const missing: RequiredFieldKey[] = [];
    if (form.symbol.trim() === '') missing.push('symbol');
    if (form.direction === null) missing.push('direction');
    if (form.strategy === '') missing.push('strategy');
    if (!hasEntry) missing.push('entry_price');
    if (slPrice === null) missing.push('stop_loss');
    if (tpPrice === null) missing.push('take_profit');
    // One CHIP, not any text: the note is optional and a trader who typed only
    // a sentence has still not told us which of the eleven reasons this is.
    if (selectedTags.size === 0) missing.push('trade_reason');
    return missing;
  }, [form.symbol, form.direction, form.strategy, hasEntry, slPrice, tpPrice, selectedTags]);

  const isFormFilled = missingFieldKeys.length === 0;

  // What the one submit button says, and whether it is usable at all (REF-123).
  //
  // Both read the banner rather than formState, because every field's onChange
  // calls setValidationResult(null) and none of them touches formState: after
  // an edit, formState can still say 'blocked' about a plan that no longer is.
  // While there were two buttons that could not show — the submit only
  // rendered `{validationResult && …}` — and with one button it would be a
  // trade the trader cannot file.
  const isBlocked = validationResult?.status === 'blocked';
  const hasPendingWarning = validationResult?.status === 'warning';

  const fieldRefs = useRef<Partial<Record<RequiredFieldKey, HTMLDivElement | null>>>({});
  const [highlightedFields, setHighlightedFields] = useState<Set<RequiredFieldKey>>(new Set());
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
  }, []);

  function fieldHighlightStyle(key: RequiredFieldKey): React.CSSProperties {
    return {
      borderRadius: 12,
      boxShadow: highlightedFields.has(key) ? '0 0 0 3px rgba(0, 210, 210, 0.6)' : '0 0 0 3px rgba(0, 210, 210, 0)',
      transition: 'box-shadow 300ms ease',
    };
  }

  // Called when the user clicks a submit-ish button while fields are still missing —
  // highlights each missing field briefly and scrolls the first one into view.
  function highlightMissingFields() {
    if (missingFieldKeys.length === 0) return;
    setHighlightedFields(new Set(missingFieldKeys));
    fieldRefs.current[missingFieldKeys[0]]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlightTimeoutRef.current) clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = setTimeout(() => setHighlightedFields(new Set()), 2000);
  }

  // Ids of the 'warned' rule_violations rows logged when a warning was last shown
  // to the user — upgraded to 'overridden' if they go on to submit this trade.
  const warnedViolationIdsRef = useRef<string[]>([]);

  // Scrolls the warning banner into view + a brief glow, but only the first time a given
  // set of warnings appears — not on every re-render while it's already on screen.
  const warningBannerRef = useRef<HTMLDivElement | null>(null);
  const [warningBannerPulse, setWarningBannerPulse] = useState(false);
  const lastWarningSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!validationResult || validationResult.status !== 'warning') {
      lastWarningSignatureRef.current = null;
      return;
    }
    const signature = validationResult.warningReasons.join('|');
    if (signature === lastWarningSignatureRef.current) return;
    lastWarningSignatureRef.current = signature;

    warningBannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setWarningBannerPulse(true);
    const t = setTimeout(() => setWarningBannerPulse(false), 1500);
    return () => clearTimeout(t);
  }, [validationResult]);

  const step1Done = form.symbol.trim() !== '' && form.direction !== null && form.strategy !== '';
  const step2Done = hasEntry && slPrice !== null && tpPrice !== null;

  const activeStep = useMemo(() => {
    if (!step1Done) return 1;
    if (!step2Done) return 2;
    return 4;
  }, [step1Done, step2Done]);

  /**
   * The whole terminal interaction, in one click (REF-123).
   *
   * There used to be a mandatory `בדוק מול החוקים שלי` press before the submit
   * button would even render, with 800ms of `setTimeout` pretending the check
   * was slow — on a 30-second budget, 3% of it spent simulating work that is
   * synchronous and local. Both are gone: the rules check runs here, and what
   * the trader sees depends on its verdict.
   *
   * - valid: inserted on this click.
   * - blocked: the banner, no insert. Unchanged.
   * - warning: the banner, no insert, and the button becomes `הגש בכל זאת`.
   *   A SECOND CLICK IS DELIBERATE AND IS NOT THE OLD GATE COMING BACK. The
   *   `rule_violations` ledger distinguishes 'warned' from 'overridden', and
   *   'overridden' is supposed to mean the trader was shown the warning and
   *   went ahead anyway. Submitting through an unseen warning would write that
   *   row for a decision nobody made, and the discipline history the coach
   *   reads is built on it. So the clean path is one click and a warning costs
   *   exactly one more — on the plan where stopping is the point.
   *
   * Re-shown rather than waved through when the warnings CHANGE between the
   * two clicks: the acknowledgement is of a specific set of reasons, not of
   * the idea of a warning.
   */
  async function handleSubmit() {
    if (!isFormFilled || slPrice === null || tpPrice === null) return;

    // From the first click, because the custom-rule re-check below makes a
    // broker pull. The button is the only thing on screen that can say so now
    // that there is no separate 'validating' state.
    setSubmitLoading(true);

    // Preset rules — synchronous and local (validateTradePlan is pure).
    const rules = presetRules ?? ({ ...DEFAULT_PRESET_RULES, id: '', user_id: userId, created_at: '', updated_at: '' } as PresetRules);
    const planForValidation: TradePlanInput = { ...form, trade_reason: composedTradeReason, stop_loss: fmtPrice(slPrice), take_profit: fmtPrice(tpPrice) };
    const result = applyRealTimeBlockingPolicy(validateTradePlan(
      planForValidation, rules, todayCount, lossCount, todayLossAmount,
      personalStrategyRows.map((s) => s.name),
      selectedStrategy?.min_rr ?? null,
    ), limits.realTimeBlocking);

    // Re-check custom rules against current data too — unlike preset rules, these are
    // normally only evaluated once, when the form opens (fetchActiveRuleViolation), and
    // can go stale by the time the user actually submits. Reuses that same check as-is;
    // the generic (non-custom) preset branch it can also return is ignored here since
    // validateTradePlan above already covers preset rules. Skipped when the user has
    // turned off discipline alerts — matches the gate at form-open time in AppShell.
    //
    // THE BROKER PULL HERE IS DELIBERATELY ALLOWED TO BE NEWER than the one the
    // figures above came from (REF-90). Those are the open-time figures, which
    // the gate in AppShell judged the same day against — that pairing is the
    // one that must not diverge, and it does not. This check is the extra look
    // at a day that may have moved in the twenty minutes since, and it can only
    // ADD a block: `customBlocked` is OR-ed into the verdict below and never
    // clears one. Newer data in the conservative direction, which is the whole
    // point of re-checking.
    const activeCheck = disciplineAlertsEnabled
      ? await fetchActiveRuleViolation(userId, await loadBrokerDayPull(userId), limits.realTimeBlocking)
      : null;
    const customViolation = activeCheck?.customRule ? activeCheck : null;
    const customBlocked = customViolation !== null
      && (customViolation.actionType === 'block_day' || customViolation.actionType === 'block_timer');

    if (result.status === 'blocked' || customBlocked) {
      setValidationResult(customBlocked && result.status !== 'blocked'
        ? { ...result, status: 'blocked', blockedReasons: [...result.blockedReasons, customViolation!.description] }
        : result);
      setFormState('blocked');
      logRuleViolations([
        ...result.violations.filter((v) => v.severity === 'block').map((v): RuleViolationLogInput => ({
          userId, ruleSource: 'preset', customRuleId: null,
          ruleKey: v.ruleKey, ruleName: v.ruleName, outcome: 'blocked', tradePlanId: null,
        })),
        ...(customBlocked ? [{
          userId, ruleSource: 'custom' as const, customRuleId: customViolation!.customRule!.id,
          ruleKey: customViolation!.customRule!.condition_type, ruleName: customViolation!.customRule!.name,
          outcome: 'blocked' as const, tradePlanId: null,
        }] : []),
      ]);
      setSubmitLoading(false);
      return;
    }

    // ── A warning the trader has not been shown yet ─────────────────────────
    //
    // Logged as 'warned' at the moment it is first displayed, exactly as the
    // removed handleValidate did: if the trader abandons the form here these
    // rows stay 'warned', and if they press `הגש בכל זאת` the insert below
    // upgrades this exact batch to 'overridden'.
    // Off `validationResult` and NOT off formState, because editing any field
    // clears the banner (`setValidationResult(null)`) without touching
    // formState — so formState can still say 'warning' about a plan the trader
    // has since changed, and this question is only ever about the reasons
    // currently on screen.
    const warningSignature = result.warningReasons.join('|');
    const warningAlreadyShown = validationResult?.status === 'warning'
      && validationResult.warningReasons.join('|') === warningSignature;

    if (result.status === 'warning' && !warningAlreadyShown) {
      setValidationResult(result);
      setFormState('warning');
      const warnEntries: RuleViolationLogInput[] = result.violations
        .filter((v) => v.severity === 'warn')
        .map((v) => ({
          userId, ruleSource: 'preset', customRuleId: null,
          ruleKey: v.ruleKey, ruleName: v.ruleName, outcome: 'warned', tradePlanId: null,
        }));
      logRuleViolations(warnEntries).then((ids) => { warnedViolationIdsRef.current = ids; });
      setSubmitLoading(false);
      return;
    }

    // Valid (blocked returned above, warning is the acknowledged case): no
    // banner to show, and no 'warned' batch waiting to be upgraded.
    if (result.status === 'valid') {
      setValidationResult(null);
      warnedViolationIdsRef.current = [];
    }

    const entry = entryNum;
    const sl = slPrice;
    const tp = tpPrice;

    // ── The portfolio, resolved to an id (REF-110 Stage 3) ───────────────────
    //
    // THE LAZY CREATION HAPPENS HERE AND NOWHERE ELSE. "תיק חדש…" is a form
    // state until this line; a trader who opened the sheet, typed a name and
    // changed their mind has written nothing. `ensureManualPortfolio` is
    // idempotent by name, so a double-submit — or the same name typed again
    // next week — reuses the row rather than making a second one called the
    // same thing.
    //
    // A refused creation resolves to null and the trade is filed UNASSIGNED
    // rather than lost. The trade is the thing the trader came here to
    // record; the portfolio is bookkeeping they can fix from /accounts in two
    // clicks, and failing the submit over it would be the wrong trade.
    const resolvedAccountId = !portfoliosEnabled
      ? null
      : portfolioId === NEW_PORTFOLIO_VALUE
        ? await ensureManualPortfolio(supabase, userId, newPortfolioName, portfoliosEnabled)
        : portfolioId === UNASSIGNED_VALUE
          ? null
          : portfolioId;

    const { data: insertedTrade, error } = await supabase.from('trade_plans').insert({
      user_id: userId,
      strategy: form.strategy,
      symbol: form.symbol.trim() || null,
      direction: form.direction,
      entry_price: entry,
      stop_loss: sl,
      take_profit: tp,
      rr_ratio: calcRR(entry, sl, tp),
      trade_reason: composedTradeReason,
      emotional_state: form.emotional_state,
      confidence_level: form.confidence_level,
      timeframe: form.timeframe || null,
      status: 'open',
      // REF-123: `units` is deliberately NOT written. The field is gone from
      // the form, so a form-created row now has `units IS NULL` — and
      // `proper_size` in lib/journal/link.ts resolves the planned quantity
      // through `finite(plan.units) ?? finite(plan.quantity)`, which means its
      // proposal is skipped rather than shown on a link. That is the accepted
      // cost of the trim (Imri, 26.10); the column itself is untouched, and the
      // journal's edit modal can still set a quantity on a row that needs one.
      point_value: pointValueNum,
      // Written explicitly rather than left to the column default, so a plan
      // created before migration 033 runs is already '$' (REF-99 req. 3).
      pnl_currency: TRADING_CURRENCY,
      strategy_conditions_checked: entryConditions.length > 0
        ? entryConditions.map((condition) => ({ condition, checked: strategyConditionsChecked[condition] === true }))
        : null,
      // PRESENT OR ABSENT, never a key with an undefined value — and absent
      // whenever migration 037 has not been run, which is what keeps this
      // insert byte-identical to the pre-REF-110 one on such a deployment.
      // Spread rather than `account_id: x ?? null`, for the same reason
      // `changedFacts` skips an absent column in the import: naming a column
      // the database does not have is a PostgREST 42703 on the one statement
      // the trader cannot afford to lose.
      ...(portfoliosEnabled ? { account_id: resolvedAccountId } : {}),
    }).select('id').single();

    if (error) {
      setFormState('error');
    } else {
      const tradePlanId: string | null = insertedTrade?.id ?? null;
      if (tradePlanId) {
        // Preset warnings were already logged as 'warned' when first shown, on the
        // click before this one — upgrade that exact batch now that the trade
        // actually went through.
        overrideRuleViolations(warnedViolationIdsRef.current, tradePlanId);
        // Custom-rule warnings are only discovered here (never shown separately beforehand),
        // so there's no prior 'warned' row to upgrade — log them straight as 'overridden'.
        if (customViolation && customViolation.actionType === 'warn') {
          logRuleViolations([{
            userId, ruleSource: 'custom', customRuleId: customViolation.customRule!.id,
            ruleKey: customViolation.customRule!.condition_type, ruleName: customViolation.customRule!.name,
            outcome: 'overridden', tradePlanId,
          }]);
        }
      }
      warnedViolationIdsRef.current = [];

      setFormState('success');
      setTimeout(() => {
        setForm(EMPTY_FORM);
        setSlInput('');
        setTpInput('');
        setSelectedTags(new Set());
        setValidationResult(null);
        setStrategyConditionsChecked({});
        // The override is dropped so "תיק חדש…" is not still selected with a
        // name the next submit would reuse. The next form open reads the
        // last-used default, which now resolves to the portfolio this trade
        // was just filed under — so the trader sees the same answer, arrived
        // at from the database rather than from leftover state.
        setPortfolioChoice(null);
        setNewPortfolioName('');
        setFormState('empty');
        onSuccess();
        handleClose();
      }, 1800);
    }
    setSubmitLoading(false);
  }

  // The submit button stays clickable even when fields are missing — clicking it
  // just highlights what's missing instead of doing nothing (or silently no-op-ing).
  function attemptSubmit() {
    if (missingFieldKeys.length > 0) { highlightMissingFields(); return; }
    handleSubmit();
  }

  function toggleTag(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
    setValidationResult(null);
    if (formState !== 'empty') setFormState('editing');
  }

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Bottom Sheet */}
      <div {...dialogProps}
        className="fixed bottom-0 left-0 right-0 z-50 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-full md:max-w-4xl animate-slide-up rounded-t-3xl overflow-hidden"
        style={{ background: 'var(--color-tg-surface)', maxHeight: '90vh' }}>

        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full" style={{ background: 'var(--color-tg-border)' }} />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-tg-border">
          <h2 id={titleId} className="text-base font-semibold text-tg-text">תוכנית עסקה</h2>
          <button onClick={handleClose} aria-label="סגור" className="text-tg-muted hover:text-tg-text transition-colors p-1">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Success state */}
        {formState === 'success' && (
          <div className="flex flex-col items-center justify-center py-16 px-4 animate-fade-in">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ background: 'var(--color-tg-success-muted)' }}>
              <svg aria-hidden="true" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-tg-text mb-1">תוכנית הוגשה!</h3>
            <p className="text-sm text-tg-text-2 text-center">העסקה נוספה לעיתון שלך. סחר לפי התוכנית.</p>
          </div>
        )}

        {/* Form */}
        {formState !== 'success' && (
          <div className="overflow-y-auto px-4 py-4 flex flex-col gap-4"
            style={{ maxHeight: 'calc(90vh - 100px)' }}>

            {loading && (
              <div className="flex items-center gap-2 text-sm text-tg-muted">
                <svg aria-hidden="true" className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                טוען חוקים...
              </div>
            )}

            {/* Personal-rule warning (action_type = 'warn') — doesn't block submission */}
            {initialWarning && (
              <div className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm"
                style={{ background: 'var(--color-tg-warning-muted)', color: 'var(--color-tg-warning)', border: '1px solid rgba(0,210,210,0.3)' }}>
                <AlertTriangle aria-hidden="true" size={16} className="shrink-0 mt-0.5" />
                <span>{initialWarning}</span>
              </div>
            )}

            {/* Validation Banner */}
            {validationResult && (
              <div
                ref={warningBannerRef}
                className={warningBannerPulse ? 'animate-pulse-warning rounded-xl' : 'rounded-xl'}
              >
                <ValidationResultBanner result={validationResult} />
              </div>
            )}

            {formState === 'error' && (
              <div className="px-4 py-3 rounded-xl text-sm"
                style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
                שגיאת שרת — נסה שוב
              </div>
            )}

            {/* Plans left open from a previous day (REF-82 §5.2).
                Above the fields, inside the same scrolling column, and not
                blocking them: everything below stays usable and submittable
                whether or not the question is answered. Renders nothing when
                there is nothing to ask about. */}
            <OpenPlanPrompt
              plans={visibleOpenPlans}
              headingId={openPlansHeadingId}
              onReportClosed={(plan) => { setOpenPlanError(''); setClosingPlanId(plan.id); }}
              onMarkNotEntered={markPlanNotEntered}
              onDismiss={dismissPlan}
              busyPlanId={markingPlanId}
              error={openPlanError}
              registerFirstButton={registerPlanButton}
            />

            {/* Today's context (REF-82 §2.1). Below the open-plan card on
                purpose: that card asks about a day that is already over and
                its answer CHANGES these numbers — "סגרתי אותה" reloads the
                context — so the question reads above the state it affects.

                Unlike that card this one always renders. It is the half of the
                one-form decision that differs between a connected and an
                unconnected user, and a user with no data to show is being told
                exactly that rather than being shown a gap. */}
            <TodayContextPanel
              headingId={todayContextHeadingId}
              loaded={contextLoaded}
              tradeCount={todayCount}
              closed={todayClosed}
              // The user's OWN limits, from their rules row — not
              // DEFAULT_PRESET_RULES. The validator falls back to those
              // defaults so a user with no row is still protected, but the
              // panel says "שהגדרת" ("that you set"), and attributing a
              // default of 5 to a user who never chose it would be a lie in
              // the one sentence that is meant to read their own number back
              // to them. No row, no comparison.
              maxDailyTrades={presetRules?.max_daily_trades ?? null}
              maxDailyLoss={presetRules?.max_daily_loss ?? null}
              source={contextSource}
              // REF-112-C item 3. Replaces the "closes came from Tradovate"
              // line with one saying the broker's data is partial, because on
              // such a day the figures beside it are Reflect's own.
              partial={contextPartial}
              lines={todayLines}
              // REF-108: what the trader is holding right now. The panel
              // renders nothing from this when they are flat.
              live={liveEnabled ? { userId, enabled: true } : null}
            />

            {/* Step 1 — Asset, direction & strategy */}
            <FormSection step={1} label="נכס ואסטרטגיה" active={activeStep === 1} done={activeStep > 1}>
              <div ref={(el) => { fieldRefs.current.symbol = el; }} style={fieldHighlightStyle('symbol')} className="flex flex-col gap-1">
                <label htmlFor={symbolId} className="text-xs font-medium text-tg-muted">סימול</label>
                {/* NQ1 IS IN THE PLACEHOLDER ON PURPOSE (REF-123).
                    A help line under this field used to say
                    "בחוזים עתידיים אפשר לכתוב NQ, NQ1 או MNQ — רפלקט יזהה",
                    added by REF-107 because nothing in the form suggested
                    futures notation and the trader who typed "NQ1" had no hint
                    the matcher was reading it as another instrument. It is
                    gone for the fold, but the thing it taught is not: the
                    placeholder now carries the third form itself, which costs
                    no vertical space at all. lib/symbols.ts still reads all
                    three. */}
                <input
                  id={symbolId}
                  ref={symbolRef}
                  type="text"
                  placeholder="NQ, NQ1, MNQ, ES, AAPL"
                  value={form.symbol}
                  onChange={(e) => { setForm({ ...form, symbol: e.target.value.toUpperCase() }); setValidationResult(null); }}
                  className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors"
                  style={{ background: 'var(--color-tg-surface-2)' }}
                />
              </div>
              <div ref={(el) => { fieldRefs.current.direction = el; }} style={fieldHighlightStyle('direction')} className="flex flex-col gap-1">
                <span id={directionLabelId} className="text-xs font-medium text-tg-muted">כיוון עסקה</span>
                {/* aria-pressed, because until now the chosen direction was
                    distinguishable only by background and border colour —
                    nothing announced it, and nothing conveyed it without
                    colour. */}
                <div role="group" aria-labelledby={directionLabelId} className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    aria-pressed={form.direction === 'long'}
                    onClick={() => { setForm({ ...form, direction: 'long' }); setValidationResult(null); }}
                    className="h-11 rounded-xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-1.5"
                    style={{
                      background: form.direction === 'long' ? 'var(--color-tg-success-muted)' : 'var(--color-tg-surface-2)',
                      borderColor: form.direction === 'long' ? 'var(--color-tg-success)' : 'var(--color-tg-border)',
                      color: form.direction === 'long' ? 'var(--color-tg-success)' : 'var(--color-tg-muted)',
                    }}
                  >
                    Long ▲
                  </button>
                  <button
                    type="button"
                    aria-pressed={form.direction === 'short'}
                    onClick={() => { setForm({ ...form, direction: 'short' }); setValidationResult(null); }}
                    className="h-11 rounded-xl text-sm font-bold border-2 transition-all flex items-center justify-center gap-1.5"
                    style={{
                      background: form.direction === 'short' ? 'var(--color-tg-danger-muted)' : 'var(--color-tg-surface-2)',
                      borderColor: form.direction === 'short' ? 'var(--color-tg-danger)' : 'var(--color-tg-border)',
                      color: form.direction === 'short' ? 'var(--color-tg-danger)' : 'var(--color-tg-muted)',
                    }}
                  >
                    Short ▼
                  </button>
                </div>
              </div>
              <div ref={(el) => { fieldRefs.current.strategy = el; }} style={fieldHighlightStyle('strategy')} className="flex flex-col gap-1">
                <span id={strategyLabelId} className="text-xs font-medium text-tg-muted">אסטרטגיה</span>
                <div role="group" aria-labelledby={strategyLabelId} className="flex flex-wrap gap-2">
                  {shownStrategies.map((s) => (
                    <StrategyChip
                      key={s}
                      label={s}
                      selected={form.strategy === s}
                      onClick={() => { setForm({ ...form, strategy: s }); setValidationResult(null); }}
                    />
                  ))}
                  {/* Inside the same group as the chips: it adds more of them
                      rather than opening anything, so it reads as the last
                      option in the list. One-way on purpose — there is no
                      "פחות". A trader who expanded the list did it to find
                      their strategy, and collapsing it under them while they
                      are still looking would be the form arguing with them. */}
                  {!strategiesExpanded && hiddenStrategyCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setStrategiesExpanded(true)}
                      className={`px-3 py-1.5 rounded-full text-sm border border-dashed transition-all duration-150 text-tg-muted hover:text-tg-text ${CHART_TOGGLE_FOCUS_RING}`}
                      style={{ background: 'transparent', borderColor: 'var(--color-tg-border)' }}
                    >
                      עוד {hiddenStrategyCount}
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-px" style={{ background: 'var(--color-tg-border)' }} />
                {/* Already the visible heading for the group below it, so it
                    names that group rather than a second label being added. */}
                <span id={personalStrategyLabelId} className="text-[10px] text-tg-muted shrink-0">האסטרטגיות שלי</span>
                <div className="flex-1 h-px" style={{ background: 'var(--color-tg-border)' }} />
              </div>
              {personalStrategyRows.length > 0 ? (
                <div role="group" aria-labelledby={personalStrategyLabelId} className="flex flex-wrap gap-2">
                  {personalStrategyRows.map((s) => (
                    <StrategyChip
                      key={s.id}
                      label={s.name}
                      selected={form.strategy === s.name}
                      personal
                      onClick={() => { setForm({ ...form, strategy: s.name }); setValidationResult(null); }}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-tg-muted">לא הוספת אסטרטגיות עדיין — ניתן להוסיף בעמוד האסטרטגיות</p>
              )}
            </FormSection>

            {/* Step 2 — Prices & position sizing */}
            <FormSection step={2} label="מחירים" active={activeStep === 2} done={activeStep > 2}>
              <div className="flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
                  הזן Stop Loss / Take Profit ב:
                </span>
                <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-tg-border)' }}>
                  <button
                    type="button"
                    onClick={() => changePnlMode('points')}
                    className="px-2.5 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'points' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'points' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    נק׳
                  </button>
                  <button
                    type="button"
                    onClick={() => changePnlMode('percent')}
                    className="px-2.5 py-1 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'percent' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'percent' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    %
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div ref={(el) => { fieldRefs.current.entry_price = el; }} style={fieldHighlightStyle('entry_price')}>
                  <PriceInput
                    label="כניסה"
                    value={form.entry_price}
                    onChange={(v) => { setForm({ ...form, entry_price: v }); setValidationResult(null); }}
                  />
                </div>
                <div ref={(el) => { fieldRefs.current.stop_loss = el; }} style={fieldHighlightStyle('stop_loss')}>
                  <PriceInput
                    label={`Stop Loss (${pnlMode === 'points' ? 'נק׳' : '%'})`}
                    value={slInput}
                    onChange={(v) => { setSlInput(v); setValidationResult(null); }}
                    danger
                    hint={
                      !hasEntry ? 'הזן מחיר כניסה'
                      : slPrice !== null ? `מחיר: ${fmtPrice(slPrice)}`
                      : undefined
                    }
                  />
                </div>
                <div ref={(el) => { fieldRefs.current.take_profit = el; }} style={fieldHighlightStyle('take_profit')}>
                  <PriceInput
                    label={`Take Profit (${pnlMode === 'points' ? 'נק׳' : '%'})`}
                    value={tpInput}
                    onChange={(v) => { setTpInput(v); setValidationResult(null); }}
                    success
                    hint={
                      !hasEntry ? 'הזן מחיר כניסה'
                      : tpPrice !== null ? `מחיר: ${fmtPrice(tpPrice)}`
                      : undefined
                    }
                  />
                </div>
              </div>
              {rr !== null && rr > 0 && (
                <div className="flex items-center justify-between px-4 py-2.5 rounded-xl animate-fade-in"
                  style={{
                    background: rr >= 2 ? 'var(--color-tg-success-muted)' : rr >= 1 ? 'var(--color-tg-warning-muted)' : 'var(--color-tg-danger-muted)',
                  }}>
                  <span className="text-sm text-tg-text-2">יחס R:R מחושב</span>
                  <span className="text-sm font-bold"
                    style={{ color: rr >= 2 ? 'var(--color-tg-success)' : rr >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)' }}>
                    1:{rr}
                  </span>
                </div>
              )}

              {/* ── "שווי נקודה" behind a disclosure (REF-123) ───────────────
                  Moved, NOT deleted, and this is the one removal in the trim
                  that would have cost real money. The column is already
                  optional and already defaults to 1, so demoting it to a
                  disclosure changes no data path at all — while deleting it
                  would send every manual close through `(pointValue ?? 1)` and
                  silently store raw index points as dollars: 5 points on MNQ
                  as $5 instead of $10. That cascades into stats, the
                  dashboard, the weekly email and — because those thresholds
                  are in currency — the max_daily_loss rules, which is the same
                  unit bug lib/rules/tradeRuleContext.ts is a written record of.
                  There is no per-symbol lookup to fall back on yet
                  (lib/symbols.ts holds no dollar values), so the field stays
                  reachable until a follow-up ticket adds one. */}
              <Disclosure
                label="הגדרות מתקדמות"
                open={advancedOpen}
                onToggle={() => setAdvancedOpen((v) => !v)}
                regionId={advancedRegionId}
              >
                {/* ── "תיק" — which account this trade belongs to (REF-110 §B)
                    Rendered as its own markup rather than through <Select>,
                    for one reason: the helper line is tied to the control with
                    aria-describedby. Imri's requirement is that every element
                    explains itself, and an explanation a screen reader does not
                    reach only explains it to some traders.

                    MOVED HERE FROM THE TOP OF STEP 1 (REF-123). It led the
                    form because it is the field a trader usually knows the
                    answer to before they open the sheet — but that is the
                    argument for it being cheap, not for it being first, and
                    at 85px it was first in the way. It already defaults to
                    the portfolio of the trader's last plan, so the common
                    answer is the one it is already showing. */}
                {portfoliosEnabled && (
                  <div className="flex flex-col gap-1">
                    <label htmlFor={portfolioFieldId} className="text-xs font-medium text-tg-muted">תיק</label>
                    <select
                      id={portfolioFieldId}
                      aria-describedby={portfolioHintId}
                      value={portfolioId}
                      onChange={(e) => setPortfolioChoice(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors appearance-none cursor-pointer"
                      style={{ background: 'var(--color-tg-surface-2)' }}
                    >
                      <option value={UNASSIGNED_VALUE}>ללא תיק</option>
                      {portfolios.map((p) => (
                        <option key={p.id} value={p.id}>
                          {/* The status rides in the option text because a
                              <select> cannot carry a chip. A closed portfolio
                              is still choosable — a trader reconciling last
                              month's trades needs it. */}
                          {p.status === 'active' ? portfolioLabel(p) : `${portfolioLabel(p)} · ${statusLabel(p.status)}`}
                        </option>
                      ))}
                      <option value={NEW_PORTFOLIO_VALUE}>תיק חדש…</option>
                    </select>
                    <p id={portfolioHintId} className="text-[11px] text-tg-muted">{PORTFOLIO_COPY.formField}</p>
                    {portfolioId === NEW_PORTFOLIO_VALUE && (
                      <div className="flex flex-col gap-1 mt-1">
                        <label htmlFor={newPortfolioFieldId} className="text-xs font-medium text-tg-muted">שם התיק החדש</label>
                        <input
                          id={newPortfolioFieldId}
                          type="text"
                          value={newPortfolioName}
                          onChange={(e) => setNewPortfolioName(e.target.value)}
                          placeholder="למשל: אינטראקטיב, אישי"
                          className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors"
                          style={{ background: 'var(--color-tg-surface-2)' }}
                        />
                        <p className="text-[11px] text-tg-muted">{PORTFOLIO_COPY.createManual}</p>
                      </div>
                    )}
                  </div>
                )}
                {/* Timeframe, also moved out of Step 1 (REF-123). It has never
                    been required and it has no default — an untouched plan
                    writes null, exactly as before. The one case where hiding it
                    would strand a trader is handled above: a personal strategy
                    that restricts timeframes opens this disclosure by itself,
                    so the compliance panel can never report "טיים-פריים ✗"
                    against a field that is not on screen. */}
                <Select
                  label="Timeframe"
                  value={form.timeframe}
                  onChange={(e) => { setForm({ ...form, timeframe: e.target.value as Timeframe }); setValidationResult(null); }}
                  options={TIMEFRAMES.map((tf) => ({ value: tf, label: tf }))}
                  placeholder="בחר Timeframe"
                />
                <div className="flex flex-col gap-1">
                  <label htmlFor="trade-point-value" className="text-xs font-medium text-tg-muted">שווי נקודה ($)</label>
                  <input
                    id="trade-point-value"
                    type="number"
                    step="any"
                    placeholder="1"
                    value={form.point_value}
                    aria-describedby={sizingNoteId}
                    onChange={(e) => setForm({ ...form, point_value: e.target.value })}
                    className="w-full h-10 px-2 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors text-center"
                    style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
                  />
                  <p id={sizingNoteId} className="text-[10px] text-tg-muted">
                    אופציונלי, ברירת מחדל 1. משמש כדי שהמערכת תחשב עבורך רווח/הפסד ({TRADING_CURRENCY}) בסגירה ידנית של עסקה
                  </p>
                </div>
              </Disclosure>
            </FormSection>

            {/* Entry conditions checklist — only when the selected personal strategy defines them */}
            {entryConditions.length > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl p-3"
                style={{ background: 'var(--color-tg-surface-2)', border: '1px solid var(--color-tg-border)' }}>
                <span className="text-xs font-semibold text-tg-text">תנאי הכניסה של האסטרטגיה</span>
                <div className="flex flex-col gap-1.5">
                  {entryConditions.map((condition) => {
                    const checked = strategyConditionsChecked[condition] === true;
                    return (
                      <button
                        key={condition}
                        type="button"
                        onClick={() => toggleConditionChecked(condition)}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-xs border transition-all text-right"
                        style={{
                          background: checked ? 'var(--color-tg-success-muted)' : 'var(--color-tg-surface)',
                          borderColor: checked ? 'var(--color-tg-success)' : 'var(--color-tg-border)',
                          color: checked ? 'var(--color-tg-success)' : 'var(--color-tg-text-2)',
                        }}
                      >
                        <span
                          className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                          style={{
                            background: checked ? 'var(--color-tg-success)' : 'transparent',
                            border: checked ? 'none' : '1px solid var(--color-tg-border)',
                          }}
                        >
                          {checked && <Check size={11} color="white" />}
                        </span>
                        {condition}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Compliance panel — how well the current plan matches the selected strategy */}
            {selectedStrategy && complianceTotal > 0 && (
              <div className="flex flex-col gap-2 rounded-2xl p-3"
                style={{ background: 'var(--color-tg-surface-2)', border: '1px solid var(--color-tg-border)' }}>
                <span className="text-xs font-semibold text-tg-text">התאמה לאסטרטגיה</span>
                {complianceChecks.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {complianceChecks.map((c) => (
                      <div key={c.label} className="flex items-center justify-between text-xs">
                        <span style={{ color: 'var(--color-tg-text-2)' }}>{c.label}</span>
                        {/* The icon is decorative; the sr-only word carries the
                            pass/fail state, which colour alone never did. */}
                        <span style={{ color: c.passed ? 'var(--color-tg-success)' : 'var(--color-tg-danger)' }}>
                          {c.passed
                            ? <Check aria-hidden="true" size={14} />
                            : <X aria-hidden="true" size={14} />}
                          <span className="sr-only">{c.passed ? 'עומד בתנאי' : 'לא עומד בתנאי'}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between text-xs pt-1.5"
                  style={{ borderTop: '1px solid var(--color-tg-border)' }}>
                  <span className="font-semibold text-tg-text">ציון התאמה</span>
                  <span className="font-bold"
                    style={{ color: complianceFailed === 0 ? 'var(--color-tg-success)' : 'var(--color-tg-warning)' }}>
                    {compliancePassed}/{complianceTotal}
                  </span>
                </div>
                {complianceFailed > 0 && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
                    style={{ background: 'var(--color-tg-warning-muted)', color: 'var(--color-tg-warning)' }}>
                    <AlertTriangle aria-hidden="true" size={14} className="shrink-0" />
                    <span>העסקה סוטה מהאסטרטגיה שלך ב-{complianceFailed} קריטריונים</span>
                  </div>
                )}
              </div>
            )}

            {/* Step 3 — Emotional State & Confidence */}
            <FormSection step={3} label="מצב רגשי ורמת ביטחון" active={step1Done && step2Done} done={false}>
              <EmotionalStateSlider
                value={form.emotional_state}
                onChange={(v) => { setForm({ ...form, emotional_state: v }); setValidationResult(null); }}
              />
              <ConfidenceLevelSlider
                value={form.confidence_level}
                onChange={(v) => { setForm({ ...form, confidence_level: v }); setValidationResult(null); }}
              />
            </FormSection>

            {/* Step 4 + Chart — stacked on mobile, side-by-side on desktop */}
            <div className="flex flex-col md:flex-row gap-4">

              {/* Step 4 (mobile: first; desktop: right) */}
              <div className="order-1 md:order-2 md:flex-1 md:overflow-y-auto md:max-h-[450px]">
                <FormSection step={4} label="סיבת הכניסה" active={activeStep === 4} done={false}>
                  {/* ── The chips ARE the field now (REF-123) ───────────────
                      They used to append themselves into the textarea, and the
                      textarea was the required field — so the cheapest path
                      through this section was still typing a sentence. Now one
                      chip is required and the free text is optional: the cost
                      drops from a sentence to a tap, and `trade_reason` is
                      still written non-empty, which is what keeps the live
                      NOT NULL constraint satisfied with no migration. */}
                  <div
                    ref={(el) => { fieldRefs.current.trade_reason = el; }}
                    style={fieldHighlightStyle('trade_reason')}
                    className="flex flex-col gap-1.5"
                  >
                    <span id={reasonTagsLabelId} className="text-xs font-medium text-tg-muted">
                      למה אתה נכנס? בחר לפחות תגית אחת
                    </span>
                    <div role="group" aria-labelledby={reasonTagsLabelId} className="flex flex-wrap gap-1.5">
                      {REASON_TAGS.map((tag) => {
                        const selected = selectedTags.has(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            // Selection is a choice the trader can take back
                            // now, so it has to be announced and not left to
                            // colour — the same reason StrategyChip below
                            // carries aria-pressed.
                            aria-pressed={selected}
                            onClick={() => toggleTag(tag)}
                            className="px-2.5 py-1 rounded-full text-xs border transition-all duration-150"
                            style={{
                              background: selected ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                              borderColor: selected ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                              color: selected ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                            }}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <Disclosure
                    label="הוסף הערה"
                    open={noteOpen}
                    onToggle={() => setNoteOpen((v) => !v)}
                    regionId={noteRegionId}
                  >
                    <div className="flex flex-col gap-1">
                      <label htmlFor={reasonId} className="text-xs font-medium text-tg-muted">הערה (אופציונלי)</label>
                      <textarea
                        id={reasonId}
                        rows={2}
                        placeholder="תאר מה אתה רואה בגרף..."
                        value={form.trade_reason}
                        onChange={(e) => { setForm({ ...form, trade_reason: e.target.value }); setValidationResult(null); }}
                        className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary transition-colors resize-none"
                        style={{ background: 'var(--color-tg-surface-2)' }}
                      />
                    </div>
                  </Disclosure>
                </FormSection>
              </div>

              {/* Chart (mobile: second/below; desktop: left) */}
              <div className="order-2 md:order-1 md:flex-1">
                <div id={chartRegionId}>
                  {chartVisible ? (
                    <TradingViewChart
                      symbol={chartSymbol}
                      timeframe={chartTimeframe}
                    />
                  ) : (
                    // ON DESKTOP: the same frame as the chart it stands in for —
                    // aspect ratio, radius, border and surface restated from
                    // TradingViewChart's own outer box (which is why the two
                    // have to stay in sync) so that revealing the chart drops
                    // it into an already-reserved space instead of reflowing
                    // the column.
                    //
                    // ON MOBILE: a button row, and `aspect-[4/3]` is gone
                    // (REF-123). It was reserving a ~290px empty rectangle on a
                    // 390px phone to hold one button and two lines of
                    // disclaimer — the single largest piece of dead vertical
                    // space in the sheet. The no-reflow argument it existed for
                    // is a desktop side-by-side concern; on a phone the chart
                    // is below the fold anyway, and the trader who opens it is
                    // not also reading the price fields at that moment.
                    //
                    // The TradingView disclosure stays on both. It is the line
                    // that tells the trader their symbol is about to leave the
                    // page, so it is not something a narrower screen gets less
                    // of — it just sits beside the button instead of under it.
                    <div
                      className="flex flex-row md:flex-col items-center justify-center gap-3 md:gap-2 w-full px-4 py-3 md:py-0 rounded-2xl md:aspect-[16/9]"
                      style={{ border: '1px solid var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setChartVisible(true)}
                        disabled={!chartSymbol}
                        aria-expanded={false}
                        aria-controls={chartRegionId}
                        aria-describedby={chartSymbol ? undefined : `${chartRegionId}-hint`}
                        className={`shrink-0 ${CHART_TOGGLE_FOCUS_RING}`}
                      >
                        <LineChart size={14} aria-hidden />
                        הצג גרף
                      </Button>
                      {/* Beside the button on mobile, under it on desktop —
                          one wrapper so the row is [button | text] and not
                          three competing flex children. */}
                      <div className="flex flex-col gap-1 md:items-center">
                        {!chartSymbol && (
                          <p id={`${chartRegionId}-hint`} className="text-[10px] text-start md:text-center" style={{ color: 'var(--color-tg-muted)' }}>
                            הזן סימבול כדי להציג גרף
                          </p>
                        )}
                        <p className="text-[10px] text-start md:text-center max-w-[34ch] leading-snug" style={{ color: 'var(--color-tg-muted)' }}>
                          הגרף מסופק על ידי TradingView. בלחיצה, הסימבול שהזנת מועבר אליהם.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
                {/* Outside the region it controls, under the chart's own
                    indicative-data disclaimer. tv.js stays loaded and cached for
                    the rest of the page's life — hiding only takes the widget
                    off screen, it doesn't undo the opt-in. */}
                {chartVisible && (
                  <div className="flex justify-center mt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setChartVisible(false)}
                      aria-expanded
                      aria-controls={chartRegionId}
                      className={CHART_TOGGLE_FOCUS_RING}
                    >
                      <EyeOff size={14} aria-hidden />
                      הסתר גרף
                    </Button>
                  </div>
                )}
              </div>

            </div>

            {/* Actions */}
            <div className="flex flex-col gap-2 pb-4">
              {/* Missing-fields hint (gray) — guidance, not an error state */}
              {missingFieldKeys.length > 0 && (
                <p dir="rtl" className="text-center text-xs text-zinc-400">
                  חסר: {missingFieldKeys.map((key) => REQUIRED_FIELD_LABELS[key]).join(', ')}
                </p>
              )}

              {/* Warning echo (amber) — repeats the active warnings right by the submit
                  button, so users who scrolled past the banner still see them before submitting. */}
              {validationResult && validationResult.status === 'warning' && (
                <div dir="rtl" className="flex flex-col gap-1">
                  {validationResult.warningReasons.map((reason, i) => (
                    <div key={i} className="flex items-start gap-1.5 text-xs"
                      style={{ color: 'var(--color-tg-warning)' }}>
                      <AlertTriangle aria-hidden="true" size={12} className="shrink-0 mt-0.5" />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* ONE BUTTON (REF-123). It used to be two: a mandatory
                  `בדוק מול החוקים שלי` in secondary, and only once it had been
                  pressed did the submit button render at all. The check now
                  runs inside handleSubmit, so this button is the whole terminal
                  interaction — and `loading` covers the broker pull that the
                  custom-rule re-check makes, which is the only part of it that
                  is actually slow.

                  `הגש בכל זאת` is the second click a warning costs. See
                  handleSubmit on why that one is kept. */}
              <Button
                fullWidth
                disabled={isBlocked}
                loading={submitLoading}
                onClick={attemptSubmit}
                variant={isBlocked ? 'danger' : 'primary'}
                size="lg"
              >
                {isBlocked
                  ? 'עסקה חסומה'
                  : hasPendingWarning ? 'הגש בכל זאת' : 'הגש תוכנית עסקה'}
              </Button>

              {!validationResult && (
                <div className="text-center text-xs text-tg-muted mt-1">
                  תכנן לפני שתסחר — עצור, חשוב, הגש
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* "סגרתי אותה" — the journal's own close dialog, for the plan on the
          card. Not a second closing form: a close needs an exit price to
          produce a real P&L, and CloseTrade is the one component that knows how
          to take one and what to write (REF-82 §5.2).

          Mounted here as a sibling of the sheet rather than inside it, so it
          is not inside the sheet's own scroll container, and only when there is
          a plan to close — useModalDialog has to run on mount to push onto the
          dialog stack, and it is that stack that gives this dialog Escape and
          the focus trap while the sheet keeps both when it closes. */}
      {closingPlan && (
        <ClosePlanDialog
          titleId={closePlanTitleId}
          title={`סגירת העסקה — ${closingPlan.symbol ?? closingPlan.strategy}`}
          exitPriceRef={closePlanExitPriceRef}
          // Dismissing reloads rather than just closing. CloseTrade writes the
          // close to the database BEFORE it shows its AI debrief, and only
          // calls onClosed once the user dismisses that — so Escape or × at
          // that point leaves a card on screen for a plan that is already
          // closed. Refetching is what makes the list say what the database
          // says, in the one case where this component cannot know.
          onCancel={() => { setClosingPlanId(null); loadContext(); }}
        >
          <CloseTrade
            tradeId={closingPlan.id}
            entryPrice={closingPlan.entry_price}
            stopLoss={closingPlan.stop_loss}
            takeProfit={closingPlan.take_profit}
            rrRatio={closingPlan.rr_ratio}
            emotionalState={closingPlan.emotional_state}
            strategy={closingPlan.strategy}
            tradeReason={closingPlan.trade_reason}
            direction={closingPlan.direction}
            units={closingPlan.units}
            pointValue={closingPlan.point_value}
            exitPriceRef={closePlanExitPriceRef}
            onClosed={() => handlePlanClosed(closingPlan.id)}
          />
        </ClosePlanDialog>
      )}
    </>
  );
}

/**
 * Dialog chrome for the close-the-old-plan flow.
 *
 * A separate component, not an `if` around a hook: useModalDialog registers on
 * the shared dialog stack when it mounts and unregisters when it unmounts, and
 * that is what hands Escape and the focus trap to this dialog while it is up
 * and back to the trade sheet underneath when it goes.
 *
 * Portalled to <body> because the sheet sets `md:-translate-x-1/2` — a
 * transform, which would make a `position: fixed` child position itself against
 * the sheet's box instead of the viewport. Same reason the journal's Modal is
 * portalled; z-index one step above the sheet's z-50.
 *
 * Focus lands on the exit-price field, the first thing to fill in, exactly as
 * it does when this dialog is opened from the journal. On close, useModalDialog
 * restores focus to the card button that opened it — or, once that card is
 * gone, the parent's own hand-off takes over.
 */
function ClosePlanDialog({ titleId, title, exitPriceRef, onCancel, children }: {
  titleId: string;
  /** Visible heading, and via titleId the dialog's accessible name. */
  title: string;
  exitPriceRef: React.RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const mounted = useHydrated();
  const { dialogProps } = useModalDialog({
    open: mounted, onClose: onCancel, labelledBy: titleId, initialFocusRef: exitPriceRef,
  });

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center overflow-y-auto p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onCancel}
    >
      <div
        {...dialogProps}
        dir="rtl"
        className="w-full max-w-lg mx-auto max-h-[90dvh] overflow-y-auto rounded-2xl p-5 flex flex-col gap-3 my-auto"
        style={{
          background: 'var(--color-tg-surface)',
          border: '1px solid var(--color-tg-border)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <p id={titleId} className="text-base font-semibold text-tg-text">{title}</p>
          <button
            type="button"
            onClick={onCancel}
            aria-label="סגור"
            className="text-tg-muted hover:text-tg-text transition-colors p-1 shrink-0"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

/**
 * A labelled show/hide for a field the form no longer asks for by default
 * (REF-123) — "הגדרות מתקדמות" in Step 2, "הוסף הערה" in Step 4.
 *
 * The region div is always rendered and only its CONTENT is conditional, the
 * same shape the chart toggle above uses: `aria-controls` has to point at an
 * element that exists, or it announces nothing. The button carries
 * `aria-expanded` so the state is conveyed without relying on the chevron.
 */
function Disclosure({ label, open, onToggle, regionId, children }: {
  label: string;
  open: boolean;
  onToggle: () => void;
  regionId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={regionId}
        className={`self-start flex items-center gap-1 text-[11px] font-medium text-tg-muted hover:text-tg-text transition-colors rounded ${CHART_TOGGLE_FOCUS_RING}`}
      >
        <ChevronDown
          size={12}
          aria-hidden
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease' }}
        />
        {label}
      </button>
      <div id={regionId}>{open && children}</div>
    </div>
  );
}

function StrategyChip({
  label, selected, personal, onClick,
}: {
  label: string;
  selected: boolean;
  personal?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      // Selection was carried by colour alone before this. aria-pressed is what
      // tells a screen reader which chip is the chosen one.
      aria-pressed={selected}
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-sm border transition-all duration-150"
      style={{
        background: selected
          ? personal ? 'var(--color-tg-success-muted)' : 'var(--color-tg-primary-muted)'
          : 'var(--color-tg-surface-2)',
        borderColor: selected
          ? personal ? 'var(--color-tg-success)' : 'var(--color-tg-primary)'
          : 'var(--color-tg-border)',
        color: selected
          ? personal ? 'var(--color-tg-success)' : 'var(--color-tg-primary)'
          : 'var(--color-tg-text-2)',
      }}
    >
      {label}
    </button>
  );
}

function FormSection({
  step, label, active, done, children,
}: {
  step: number;
  label: string;
  active: boolean;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-2xl p-3 transition-all duration-200"
      style={{
        background: active ? 'var(--color-tg-surface-2)' : 'transparent',
        border: active ? '1px solid var(--color-tg-primary)' : '1px solid transparent',
        opacity: !active && !done ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
          style={{
            background: done ? 'var(--color-tg-success)' : active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
            color: done || active ? 'white' : 'var(--color-tg-muted)',
          }}
        >
          {done ? <Check size={9} /> : step}
        </span>
        <span
          className="text-xs font-semibold"
          style={{ color: active ? 'var(--color-tg-text)' : done ? 'var(--color-tg-text-2)' : 'var(--color-tg-muted)' }}
        >
          {label}
        </span>
      </div>
      {children}
    </div>
  );
}

function PriceInput({
  label, value, onChange, danger, success, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  danger?: boolean;
  success?: boolean;
  hint?: string;
}) {
  const borderColor = danger
    ? 'var(--color-tg-danger)'
    : success
      ? 'var(--color-tg-success)'
      : 'var(--color-tg-border)';

  // Generated per instance: the component renders three times in the form
  // (entry / stop loss / take profit), so a fixed id would collide.
  const inputId = useId();
  const hintId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-xs font-medium" style={{ color: borderColor }}>
        {label}
      </label>
      <input
        id={inputId}
        type="number"
        step="any"
        placeholder="0.00"
        value={value}
        // The hint was rendered but never associated, so the resolved price
        // ("מחיר: 4512.5") and the "enter an entry price first" prompt were
        // both invisible to a screen reader. Only referenced when one is on
        // screen — pointing at an absent id announces nothing.
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 px-2 rounded-xl text-sm text-tg-text border focus:outline-none transition-colors text-center"
        style={{
          background: 'var(--color-tg-surface-2)',
          borderColor,
        }}
      />
      {hint && (
        <span id={hintId} className="text-[10px] text-center truncate" style={{ color: 'var(--color-tg-muted)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}
