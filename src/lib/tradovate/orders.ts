/**
 * Did the trader move their stop? (REF-113 Stage 2.)
 *
 * SERVER ONLY. Two halves, and the split is the whole design of this module:
 *
 *   - {@link readStopHistories} talks to Tradovate. It is the only thing here
 *     that can fail, cost a request, or see a credential.
 *   - {@link deriveStopHistory} is PURE. Given the day's orders it answers the
 *     question, and it is the half the regression suite drives — see
 *     scripts/broker-orders-check.ts, which needs no network and no .env.local.
 *
 * NOTHING HERE WRITES. ./import.ts owns every statement against `trade_plans`;
 * this module hands it a {@link StopHistory} per trade and has no opinion about
 * columns. Stage 3 is the half that writes.
 *
 *
 * WHY THIS IS POSSIBLE AT ALL, AND WHY IT IS SAME-DAY ONLY
 * -------------------------------------------------------
 *
 * Measured on 19.10 against a real bracketed trade whose stop was dragged twice
 * by hand (reported on REF-113):
 *
 *   1. `stopPrice` sits on `orderVersion`, not on `order`. **The version history
 *      of a stop order IS the history of its moves.** The sample's stop had
 *      three versions and three distinct stop prices — the `New` plus the two
 *      drags — and the only fields that changed between them were `id` and
 *      `stopPrice`.
 *   2. `/order/list` RETURNS THE CURRENT TRADING DAY AND NOTHING ELSE
 *      (`depthDays = 0`; the evening before the measurement it returned zero
 *      rows). There is no backfill and there never can be one.
 *
 * (2) is what shapes the rest of the integration. A trade that OPENED YESTERDAY
 * and closed today has no readable orders at all, so its answer is `'unknown'`
 * and never `'none'` — that is not an edge case, it is every swing trade. And it
 * is why the nightly 03:30 UTC import cron is NOT a place this runs from: it
 * fires four and a half hours after Tradovate has already rolled the trading day
 * over, so it could never see the orders of the day it is importing. Stage 2
 * runs from the Sync button and the end-of-day summary; Stage 4 adds a cron
 * timed to the trading day instead of to midnight.
 *
 *
 * THE THREE LAYERS OF ATTRIBUTION, STRONGEST FIRST (§1.2)
 * ------------------------------------------------------
 *
 * Linking a protective order to a trade is the hard half of this ticket, and it
 * is three separate arguments rather than one chain. Each is tried in order and
 * the first that produces candidates wins, so an inference never overrides a
 * fact:
 *
 *   A. **The stop IS the exit.** `BrokerTrade.entryOrderIds` holds every order
 *      that produced a fill in the group — entry and exit both — so if one of
 *      them is a stop order ON THE CLOSING SIDE, it is this trade's stop and it
 *      is the order that closed it. Zero inference, zero extra cost,
 *      `source: 'linked'`.
 *
 *   B. **The bracket.** An OCO's orders are siblings under one `orderStrategy`.
 *      The join is only reachable FROM the strategy — the order carries no
 *      `orderStrategyId`, measured — so this costs one call per strategy to
 *      build the reverse map. `source: 'linked'`.
 *
 *   C. **The window**, and only when A and B found nothing. A trader who placed
 *      a stop by hand after entering is a first-class case, not an edge: same
 *      account, same contract, the opposite action, not one of the trade's own
 *      orders, submitted inside the trade's life, and no larger than the
 *      position. `source: 'inferred'`.
 *
 * LINKAGE UPGRADES CONFIDENCE AND IS NEVER A PRECONDITION. That sentence is from
 * the investigation and it is why C exists at all.
 *
 *
 * AND EVERY LAYER TESTS THE SIDE, WHICH IT DID NOT AT FIRST
 * --------------------------------------------------------
 *
 * A protective order is on the side that CLOSES the position, and an entry
 * order is not a protective order however it is typed. Layers A and B tested no
 * side for the first three stages of this ticket, and the cost was measured in
 * production on 19.10: a long whose entry was a BUY STOP had that entry
 * attributed to it as its protective stop, stored `broker_stop_loss` 148 ticks
 * ABOVE the entry, and described the trader walking the breakout trigger down to
 * the market as a stop being `'widened'`.
 *
 * So the side is tested in two independent places, because one test was never
 * enough for a number this load-bearing:
 *
 *   1. **At admission**, per order, off `TradovateOrder.action` — in
 *      {@link candidateOrders}. FAIL-OPEN in A and B, fail-closed in C; the
 *      asymmetry is argued where it is written.
 *   2. **At selection**, per price, off `BrokerTrade.direction` — {@link riskOf}
 *      for stops and `gainOf` for targets. This one needs no field to be
 *      present, and it is what catches a wrong-side candidate whose `action`
 *      is honestly a `Sell` — a second stop order, say, or a cancel/replace
 *      leftover, neither of which (1) can see.
 *
 * Both are PARTITIONS and neither is a filter. A side test that could empty the
 * candidate set could manufacture a `'none'`, and `'none'` is the one wrong
 * answer this module must never give.
 *
 *
 * AND THE INITIAL STOP IS ANCHORED AT THE ENTRY FILL, NOT AT VERSION ONE
 * ---------------------------------------------------------------------
 *
 * MEASURED ON THE SAME 19.10 TRADE, and it is the second defect that one row
 * held. Q8 of the probe reported the protective stop's seven versions as signed
 * tick distances from the entry:
 *
 *     -11   -132   -131   -131   -211   -90   +1
 *
 * Two of those are the trader moving their risk. The entry was a BUY STOP whose
 * trigger they walked down twice before it filled, and A BRACKET RE-PRICES ITS
 * STOP EVERY TIME THE ENTRY IT HANGS OFF MOVES — so the first three versions are
 * the broker following the trigger, the third being the one it minted at the
 * fill, when 132 ticks from the trigger became 131 from the price that actually
 * filled. The seventh is a drag to the market to get out. Taking version one as
 * the initial stop stored ELEVEN TICKS of risk on a trade that risked a hundred
 * and thirty-one, and counted five moves against the two the trader made.
 *
 * So the window a verdict is computed over has both ends cut, and the two ends
 * are cut by different kinds of evidence:
 *
 *   - **The anchor**, by a clock. {@link StopHistory.initialStop} is the last
 *     version in force at the moment the entry filled — see
 *     {@link anchorStop} — and everything before it is reported as a count in
 *     {@link StopHistory.preFillVersions} rather than as a move.
 *   - **The exit drag**, by a status and a crossing. A trader who drags their
 *     stop onto the market to get out leaves a terminal order — filled, or
 *     cancelled behind the flatten that beat it — whose last step crossed the
 *     price they got out at, and that is an exit and not a protective move. See
 *     {@link withoutExitDrag}.
 *
 * THE CLOCK IS THE EXPENSIVE HALF AND IT FAILS SAFE. A version carries no
 * instant (./types.ts measured it absent), so the instants come from
 * `/command/list` paired POSITIONALLY with the versions, and the pairing is
 * refused on any of several counts — see {@link versionInstants}, where each
 * refusal is argued against the shift it prevents. When it is refused — no
 * commands, a count that does not line up, instants that go backwards, a failed
 * or truncated read — the anchor falls back to version one, which is exactly
 * the old behaviour, and {@link StopHistory.anchoredAtFill} is `false` so that
 * no reader has to guess which of the two it is holding.
 *
 * AND THE CLOCK CAN CHANGE WHICH CANDIDATE WINS, NOT ONLY WHERE THE WINDOW
 * STARTS. This was nearly left as a footnote and it is not one. Candidates are
 * ranked by the risk their ANCHORED version states, so on a trade with two stop
 * orders a run with the clock and a run without it can choose different orders
 * — and therefore report a different `versions`, `movedCount`, `direction` and
 * `source`, not just a different `initialStop`. Ranking on version one while
 * reporting the anchored price would be worse (it is half of the 19.10 defect:
 * rank on one number, publish another), so the dependency is deliberate. What
 * it costs is that "a clock failure costs the anchor and nothing else" is TRUE
 * ONLY FOR A TRADE WITH ONE STOP ORDER, and `./import.ts` never re-derives a
 * row that already has a history, so whichever run landed first is the one that
 * stands.
 *
 *
 * THE FOUR WAYS THIS ANSWERS "I DO NOT KNOW", AND WHY TWO OF THEM ARE NOT STORED
 * -----------------------------------------------------------------------------
 *
 * `'unknown'` is never the same as `'none'`. `'none'` is a measurement — we read
 * the orders and the trader had no stop — and it is a finding a coach can act
 * on. `'unknown'` is our own failure, and {@link StopHistory.reason} says which:
 *
 *   `'interday'`   the trade's own orders are not in today's list. PERMANENT.
 *   `'ambiguous'`  two parallel positions in one contract (§1.3). PERMANENT.
 *   `'capped'`     the per-run request ceiling stopped the scan. TRANSIENT.
 *   `'failed'`     a read failed. TRANSIENT.
 *
 * AND THE TWO TRANSIENT ONES ARE DROPPED BY {@link readStopHistories} RATHER
 * THAN RETURNED. This is a deliberate refinement of §4.3, which said a capped
 * trade should be stored as `'unknown'` with `capped: true`. It must not be:
 * the candidate filter is `stop_history IS NULL`, so STORING an `'unknown'`
 * takes the row out of scope for every later run that day — the 21:30 cron
 * would skip exactly the trades the 13:00 summary could not finish. A dropped
 * entry leaves the columns absent, which reads as "we have not looked" and is
 * retried. {@link deriveStopHistory} still RETURNS them, with the reason, which
 * is what the suite asserts against.
 *
 *
 * WHAT THIS MODULE REFUSES TO READ, AND WHY THAT IS THE COST CONTROL
 * -----------------------------------------------------------------
 *
 * ONE `/command/list` AND NO `/commandReport/deps`, WHICH IS A DEPARTURE FROM
 * §2.1 AND IS ARGUED WHERE IT IS SPENT. §2.1 read zero commands because "the
 * order a verdict wants is the order of the versions, and `id` ascending gives
 * it for free" — true of the verdict and false of the anchor, which needs a
 * clock and has nowhere else to get one (see the section above). It is ONE LIST
 * CALL PER HOST PER RUN, not one per order, and it buys exactly one bit per
 * version: before the fill, or after it.
 *
 * `movedAtMs` IS STILL ALWAYS NULL. The pairing that decides that bit is
 * positional, which is sound for a question whose wrong answer is a documented
 * fallback and is not sound as a published instant — see
 * {@link TradovateCommand}. `isAutomated` is left on the table for the same
 * reason and `automated` stays empty.
 *
 * The budget per run, per host: one `/order/list`, one `/orderStrategy/list`,
 * one `/command/list`, one `/orderStrategyLink/deps` per strategy, one
 * `/orderVersion/deps` per candidate order. A typical day of three trades
 * reaches eight to ten calls against a documented 5,000 per hour.
 * {@link MAX_ORDER_DEPS_PER_RUN} is the hard stop, and what matters about it is
 * the FAILURE DIRECTION: over the ceiling, a trade reads `'unknown'`, never
 * `'none'`.
 *
 * THE THREE LIST CALLS DO NOT SPEND THE CEILING and the deps calls do, which is
 * the same split the ceiling had before: what escalates to a `p-captcha` is a
 * fan-out proportional to the day's order count, and a flat one-per-host read is
 * not one.
 *
 *
 * AND NOTHING HERE PUTS A PRICE IN A MESSAGE
 * ------------------------------------------
 *
 * `withoutResponseBody` wraps EVERY read, before anything else in the function.
 * `TradovateRequestError` puts `body.slice(0, 300)` into its message, and for
 * `/orderVersion/deps` — and for `/command/list`, which echoes the terms of
 * every modification — that body is the trader's own stop prices, handed to
 * whatever logs it, four layers up, where nobody is thinking about this call.
 * Same reduction `discoverHostAccounts` makes on `/account/list`, for the same
 * reason. The log line below is counts only.
 */

import type { BrokerTrade, TradovateReader } from './fills';
import { withoutResponseBody } from './errors';
import type { TradovateEnvironment } from './hosts';
import { redactSecrets } from './redact';
import type {
  TradovateCommand,
  TradovateOrder,
  TradovateOrderStrategy,
  TradovateOrderStrategyLink,
  TradovateOrderVersion,
} from './types';

/**
 * The hard ceiling on `deps` calls for one run, across every host.
 *
 * Sixty, which is roughly seven times a typical day and still an order of
 * magnitude under the documented hourly quota. The number is less important than
 * the direction of its failure: FINDINGS.md §6 records that Tradovate's limits
 * apply separately to the number of ENTITIES in a response and that the penalty
 * escalates to a `p-captcha` a third-party application cannot solve — leaving
 * the trader waiting about an hour with their day's import stuck. A ceiling that
 * produces `'unknown'` is cheap; a captcha is not.
 *
 * Spent by BOTH deps shapes out of one counter — the strategy links and the
 * order versions — because the thing being protected is the request count and it
 * does not care which path spent it.
 */
export const MAX_ORDER_DEPS_PER_RUN = 60;

/**
 * How far outside a trade's life a protective order may be submitted and still
 * be attributed to it, in the window layer.
 *
 * One minute, and it is CLOCK TOLERANCE rather than a search widening. A stop
 * submitted before there was anything to protect is not this trade's stop, and
 * one submitted after the last exit fill cannot be either; the minute absorbs
 * the skew between an order's `timestamp` and a fill's.
 */
const WINDOW_TOLERANCE_MS = 60_000;

/** What the broker says about one trade's protective orders. The JSONB body. */
export interface StopHistory {
  /**
   * The answer, in the four values every reader branches on.
   *
   *   `'moved'`   a stop existed and its price changed at least once
   *   `'kept'`    a stop existed and never changed
   *   `'none'`    we read the orders and there was no stop — a FINDING
   *   `'unknown'` we could not tell. See {@link reason}.
   */
  verdict: 'moved' | 'kept' | 'none' | 'unknown';
  /** Why the verdict is `'unknown'`, and null whenever it is not. */
  reason: 'interday' | 'ambiguous' | 'capped' | 'failed' | null;
  /**
   * The stop THE POSITION OPENED UNDER. This is what `broker_stop_loss` holds.
   *
   * "As first submitted" until the fill anchor, and the distance between the two
   * readings was measured at 120 ticks on one real trade — see the header. It is
   * the last version in force when the entry filled, which on a trade with no
   * bracket and no moved entry is still version one.
   *
   * `versions[preFillVersions]`, and that identity is worth keeping: the
   * revisions this skipped are still in {@link versions} rather than erased.
   */
  initialStop: number | null;
  /**
   * Which side of the entry {@link initialStop} sat on. REF-113 follow-up.
   *
   *   `'risk'`  below the entry for a long, above it for a short — the only
   *             side a protective stop can be SUBMITTED on, because the other
   *             one fills the instant it reaches the book.
   *   `'wrong'` the other side, which is not a thing a broker can really do
   *             and therefore says this number is not a protective stop.
   *   `null`    there is no stop to have a side.
   *
   * MEASURED, NOT HYPOTHETICAL: on 19.10 a long stored an initial stop 148
   * ticks above its entry, and nothing in the shape said so. The selection now
   * prefers the risk side (see the reduce in {@link deriveStopHistory}), so
   * `'wrong'` survives only when EVERY candidate was on the wrong side — which
   * is a statement about our attribution, not about the trader.
   *
   * SO ANY READER THAT PUTS THIS NUMBER IN FRONT OF A TRADER MUST BRANCH ON
   * THIS FIELD. Stage 5 shows `broker_stop_loss` beside the planned stop; a
   * `'wrong'` is the signal to show nothing rather than to show a number that
   * disagrees with the trade it describes.
   *
   * ONLY {@link initialStop} IS TESTED, AND THAT IS NOT AN OVERSIGHT. A long's
   * stop dragged into profit ends ABOVE the entry legitimately — the measured
   * 19.10 bracket does exactly that — so a side test anchored to
   * {@link finalStop} would call the healthiest case a defect. It is tested on
   * the ANCHORED version rather than on version one for the same reason: the
   * side of a revision that was never in force says nothing about the trade.
   */
  initialStopSide: 'risk' | 'wrong' | null;
  /**
   * The stop as last submitted, over the counted window alone. In the JSON only.
   *
   * NOT NECESSARILY THE LAST ENTRY OF {@link versions}: a drag onto the market
   * to force an exit is the stop being used rather than moved, and it is cut
   * from the window (see the header). On the measured trade that is the
   * difference between reporting a final stop one tick ABOVE the entry and the
   * ninety ticks below it the trader was actually protected at.
   */
  finalStop: number | null;
  /** The target nearest the entry. This is what `broker_take_profit` holds. */
  initialTarget: number | null;
  /**
   * How many times the stop price changed, inside the counted window.
   *
   * THREE THINGS ARE NOT A MOVE, and each of them put a number on this field
   * that the trader would not recognise:
   *
   *   - a cancellation, which states no price at all (edge case 5);
   *   - a revision that restates the price it already had, which Tradovate
   *     mints for a quantity or TIF modify — the measured entry trigger had
   *     seven versions and three distinct prices;
   *   - anything outside the window: the broker's pre-fill re-pricing and the
   *     drag that closed the trade. See the header.
   */
  movedCount: number;
  /**
   * Which way it went, over CONSECUTIVE STEPS and never end-to-end (§C).
   *
   *   `'tightened'` every counted step moved toward the entry (risk down)
   *   `'widened'`   every counted step moved away from it
   *   `'mixed'`     both happened
   *
   * Null when nothing moved. "Widened" and not "worsened": this is a
   * description, and the judgement belongs to the rule the trader wrote.
   */
  direction: 'tightened' | 'widened' | 'mixed' | null;
  /**
   * When the move happened. STILL ALWAYS NULL, AND NO LONGER FOR WANT OF A
   * READ. `/command/list` is read now (see the header) and its instants are
   * paired positionally with the versions — which is enough to decide whether a
   * version predates the fill, a one-bit question whose wrong answer is a
   * documented fallback, and is not enough to publish as the instant a trader
   * touched their stop. Declared so that the field's absence is a stated fact
   * rather than a shape change later.
   */
  movedAtMs: null;
  /** Whether the stop was a trailing one. Its steps are the server's, not the trader's. */
  trailing: boolean;
  /** `verdict === 'none'`, as its own fact. Decision 2: no stop is a finding. */
  noStopPlaced: boolean;
  /** Which layer attributed the orders. See the header. */
  source: 'linked' | 'inferred' | 'none';
  /**
   * EVERY stop price the chosen order stated, oldest first. The evidence.
   *
   * THE WHOLE LIST AND NOT THE COUNTED WINDOW, on purpose. The verdict fields
   * above are a reading of this list, and a reading that threw away its own
   * input would leave nobody able to check it — which is how the 19.10 defect
   * survived a sync: the row said `movedCount: 5` and held nothing that could
   * say which five. Without instants, in v1.
   */
  versions: { stopPrice: number }[];
  /**
   * How many entries of {@link versions} precede {@link initialStop} — the
   * revisions that were already superseded when the position opened.
   *
   * Zero on a trade entered at market, which is most of them. Non-zero is the
   * signature of a bracket submitted behind an entry that moved before it
   * filled, and it is the count the 19.10 trade needed to be two.
   */
  preFillVersions: number;
  /**
   * Whether {@link initialStop} was decided by a clock or fell back to the
   * first version.
   *
   * `false` IS NOT A FAILURE AND IS NOT WORTH HIDING. It means the instants for
   * this order's versions could not be established — see {@link versionInstants}
   * for the several ways that happens — so the answer is the pre-anchor answer:
   * version one, with every version counted. On a trade whose stop was placed
   * once and left alone the two readings are identical, which is why this is a
   * flag rather than an `'unknown'`.
   *
   * WHAT A READER SHOULD DO WITH IT: nothing, unless it is about to tell the
   * trader a number they could dispute. `preFillVersions === 0` with
   * `anchoredAtFill === false` is the common, uninteresting case; a `false` on a
   * stop with many versions is the one worth a second look.
   *
   * AND `undefined` IS A THIRD STATE FOR ANYONE READING THE STORED COLUMN. This
   * interface describes what the module WRITES. `stop_history` is JSONB with no
   * CHECK, and every row written before this field existed carries neither it
   * nor {@link preFillVersions} — so a cast of a stored row yields `undefined`
   * where the declared types promise a value. There is no backfill and there
   * cannot be one: `./import.ts` derives only rows where `stop_history IS NULL`,
   * and `/order/list` is `depthDays = 0`, so the orders those rows came from are
   * gone. Treat an absent value as `false`, and an absent `preFillVersions` as
   * UNKNOWN rather than as zero. The shape block in
   * supabase/migrations/038_broker_stops.sql says the same thing where somebody
   * adding this column to a `select` will be standing.
   */
  anchoredAtFill: boolean;
  /** The targets that were not chosen, nearest first (§1.3 of decision 3). */
  otherTargets: number[];
  /** Present when one logical position became several trade rows (§1.3). */
  sharedWithTrades?: number;
  /** Present when the run hit {@link MAX_ORDER_DEPS_PER_RUN}. */
  capped?: true;
}

/**
 * Everything {@link deriveStopHistory} is allowed to know. Read once per run.
 *
 * `versions` IS A PARTIAL MAP AND THE ABSENCE OF A KEY IS A VALUE: it means the
 * order's versions were never asked for, because the ceiling was reached or a
 * read failed. That is what turns a `'none'` into an `'unknown'`, and encoding
 * it as a missing key rather than as a separate set is what makes it impossible
 * to forget.
 */
export interface StopEvidence {
  /** This host's `/order/list`, filtered to the trader's accounts, by id. */
  orders: ReadonlyMap<number, TradovateOrder>;
  /** Versions per order id, oldest first. A MISSING KEY MEANS NOT ASKED. */
  versions: ReadonlyMap<number, readonly TradovateOrderVersion[]>;
  /** `orderId` → `orderStrategyId`, from the reverse map layer B builds. */
  strategyByOrder: ReadonlyMap<number, number>;
  /**
   * Whether that reverse map covers every strategy of the day.
   *
   * False means a bracket may have been missed, so `'none'` is not a conclusion
   * this run is entitled to — the same fail-safe direction as a missing
   * `versions` key.
   */
  strategiesComplete: boolean;
  /** Why some versions are missing, when some are. */
  unscanned: 'capped' | 'failed' | null;
  /**
   * `orderId` → the instants of that order's commands, ASCENDING. The clock the
   * fill anchor runs on, and the only reason `/command/list` is read.
   *
   * PAIRED POSITIONALLY WITH THE VERSIONS, which is the whole fragility of this
   * field and is why {@link anchorStop} refuses the pairing unless the list is
   * at least as long as the version list. A command is given per modification
   * and a version is minted per modification, so the Nth command of an order is
   * the Nth version of it — until something in that sequence mints one and not
   * the other, and a cancel is exactly that (it is a command, and the measured
   * one minted no version). A cancel is LAST, so it lengthens the list without
   * shifting the pairs; anything that could shift them would have to be a
   * command in the middle that minted no version, and the refusal above is what
   * stands in for not being able to rule that out.
   *
   * ABSENT OR SHORT IS A VALUE, as everywhere else here: it means the anchor
   * falls back to version one and says so. Never an `'unknown'` — a fallback
   * anchor is a worse number, not an unreadable one.
   */
  commandTimes?: ReadonlyMap<number, readonly number[]>;
  /**
   * `orderVersion.id` → whether the server rather than the trader produced it.
   *
   * STILL EMPTY, AND NOW FOR A SHARPER REASON THAN "WE DO NOT READ COMMANDS".
   * `isAutomated` is measured on `/command/list`, which {@link commandTimes}
   * does read — but a command carries no version id, so attributing one to a
   * version means trusting the same positional pairing the anchor uses, and a
   * misattributed `true` MUTES A REAL MOVE on exactly the trade whose stop was
   * modified in some way that minted no version. The anchor can afford that bet
   * because its fallback is a documented one; this field's fallback is silence.
   * The three states are deliberate and are not symmetrical:
   *
   *   `true`    → the step is NOT counted as the trader's
   *   `false`   → counted
   *   ABSENT    → counted, falling back to the version verdict
   *
   * So the flag can only ever TAKE A MOVE AWAY from the trader, never confirm
   * one. The flag was present on 8 of 15 measured commands and there is no way
   * to tell "Tradovate omits a false boolean" from "the field is not populated
   * on this command type" by counting. The asymmetry is what that uncertainty
   * costs, and it is the same argument that ruled out trailing option 3: a wrong
   * `moved_sl = true` arms `moved_sl_last_trade`, which can be `block_day`, and
   * BLOCKS A TRADER OUT OF THE APP OVER SOMETHING THEY DID NOT DO. A wrong
   * `false` silently mutes one rule. Between the two, mute.
   */
  automated?: ReadonlyMap<number, boolean>;
}

/** Which layer offered a candidate order. Decides `source` and the filters. */
type Layer = 'own' | 'strategy' | 'window';

interface Candidate {
  orderId: number;
  layer: Layer;
}

const usableId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
};

const instant = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** The action that CLOSES a trade: a long is closed by a sell. */
const closingAction = (direction: BrokerTrade['direction']): 'Buy' | 'Sell' =>
  direction === 'long' ? 'Sell' : 'Buy';

/** Versions of one order, oldest first. `id` ascending IS the clock (§2.1). */
function inVersionOrder(
  versions: readonly TradovateOrderVersion[]
): readonly TradovateOrderVersion[] {
  // A version with no usable id cannot be placed in the sequence at all, and
  // guessing its position is how a "move" gets invented out of a reordering.
  return [...versions].filter((v) => usableId(v.id)).sort((a, b) => a.id - b.id);
}

/**
 * The newest `orderType` the versions state.
 *
 * Read off the LAST version rather than the first because a modify can change an
 * order's type, and what the order finally was is what it was protecting with.
 * Null when no version names one, which classifies the order as neither a stop
 * nor a target — the fail-closed direction.
 */
function orderTypeOf(versions: readonly TradovateOrderVersion[]): string | null {
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    const type = versions[i]?.orderType;
    if (typeof type === 'string' && type.length > 0) return type;
  }
  return null;
}

/**
 * Whether an order type is a stop.
 *
 * A SUBSTRING TEST AND NOT A UNION, because the measured sample cannot
 * enumerate the set and a union missing one value would classify a real stop as
 * not a stop — which reads as `'none'`, which is the one wrong answer this module
 * must never give. `StopLimit` is a stop and is tested BEFORE the limit test for
 * exactly that reason.
 */
const isStopType = (type: string | null): boolean => type !== null && /stop/i.test(type);
const isTrailingType = (type: string | null): boolean => type !== null && /trail/i.test(type);
const isTargetType = (type: string | null): boolean =>
  type !== null && /limit/i.test(type) && !isStopType(type);

/** The orders of this trade that are actually in today's list. */
function ownOrders(trade: BrokerTrade, orders: StopEvidence['orders']): TradovateOrder[] {
  const own: TradovateOrder[] = [];
  for (const id of trade.entryOrderIds) {
    const order = orders.get(id);
    if (order) own.push(order);
  }
  return own;
}

/**
 * When the trade's first order was SUBMITTED — the window's anchor (§B).
 *
 * The submission of the entry order and not the entry fill, because a bracket is
 * submitted with the entry: a window opened at the fill would miss every OCO
 * placed behind a resting limit entry. Null when no own order carries a readable
 * timestamp, which only disables layer C — A and B need no clock.
 */
function anchorMs(own: readonly TradovateOrder[]): number | null {
  const stamps = own.map((order) => instant(order.timestamp)).filter((ms): ms is number => ms !== null);
  return stamps.length > 0 ? Math.min(...stamps) : null;
}

/** The contract this trade was traded on, from its own orders. */
function contractOf(own: readonly TradovateOrder[]): number | null {
  for (const order of own) {
    if (usableId(order.contractId)) return order.contractId;
  }
  return null;
}

/**
 * Every order that could be this trade's protective order, by layer.
 *
 * EXPORTED, AND SHARED WITH THE READER ON PURPOSE. {@link readStopHistories}
 * has to know which orders to fetch versions for BEFORE anything can be
 * classified — `orderType` is only on the version — so the reader and the
 * derivation must agree about the candidate set exactly. Two copies of these
 * predicates would drift into a reader that fetches an order the derivation
 * never looks at, or worse, a derivation that reaches for versions the reader
 * never asked for.
 *
 * Only the ORDER-level predicates are here. Whether a candidate is a stop, a
 * target or neither is a version-level question and belongs to the derivation.
 */
export function candidateOrders(params: {
  trade: BrokerTrade;
  evidence: Pick<StopEvidence, 'orders' | 'strategyByOrder'>;
}): Candidate[] {
  const { trade, evidence } = params;
  const own = ownOrders(trade, evidence.orders);
  if (own.length === 0) return [];

  // EVERY OWN ORDER, INCLUDING THE ENTRY, AND THAT IS NOT WHAT `protective`
  // BELOW FILTERS. `own` and `ownIds` answer three questions that need the
  // entry order specifically — the window's anchor, the contract, and WHICH
  // STRATEGY THIS TRADE BELONGS TO. In a bracket the entry order is the leg
  // that carries the `orderStrategy` link, so narrowing this set would cut
  // layer B off from the bracket it exists to walk. The side test gates what is
  // OFFERED as a candidate, never what is known about the trade.
  const ownIds = new Set(own.map((order) => order.id));
  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  const offer = (orderId: number, layer: Layer) => {
    if (seen.has(orderId)) return;
    seen.add(orderId);
    candidates.push({ orderId, layer });
  };

  const closes = closingAction(trade.direction);

  /**
   * Whether an order is on the side that could protect this position.
   *
   * REF-113 FOLLOW-UP, AND THE DEFECT IT CLOSES WAS MEASURED IN PRODUCTION on
   * 19.10: a long whose ENTRY was a buy stop had that entry order attributed to
   * it as the protective stop, because `isStopType('Stop')` is true of a
   * breakout trigger and layers A and B tested no side at all. The trade's
   * stored `broker_stop_loss` was then the entry trigger's first version —
   * 148 ticks ABOVE the entry, a price at which a long's sell stop would have
   * filled instantly — and its `direction` described the trader walking that
   * trigger down to the market rather than anything they did to their stop.
   *
   * The rule was already stated twice and enforced in neither place that
   * decides: {@link TradovateOrder.action}'s own doc comment says "the
   * protective order of a long is a `Sell`", and layer C has tested it since
   * the first commit. This lifts it to A and B, where a LINKED order — the
   * strongest evidence this module has — was being trusted about a question it
   * disqualifies itself from.
   *
   * FAIL-OPEN ON AN ABSENT `action`, AND THAT ASYMMETRY WITH LAYER C IS THE
   * POINT. `action` is optional on the entity. Rejecting an order that does not
   * state a side would turn a real stop into no candidate, which reads as
   * `'none'` — "the trader traded without a stop" — and that is the one wrong
   * answer this module must never give (see the header on {@link isStopType}).
   * Layer C rejects an absent side because C is an INFERENCE and a missing
   * field there means the window cannot argue its case; A and B hold a FACT
   * about linkage and only lose the side of it.
   */
  const protective = (order: TradovateOrder): boolean =>
    order.action === undefined || order.action === closes;

  // ── Layer A ───────────────────────────────────────────────────────────────
  // Every order that produced a fill in this group. One of them may BE the
  // stop, in which case nothing has to be inferred at all. The entry order is
  // in here too and is exactly what `protective` is keeping out.
  for (const order of own) if (protective(order)) offer(order.id, 'own');

  // ── Layer B ───────────────────────────────────────────────────────────────
  // The siblings of any own order that belongs to a strategy. Walked through
  // the reverse map rather than by asking the strategy again.
  const strategies = new Set<number>();
  for (const id of ownIds) {
    const strategyId = evidence.strategyByOrder.get(id);
    if (strategyId !== undefined) strategies.add(strategyId);
  }
  if (strategies.size > 0) {
    for (const [orderId, strategyId] of evidence.strategyByOrder) {
      if (!strategies.has(strategyId)) continue;
      const order = evidence.orders.get(orderId);
      if (order === undefined) continue;
      // An OSO's entry leg is a sibling of its own bracket, so the side test
      // belongs here for the same reason it belongs in A.
      if (!protective(order)) continue;
      offer(orderId, ownIds.has(orderId) ? 'own' : 'strategy');
    }
  }

  // ── Layer C ───────────────────────────────────────────────────────────────
  // The window. Four order-level predicates and a clock; the quantity test is
  // version-level and is applied in the derivation.
  const anchor = anchorMs(own);
  const contractId = contractOf(own);
  if (anchor !== null && contractId !== null) {
    const from = anchor - WINDOW_TOLERANCE_MS;
    const until = trade.closedAtMs + WINDOW_TOLERANCE_MS;

    for (const order of evidence.orders.values()) {
      if (ownIds.has(order.id)) continue;
      if (order.accountId !== trade.accountId) continue;
      if (order.contractId !== contractId) continue;
      // A protective order sits on the side that CLOSES the position. An order
      // on the entry side inside the same window is a scale-in, not a stop.
      // STRICTER THAN `protective` ON PURPOSE: an absent side is fatal to an
      // inference and survivable for a link. See `protective` above.
      if (order.action !== closes) continue;
      const submitted = instant(order.timestamp);
      if (submitted === null || submitted < from || submitted > until) continue;
      offer(order.id, 'window');
    }
  }

  return candidates;
}

/** A trade's life, for the overlap test: submission of the first order to exit. */
function lifespan(trade: BrokerTrade, orders: StopEvidence['orders']): [number, number] {
  const anchor = anchorMs(ownOrders(trade, orders));
  return [Math.min(anchor ?? trade.openedAtMs, trade.openedAtMs), trade.closedAtMs];
}

/**
 * The other trade rows of this run that describe the same logical position.
 *
 * §1.3, AND THE MOST SUBTLE THING IN THIS MODULE. `order → trade` is not a
 * function: Stage 1 found that an entry order for three contracts, filling in
 * three pieces each paired with a separate exit fill, produces THREE
 * `BrokerTrade` rows — union-find groups on shared fills, and those three share
 * none. There was one stop on one position, and the honest answer is to attribute
 * it to all three rows and say so (`sharedWithTrades`). That distortion —
 * `tradeScore` penalising three rows for one move — already exists today for the
 * trade count and the P&L, and REF-113 does not deepen it.
 *
 * WHAT SEPARATES THAT FROM REAL AMBIGUITY IS WHETHER THEY SHARE AN ORDER ID:
 *
 *   lifespans do not overlap          → unrelated. Ordinary attribution.
 *   overlap AND share an `orderId`    → ONE position, several rows. Attribute
 *                                       to all of them.
 *   overlap AND share NO `orderId`    → two parallel positions in one contract.
 *                                       `'unknown'`, and nothing is written.
 *
 * The third row is the case §B declared and this is the explicit test for it.
 */
function relatedTrades(params: {
  trade: BrokerTrade;
  trades: readonly BrokerTrade[];
  orders: StopEvidence['orders'];
  contractId: number;
}): { shared: BrokerTrade[]; ambiguous: boolean } {
  const { trade, trades, orders, contractId } = params;
  const [from, until] = lifespan(trade, orders);
  const mine = new Set(trade.entryOrderIds);

  const shared: BrokerTrade[] = [];
  let ambiguous = false;

  for (const other of trades) {
    if (other.brokerTradeKey === trade.brokerTradeKey) continue;
    if (other.host !== trade.host) continue;
    if (other.accountId !== trade.accountId) continue;

    const otherOwn = ownOrders(other, orders);
    // A trade whose own orders are not in today's list cannot be holding a
    // competing position whose stop IS in it — both were submitted on the same
    // day as the orders they belong to. So it is not evidence either way.
    if (otherOwn.length === 0) continue;
    if (contractOf(otherOwn) !== contractId) continue;

    const [otherFrom, otherUntil] = lifespan(other, orders);
    if (otherUntil < from || otherFrom > until) continue;

    if (other.entryOrderIds.some((id) => mine.has(id))) shared.push(other);
    else ambiguous = true;
  }

  return { shared, ambiguous };
}

/** One candidate, once its versions have been read and classified. */
interface ProtectiveOrder {
  orderId: number;
  layer: Layer;
  versions: readonly TradovateOrderVersion[];
  type: string | null;
  /**
   * The order's own `ordStatus`, carried from the order rather than the version.
   *
   * Read by {@link withoutExitDrag} alone, and read there because a cancelled
   * stop is the state a hand-forced exit leaves behind. It is the order's field
   * and not the version's — the versions name the terms, the order names what
   * became of it.
   */
  ordStatus?: string;
}

/**
 * One stop candidate's versions, placed against the entry fill.
 *
 * The output of the two cuts the header describes, and it is computed PER
 * CANDIDATE rather than once for the winner, because the selection ranks
 * candidates by the risk their initial stop states — and after the anchor, that
 * is the anchored version's risk and not version one's. Ranking on one number
 * and reporting another is how the 19.10 row came to describe a price it had
 * never chosen.
 */
interface AnchoredStop {
  order: ProtectiveOrder;
  /** Every stated stop price, oldest first. {@link StopHistory.versions}. */
  all: number[];
  /**
   * The versions the verdict is computed over: the anchor onward, less an exit
   * drag. NEVER EMPTY — every caller indexes it, and the cuts are written so
   * that they cannot take the last version away.
   *
   * CARRIES THE PRICE RATHER THAN LETTING EACH READER RE-DERIVE IT. `finite`
   * over `stopPrice` is the one place "a version with no stated price is not a
   * price" is decided, and a reader that re-ran it would be a second place to
   * keep that rule — which is also three more passes over the same list for one
   * number.
   */
  counted: readonly StatedStop[];
  /** Index into {@link all} of the anchor. `all[preFill]` is the initial stop. */
  preFill: number;
  /** Whether a clock decided {@link preFill}. {@link StopHistory.anchoredAtFill}. */
  anchoredAtFill: boolean;
}

/** One version of a stop that stated a price, with the instant we could put on it. */
interface StatedStop {
  version: TradovateOrderVersion;
  price: number;
  /** Null when no source could time it. See {@link versionInstants}. */
  atMs: number | null;
}

/** An `'unknown'` answer, with the reason it is one. */
function unknownHistory(
  reason: NonNullable<StopHistory['reason']>,
  extra: Partial<StopHistory> = {}
): StopHistory {
  return {
    verdict: 'unknown',
    reason,
    initialStop: null,
    initialStopSide: null,
    finalStop: null,
    initialTarget: null,
    movedCount: 0,
    direction: null,
    movedAtMs: null,
    trailing: false,
    noStopPlaced: false,
    source: 'none',
    versions: [],
    preFillVersions: 0,
    anchoredAtFill: false,
    otherTargets: [],
    ...extra,
  };
}

/**
 * What the broker's orders say about one trade. PURE.
 *
 * `trades` is the whole run's rows and not a mistake: the §1.3 test needs the
 * siblings, and a function that took only the subject would have to be told the
 * answer instead of working it out.
 *
 * READS NOTHING AND THROWS NOTHING. Every number comes off the evidence through
 * a finiteness check, because a type here is a claim about Tradovate's
 * documentation and not about the value in hand — the same discipline
 * ./fills.ts applies to `netPos`.
 */
export function deriveStopHistory(params: {
  trade: BrokerTrade;
  trades: readonly BrokerTrade[];
  evidence: StopEvidence;
}): StopHistory {
  const { trade, trades, evidence } = params;
  const capped = evidence.unscanned === 'capped' ? { capped: true as const } : {};
  // Why an `'unknown'` from an incomplete scan is unknown. Defaulted to the
  // ceiling because a caller that assembled evidence with gaps and did not say
  // why has, in effect, stopped asking.
  const transient = evidence.unscanned ?? 'capped';

  const own = ownOrders(trade, evidence.orders);
  // The inter-day case, and it is the common one rather than an edge: the entry
  // order was submitted yesterday and `/order/list` has already forgotten it.
  // There is no anchor, no contract and no stop to find — and crucially, no
  // grounds to say the trader placed none.
  if (own.length === 0) return unknownHistory('interday');

  const contractId = contractOf(own);
  if (contractId === null) return unknownHistory('interday');

  const { shared, ambiguous } = relatedTrades({ trade, trades, orders: evidence.orders, contractId });
  // Two positions open in one contract at one time, sharing no order. Which
  // stop belonged to which is not recoverable, and a guess here would put one
  // trade's risk on another's row.
  if (ambiguous) return unknownHistory('ambiguous');

  const sharedWith = shared.length > 0 ? { sharedWithTrades: shared.length + 1 } : {};

  // ── Classify the candidates ───────────────────────────────────────────────
  const candidates = candidateOrders({ trade, evidence });
  const scanned: ProtectiveOrder[] = [];
  let missing = false;

  for (const { orderId, layer } of candidates) {
    const versions = evidence.versions.get(orderId);
    if (versions === undefined) {
      // The ceiling, or a failed read. Either way this order was never looked
      // at, so nothing it might have been can be ruled out.
      missing = true;
      continue;
    }
    const ordered = inVersionOrder(versions);
    scanned.push({
      orderId,
      layer,
      versions: ordered,
      type: orderTypeOf(ordered),
      ordStatus: evidence.orders.get(orderId)?.ordStatus,
    });
  }

  // Layers A and B before C, and C only if the first two produced nothing. An
  // inference must never outrank a link — see the header.
  const linked = scanned.filter((order) => order.layer !== 'window');
  const linkedStops = linked.filter((order) => isStopType(order.type));
  const linkedTargets = linked.filter((order) => isTargetType(order.type));

  const useWindow = linkedStops.length === 0 && linkedTargets.length === 0;
  const pool = useWindow ? scanned : linked;

  const stops = pool.filter((order) => isStopType(order.type)).filter(
    (order) => stopPrices(order.versions).length > 0
  );
  const targets = pool
    .filter((order) => isTargetType(order.type))
    .filter((order) => targetPrice(order.versions) !== null);

  // The quantity test, and it applies to INFERRED candidates only. An order for
  // more contracts than the position held cannot be protecting it — but a
  // bracket's own stop legitimately covers the whole logical position, which
  // §1.3 may have split into several rows, so applying this to a linked order
  // would discard the most reliable evidence this module has.
  const sized = (order: ProtectiveOrder): boolean => {
    if (order.layer !== 'window') return true;
    const qty = finite(order.versions[order.versions.length - 1]?.orderQty);
    return qty === null || qty <= trade.qty;
  };

  const stopOrders = stops.filter(sized);
  const targetOrders = targets.filter(sized);

  // ── No stop, and the two reasons that is not a conclusion ─────────────────
  if (stopOrders.length === 0) {
    // Something was not looked at, or the bracket map is incomplete. "We found
    // no stop" is only a finding when the search was complete; otherwise it is
    // our own failure wearing the finding's clothes, and `'none'` would arm a
    // coach to tell a trader they traded without a stop.
    if (missing || !evidence.strategiesComplete) {
      return unknownHistory(transient, { ...capped, ...sharedWith });
    }

    const chosenTarget = nearestTarget(targetOrders, trade);
    return {
      verdict: 'none',
      reason: null,
      initialStop: null,
      initialStopSide: null,
      finalStop: null,
      initialTarget: chosenTarget.initialTarget,
      movedCount: 0,
      direction: null,
      movedAtMs: null,
      trailing: false,
      noStopPlaced: true,
      source: chosenTarget.initialTarget === null ? 'none' : chosenTarget.source,
      versions: [],
      preFillVersions: 0,
      anchoredAtFill: false,
      otherTargets: chosenTarget.otherTargets,
      ...capped,
      ...sharedWith,
    };
  }

  // ── The stop: the MOST RISK, which is not the same as the furthest ────────
  // A stop is a worst case. A long of three contracts stopped at 99 for one and
  // 98 for two risked 98, and taking the nearer number would flatter both the
  // risk and the R:R the planning block compares against. The mirror decision
  // for targets is below and is the opposite on purpose: a target is an
  // expectation, so the nearest is "my target" (Imri, 19.10).
  //
  // THIS WAS `Math.abs` AND THAT IS THE SECOND HALF OF THE 19.10 DEFECT. An
  // absolute distance has no side, so a price on the WRONG side of the entry
  // won whenever it happened to be further away — and the production row that
  // started this was exactly that: a candidate 148 ticks above a long's entry
  // beat the real stop 131 ticks below it, 37.00 > 32.75, and the trade stored
  // a "stop" it could never have had. Note how narrowly the old test suite
  // missed it: its two-stop case had BOTH stops below the entry, where an
  // absolute distance gives the right answer for the wrong reason.
  //
  // A PARTITION AND NOT A FILTER, and that is the fail-safe. Discarding
  // wrong-side candidates outright would leave `stopOrders` empty on a trade
  // where every candidate is wrong-side, and an empty list is `'none'` — "the
  // trader traded without a stop", the one wrong answer this module must never
  // give. So the risk side merely OUTRANKS the wrong side: as long as one real
  // stop is present it wins outright, and when none is, the best of a bad set
  // is still reported and {@link StopHistory.initialStopSide} says it is bad.
  //
  // ANCHORED FIRST, THEN RANKED, and the order of those two matters: the risk a
  // candidate states is the risk of the version that was in force when the
  // position opened, not of a revision the broker superseded before the fill.
  const anchored = stopOrders.map((order) =>
    anchorStop({ order, trade, commandTimes: evidence.commandTimes })
  );
  const onRiskSide = anchored.filter((entry) => riskOf(entry, trade) > 0);
  const ranked = onRiskSide.length > 0 ? onRiskSide : anchored;
  const stop = ranked.reduce((worst, entry) =>
    riskOf(entry, trade) > riskOf(worst, trade) ? entry : worst
  );

  const counted = stop.counted.map((entry) => entry.price);
  const steps = countMoves({
    steps: stop.counted,
    direction: trade.direction,
    trailing: isTrailingType(stop.order.type),
    automated: evidence.automated,
  });

  const chosenTarget = nearestTarget(targetOrders, trade);

  return {
    verdict: steps.movedCount > 0 ? 'moved' : 'kept',
    reason: null,
    initialStop: counted[0],
    initialStopSide: riskOf(stop, trade) > 0 ? 'risk' : 'wrong',
    finalStop: counted[counted.length - 1],
    initialTarget: chosenTarget.initialTarget,
    movedCount: steps.movedCount,
    direction: steps.direction,
    movedAtMs: null,
    trailing: isTrailingType(stop.order.type),
    noStopPlaced: false,
    source: stop.order.layer === 'window' ? 'inferred' : 'linked',
    versions: stop.all.map((stopPrice) => ({ stopPrice })),
    preFillVersions: stop.preFill,
    anchoredAtFill: stop.anchoredAtFill,
    otherTargets: chosenTarget.otherTargets,
    ...capped,
    ...sharedWith,
  };
}

/**
 * The instant of each of an order's versions, in version order. REF-113
 * follow-up, and the clock the fill anchor needs.
 *
 * TWO SOURCES, AND THE WEAKER ONE IS THE ONE THAT RUNS TODAY:
 *
 *   1. The version's own `timestamp`, when a host sends one. Measured absent on
 *      every row of the 19.10 sample (./types.ts), so this is a contingency —
 *      but it needs no pairing to be trusted, so it is tried first.
 *   2. `/command/list`, paired POSITIONALLY. See
 *      {@link StopEvidence.commandTimes} for why that pairing holds and what it
 *      cannot survive.
 *
 * ALL OR NOTHING, PER SOURCE, AND NULL MEANS NOTHING. A list where some instants
 * are known and some are not would let the anchor land on a version whose
 * neighbour simply had no clock, which is a wrong anchor wearing a right one's
 * clothes — and mixing the two sources could put a version stamp and a command
 * stamp in one comparison, which is not a comparison. So a source either times
 * every version or supplies nothing, the return type says which, and nothing
 * means the documented fallback.
 *
 * THREE REFUSALS, AND THE FIRST TWO ARE WHAT THE COUNT ALONE DOES NOT CATCH.
 *
 *   1. **The counts must line up EXACTLY**, with one exception: a cancelled
 *      order may carry one extra command, because a cancel is a command that
 *      mints no version and a cancel is last. Anything else — a REJECTED
 *      MODIFY, which is a command in the MIDDLE that minted no version, or a
 *      version this module dropped for an unusable `id` — makes the list longer
 *      than the exception allows and refuses the pairing. `commands.length >=
 *      versions.length` was the first guard here and it is not enough: a
 *      rejected modify passes it and then shifts every pair after it, which
 *      dates a post-fill revision before the fill and stores it as the risk the
 *      position opened under, with `anchoredAtFill: true` asserting a clock
 *      answered.
 *   2. **The instants must not decrease.** The command path is sorted, so this
 *      bites on the version path, which is ordered by `id` and not by time: a
 *      host whose version ids are not minted in time order, or whose brokers'
 *      clocks skew, would otherwise have the counted window take an index
 *      suffix of a sequence that is not in time order at all and silently drop
 *      a real post-fill move out of the middle of it.
 *   3. Every version must be timed, which is the all-or-nothing rule above.
 */
function versionInstants(
  order: ProtectiveOrder,
  commandTimes: StopEvidence['commandTimes']
): number[] | null {
  const wanted = order.versions.length;

  const own = order.versions.map((version) => instant(version.timestamp));
  if (own.every((ms): ms is number => ms !== null)) return rising(own);

  const commands = commandTimes?.get(order.orderId);
  if (commands === undefined) return null;
  // One spare command, and only for the cancel that a cancelled order's last
  // command is. See refusal 1.
  const spare = cancelShaped(order.ordStatus) ? 1 : 0;
  if (commands.length < wanted || commands.length > wanted + spare) return null;
  return rising(commands.slice(0, wanted));
}

/** The instants, if they never go backwards. Refusal 2 of {@link versionInstants}. */
function rising(instants: readonly number[]): number[] | null {
  for (let i = 1; i < instants.length; i += 1) {
    if (instants[i] < instants[i - 1]) return null;
  }
  return [...instants];
}

/**
 * Whether an order's status says it was cancelled.
 *
 * A SUBSTRING TEST, for the reason {@link isStopType} gives: the measured value
 * is `Canceled`, the spelling with two Ls exists in the wild, and the set cannot
 * be enumerated from one sample. Fails SAFE on a status it does not recognise —
 * {@link versionInstants} then allows the pairing no spare command.
 *
 * CANCELLED AND NOT TERMINAL, and the narrowness is the point: this one gates
 * the SPARE COMMAND, and only a cancel is a command that mints no version. A
 * fill is an execution and issues no command at all, so a filled order gets no
 * spare. {@link terminalShaped} is the wider test and has the other reader.
 */
const cancelShaped = (ordStatus: string | undefined): boolean =>
  ordStatus !== undefined && /cancel/i.test(ordStatus);

/**
 * Whether an order's status says it is DONE — cancelled or filled.
 *
 * {@link withoutExitDrag}'s gate. The two outcomes are one event seen from two
 * sides, so they are tested together; what this excludes is a stop still
 * `Working`, which nobody pulled out of the way.
 *
 * `PartiallyFilled` IS DELIBERATELY INCLUDED by the substring, because a stop
 * that filled for part of the position is still a stop the trade got out
 * through. A hypothetical `Unfilled`-shaped value would be read as filled by the
 * same substring; the cost is one uncounted move, which is the direction this
 * function already argues for at length, and the alternative — an enumerated
 * union against a set one sample cannot enumerate — is the mistake
 * {@link isStopType} exists to avoid.
 */
const terminalShaped = (ordStatus: string | undefined): boolean =>
  ordStatus !== undefined && /cancel|fill/i.test(ordStatus);

/**
 * One stop candidate's versions, cut at both ends. See the module header.
 *
 * THE ANCHOR IS THE LAST VERSION IN FORCE AT THE FILL, which is the largest
 * index whose instant is at or before `openedAtMs` — AT, not before, and that
 * `<=` is load-bearing: the measured bracket's third version is the one the
 * broker minted as the fill happened, re-pricing the stop from 132 ticks off the
 * entry TRIGGER to 131 off the price that actually filled. It is the stop the
 * position opened under and a `<` would have skipped it.
 *
 * `openedAtMs` IS THE FIRST OPENING FILL AND NOT THE LAST. On a position scaled
 * into over several fills, the stop in force at the first one is the stop the
 * trader opened under; anchoring at the last would read their own adjustments
 * between the first contract and the last as the broker's pre-fill re-pricing
 * and drop them from the count. Later is the greedier reading and this takes the
 * earlier one, for the same reason the module prefers the most risk to the
 * least.
 *
 * NO INSTANTS MEANS INDEX ZERO AND `anchoredAtFill: false`. Every version
 * AFTER the fill also means index zero — a stop placed by hand once the trader
 * was already in has nothing before it to skip — and that case is flagged
 * `true`, because the clock did answer. The two look the same in `preFill` and
 * are told apart by the flag, which is the only reason the flag exists.
 */
function anchorStop(params: {
  order: ProtectiveOrder;
  trade: BrokerTrade;
  /** The clock alone. The order's own status travels on {@link ProtectiveOrder}. */
  commandTimes: StopEvidence['commandTimes'];
}): AnchoredStop {
  const { order, trade, commandTimes } = params;

  const times = versionInstants(order, commandTimes);
  const fillMs = finite(trade.openedAtMs);

  // The versions that STATE a price, each carrying the instant of ITS POSITION
  // IN THE FULL LIST — a cancellation states no price and cannot be an anchor,
  // but it did consume a command, so the pairing happens before this filter and
  // never after it. The price is carried through rather than re-derived: it is
  // `initialStop`, it is `finalStop`, and it is what `riskOf` ranks on.
  const stated: StatedStop[] = [];
  order.versions.forEach((version, i) => {
    const price = finite(version.stopPrice);
    if (price !== null) stated.push({ version, price, atMs: times?.[i] ?? null });
  });

  const timed = times !== null && fillMs !== null;
  const preFill = timed ? anchorIndex(stated, fillMs) : 0;
  const counted = withoutExitDrag(stated.slice(preFill), order, trade);

  return {
    order,
    all: stated.map((entry) => entry.price),
    counted,
    preFill,
    anchoredAtFill: timed,
  };
}

/**
 * The index of the last version in force at the fill. Zero when none is.
 *
 * TIES AT THE BOUNDARY RESOLVE TO THE EARLIEST, AND THAT IS THE CONSERVATIVE
 * DIRECTION RATHER THAN THE OBVIOUS ONE. A command's instant is only as precise
 * as the host sends it, and the measured trade has the broker's fill re-pricing
 * and the trader's first drag seconds apart — at second resolution they can
 * share a stamp. Taking the LAST of a tied run would then anchor on the
 * trader's drag, which is a TIGHTER price: it would understate the risk the
 * position opened under and drop a real move from the count, and flattering the
 * risk is the one thing this module refuses everywhere (see the reduce in
 * {@link deriveStopHistory}). Taking the earliest of the run overstates nothing
 * and keeps the move.
 */
function anchorIndex(stated: readonly { atMs: number | null }[], fillMs: number): number {
  let latest: number | null = null;
  for (const entry of stated) {
    if (entry.atMs !== null && entry.atMs <= fillMs && (latest === null || entry.atMs > latest)) {
      latest = entry.atMs;
    }
  }
  if (latest === null) return 0;
  const first = stated.findIndex((entry) => entry.atMs === latest);
  return first < 0 ? 0 : first;
}

/**
 * The counted window, less the drag that closed the trade.
 *
 * WHAT THIS CUTS, IN THE TRADER'S WORDS: "I pulled my stop up to the market to
 * get out." The broker sees a modification like any other, and the counted
 * window would see a move toward the entry — on the measured trade, a final
 * stop ONE TICK ABOVE the entry on a long, which both reports a move the trader
 * did not make to their risk and throws away the ninety-tick stop they were
 * actually protected at.
 *
 * THREE CONDITIONS, ALL OF THEM NECESSARY, AND THEY ARE NARROW ON PURPOSE:
 *
 *   1. It is the LAST version. A drag to the market is the last thing that
 *      happens to a stop; one in the middle is a stop that was moved and then
 *      moved again, and that is two moves.
 *   2. The order is TERMINAL — cancelled or filled. Both are the same event seen
 *      from two sides and the distinction was a mistake while it lasted: the
 *      trader drags the stop onto the market, and then either it fills (the stop
 *      IS the exit) or their flatten fills first and the OCO cancels it. A stop
 *      still WORKING after the trade closed is neither, and is not a stop
 *      somebody pulled out of the way.
 *   3. The LAST STEP CROSSED THE EXIT: the version before it sits on the
 *      protective side of the price the trade actually got out at, and the last
 *      one sits at or past it. A long needs `before < exit <= after`, a short
 *      the mirror.
 *
 * (2) ONCE READ `CANCELLED` ALONE, PLUS "AND PRODUCED NO FILL IN THIS GROUP".
 * That pair was built to protect a stop that filled partially and had its
 * remainder cancelled, on the reasoning that its last version was a price the
 * trader was genuinely protected at. The reasoning was backwards: a stop that
 * filled, wholly or partly, is a stop the trade got out THROUGH, and its last
 * version is the price it got out at. So the fill test is gone and `Filled`
 * joins `Canceled` instead of excluding.
 *
 * AND (3) IS A CROSSING RATHER THAN A POSITION BECAUSE A POSITION IS NOT ENOUGH
 * — this is the first thing the suite caught. "The last version is at or beyond
 * the exit" is also true of a stop that was tightened once and then cancelled
 * while the market ran past where it used to be: a long stopped at 95, tightened
 * to 96, cancelled, and closed by hand at 90 has a last version above its exit
 * and has genuinely been moved. What that case does NOT have is a last step that
 * crossed 90 — it was already on the far side of it before the step. A drag onto
 * the market is by construction a crossing: the stop starts where it was
 * protecting from and ends where the trade got out.
 *
 * AND IT NEVER EMPTIES THE WINDOW. A stop whose only counted version is the
 * drag itself keeps it: `initialStop` has to come from somewhere, and a window
 * with nothing in it would read as `'none'` — the one wrong answer this module
 * must never give. A one-version window also has no move to miscount, and no
 * step to have crossed anything, so there is nothing to gain by cutting it.
 *
 *
 * TWO BOUNDARIES THIS CANNOT RESOLVE, STATED RATHER THAN HIDDEN
 * ------------------------------------------------------------
 *
 * **`exitPrice` IS A QUANTITY-WEIGHTED AVERAGE** (./fills.ts), so on a scaled-out
 * trade it is a price the exit may never have printed at, and the crossing is
 * tested against it anyway. The honest quantity is the fill that closed the last
 * contract, and it is not on {@link BrokerTrade} — the fills are summarised into
 * an average before this module sees them. On a single-leg exit, which is most
 * trades, the average IS the closing price and the test is exact. On a scale-out
 * the cut can fire a step early or a step late, which costs one move in the
 * count; reaching the per-leg price is a change to ./fills.ts and is not this
 * one.
 *
 * **A STOP AT EXACTLY THE EXIT IS AMBIGUOUS AND IS CUT**, and taking `Filled`
 * widens that boundary rather than narrowing it. `after >= exitPrice` must take
 * equality — a drag onto the market lands AT the market — and a stop that FILLED
 * is at the exit by construction, because its fill is what the exit price is
 * made of. So a stop that was trailed up and then hit reads as an exit through
 * the stop and its last tightening is cut: a long trailed 95 → 98 and stopped
 * out at 98 reports `kept`, `movedCount: 0`, `finalStop: 95`.
 *
 * THAT IS A DELIBERATE READING AND NOT AN OVERSIGHT, on two grounds. A trader
 * stopped out at their stop DID honour it, which is what `kept_sl` is for. And
 * the direction of the error is the one the module already chose for
 * {@link StopEvidence.automated}: under-reporting a move mutes one rule, while
 * over-reporting one can arm `moved_sl_last_trade`, which can be `block_day`,
 * and lock a trader out of the app over something they did not do. Between the
 * two, mute. What it costs is that a trailing stop's last tightening is not
 * visible in `movedCount`; it is still in {@link StopHistory.versions}, which is
 * why that field keeps every price rather than the counted window.
 */
function withoutExitDrag(
  stated: readonly StatedStop[],
  order: ProtectiveOrder,
  trade: BrokerTrade
): readonly StatedStop[] {
  if (stated.length < 2) return stated;
  if (!terminalShaped(order.ordStatus)) return stated;

  const { exitPrice } = trade;
  const before = stated[stated.length - 2].price;
  const after = stated[stated.length - 1].price;
  const crossed =
    trade.direction === 'long'
      ? before < exitPrice && after >= exitPrice
      : before > exitPrice && after <= exitPrice;

  return crossed ? stated.slice(0, -1) : stated;
}

/**
 * The stop prices this order actually stated, oldest first.
 *
 * A VERSION WITH NO STOP PRICE IS DROPPED RATHER THAN READ AS A CHANGE, and that
 * is edge case 5: a trader who closed by hand leaves the stop `Canceled`, and a
 * cancellation IS NOT A MOVE and must not increment `movedCount`. The measured
 * sample's cancellation minted no version at all, so this is belt and braces —
 * but it is the belt that holds if a host does mint one, and the alternative
 * silently reports a move the trader never made.
 */
function stopPrices(versions: readonly TradovateOrderVersion[]): number[] {
  const prices: number[] = [];
  for (const version of versions) {
    const price = finite(version.stopPrice);
    if (price !== null) prices.push(price);
  }
  return prices;
}

/**
 * The risk this stop's ANCHORED version states, signed. Positive is a real stop.
 *
 * The number "furthest from entry" was always reaching for and never had: a
 * long risks `entry - stop` and a short risks `stop - entry`, so one subtraction
 * read off {@link BrokerTrade.direction} both ORDERS the candidates and TELLS
 * THE SIDE, and a negative value is a candidate that cannot be a protective
 * stop at all. Read off the trade and never from whether the price happens to
 * sit above or below the entry — the same rule {@link countMoves} states at
 * more length, and for the same reason.
 *
 * THE ANCHORED VERSION AND NOTHING ELSE. A stop dragged into profit ends on the
 * wrong side legitimately, which is a healthy trade and not a defect; what
 * cannot happen is a protective stop IN FORCE AT THE FILL on the wrong side,
 * because the book would have filled it on arrival. It was version one before
 * the fill anchor, and that is what made the 19.10 trade rank its candidates on
 * a price the broker had already superseded.
 *
 * Safe to index: {@link AnchoredStop.counted} is never empty, and every caller
 * has already filtered to orders with at least one stated stop price
 * (`stopPrices(...).length > 0` in {@link deriveStopHistory}).
 */
function riskOf(stop: AnchoredStop, trade: BrokerTrade): number {
  const anchor = stop.counted[0].price;
  return trade.direction === 'long' ? trade.entryPrice - anchor : anchor - trade.entryPrice;
}

/** A target's price: the limit price of its first version. */
function targetPrice(versions: readonly TradovateOrderVersion[]): number | null {
  for (const version of versions) {
    const price = finite(version.price);
    if (price !== null) return price;
  }
  return null;
}

/**
 * The target nearest the entry, and the ones that lost. Decision 3.
 *
 * SIDED SINCE THE REF-113 FOLLOW-UP, and this is the stop defect's twin rather
 * than a precaution. A long's target is ABOVE its entry, and "nearest the
 * entry" without a side is won by whatever sits closest to it on either — so a
 * resting BUY LIMIT entry order, which is `isTargetType` and is at distance
 * zero from the fill it produced, outranked every real target in the bracket.
 * Measured: `broker_take_profit` came back as the entry price itself with the
 * planned target demoted into {@link StopHistory.otherTargets}.
 *
 * The side test in {@link candidateOrders} keeps that particular order out
 * whenever Tradovate states its `action`, so this is the second of two locks on
 * one door — deliberately, because that test is fail-open on an absent side and
 * this one needs no field to be present to work.
 *
 * WITHIN A SIDE, STILL THE NEAREST, AND STILL BY ABSOLUTE DISTANCE. The
 * ordering is what `otherTargets` means by "nearest first", and keeping it
 * absolute is what makes the wrong-side group fall back to exactly the old
 * behaviour instead of to a new one.
 */
function nearestTarget(
  orders: readonly ProtectiveOrder[],
  trade: BrokerTrade
): { initialTarget: number | null; otherTargets: number[]; source: 'linked' | 'inferred' } {
  const { entryPrice } = trade;
  /** What reaching this target would have paid. Negative is the wrong side. */
  const gainOf = (price: number): number =>
    trade.direction === 'long' ? price - entryPrice : entryPrice - price;

  const priced = orders
    .map((order) => ({ price: targetPrice(order.versions), layer: order.layer }))
    .filter((entry): entry is { price: number; layer: Layer } => entry.price !== null)
    .sort(
      (a, b) =>
        // The side first, as a partition and not as a weight — a wrong-side
        // target never outranks a real one however close it sits. Then the
        // nearest within the group.
        Number(gainOf(b.price) > 0) - Number(gainOf(a.price) > 0) ||
        Math.abs(a.price - entryPrice) - Math.abs(b.price - entryPrice)
    );

  if (priced.length === 0) return { initialTarget: null, otherTargets: [], source: 'linked' };

  return {
    initialTarget: priced[0].price,
    otherTargets: priced.slice(1).map((entry) => entry.price),
    source: priced[0].layer === 'window' ? 'inferred' : 'linked',
  };
}

/**
 * How many times the stop moved, and which way — over CONSECUTIVE STEPS (§C).
 *
 * TAKES THE COUNTED WINDOW AND NOT THE ORDER'S VERSIONS. What is outside that
 * window is the broker re-pricing a bracket before the fill and the trader
 * dragging the stop onto the market to get out, and neither is a move; the cuts
 * are {@link anchorStop}'s and this function sees only what survived them.
 *
 * END-TO-END WOULD BE WRONG AND IT IS WORTH SAYING WHY: a stop dragged up to
 * break-even and then back down to where it started has moved twice, and
 * comparing the first version to the last would report that it never moved at
 * all. So every adjacent pair is a step, and the verdict is the union of the
 * steps.
 *
 * "TIGHTENED" IS MEASURED AGAINST THE DIRECTION OF THE TRADE AND NOT AGAINST THE
 * PRICES. A long's stop sits below the entry, so upward is toward it and is less
 * risk; a short's is the mirror. This is the one comparison family
 * lib/rules/tradeRuleContext.ts records having shipped backwards once, which is
 * why the direction is read off the trade and never inferred from whether the
 * stop happens to be above or below the entry.
 *
 * TRAILING (decision 4). A trail only ever tightens, so its steps read as
 * `'tightened'` from the prices alone — which is option 1, and option 1 is the
 * fallback. Option 4 is the refinement on top: if `pegDifference` GREW between
 * two versions the trader widened the trail itself, and that step is a genuine
 * widening however the price moved. `pegDifference` was never measured (Q5 had
 * no trailing trade in the sample), so this branch is live only on a host that
 * actually sends the field, and the fallback is what runs otherwise.
 */
function countMoves(params: {
  /**
   * The counted window, already filtered to versions that stated a price — so
   * a cancellation cannot pair with a real price and read as a move (edge case
   * 5), and the filter lives in one place rather than in every reader.
   */
  steps: readonly StatedStop[];
  direction: BrokerTrade['direction'];
  trailing: boolean;
  automated?: ReadonlyMap<number, boolean>;
}): { movedCount: number; direction: StopHistory['direction'] } {
  const { steps: stated, direction, trailing, automated } = params;

  let movedCount = 0;
  let tightened = false;
  let widened = false;

  for (let i = 1; i < stated.length; i += 1) {
    const before = stated[i - 1].price;
    const after = stated[i].price;
    if (before === after) continue;

    // The server did this, not the trader. The step is real and is simply not
    // attributed — see StopEvidence.automated on why this can only subtract.
    if (automated?.get(stated[i].version.id) === true) continue;

    movedCount += 1;

    const pegBefore = trailing ? finite(stated[i - 1].version.pegDifference) : null;
    const pegAfter = trailing ? finite(stated[i].version.pegDifference) : null;
    const trailLoosened =
      pegBefore !== null && pegAfter !== null && Math.abs(pegAfter) > Math.abs(pegBefore);

    const towardEntry = direction === 'long' ? after > before : after < before;
    if (trailLoosened || !towardEntry) widened = true;
    else tightened = true;
  }

  return {
    movedCount,
    direction:
      movedCount === 0 ? null : tightened && widened ? 'mixed' : widened ? 'widened' : 'tightened',
  };
}

// ── The read side ────────────────────────────────────────────────────────────

/** What one run read, for the log line. Counts only — see the header. */
interface ReadTally {
  orders: number;
  candidates: number;
  /** Command rows kept for the anchor. Zero means every history fell back. */
  commands: number;
  deps: number;
  moved: number;
  kept: number;
  none: number;
  unknown: number;
  dropped: number;
  capped: boolean;
  failures: string[];
}

/**
 * Read the day's orders and derive a stop history per trade.
 *
 * TAKES THE TRADES IT SHOULD ASK ABOUT AND ASKS ABOUT NOTHING ELSE. The caller
 * passes only the trades whose `stop_history IS NULL` (./import.ts' candidate
 * read), which is what makes the second run of a day nearly free: a trade that
 * already has an answer costs no request at all.
 *
 * NEVER THROWS, AND THAT IS THE OPPOSITE OF `loadBrokerDay`'S RULE 2 — on
 * purpose. There, a swallowed failure under-counts the day and an under-counted
 * day makes every rule MORE PERMISSIVE, so the pull fails whole. Here a failure
 * costs one nullable column: it cannot under-count a day, it cannot lift a rule,
 * and taking the whole import down with it would cost the trader their journal
 * rows over an annotation. So this is the second deliberate swallow in the
 * integration, after `readPermittedAccounts`.
 *
 * WHAT COMES BACK IS ONLY WHAT IS WORTH STORING. A trade whose answer is
 * `'unknown'` for a TRANSIENT reason is absent from the map, so its columns stay
 * absent, so the next run of the day tries again. See the header.
 */
export async function readStopHistories(params: {
  readers: Partial<Record<TradovateEnvironment, TradovateReader>>;
  /** The trades to answer for. Already filtered to `stop_history IS NULL`. */
  trades: readonly BrokerTrade[];
  /** Test seam for the ceiling. Production uses {@link MAX_ORDER_DEPS_PER_RUN}. */
  maxDeps?: number;
}): Promise<Map<string, StopHistory>> {
  const { readers, trades, maxDeps = MAX_ORDER_DEPS_PER_RUN } = params;

  const histories = new Map<string, StopHistory>();

  const tally: ReadTally = {
    orders: 0,
    candidates: 0,
    commands: 0,
    deps: 0,
    moved: 0,
    kept: 0,
    none: 0,
    unknown: 0,
    dropped: 0,
    capped: false,
    failures: [],
  };

  // NO CANDIDATES STILL REPORTS, AND THE LINE IS WORTH WHAT IT COSTS. This used
  // to return BEFORE {@link report}, which made "the run asked about nothing"
  // the one outcome that left no trace — and it is the outcome that most needs
  // one, because every other reason a column stays empty is already in that
  // line. It cost an investigation to rediscover on 19.10
  // (~/Desktop/reflect-reports/ref-113-why-no-write.md): a row was reset, Sync
  // said "everything up to date", and nothing anywhere said the trade had been
  // dropped upstream for holding an open position on the same contract.
  //
  // THE ZERO LINE DOES NOT SAY WHY, AND IT CANNOT. The filtering is
  // `tradesNeedingStopHistory`'s (./import.ts), which refuses a trade whose
  // position is not flat, a row already answered, and a row hidden — and this
  // function is handed the survivors with no account of the rest. The import's
  // own line carries `skippedOpen`, which separates the first from the other
  // two. `candidates=0` here beside `skippedOpen` there is the pair that
  // answers it, and that is why neither line needed a new field.
  if (trades.length === 0) {
    report(tally);
    return histories;
  }

  // ONE BUDGET FOR THE WHOLE RUN, shared across hosts and across both deps
  // shapes. The thing being protected is the request count.
  let budget = Math.max(0, maxDeps);
  const spend = (): boolean => {
    if (budget <= 0) return false;
    budget -= 1;
    return true;
  };

  for (const host of ['live', 'demo'] as const) {
    const reader = readers[host];
    if (!reader) continue;
    const hostTrades = trades.filter((trade) => trade.host === host);
    if (hostTrades.length === 0) continue;

    const evidence = await readHostEvidence({
      reader,
      trades: hostTrades,
      spend,
      tally,
    });
    if (!evidence) continue;

    for (const trade of hostTrades) {
      // THE PURE HALF IS WRAPPED TOO, AND THE CLAIM IT MAKES HONEST IS IN
      // ./sync.ts: "it cannot throw: ./orders.ts swallows". That was true of
      // every READ and merely true-by-inspection of the derivation, which has
      // no I/O and therefore no obvious way to fail — and which has grown
      // branches with every stage of this ticket. An unwrapped throw here takes
      // `syncUserTrades` down whole, which costs the trader THE JOURNAL ROWS OF
      // THEIR DAY over an annotation: the exact trade this module's error
      // policy refuses to make everywhere else it is written down.
      //
      // THE TRADE GETS `'failed'`, WHICH MEANS IT IS DROPPED RATHER THAN
      // STORED, so the row keeps `stop_history IS NULL` and the next run of the
      // same trading day asks again. A derivation that threw on this evidence
      // will probably throw on the next read of it too, and that is the right
      // trade anyway: `'failed'` is the honest answer and a retry costs a
      // handful of requests, while STORING it would take the row out of scope
      // for every later run that day.
      let history: StopHistory;
      try {
        history = deriveStopHistory({ trade, trades: hostTrades, evidence });
      } catch (error) {
        // `kindOf` AND NOT THE MESSAGE, for the usual reason sharpened: a
        // TypeError's message quotes the value it choked on, and the values
        // here are the trader's stop prices.
        tally.failures.push(`derive:${kindOf(error)}`);
        history = unknownHistory('failed');
      }

      if (history.verdict === 'moved') tally.moved += 1;
      else if (history.verdict === 'kept') tally.kept += 1;
      else if (history.verdict === 'none') tally.none += 1;
      else tally.unknown += 1;

      // The transient half of `'unknown'` is dropped rather than stored, so the
      // row stays a candidate for the next run of the same trading day.
      if (history.reason === 'capped' || history.reason === 'failed') {
        tally.dropped += 1;
        continue;
      }
      histories.set(trade.brokerTradeKey, history);
    }
  }

  report(tally);
  return histories;
}

/**
 * One host's orders, versions and bracket map.
 *
 * Returns null when `/order/list` itself could not be read — there is no
 * evidence then, not even an empty kind, and every trade on the host is left
 * without an answer rather than told it had no stop.
 */
async function readHostEvidence(params: {
  reader: TradovateReader;
  trades: readonly BrokerTrade[];
  /** Claims one unit of the run's deps budget. False when it is spent. */
  spend: () => boolean;
  tally: ReadTally;
}): Promise<StopEvidence | null> {
  const { reader, trades, spend, tally } = params;

  const accountIds = new Set(trades.map((trade) => trade.accountId));

  let raw: TradovateOrder[];
  try {
    raw = (await reader.get<TradovateOrder[]>('/order/list')) ?? [];
  } catch (error) {
    // The body of an order list is the trader's own working orders. Reduced
    // here, at the only point that knows what it held.
    tally.failures.push(kindOf(withoutResponseBody(error)));
    return null;
  }

  // Filtered to the accounts these trades were traded on, and filtered HERE
  // rather than in the derivation: `/order/list` is the whole visible scope,
  // which for a prop trader includes accounts that are not theirs to read.
  const orders = new Map<number, TradovateOrder>();
  for (const order of raw) {
    if (!usableId(order.id)) continue;
    if (!accountIds.has(order.accountId)) continue;
    orders.set(order.id, order);
  }
  tally.orders += orders.size;

  // THE SANITY CHECK, DOWNGRADED FROM A CORRECTNESS CONDITION. §4.3 feared
  // `/orderVersion/list` would be the largest response in the API and be cut
  // silently; with `/order/list` bounded to one trading day the responses are
  // small and truncation is close to impossible. It is still logged, because a
  // round count is the only evidence a truncation ever leaves.
  if (TRUNCATION_COUNTS.has(raw.length)) tally.failures.push(`roundcount:${raw.length}`);

  // ── Layer B's reverse map ────────────────────────────────────────────────
  const { strategyByOrder, incomplete } = await readStrategyLinks({ reader, spend, tally });

  // ── The candidate set, deduplicated across trades ────────────────────────
  // "One map per run" (§4.3 guard 1): a bracket order that closes two trades is
  // fetched once. Same discipline as `loadContractUnits`.
  const wanted = new Set<number>();
  for (const trade of trades) {
    for (const { orderId } of candidateOrders({
      trade,
      evidence: { orders, strategyByOrder },
    })) {
      wanted.add(orderId);
    }
  }
  tally.candidates += wanted.size;

  const versions = new Map<number, readonly TradovateOrderVersion[]>();
  // Seeded from the bracket map rather than starting at null: a strategy we
  // could not read is a gap in the evidence exactly as a version we could not
  // read is, and it has to reach the derivation as one.
  let unscanned: StopEvidence['unscanned'] = incomplete;

  for (const orderId of wanted) {
    if (!spend()) {
      // Over the ceiling. Every order from here on is simply not asked about,
      // and the derivation turns that into `'unknown'` — never `'none'`.
      tally.capped = true;
      unscanned = 'capped';
      break;
    }
    try {
      const rows =
        (await reader.get<TradovateOrderVersion[]>('/orderVersion/deps', { masterid: orderId })) ??
        [];
      tally.deps += 1;
      versions.set(
        orderId,
        rows.filter((row) => usableId(row.id))
      );
    } catch (error) {
      // THE READ WHOSE BODY IS THE TRADER'S STOP PRICES. Reduced before the
      // error is even classified.
      tally.failures.push(kindOf(withoutResponseBody(error)));
      unscanned = 'failed';
    }
  }

  // ── The fill anchor's clock ──────────────────────────────────────────────
  // LAST, AND ONLY WHEN SOME ORDER HAS MORE THAN ONE VERSION. The anchor is an
  // index into a version list, so an order with a single version anchors on it
  // whatever any clock says — and "placed one stop and left it alone" is the
  // shape of most days. Asking after the version reads is what makes that
  // knowable: a day of inter-day trades (every swing trade is one) has no
  // candidate orders at all, and a day of untouched stops has no list to index.
  // Either way the request goes unmade rather than made and discarded, against
  // a rate limit whose penalty this module is built around.
  //
  // A failure costs the anchor and not the answer — the histories fall back to
  // version one and say so — so it is deliberately NOT folded into `unscanned`,
  // which is the channel for gaps that have to become `'unknown'`.
  const anchorable = [...versions.values()].some((rows) => rows.length > 1);
  const commandTimes = anchorable
    ? await readCommandTimes({ reader, orders, tally })
    : new Map<number, number[]>();

  return {
    orders,
    versions,
    strategyByOrder,
    strategiesComplete: incomplete === null,
    unscanned,
    commandTimes,
  };
}

/**
 * `orderId` → its commands' instants, ascending. The fill anchor's only clock.
 *
 * ONE CALL, NO DEPS, NO BUDGET. `/command/list` is a day-scoped list exactly as
 * `/order/list` is, so it costs one request per host however many orders the day
 * held — which is why it does not spend {@link MAX_ORDER_DEPS_PER_RUN}, the
 * ceiling that exists to bound a per-order fan-out.
 *
 * SCOPED THROUGH THE ORDERS MAP AND NOT THROUGH A FIELD ON THE COMMAND. The
 * response is the whole visible scope, which for a prop trader includes accounts
 * that are not theirs to read; `orders` is already filtered to the accounts
 * these trades were traded on, so a command whose `orderId` is not in it is
 * dropped. That needs no `accountId` on the command, which the measurement never
 * confirmed (./types.ts).
 *
 * A FAILURE IS NOT A GAP IN THE EVIDENCE. It returns an empty map, every anchor
 * falls back to version one, and `anchoredAtFill` is `false` on every history of
 * the host. Nothing becomes `'unknown'` over it: a fallback anchor is the answer
 * this module gave for three stages, and the trade's verdict, its stop prices
 * and its target are all still read. (On a trade with SEVERAL stop orders it can
 * also change which one is chosen — see the module header, which says so at
 * more length rather than leaving this sentence to carry it.)
 */
async function readCommandTimes(params: {
  reader: TradovateReader;
  orders: ReadonlyMap<number, TradovateOrder>;
  tally: ReadTally;
}): Promise<Map<number, number[]>> {
  const { reader, orders, tally } = params;
  const times = new Map<number, number[]>();

  let raw: TradovateCommand[];
  try {
    // The body of a command list is every modification's terms — the trader's
    // stop prices, in the response this module is most likely to log.
    raw = (await reader.get<TradovateCommand[]>('/command/list')) ?? [];
  } catch (error) {
    tally.failures.push(kindOf(withoutResponseBody(error)));
    return times;
  }

  // A ROUND COUNT ABANDONS THE CLOCK ENTIRELY, which is stronger than what the
  // same check does for `/order/list` and is stronger on purpose. There, a
  // possible truncation is logged because the alternative is refusing a day's
  // answers over a count that is probably a coincidence. Here the alternative
  // is the documented fallback, and the damage a truncation does is specific
  // and silent: cutting an order's EARLIEST commands leaves a list that can
  // still match the version count, so every version gets a later instant than
  // it had and the anchor moves without anything saying so.
  if (TRUNCATION_COUNTS.has(raw.length)) {
    tally.failures.push(`roundcount:${raw.length}`);
    return times;
  }

  // Orders whose command list cannot be trusted positionally. A command we
  // could not time is not droppable: dropping it SHORTENS the list, which can
  // land it exactly on the version count and have a shifted pairing accepted
  // as an exact one — so the order loses its clock instead.
  const untimed = new Set<number>();

  for (const command of raw) {
    if (!usableId(command.orderId) || !orders.has(command.orderId)) continue;
    const ms = instant(command.timestamp);
    if (ms === null) {
      untimed.add(command.orderId);
      continue;
    }
    const list = times.get(command.orderId) ?? [];
    list.push(ms);
    times.set(command.orderId, list);
  }

  for (const orderId of untimed) times.delete(orderId);

  for (const list of times.values()) {
    // Ascending, to be paired against the versions in `id` order. The response
    // order is not documented and is not relied on.
    list.sort((a, b) => a - b);
    tally.commands += list.length;
  }

  return times;
}

/**
 * `orderId` → `orderStrategyId`, for every strategy of the day.
 *
 * TWO CALLS' WORTH OF WORK FOR ONE FIELD TRADOVATE DOES NOT PUT ON THE ORDER.
 * The measurement looked for `orderStrategyId` on `order` and found it absent,
 * so the only route is to list the strategies and ask each one for its links —
 * one request per strategy, which is why it spends the same budget the version
 * reads do.
 *
 * `incomplete` IS NON-NULL THE MOMENT ANYTHING IS MISSED, and the derivation
 * reads that as grounds to refuse a `'none'`: a bracket we did not see is a stop
 * we cannot say was absent. It carries WHICH kind of gap, because that is what
 * decides whether the answer is worth storing or worth retrying.
 */
async function readStrategyLinks(params: {
  reader: TradovateReader;
  spend: () => boolean;
  tally: ReadTally;
}): Promise<{
  strategyByOrder: Map<number, number>;
  incomplete: StopEvidence['unscanned'];
}> {
  const { reader, spend, tally } = params;
  const strategyByOrder = new Map<number, number>();

  let strategies: TradovateOrderStrategy[];
  try {
    strategies = (await reader.get<TradovateOrderStrategy[]>('/orderStrategy/list')) ?? [];
  } catch (error) {
    tally.failures.push(kindOf(withoutResponseBody(error)));
    return { strategyByOrder, incomplete: 'failed' };
  }

  const ids = strategies.map((strategy) => strategy.id).filter(usableId);
  let incomplete: StopEvidence['unscanned'] = null;

  for (const masterid of ids) {
    if (!spend()) {
      tally.capped = true;
      incomplete = 'capped';
      break;
    }
    try {
      const links =
        (await reader.get<TradovateOrderStrategyLink[]>('/orderStrategyLink/deps', { masterid })) ??
        [];
      tally.deps += 1;
      for (const link of links) {
        // The strategy comes from the request and not from the row: the field
        // that would carry it was never measured, and ./types.ts does not
        // declare what nobody has seen.
        if (usableId(link.orderId)) strategyByOrder.set(link.orderId, masterid);
      }
    } catch (error) {
      tally.failures.push(kindOf(withoutResponseBody(error)));
      incomplete = 'failed';
    }
  }

  return { strategyByOrder, incomplete };
}

/**
 * Counts that have been round numbers in this API's history.
 *
 * The same five FINDINGS.md §4 names. A response of exactly one of these is the
 * only trace a silent truncation leaves, and it is logged rather than acted on —
 * see the note at the call site on why this stopped being a correctness
 * condition.
 */
const TRUNCATION_COUNTS: ReadonlySet<number> = new Set([1000, 1024, 2000, 2048, 4096]);

/** An error as a KIND. Never a message: a message from here can hold a price. */
function kindOf(error: unknown): string {
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? `${error.name}:${status}` : error.name;
  }
  return 'non-Error throw';
}

/**
 * One line per run, counts only, through redactSecrets.
 *
 * NO SYMBOL, NO PRICE, NO ORDER ID, NO ACCOUNT ID, AND NOT EVEN A COUNT PER
 * SYMBOL — a per-symbol count is a symbol. Verdict totals name nothing: they say
 * the mechanism is alive and how often it had to say "I do not know", which is
 * the one number worth watching after a deploy.
 */
function report(tally: ReadTally): void {
  const line =
    `[tradovate][orders] orders=${tally.orders} candidates=${tally.candidates} ` +
    `commands=${tally.commands} ` +
    `deps=${tally.deps} moved=${tally.moved} kept=${tally.kept} none=${tally.none} ` +
    `unknown=${tally.unknown} dropped=${tally.dropped} capped=${tally.capped}` +
    (tally.failures.length > 0 ? ` kinds=${[...new Set(tally.failures)].join(',')}` : '');

  if (tally.failures.length > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));
}
