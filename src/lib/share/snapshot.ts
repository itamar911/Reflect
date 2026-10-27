/**
 * What a shared trading day says about itself, and nothing more (REF-125
 * Stage 2 item 2).
 *
 * PURE. No client, no environment, no server-only import, no clock of its own
 * — the day and the rows are parameters. That is not tidiness: this module is
 * the entire privacy surface of the feature, so the regression suite has to be
 * able to build a snapshot from fixtures and grep the serialised JSON for
 * things that must not be in it (scripts/share-leak-check.ts). A builder that
 * needed a database could not be asserted that way.
 *
 *
 * AN ALLOW-LIST, NOT A REDACTION PASS
 * -----------------------------------
 *
 * {@link buildDailyShareSnapshot} NAMES EVERY FIELD IT EMITS and copies
 * nothing wholesale. There is no spread of a row anywhere in this file, no
 * `delete` of a key, and no "everything except" list — because a redaction
 * pass is only as current as its deny-list, and the next column added to
 * `trade_plans` would arrive in the snapshot by default and leave by review.
 * src/lib/ai/tradeFacts.ts is the existing precedent for the shape and
 * src/lib/tradovate/fills.ts' `BrokerDayContext` (seven scalars) is the other.
 *
 * REF-125 §2.5 is the list of what must never leave the server. The sharpest
 * item on it is `accounts.display_name`, which on a prop trader's account is a
 * FIRM'S NAME — portfolio.ts:34-41 states the rule ("never in a log line,
 * never in an error message, and NEVER IN AN AI PROMPT"), and a public card is
 * strictly worse than an AI prompt. Nothing here reads the `accounts` table at
 * all, and `portfolioLabel()` is deliberately not imported: it FALLS BACK to
 * `display_name` when a nickname is empty, so reaching a portfolio name
 * through it would publish the firm for exactly the traders who never named
 * their account.
 *
 * NO SYMBOL FIELD, which is worth stating because the ticket's deny rule
 * ("symbols with contract month — root only") implies there might be one. The
 * enumerated snapshot carries no instrument at all: a day's money, counts and
 * discipline do not need one, and the rule is then satisfied by construction
 * rather than by a normaliser that has to be right about `MESZ5` vs `MES`. If
 * a later stage wants the instruments traded, it adds a field here and a root
 * normaliser beside it, and the leak suite grows a case.
 *
 *
 * THE TWO DISCIPLINE NUMBERS ARE FRACTIONS, AND THAT IS THE DECISION
 * -----------------------------------------------------------------
 *
 * Not a 0-100 score. REF-125 §2.4 found five rival discipline definitions in
 * the product and two hazards that a single score inherits and a fraction does
 * not:
 *
 *   1. `behaviourDisciplineScore()` returns NULL and never 0 when no row
 *      answers any flag (disciplineAggregate.ts:64-80). Rendering that absence
 *      as "0/100" on a public page would be defamatory of the trader's own
 *      day. A fraction has an explicit denominator, so "nothing was answered"
 *      is `null` and renders as nothing rather than as a zero.
 *
 *   2. tradeScore.ts:218-237 — the discipline booleans default to
 *      not-violated on a broker row with no self-report, so "a trade entered
 *      on impulse and managed badly can collect the whole discipline block for
 *      having no evidence against it". A fraction with an HONEST DENOMINATOR
 *      is the answer: an unanswered trade is counted in neither half, so the
 *      card says "followed the plan on 4 of the 5 trades that recorded it"
 *      rather than silently crediting the sixth.
 *
 * Every denominator here is therefore "rows that answered", never
 * `rows.length` — which is REF-107 Stage 4's rule, and the thing
 * scripts/features-null-safety-check.ts exists to pin.
 */

import { hasMoneyPnl, isWinningTrade, pnlRow, tradeMoneyPnl } from '@/lib/pnl';
import { readStopHistory, stopWasWidened } from '@/lib/journal/stopHistory';
import { tradingDayOfTrade, type TradingDay } from '@/lib/tradingDay';

/** The snapshot format. Bumped when a field changes meaning, never for an addition. */
export const SHARE_SNAPSHOT_VERSION = 1;

/**
 * The longest public handle. 24 characters, which is a display decision and
 * not a safety one: the card renders it on one line beside the day label at
 * mobile width.
 */
export const MAX_PUBLIC_NICKNAME = 24;

/**
 * A discipline count and the number of trades that answered the question.
 *
 * `answered` IS NEVER `rows.length` AND IS NEVER ZERO. A fraction with a zero
 * denominator is not a fraction, so the builder returns `null` for the whole
 * thing instead — see the header's hazard 1. A reader therefore never has to
 * guard against a division by zero, and `met <= answered` always holds.
 */
export interface ShareFraction {
  /** Trades on which the trader did the thing. */
  met: number;
  /** Trades that recorded an answer either way. */
  answered: number;
}

/**
 * Where the day's figures came from, over the trades actually counted.
 *
 * PER-TRADE AND NEVER PER-USER. REF-125 §3.5: stats are cross-account by
 * product promise (portfolio.ts:154), so "this trader has a broker connection"
 * is not evidence about any particular trade. `source` is.
 */
export type ShareProvenance = 'broker' | 'mixed' | 'manual';

/** What the trader agreed to show. All false is the resting state. */
export interface ShareVisibility {
  nickname: boolean;
  accounts: boolean;
  balance: boolean;
}

export interface DailyShareSnapshot {
  /** {@link SHARE_SNAPSHOT_VERSION} at mint time. */
  v: number;
  /** The CME trading day this describes, `YYYY-MM-DD`. */
  day: TradingDay;
  /**
   * The day's money, summed over the counted trades.
   *
   * NULL AND NOT ZERO when no counted trade carries a money figure at all. The
   * distinction is the whole of §2.4's hazard 1 applied to P&L: a day of three
   * closed trades none of which recorded an amount is not a breakeven day, and
   * `$0.00` under a "Broker-synced" tag would be a claim we cannot support.
   */
  pnl: number | null;
  /** Closed trades counted. See {@link countedShareTrades} for what "counted" is. */
  trades: number;
  /** Of {@link trades}. `wins + losses === trades` by construction. */
  wins: number;
  losses: number;
  /** "עמד בתוכנית 4/5", or null when no trade answered. */
  followedPlan: ShareFraction | null;
  /** "הסטופ לא הורחק 3/4", or null. See {@link stopHeldOutcome} for the predicate. */
  stopHeld: ShareFraction | null;
  /** Money only. Null when no counted trade carries a money figure. */
  best: number | null;
  worst: number | null;
  provenance: ShareProvenance;
  /** The opt-in handle, or null — which is anonymous and is the default. */
  nickname: string | null;
}

/**
 * A `trade_plans` row as this module reads it: EVERY FIELD OPTIONAL.
 *
 * Optional rather than nullable, and the difference is the one `lib/types.ts`
 * draws at :108-110. A reader on a database where migration 034 has not run
 * gets no `source` KEY at all from `select('*')`, and 038's `stop_history` is
 * the same. Both are read through `?? null` and a `=== true` here, never
 * through a truthiness test, which is `lib/trades/visible.ts`' rule and the
 * reason the builder needs no migration flag to be safe.
 */
export interface ShareTradeRow {
  status?: string | null;
  exit_price?: number | string | null;
  entry_price?: number | string | null;
  take_profit?: number | string | null;
  direction?: 'long' | 'short' | null;
  pnl_amount?: number | string | null;
  actual_pnl?: number | string | null;
  closed_at?: string | null;
  submitted_at?: string | null;
  followed_plan?: boolean | null;
  moved_sl?: boolean | null;
  stop_history?: unknown;
  source?: string | null;
  hidden?: boolean | null;
}

// ── The counted set ─────────────────────────────────────────────────────────

/**
 * Whether a row came from a broker rather than from the trade form.
 *
 * `source === 'tradovate'` and not `broker_trade_key != null`, which is
 * JournalClient.tsx:198-200's predicate restated rather than imported — that
 * one is a local function in a 2,000-line client component and takes the
 * journal's own `Trade` type. The docstring there is explicit that `source` is
 * the right test because it is the column the product principle is stated in.
 *
 * A row with NO `source` KEY reads as manual, which is correct twice over: it
 * is the column's default on every row the trade form ever wrote, and on a
 * pre-034 database no row can have come from a broker because the import is
 * gated on the same migration.
 */
function isBrokerRow(row: ShareTradeRow): boolean {
  return row.source === 'tradovate';
}

/**
 * The trades a shared day is about: CLOSED, PRICED, NOT DELETED, and dated
 * into `day` by `closed_at`.
 *
 * CLOSED-ONLY, BY `closed_at`, AND THAT IS A PRODUCT RULING RATHER THAN A
 * PREFERENCE. TodayContextPanel.tsx:47-63 wrote it down: "how many trades
 * today" is counted by `submitted_at` and "today's money" by `closed_at`, they
 * are therefore DIFFERENT SETS, and mixing them is "the bug class
 * tradeRuleContext.ts exists to have ended". A card that showed a
 * `submitted_at` count beside a `closed_at` P&L could truthfully say "2
 * trades, +$300" about a day in which one of those two trades contributed
 * nothing to the $300.
 *
 * So the card picks ONE scope — the retrospective one — and every number on it
 * comes from this set. It is also the only scope a broker can verify: an open
 * position has no realised money to report.
 *
 * `tradingDayOfTrade` is the Stage 1 definition and resolves `closed_at` first,
 * so the filter and the `status`/`exit_price` tests agree about which
 * timestamp dates the row.
 */
export function countedShareTrades(
  rows: readonly ShareTradeRow[],
  day: TradingDay
): ShareTradeRow[] {
  return rows.filter(
    (row) =>
      row.hidden !== true &&
      row.status === 'closed' &&
      row.exit_price != null &&
      tradingDayOfTrade(row) === day
  );
}

// ── The two discipline predicates ───────────────────────────────────────────

/**
 * Whether this trade's stop was held, or `null` for "nothing answered".
 *
 * THE THREE-WAY ANSWER IS THE POINT, and the `null` is doing the work the
 * header's hazard 2 describes. Read in order:
 *
 *   1. A READABLE `stop_history` DOCUMENT WINS, because it is the broker's
 *      evidence rather than a self-report, and `readStopHistory` has already
 *      refused the documents whose verdict cannot be trusted.
 *
 *        'kept'    → true.  We looked and it never moved.
 *        'moved'   → NOT WIDENED. `stopWasWidened` is the predicate the
 *                    widened-only rule and the score already share, so
 *                    "a widening happened" has one definition in the product.
 *                    A TIGHTENING IS THEREFORE HELD, which is Imri's 19.10
 *                    decision (stopHistory.ts:46-57): "a trader who moves a
 *                    stop TOWARD the profit is managing risk, not breaking
 *                    discipline."
 *        'none'    → NULL, AND THIS IS THE IMPORTANT ONE. We looked and there
 *                    was no stop at all. There is nothing to widen, so a
 *                    `true` here would credit a trade taken with NO STOP as
 *                    perfect stop discipline — the single most flattering
 *                    thing this card could say, and exactly §2.4's "no
 *                    evidence reads as clean" hazard. Not counted either way.
 *        'unknown' → NULL. "We looked and could not tell" must not read as
 *                    'kept'; stopHistory.ts:34-37 says so in as many words —
 *                    "a trader would be told their stop stayed put on the
 *                    strength of a read that failed".
 *
 *   2. NO DOCUMENT → the trader's own `moved_sl`. Coarser on purpose: a
 *      self-report cannot distinguish a tighten from a widen, so a `true`
 *      counts against. That is the conservative direction and it is the
 *      trader's own answer about their own trade, not an inference of ours.
 *
 *   3. NEITHER → null. Not counted, in either half.
 */
export function stopHeldOutcome(row: ShareTradeRow): boolean | null {
  const history = readStopHistory(row.stop_history);
  if (history !== null) {
    if (history.verdict === 'kept') return true;
    if (history.verdict === 'moved') return !stopWasWidened(row.stop_history);
    // 'none' and 'unknown' — see the docblock. Fall through to no answer
    // rather than to the self-report: the document is the better evidence and
    // what it says is that this question does not apply to this trade.
    return null;
  }
  if (row.moved_sl == null) return null;
  return row.moved_sl !== true;
}

/** `followed_plan`, which is a plain self-report and has no second source. */
function followedPlanOutcome(row: ShareTradeRow): boolean | null {
  return row.followed_plan == null ? null : row.followed_plan === true;
}

/**
 * Count a three-way predicate into a fraction, or into nothing.
 *
 * Returns null — never `{ met: 0, answered: 0 }` — when no row answered. See
 * {@link ShareFraction}.
 */
function fractionOf(
  rows: readonly ShareTradeRow[],
  outcome: (row: ShareTradeRow) => boolean | null
): ShareFraction | null {
  let met = 0;
  let answered = 0;
  for (const row of rows) {
    const value = outcome(row);
    if (value === null) continue;
    answered++;
    if (value) met++;
  }
  return answered === 0 ? null : { met, answered };
}

// ── The builder ─────────────────────────────────────────────────────────────

/**
 * Where the day's figures came from.
 *
 * ZERO TRADES IS `'manual'`, AND THE ORDER OF THESE TESTS IS WHY. With no
 * counted rows, `broker === total` is `0 === 0` and a naive "all rows are
 * broker rows" test answers `'broker'` — a card with no trades on it carrying
 * a "Broker-synced" tag, which is a provenance claim about nothing. The empty
 * day is checked first and resolves to the state that renders NO TAG AT ALL.
 *
 * That is also the repo's own precedent for the manual case generally
 * (link.ts:68-69): "a journal that labels its own default case 'ידני' treats
 * hand entry as the exception."
 */
function provenanceOf(rows: readonly ShareTradeRow[]): ShareProvenance {
  if (rows.length === 0) return 'manual';
  const broker = rows.filter(isBrokerRow).length;
  if (broker === 0) return 'manual';
  if (broker === rows.length) return 'broker';
  return 'mixed';
}

/**
 * Build the frozen card for one trading day.
 *
 * TAKES THE VISIBILITY AND APPLIES IT HERE rather than leaving the caller to
 * decide what to include, so that "the nickname toggle was off" is a property
 * of the SNAPSHOT and therefore assertable by the leak suite. A caller that
 * resolved the name itself could pass one in with the toggle off and nothing
 * in a pure test would notice.
 *
 * `publicNickname` is the raw column value and is normalised here, so a row
 * holding `'   '` from some other write path is still anonymous — see
 * {@link readPublicNickname}.
 */
export function buildDailyShareSnapshot({
  rows,
  day,
  visibility,
  publicNickname,
}: {
  rows: readonly ShareTradeRow[];
  day: TradingDay;
  visibility: ShareVisibility;
  publicNickname?: unknown;
}): DailyShareSnapshot {
  const counted = countedShareTrades(rows, day);

  // `pnlRow` ONCE PER TRADE rather than a cast at each call site. It is the
  // adapter lib/pnl.ts built for precisely this input — "what `select('*')`
  // hands the AI routes" — and its docstring records why the alternative is a
  // bug and not a style: the four routes that each grew their own
  // `exit_price > entry_price` win test "call every profitable short a loss".
  const facts = counted.map((row) => pnlRow(row as Record<string, unknown>));

  // Only the rows that carry a money figure may contribute to money. A closed
  // row with neither `actual_pnl` nor `pnl_amount` is a trade whose amount was
  // never recorded, and summing it as 0 would quietly average it in.
  const amounts = facts.filter(hasMoneyPnl).map(tradeMoneyPnl);

  let wins = 0;
  let losses = 0;
  for (const fact of facts) {
    // `isWinningTrade` is the canonical win test and falls back to price points
    // for a row with no money, so a day of unpriced trades still splits. It
    // answers `false` on an exact breakeven, which is the product's existing
    // definition everywhere else and is kept rather than given a third bucket
    // the rest of the app does not have.
    if (isWinningTrade(fact) === true) wins++;
    else losses++;
  }

  const nickname = visibility.nickname ? readPublicNickname(publicNickname) : null;

  return {
    v: SHARE_SNAPSHOT_VERSION,
    day,
    pnl: amounts.length === 0 ? null : amounts.reduce((sum, value) => sum + value, 0),
    trades: counted.length,
    wins,
    losses,
    followedPlan: fractionOf(counted, followedPlanOutcome),
    stopHeld: fractionOf(counted, stopHeldOutcome),
    best: amounts.length === 0 ? null : Math.max(...amounts),
    worst: amounts.length === 0 ? null : Math.min(...amounts),
    provenance: provenanceOf(counted),
    nickname,
  };
}

// ── The defensive readers ───────────────────────────────────────────────────

/**
 * A public handle, or null for anonymous.
 *
 * NULL, EMPTY AND WHITESPACE-ONLY ARE ONE ANSWER, in one place. The column is
 * nullable with no default and the API route trims before writing, but a
 * handle is CONSENT and the three-state lesson applies to consent harder than
 * it does to a stop (stopHistory.ts:224-229): a row that acquires `''` by some
 * other write path must still render anonymously rather than publish an empty
 * name. Reading it through one function is what makes that true of every
 * caller instead of of the careful ones.
 *
 * Inner whitespace is collapsed and the result is bounded — a 400-character
 * handle is a layout bug on a public page, and a handle with a newline in it
 * is a handle chosen to break one.
 */
export function readPublicNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.slice(0, MAX_PUBLIC_NICKNAME);
}

/**
 * The visibility document, read defensively. Anything unreadable is all-false.
 *
 * FAIL-CLOSED IN EVERY DIRECTION: a missing key, a non-object, a string
 * `"true"` and a `1` all answer false. The column has a NOT NULL default in
 * migration 043, so the common path is a well-formed document — but it is
 * JSONB with no CHECK, and the one thing a bad read must never do on this
 * particular column is show MORE than the trader agreed to.
 */
export function readShareVisibility(value: unknown): ShareVisibility {
  const raw = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;
  return {
    nickname: raw.nickname === true,
    accounts: raw.accounts === true,
    balance: raw.balance === true,
  };
}

const PROVENANCES: readonly ShareProvenance[] = ['broker', 'mixed', 'manual'];

/** A finite number, or null. PostgREST hands `NUMERIC` back as a string. */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A non-negative integer, or 0 — for the three counts, which cannot be absent. */
const count = (value: unknown): number => {
  const n = num(value);
  return n === null || n < 0 ? 0 : Math.floor(n);
};

function readFraction(value: unknown): ShareFraction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const answered = count(raw.answered);
  // A zero denominator is not a fraction — the builder never writes one, and a
  // document that carries one is a document to render nothing from. `met`
  // above `answered` is the other impossible pair and is clamped rather than
  // rejected, so a near-miss still renders something true.
  if (answered === 0) return null;
  return { met: Math.min(count(raw.met), answered), answered };
}

/**
 * The stored snapshot, or null when there is nothing a reader may rely on.
 *
 * THE ONLY WAY THE PUBLIC PAGE LEARNS ANYTHING, so it trusts nothing. JSONB
 * with no CHECK, written by a build that may be older than the reader — the
 * same situation `readStopHistory` and `readDailyDebrief` are in, and the same
 * answer: validate every field, and return null rather than a half-document
 * when the one field that identifies it is missing.
 *
 * `day` IS THE REQUIRED FIELD. A card with no day is not a card — the heading
 * is "יום מסחר 27.10" — and a reader that invented one would publish a page
 * claiming a day nobody shared. Everything else has a defined absence.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not copy unknown keys through. A future
 * field is invisible to an older reader, which is the correct direction for a
 * public page — a deployment that does not understand a field cannot render it
 * wrongly, and cannot pass it on.
 */
export function readDailyShareSnapshot(value: unknown): DailyShareSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const day = typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    ? raw.day
    : null;
  if (day === null) return null;

  const provenance = PROVENANCES.find((p) => p === raw.provenance) ?? 'manual';

  return {
    v: count(raw.v),
    day,
    pnl: num(raw.pnl),
    trades: count(raw.trades),
    wins: count(raw.wins),
    losses: count(raw.losses),
    followedPlan: readFraction(raw.followedPlan),
    stopHeld: readFraction(raw.stopHeld),
    best: num(raw.best),
    worst: num(raw.worst),
    // An unreadable provenance resolves to the state that prints NO TAG. The
    // alternative directions both assert something: 'broker' would claim a
    // verification nothing supports, 'mixed' would claim a mixture.
    provenance,
    nickname: readPublicNickname(raw.nickname),
  };
}
