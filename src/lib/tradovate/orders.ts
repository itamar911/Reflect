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
 *      them is a stop order, it is this trade's stop and it is the order that
 *      closed it. Zero inference, zero extra cost, `source: 'linked'`.
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
 * ZERO `/command/list` IN v1 (§2.1). Commands are the only place a MODIFY
 * carries a timestamp and an `isAutomated` flag, and neither is needed: the
 * order a verdict wants is the order of the versions, and `id` ascending gives
 * it for free. So `movedAtMs` is always `null` here and this module makes
 * exactly one call shape per candidate order.
 *
 * The budget per run, per host: one `/order/list`, one `/orderStrategy/list`,
 * one `/orderStrategyLink/deps` per strategy, one `/orderVersion/deps` per
 * candidate order. A typical day of three trades reaches seven to nine calls
 * against a documented 5,000 per hour. {@link MAX_ORDER_DEPS_PER_RUN} is the
 * hard stop, and what matters about it is the FAILURE DIRECTION: over the
 * ceiling, a trade reads `'unknown'`, never `'none'`.
 *
 *
 * AND NOTHING HERE PUTS A PRICE IN A MESSAGE
 * ------------------------------------------
 *
 * `withoutResponseBody` wraps EVERY read, before anything else in the function.
 * `TradovateRequestError` puts `body.slice(0, 300)` into its message, and for
 * `/orderVersion/deps` that body is the trader's own stop prices — handed to
 * whatever logs it, four layers up, where nobody is thinking about this call.
 * Same reduction `discoverHostAccounts` makes on `/account/list`, for the same
 * reason. The log line below is counts only.
 */

import type { BrokerTrade, TradovateReader } from './fills';
import { withoutResponseBody } from './errors';
import type { TradovateEnvironment } from './hosts';
import { redactSecrets } from './redact';
import type {
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
  /** The stop as first submitted. This is what `broker_stop_loss` holds. */
  initialStop: number | null;
  /** The stop as last submitted. In the JSON only — no column holds it. */
  finalStop: number | null;
  /** The target nearest the entry. This is what `broker_take_profit` holds. */
  initialTarget: number | null;
  /** How many times the stop price changed. A cancellation is NOT a move. */
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
   * When the move happened. ALWAYS NULL IN v1 — a version carries no timestamp
   * and `/command/list` is not read (§2.1). Declared so that the field's
   * absence is a stated fact rather than a shape change later.
   */
  movedAtMs: null;
  /** Whether the stop was a trailing one. Its steps are the server's, not the trader's. */
  trailing: boolean;
  /** `verdict === 'none'`, as its own fact. Decision 2: no stop is a finding. */
  noStopPlaced: boolean;
  /** Which layer attributed the orders. See the header. */
  source: 'linked' | 'inferred' | 'none';
  /** The stop prices, oldest first. Without instants, in v1. */
  versions: { stopPrice: number }[];
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
   * `orderVersion.id` → whether the server rather than the trader produced it.
   *
   * EMPTY IN v1, and it is a parameter rather than a field read off the version
   * because that is where the value actually comes from: `isAutomated` was
   * measured on `/command/list`, which this module does not read (§2.1). The
   * three states are deliberate and are not symmetrical:
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

  const ownIds = new Set(own.map((order) => order.id));
  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  const offer = (orderId: number, layer: Layer) => {
    if (seen.has(orderId)) return;
    seen.add(orderId);
    candidates.push({ orderId, layer });
  };

  // ── Layer A ───────────────────────────────────────────────────────────────
  // Every order that produced a fill in this group. One of them may BE the
  // stop, in which case nothing has to be inferred at all.
  for (const order of own) offer(order.id, 'own');

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
      if (!evidence.orders.has(orderId)) continue;
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
    const closes = closingAction(trade.direction);

    for (const order of evidence.orders.values()) {
      if (ownIds.has(order.id)) continue;
      if (order.accountId !== trade.accountId) continue;
      if (order.contractId !== contractId) continue;
      // A protective order sits on the side that CLOSES the position. An order
      // on the entry side inside the same window is a scale-in, not a stop.
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
    finalStop: null,
    initialTarget: null,
    movedCount: 0,
    direction: null,
    movedAtMs: null,
    trailing: false,
    noStopPlaced: false,
    source: 'none',
    versions: [],
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
    scanned.push({ orderId, layer, versions: ordered, type: orderTypeOf(ordered) });
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

    const chosenTarget = nearestTarget(targetOrders, trade.entryPrice);
    return {
      verdict: 'none',
      reason: null,
      initialStop: null,
      finalStop: null,
      initialTarget: chosenTarget.initialTarget,
      movedCount: 0,
      direction: null,
      movedAtMs: null,
      trailing: false,
      noStopPlaced: true,
      source: chosenTarget.initialTarget === null ? 'none' : chosenTarget.source,
      versions: [],
      otherTargets: chosenTarget.otherTargets,
      ...capped,
      ...sharedWith,
    };
  }

  // ── The stop: the FURTHEST from entry, deliberately ───────────────────────
  // A stop is a worst case. A long of three contracts stopped at 99 for one and
  // 98 for two risked 98, and taking the nearer number would flatter both the
  // risk and the R:R the planning block compares against. The mirror decision
  // for targets is below and is the opposite on purpose: a target is an
  // expectation, so the nearest is "my target" (Imri, 19.10).
  const stop = stopOrders.reduce((furthest, order) => {
    const a = Math.abs(stopPrices(order.versions)[0] - trade.entryPrice);
    const b = Math.abs(stopPrices(furthest.versions)[0] - trade.entryPrice);
    return a > b ? order : furthest;
  });

  const prices = stopPrices(stop.versions);
  const steps = countMoves({
    versions: stop.versions,
    direction: trade.direction,
    trailing: isTrailingType(stop.type),
    automated: evidence.automated,
  });

  const chosenTarget = nearestTarget(targetOrders, trade.entryPrice);

  return {
    verdict: steps.movedCount > 0 ? 'moved' : 'kept',
    reason: null,
    initialStop: prices[0],
    finalStop: prices[prices.length - 1],
    initialTarget: chosenTarget.initialTarget,
    movedCount: steps.movedCount,
    direction: steps.direction,
    movedAtMs: null,
    trailing: isTrailingType(stop.type),
    noStopPlaced: false,
    source: stop.layer === 'window' ? 'inferred' : 'linked',
    versions: prices.map((stopPrice) => ({ stopPrice })),
    otherTargets: chosenTarget.otherTargets,
    ...capped,
    ...sharedWith,
  };
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

/** A target's price: the limit price of its first version. */
function targetPrice(versions: readonly TradovateOrderVersion[]): number | null {
  for (const version of versions) {
    const price = finite(version.price);
    if (price !== null) return price;
  }
  return null;
}

/** The target nearest the entry, and the ones that lost. Decision 3. */
function nearestTarget(
  orders: readonly ProtectiveOrder[],
  entryPrice: number
): { initialTarget: number | null; otherTargets: number[]; source: 'linked' | 'inferred' } {
  const priced = orders
    .map((order) => ({ price: targetPrice(order.versions), layer: order.layer }))
    .filter((entry): entry is { price: number; layer: Layer } => entry.price !== null)
    .sort((a, b) => Math.abs(a.price - entryPrice) - Math.abs(b.price - entryPrice));

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
  versions: readonly TradovateOrderVersion[];
  direction: BrokerTrade['direction'];
  trailing: boolean;
  automated?: ReadonlyMap<number, boolean>;
}): { movedCount: number; direction: StopHistory['direction'] } {
  const { versions, direction, trailing, automated } = params;

  // Only the versions that stated a stop price, so a cancellation cannot pair
  // with a real price and read as a move. See {@link stopPrices}.
  const stated = versions.filter((version) => finite(version.stopPrice) !== null);

  let movedCount = 0;
  let tightened = false;
  let widened = false;

  for (let i = 1; i < stated.length; i += 1) {
    const before = finite(stated[i - 1].stopPrice)!;
    const after = finite(stated[i].stopPrice)!;
    if (before === after) continue;

    // The server did this, not the trader. The step is real and is simply not
    // attributed — see StopEvidence.automated on why this can only subtract.
    if (automated?.get(stated[i].id) === true) continue;

    movedCount += 1;

    const pegBefore = trailing ? finite(stated[i - 1].pegDifference) : null;
    const pegAfter = trailing ? finite(stated[i].pegDifference) : null;
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
  if (trades.length === 0) return histories;

  const tally: ReadTally = {
    orders: 0,
    candidates: 0,
    deps: 0,
    moved: 0,
    kept: 0,
    none: 0,
    unknown: 0,
    dropped: 0,
    capped: false,
    failures: [],
  };

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
      const history = deriveStopHistory({ trade, trades: hostTrades, evidence });

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

  return {
    orders,
    versions,
    strategyByOrder,
    strategiesComplete: incomplete === null,
    unscanned,
  };
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
    `deps=${tally.deps} moved=${tally.moved} kept=${tally.kept} none=${tally.none} ` +
    `unknown=${tally.unknown} dropped=${tally.dropped} capped=${tally.capped}` +
    (tally.failures.length > 0 ? ` kinds=${[...new Set(tally.failures)].join(',')}` : '');

  if (tally.failures.length > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));
}
