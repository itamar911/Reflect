/**
 * Today's closed round trips, read from Tradovate (REF-90 §3).
 *
 * The first thing in this repository that reads trading data. Everything above
 * it — OAuth, token storage, renewal, the refresh keep-alive, per-user hosts —
 * existed before this file and had no consumer.
 *
 *
 * WHY THIS IS A CHAIN AND NOT ONE CALL
 * ------------------------------------
 *
 * `/<entity>/list` takes no filter parameters: not by date, not by account.
 * Each one "fetches all" of that entity in the logged-on user's visible scope,
 * and the entity that comes closest to "a trade" — `FillPair` — carries no
 * date, no account and no money. So the four facts a discipline rule needs
 * live in four places and have to be joined here:
 *
 *   /account/list    → which accounts are this trader's own   (./accounts.ts)
 *   /position/list   → accountId for a positionId             (the only link)
 *   /fillPair/list   → the round trips, with both legs' prices
 *   /fill/list       → the instant each leg executed          (the day boundary)
 *
 * Plus one conditional read, and the condition is the point:
 *
 *   /tradingPermission/list → the accounts this trader may trade but does not
 *                             own, asked only when some account failed on
 *                             ownership alone (REF-90 Stage 2, ./accounts.ts)
 *
 * Then, for each contract that actually appears in the trades we are about to
 * count, three more calls plus one shared lookup turn points into dollars:
 *
 *   /contract/item         → name, contractMaturityId
 *   /contractMaturity/item → productId
 *   /product/item          → valuePerPoint, currencyId
 *   /currency/list         → currencyId → 'USD'               (once per pull)
 *
 * THE MATURITY HOP IS NOT AN EXTRA STEP, IT IS THE DOCUMENTED ONE. `Contract`
 * has no `productId` in any published schema; `ContractMaturity` has it as a
 * required field, reached by a required field of the contract. Reading the
 * contract's own undocumented copy is what REF-90 shipped and had to take back
 * when a production host omitted it — see loadContractUnits.
 *
 * Eight to ten requests for a trader holding one or two contracts, against a
 * documented 5,000 per hour per user, and fewer than that in practice: the last
 * two are cached by contract name, so a warm pull pays one per contract. The
 * cost that matters is latency, not quota, which is why that cache exists and
 * why the client also caches the whole result briefly rather than pulling once
 * per enforcement path (lib/rules/brokerDayContext.ts).
 *
 * The full-list reads are also the scaling limit of this design, and it is
 * worth naming: `/fill/list` and `/fillPair/list` grow with a trader's whole
 * history because the API offers no way to ask for less. The narrowing variants
 * (`/fill/items?ids=`, `/fillPair/ldeps?masterid=`) would need one request per
 * position, trading one unbounded response for N round trips. At the scale this
 * ships to — an allowlist — the single response wins. Past that, it will not.
 *
 *
 * THE ARITHMETIC, AND THE ONE THING IT MUST NOT GET WRONG
 * ------------------------------------------------------
 *
 *   pnl = (sellPrice − buyPrice) × qty × valuePerPoint
 *
 * `FillPair` names its legs by SIDE, not by order: `buyPrice` is the price of
 * the buy leg whether that leg opened the position or closed it. So this one
 * expression is correct for a long and for a short without a direction branch —
 * a profitable short sold high and bought back low, which is `sellPrice >
 * buyPrice`, which is positive. That matters more than it looks: the rule
 * context module's header records that A PROFITABLE SHORT COUNTED AS A LOSS in
 * the code this is replacing, because that code measured `abs(entry − exit)`
 * and looked at which was larger. Nothing here looks at direction at all.
 *
 * `valuePerPoint` is not optional decoration. Without it the result is POINTS,
 * and `max_daily_loss` is dollars; multiplying by one and calling it money is
 * the same unit bug one level down. A product that does not state it is
 * refused — see TradovateUnpriceableError.
 *
 * NOT INCLUDED: commissions and exchange fees. `(sell − buy) × qty × value` is
 * gross, and Tradovate's own `realizedPnL` on
 * /cashBalance/getcashbalancesnapshot may be net — the documentation says only
 * "Profit/loss from closed positions" and does not say. So this figure can read
 * slightly better than the trader's statement, always in the same direction,
 * by roughly a few dollars per round trip. Worth knowing when comparing the two
 * by eye; not worth guessing a fee schedule to correct.
 *
 *
 * WHAT THIS MODULE RETURNS, AFTER REF-107 STAGE 1
 * -----------------------------------------------
 *
 * Two things from one pull: {@link BrokerDayContext}, the seven scalars the
 * discipline rules act on, and {@link BrokerTrade}[], the rows a journal is made
 * of. The second is new, and it reverses a position REF-90 took here — "return
 * the answer, not the data". The reversal is the whole of REF-107 and it is
 * deliberate: a rule needs an answer, but A JOURNAL IS THE DATA, and there is
 * nothing to show a trader about a trade they took that does not include the
 * trade.
 *
 * What has NOT changed is that the rules still read the scalars only, and that
 * THE SCALARS ARE THE REDUCTION OF THAT LIST rather than a second count of the
 * same pairs — one list, reduced once, in {@link loadBrokerDay}. Any other
 * arrangement lets REF-90's figures drift from REF-107's rows while both look
 * right, which is the one failure neither side would notice.
 *
 * The rows do not travel anywhere the scalars already travelled.
 * /api/tradovate/today still answers with scalars alone; the rows have their own
 * route and their own privacy note (app/api/tradovate/trades/route.ts).
 */

import {
  cyclesFromFills,
  type CycleLeg,
  type HeldGroup as CycleHeldGroup,
  type HeldReason as CycleHeldReason,
  type LogicalPosition,
} from './cycles';
import { loadContractNames } from './contract-names';
import { TradovateRequestError, TradovateUnpriceableError, withoutResponseBody } from './errors';
import { closedToday, minutesSince } from './trading-day';
import {
  claimedAccounts,
  partitionAccounts,
  permissionsCouldHelp,
  permittedAccountIds,
  unsupportedTypeAccounts,
  type ClaimedAccount,
} from './accounts';
import type { TradovateEnvironment } from './hosts';
import type {
  TradovateAccount,
  TradovateContract,
  TradovateContractMaturity,
  TradovateCurrency,
  TradovateFill,
  TradovateFillPair,
  TradovatePosition,
  TradovateProduct,
} from './types';

/**
 * The read side of ./client.ts, narrowed to what this module does.
 *
 * An interface rather than a direct dependency on `tradovateGet` for one
 * reason: it is the seam the test script drives. `tradovateGet` is a thin
 * wrapper over `fetch`, so a mock reader and a mocked `globalThis.fetch` would
 * cover the same ground, but the reader keeps the day-pull tests about the join
 * and the arithmetic instead of about HTTP.
 *
 * The route builds one that carries the user's token and the user's host — both
 * mandatory together, which ./client.ts enforces in the type system.
 */
export interface TradovateReader {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
}

/**
 * What the rule engine gets from the broker, and nothing else.
 *
 * STILL SEVEN SCALARS, AND STILL ALL THE RULES GET. REF-90 wrote here that this
 * was "deliberately not a list of trades", because a route that returned fills
 * would be sending a trader's positions to the browser for no purpose. REF-107
 * supplies the purpose — a journal — and so {@link loadBrokerDay} now returns
 * {@link BrokerTrade}[] BESIDE this, not inside it. The distinction is the whole
 * design: the rules take the reduction, the journal takes the rows, and the
 * route that serves the rules keeps sending nothing but this type.
 */
export interface BrokerDayContext {
  /**
   * Trades finished on or after the day boundary — grouped, so scaling out of
   * one position is one trade and not three. See {@link Trade}.
   */
  closedCount: number;
  /** How many of those lost money, netted across their legs. */
  losingCount: number;
  /** Today's realised P&L, netted and signed. Negative means the day is down. */
  net: number;
  /** Money lost today, as a positive number. Gross: winners are not deducted. */
  lost: number;
  /** Consecutive losing trades counting back from the most recent close. */
  lossStreak: number;
  /** Minutes since the most recent close in that streak, or null when there is none. */
  minutesSinceLastClose: number | null;
  /** When this was read from Tradovate, ISO 8601. */
  asOf: string;
}

/**
 * One finished trade, as a journal row (REF-107 Stage 1).
 *
 * This replaces REF-90's `PricedTrade`, which was the same grouping reduced to
 * an instant and a dollar figure. It is the same list, with the fields that were
 * built and thrown away kept: §A1 of the REF-107 investigation found three
 * genuine gaps against a journal row — the contract's NAME, the DIRECTION, and
 * the ENTRY TIME — and all three come from reads this chain already makes.
 *
 * THIS IS STILL THE ONLY SHAPE THAT CROSSES A HOST BOUNDARY, and it now carries
 * ids, so the rule REF-90 wrote here needs restating rather than deleting.
 * Nothing documents whether live and demo share id spaces, so what must never
 * happen is that a POOLED list gets re-keyed on an id: pool before
 * {@link groupIntoTrades} and two unrelated fills sharing an id are welded into
 * one trade; pool before {@link loadContractUnits} and one host's
 * `valuePerPoint` prices the other host's contract. Both of those still run per
 * host, upstream of here. What crosses is a FINISHED row, and the ids on it are
 * carried, never joined on again — which is also why {@link host} is a field and
 * why {@link brokerTradeKey} is qualified by it.
 */
export interface BrokerTrade {
  /**
   * A stable natural key for this trade: `<host>:<lowest fill id in the group>`.
   *
   * §A3 of the investigation reached the fill group rather than any single
   * entity id, and the reasoning is {@link Trade}: the unit a journal means by
   * "a trade" is a GROUP of fill pairs, and Tradovate does not name it, so it
   * has no id of its own. The lowest `fill.id` in the group is the one thing
   * that is both derived from it and fixed — union-find is deterministic on the
   * same input and fill ids do not move.
   *
   * THE HOST PREFIX IS A DEPARTURE FROM §A3, WHICH SAID THE FILL ID ALONE, and
   * it is here for this module's oldest rule: ids are host-local until something
   * documents otherwise. Unprefixed, a demo fill 401 and a live fill 401 produce
   * one key, and the `UNIQUE (user_id, broker_trade_key)` that Stage 2 hangs
   * idempotent re-imports on would then silently drop one of two real trades.
   * Prefixing costs a few bytes in a TEXT column and removes the question.
   *
   * STABLE ONLY ONCE THE POSITION IS FULLY CLOSED — §A3's own caveat, and it is
   * pinned by test rather than fixed here. A later pull that sees a NEW fill
   * pair bridging two groups merges them, and the merged group's lowest fill id
   * can be one that belonged to the other group. Stage 2 must not treat this as
   * a key it can write mid-position.
   */
  brokerTradeKey: string;
  /** Which host reported it. Part of {@link brokerTradeKey} for the reason given there. */
  host: TradovateEnvironment;
  /** The account that traded it, via the position. Host-local, like every id here. */
  accountId: number;
  /**
   * The contract's name, e.g. `ESZ6` — what `trade_plans.symbol` holds.
   *
   * Null when the contract body named nothing usable. That case already exists
   * and is already priced: {@link loadContractUnits} treats a nameless contract
   * as one it cannot cache, not one it refuses, and failing a day REF-90 totals
   * today over a display field would be the REF-90 §4 mistake a second time.
   * `trade_plans.symbol` is nullable, so null survives the whole way down.
   */
  symbol: string | null;
  /**
   * Which side opened it, read from WHICH LEG EXECUTED FIRST — buy first is a
   * long — and never from the prices.
   *
   * The same comparison {@link datePair} already made to find the close, used
   * for its other half instead of discarded. Deriving direction from prices, or
   * from a `take_profit` above an entry, is the family of bugs
   * lib/rules/tradeRuleContext.ts' header records having shipped once and §0ד of
   * the investigation found still live in three readers.
   */
  direction: 'long' | 'short';
  /** Contracts, summed across the group's legs: a scale-out of three is 3. */
  qty: number;
  /** Quantity-weighted average entry. See {@link describeTrade} for why weighted. */
  entryPrice: number;
  /** Quantity-weighted average exit. */
  exitPrice: number;
  /** The moment the trader was first in: the earliest leg's opening fill. */
  openedAtMs: number;
  /** The moment the trader was finally out. See {@link Trade}. */
  closedAtMs: number;
  /**
   * Net dollars across the group's legs. Signed. GROSS — no commissions, see
   * the module header, and §E11 of the investigation recommends saying so in the
   * journal rather than guessing a fee schedule.
   */
  pnlUsd: number;
  /** Every fill in the group, ascending. The first is what keys the trade. */
  fillIds: number[];
  /**
   * Every ORDER that produced a fill in this group, ascending (REF-113 Stage 1).
   *
   * THE EXACT HALF OF REF-113'S LINKING RULE, AND IT COSTS NOTHING. `fill.orderId`
   * is documented on the entity (./types.ts) and `/fill/list` is already read on
   * every pull, so this is a field the chain had in hand and discarded. §B of the
   * REF-113 investigation turns on it: a trade's own orders are
   * `{ fill.orderId : fill.id ∈ fillIds }` — no time window, no side test, no
   * heuristic, which is what the protective-order search is NOT and cannot be.
   *
   * ENTRY *AND* EXIT, DESPITE THE NAME. Every order that contributed a fill is
   * here, which on a normal trade is the entry order and the order that closed
   * it. The name says "entry" because the entry orders are what §B anchors the
   * protective-order time window on — a bracket is submitted WITH the entry
   * order, so a window opened at the entry FILL would miss every OCO placed
   * behind a resting limit entry. Nothing here distinguishes the two roles; that
   * needs `orderVersion.orderType`, which this pull does not read.
   *
   * ONE CONSEQUENCE WORTH KNOWING NOW: when the stop was the exit, its order is
   * already in this list, so that case needs no inference at all. It is the
   * highest-confidence case REF-113 has, and it is reachable from this field
   * alone.
   *
   * An unusable `orderId` is OMITTED rather than carried as `0` — see
   * {@link usableId}, which is the same boundary the pricing chain puts on every
   * number it reads off the wire. A `0` in here would be a plausible-looking
   * order id that joins to nothing, which is the silent-wrongness direction this
   * module refuses everywhere else. The list can therefore be shorter than
   * {@link fillIds}, and may be empty.
   *
   * NEVER LEAVES THE SERVER. Host-local like every id here, and ids are the one
   * thing /api/tradovate/today is asserted not to carry — see the leak group in
   * scripts/tradovate-today-check.ts, which names this field.
   */
  entryOrderIds: number[];
  /**
   * Whether THIS LOGICAL POSITION's `netPos` returned to zero (REF-117 Stage 2).
   *
   * THIS REPLACES `positionFlat`, AND THE RENAME IS THE WHOLE OF REF-117'S
   * SECOND CASE. The old field asked whether every Position row this group's
   * legs touched was flat RIGHT NOW — a question about the contract, not about
   * the trade. A Position is one row per contract per trading day with a live
   * `netPos`, so a trader who closed a round trip and immediately took a new
   * position on the same contract put that row back to non-zero, and every
   * trade already finished on that contract read `positionFlat: false` again
   * for as long as the new one was open. The closed trade did not reach the
   * journal, and the trader on 19.10 concluded something had broken. They were
   * reading the field correctly; the field was asking the wrong question.
   *
   * A cycle, by contrast, is closed by the fills that closed it, and nothing
   * executed afterwards can be part of it — so this is true the moment the
   * trader is out and stays true whatever they do next.
   *
   * IT STILL MAKES {@link brokerTradeKey} SAFE TO PERSIST, for a stronger reason
   * than before rather than the same one. §A3's hazard was that a later fill
   * pair could BRIDGE two groups, merging them and moving the key to the other
   * group's lowest fill id — a duplicate the partial UNIQUE could not catch
   * because both keys were genuinely distinct. Under cycles that cannot happen:
   * a closed cycle ends at `netPos = 0` and a later fill can only extend the
   * open cycle or start a new one. The key of a closed cycle is final.
   *
   * SO WHY IS IT STILL THE IMPORT'S GATE? Because an OPEN cycle's key is not
   * final — its lowest fill id is fixed, but its quantity, its exit price and
   * its P&L all still move — and a row written mid-cycle would be restated on
   * every pull until the trader was out. The gate is now about a row being
   * FINISHED rather than about a key being stable, which is a smaller claim and
   * a true one.
   *
   * FALSE WHEN UNKNOWN, still. ./cycles.ts does not state a cycle at all unless
   * the walk reconciles against the broker's `netPos`; a group it cannot account
   * for is held, not reported as closed. The two failure directions are the ones
   * REF-107 named: not importing is a trade missing until the next pull,
   * importing early is a duplicate nothing removes.
   *
   * AND THE STOP-HISTORY COST IS GONE, which was the expensive half of the old
   * field. `tradesNeedingStopHistory` (./import.ts) filters on this, so under
   * `positionFlat` an open position on a contract withheld REF-113's annotation
   * from the day's EARLIER trades on that same contract — and `/order/list` is
   * `depthDays = 0`, so if the position was still open when the trading day
   * rolled, those orders were destroyed and the annotation was lost for good
   * (measured on 19.10, ~/Desktop/reflect-reports/ref-113-why-no-write.md).
   * A closed cycle is now a candidate immediately, which is decision ד of that
   * report delivered as a side effect.
   */
  cycleClosed: boolean;
  /**
   * The pieces this position was entered and exited in (REF-117 Stage 6).
   *
   * ALWAYS PRESENT AND OFTEN TRIVIAL: a trade entered and exited whole is one
   * entry and one exit, and the surfaces that read this say nothing at all
   * unless one side has more than one. See {@link TradeStages}.
   */
  stages: TradeStages;
}

/**
 * One entry or one exit, as a journal row carries it (REF-117 Stage 6).
 *
 * A PROJECTION OF {@link import('./cycles').CycleLeg} AND NOT THE LEG ITSELF.
 * The leg carries a fill id, an order id, an instant and a `splitFromFill`
 * flag, and none of those is a thing to show a trader or to store: ids never
 * leave the server (the leak group in scripts/tradovate-today-check.ts), and
 * the instants are already summarised into `submitted_at` and `closed_at`. What
 * is left is what the sentence needs — how much, at what price.
 */
export interface TradeStage {
  /** Contracts this piece contributed. */
  qty: number;
  price: number;
}

/**
 * How the position was entered and exited, piece by piece (REF-117 Stage 6).
 *
 * WHY THIS IS A FIELD AT ALL, AND WHY IT IS NOT DERIVABLE DOWNSTREAM. `qty`,
 * `entryPrice` and `exitPrice` are a quantity and two QUANTITY-WEIGHTED MEANS,
 * and the whole of {@link describeCycle}'s averaging note is about making those
 * three reproduce the P&L beside them. What they cannot do is say how many
 * decisions produced them: "נכנסת ב-2 שלבים · יצאת ב-3 שלבים" is a fact about a
 * trade that the three figures provably erase, and REF-117 Stage 0 measured a
 * production position that was entered in two pieces and covered in two.
 *
 * THE ORDER IS TIME ORDER, which is ./cycles.ts' order for `legs` and is the
 * order a trader scaled in. It is data, like `versions` in a stop history.
 */
export interface TradeStages {
  entries: TradeStage[];
  exits: TradeStage[];
}

/**
 * One pull's two answers (REF-107 Stage 1).
 *
 * `day` is byte-for-byte what {@link loadBrokerDay} returned before this stage,
 * and `trades` is the list it reduced to produce it — not a second pass over the
 * same pairs. See the module header on why that matters more than the shape.
 */
/**
 * One thing this pull could not do, with the ids it takes to finish the job
 * (REF-112 §5).
 *
 * THE SERVER-SIDE HALF OF {@link import('./notices').BrokerNotice}, and the two
 * are separate types on purpose — the same separation {@link HeldGroup} and
 * `SyncResult.heldSymbols` already have. This one carries `host` and
 * `accountId`, because ./sync.ts needs them to look up what the trader called
 * that account; the wire type carries the resolved label and nothing else. An
 * id cannot reach the browser by forgetting to strip it, because the type that
 * crosses the wire has no field to put it in.
 *
 * `name` IS THE BROKER'S OWN `Account.name` and is the fallback label. For a
 * non-`Customer` account it is the ONLY label there will ever be: that account
 * is filtered out before ./account-sync.ts sees it, so it has no row and
 * therefore no nickname.
 */
export type PullNotice =
  /**
   * TWO MEMBERS AND NOT ONE WITH A TWO-VALUE `kind`, although they carry
   * identical fields. A single member whose discriminant is itself a union
   * cannot be narrowed away by `kind !== …`, so ./sync.ts' reducer would have
   * to cast — and a cast is exactly what must not stand between a type that
   * holds a broker account id and a type that crosses the wire.
   */
  | SkippedAccountNotice<'account_currency'>
  | SkippedAccountNotice<'account_type'>
  | { kind: 'no_accounts' }
  | { kind: 'host_degraded' }
  | { kind: 'unpriced_product'; root: string | null };

/** One account left out of the pull, with what it takes to name it. */
interface SkippedAccountNotice<K extends 'account_currency' | 'account_type'> {
  kind: K;
  host: TradovateEnvironment;
  accountId: number;
  name: string;
}

export interface BrokerDay {
  day: BrokerDayContext;
  trades: BrokerTrade[];
  /**
   * What this pull could not do, pooled across hosts (REF-112 §5).
   *
   * BESIDE {@link held} RATHER THAN FOLDED INTO IT, although both describe an
   * under-count and both exist for the same reason. A held group is a
   * reconciliation that failed on data we could read: the next sync re-offers
   * the same window and the usual cause does not repeat, so its sentence says
   * "ממתינות". These are things about the ACCOUNT or the PRODUCT that will
   * still be true tomorrow — a EUR-denominated product stays EUR-denominated,
   * an `Omnibus` account stays `Omnibus` — so their sentences say what Reflect
   * does not support and, where there is one, what the trader can do. Two
   * different promises; one list could only make one of them.
   *
   * Empty on an ordinary day, which is what makes it free to carry.
   */
  notices: PullNotice[];
  /**
   * The logical positions this pull REFUSED to state, per group (REF-117 Stage 2).
   *
   * Pooled across hosts like `trades`, and present even when empty — which it
   * is on an ordinary day. See {@link HeldGroup} for why an absence travels
   * beside the rows instead of being swallowed, and for why it is not an error.
   */
  held: HeldGroup[];
  /**
   * What discovery saw, per host that ANSWERED it (REF-110 Stage 1).
   *
   * A host whose discovery failed has NO ENTRY HERE, and the absence is the
   * payload: it is what lets the accounts sync tell "this account is gone" from
   * "we never asked". See {@link HostAccounts}.
   */
  accounts: HostAccounts[];
}

/**
 * One host's claimed accounts, from a discovery call that SUCCEEDED.
 *
 * The existence of this entry is a statement in its own right — "this host
 * returned a list" — and `loadBrokerDay` only ever pushes one after
 * {@link discoverHostAccounts} resolved. A host dropped by failure rule 1
 * contributes nothing, which is exactly the fail-safe REF-110 §A.5 needs:
 * treating "not in the list" as closed on a host that was never asked would
 * mark every account on it closed on the first demo outage.
 *
 * NOT DEDUPLICATED ACROSS HOSTS, unlike the trade pooling above it. The day's
 * dedupe exists because two hosts reporting the same account id might be one
 * account and double-counting a trade would inflate a loss; here the identity
 * is `(broker_account_id, broker_host)` on both sides of the join — 034 stamps
 * the host on every imported row and 037's unique index carries it — so a
 * host-qualified row is the only thing a trade can be joined to. An id that
 * genuinely appears on both hosts becomes two account rows, one of which
 * collects no trades, and that is the honest answer while nothing documents
 * the two id spaces as shared.
 */
export interface HostAccounts {
  host: TradovateEnvironment;
  /** Owned or permitted, tradeable or not. Never another trader's. */
  claimed: ClaimedAccount[];
}

/**
 * How far back the loss streak looks.
 *
 * Ten, matching the rule engine's own `.limit(10)` on recent closes, and for
 * the same stated reason: a streak long enough to matter is shorter than that,
 * and the count stops at the first non-loss anyway.
 *
 * Ten TRADES, not ten fill pairs — {@link Trade} is what gets counted, so a
 * trader who scaled out of three positions has used three of the ten.
 *
 * NOTE THAT THIS IS NOT LIMITED TO TODAY, and must not be. `lossStreak` in
 * Reflect counts back from the most recent close whenever it happened, so a
 * trader who lost three in a row yesterday evening is still on a streak of
 * three this morning. A broker streak measured over today alone would report
 * zero and lift a cooldown the trader set for exactly that situation. The
 * pairs are already in hand — the lists are unfiltered — so the wider window
 * costs nothing.
 */
const STREAK_WINDOW = 10;

// There was an EMPTY_DAY constant here, and the honest zero it described is now
// what the pooled arithmetic produces on its own: loadBrokerDay() has no early
// return at all, so a pull that found no account, no position or no pair on
// either host reaches the same reduction as a full day and that reduction sums
// nothing. One path to the zero instead of five.

/**
 * THERE WAS A UNION-FIND OVER FILL IDS HERE, AND IT WAS THE WRONG RULE
 * (REF-117 Stage 2).
 *
 * `groupIntoTrades`, `Trade`, `DatedPair`, `legsInOpeningOrder` and `datePair`
 * all lived in this space and are gone. What they did: joined two `FillPair`s
 * into one trade iff they shared a fill id. That is correct whenever ONE leg of
 * the round trip filled in a single piece — the shared fill is the glue — and it
 * breaks the moment BOTH legs fill in pieces, because Tradovate then matches
 * them pairwise and the resulting pairs have no fill in common at all.
 *
 * Measured in production twice on 20.10 (REF-117 Stage 0): a short of two,
 * covered in two pieces, reported `components: 2, cycles: 1`. One decision, two
 * journal rows, two scores, two entries in `todayTradeCount`, and TWO
 * CONSECUTIVE LOSSES where the trader took one — which is the exact distortion
 * the old `Trade` doc comment warned about for scale-OUTs and then shipped for
 * scale-ins: `cooldown_after_losses` defaults to three, so the app locks a
 * trader out over a loss they took once.
 *
 * The unit is now a LOGICAL POSITION — every fill on one contract in one account
 * from the moment `netPos` leaves 0 until it returns to 0 — and it lives in
 * ./cycles.ts, which is pure and has its own suite. What stayed here is
 * everything this module was always about: the host rules, the account
 * ownership filter, the pricing chain, and the refusals.
 *
 * THE PAIRS DID NOT GO AWAY AND MUST NOT. They have two jobs left, and losing
 * either one would be a regression: they are the ONLY path from a fill to an
 * account (`TradovateFill` carries neither `accountId` nor `positionId`, so a
 * walk over `/fill/list` alone would interleave a prop trader's two accounts on
 * one contract into one fabricated cycle), and they are what the money is
 * computed from — see {@link priceCycle}, which keeps the REF-90 arithmetic and
 * checks it against the walk rather than replacing it.
 */

/**
 * Why a logical position produced no journal row (REF-117 Stage 2).
 *
 * ./cycles.ts' five reasons, plus the two this module adds because they are
 * about a ROW rather than about a walk: `'interday'` (the entry fills are
 * outside the API's depth, so `entryPrice` and `openedAtMs` cannot be stated)
 * and `'partly_priced'` (the pairs do not cover the cycle's exit quantity, so
 * the money would be a fraction of a real loss).
 */
export type HeldReason =
  | CycleHeldReason
  | 'interday'
  | 'partly_priced'
  /**
   * A pair landed in no cycle at all, so its money was left out of the day.
   *
   * THIS IS WHAT REPLACED `datePair`'s `missing_fill` THROW, and it covers the
   * same ground without taking the pull down. A pair whose legs are not in
   * `/fill/list` cannot be placed on any cycle, because the walk never saw the
   * fills that would have held it — so instead of failing the whole day on every
   * contract, the pair is named and the rest of the day is stated. See
   * {@link import('./cycles').CycleScan.orphanPairs}.
   */
  | 'orphan_pair';

/**
 * One absence, stated rather than swallowed.
 *
 * THE REASON THIS TYPE EXISTS AT ALL is the module's oldest fail-safe: an
 * under-counted day makes every rule MORE PERMISSIVE, which is the one
 * direction this integration must never fail in. Before REF-117 the equivalent
 * absences were either a thrown `missing_fill` — which fails the whole pull, on
 * every contract, for one unaccountable group — or nothing at all. Neither is
 * readable. This is counted, carried on {@link BrokerDay.held}, and logged.
 *
 * IT IS NOT AN ERROR AND DELIBERATELY DOES NOT FAIL THE PULL, and that is a
 * judgement rather than a derivation. Holding one `(account, contract)` group
 * costs the day the trades on that contract; throwing costs the trader every
 * rule on every contract plus the journal, because one overnight carry would
 * take the integration down for the session. The under-count is the smaller
 * failure AS LONG AS IT IS VISIBLE, which is what this type is for — and a
 * surface that shows it to the trader is REF-117 Stage 6, not this stage.
 */
export interface HeldGroup extends Omit<CycleHeldGroup, 'reason'> {
  reason: HeldReason;
  /**
   * The contract's NAME, for the one sentence the trader is shown (REF-117
   * Stage 6).
   *
   * THE ONLY FIELD ON THIS TYPE THAT MAY LEAVE THE SERVER. `accountId`,
   * `contractId`, `fills` and `impliedPrevPos` are broker ids and operator
   * diagnostics; a trader cannot act on any of them and the leak group in
   * scripts/tradovate-today-check.ts is what keeps ids off the wire. A symbol
   * is the thing they recognise — "the MNQ trades are not in yet" — and
   * lib/tradovate/sync-response.ts carries this one string and nothing else.
   *
   * NULL FOR TWO DIFFERENT REASONS AND BOTH RENDER THE SAME WAY: the contract
   * body named nothing usable, or the group is not about a contract at all
   * (`'orphan_pair'`, which is reported once for the host). A null degrades the
   * sentence to the one without a symbol rather than suppressing it — the
   * absence is the thing worth saying, and the contract is the detail.
   *
   * RESOLVED THROUGH ./contract-names.ts, WHICH SWALLOWS. A held group must
   * never be able to fail the pull; that is the whole reason this type exists
   * instead of a throw.
   */
  symbol: string | null;
}

/**
 * How far the pair arithmetic and the fill walk may disagree, in dollars.
 *
 * ONE CENT, WHICH IS TWELVE ORDERS OF MAGNITUDE ABOVE THE NOISE AND FAR BELOW
 * ANYTHING A TRADER CAN SEE. The two expressions are equal in real arithmetic
 * and not in IEEE 754: `(avgSell − avgBuy) × qty` divides and then multiplies,
 * `−Σ signed × price` does neither, and the REF-117 suite measured the gap at
 * 1.4e-14 on a five-contract scale-out. A quarter of a million dollars of
 * notional moves that to about 6e-8. A real fault — a pair assigned to the wrong
 * cycle — is dollars.
 */
const PNL_DRIFT_TOLERANCE_USD = 0.01;

/** What one contract is worth per point, in what currency, and what it is called. */
interface ContractUnit {
  valuePerPoint: number;
  currencyName: string;
  /**
   * The contract's own name, e.g. `ESZ6`, or null when the body named nothing
   * usable.
   *
   * REF-107 §A1: this was already on the `/contract/item` response that the
   * pricing chain reads for `contractMaturityId`, and was the one journal field
   * that needed no new request to obtain. It rides on the unit rather than in a
   * second map so that a contract cannot be priced by one lookup and named by
   * another. Where the name is non-null it is also this entry's key in
   * {@link unitByContractName}.
   */
  name: string | null;
}

/**
 * Why one contract could not be priced, when that is not fatal to the pull
 * (REF-112 §5.10, §5.11).
 *
 * `name` IS CARRIED EVEN THOUGH THE UNIT IS NOT, and it is the only reason
 * this is a record rather than a bare reason. A refusal has to be able to say
 * which instrument it is about, and the `/contract/item` body — which every
 * path below has already read by the time it can refuse — is where the name
 * comes from. Null when the body named nothing usable.
 */
interface UnitRefusal {
  reason: TradovateUnpriceableError['reason'];
  name: string | null;
}

/**
 * What the pricing chain could state, and what it could not.
 *
 * TWO MAPS AND NOT A MAP OF A UNION, because the callers are different
 * questions and conflating them is how a refused contract gets priced by
 * accident: `units.get(id)` is "what is this worth", and a contract in
 * `refused` is absent from it entirely.
 *
 * A CONTRACT IS IN EXACTLY ONE OF THEM. Nothing writes to `refused` after
 * `units`, and every refusal path returns.
 */
interface ContractUnits {
  units: Map<number, ContractUnit>;
  refused: Map<number, UnitRefusal>;
}

/**
 * A finite number greater than zero.
 *
 * ONE BOUNDARY FOR EVERY NUMBER THE PRICING CHAIN READS OFF THE WIRE: the two
 * ids it walks to a product, and the value per point it ends at. `0` is what an
 * absent numeric field tends to coerce to, it is not an entity id this API
 * issues, and it is not a value per point either — so one test refuses all
 * three, and extracting it is what stops the three from drifting apart as they
 * did when only one of them existed (REF-90).
 *
 * Takes `unknown` rather than `number | undefined` on purpose: these values
 * come off a JSON body, where the type that describes them is a claim about the
 * documentation and not about the wire.
 */
function usableId(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * What a contract named `ESZ6` is worth per point, across pulls and traders.
 *
 * KEYED ON THE CONTRACT'S NAME, AND THAT IS THE WHOLE REASON THIS IS SAFE TO
 * SHARE. {@link loadHostTrades}' header forbids pooling anything id-bearing
 * between hosts, because nothing documents live and demo as sharing id spaces —
 * a `contractId`-keyed entry really could price one host's contract with the
 * other's value per point, which is the silent unit bug this module exists to
 * prevent. A name cannot do that: `ESZ6` is `ESZ6` on any host, because a
 * contract spec is an exchange fact rather than a host-local row. Both halves
 * of the value are the same kind of fact — `valuePerPoint` is the spec, and
 * `currencyName` is already resolved to 'USD' rather than a host-local
 * `currencyId`.
 *
 * NOT KEYED BY USER, DELIBERATELY. The day-pull cache in
 * lib/rules/brokerDayContext.ts is keyed by `userId` because whose day it is
 * matters, and signing in as somebody else must not be served the previous
 * trader's figures. What one point of ES is worth is nobody's data: it is the
 * same number for every trader, so one process may answer them all from one
 * entry. Please do not "fix" this to match the other cache.
 *
 * It saves the LAST TWO calls, not the first: the key comes out of
 * /contract/item, so that read still happens once per contract per pull.
 */
const unitByContractName = new Map<string, ContractUnit>();

/**
 * How many contract specs one process keeps.
 *
 * The natural TTL is the process lifetime, which on Vercel is short, so there
 * is no expiry here — a spec changes when a contract is relisted, which is to
 * say almost never. The cap is what stops a long-lived instance from growing an
 * entry per contract per trader forever. A trader holds one or two contracts,
 * so this is already a hundred traders' worth of distinct instruments.
 */
const UNIT_CACHE_MAX = 256;

/** Remember a spec, oldest out. A Map iterates in insertion order, so the oldest key is the first. */
function rememberUnit(name: string, unit: ContractUnit): void {
  if (!unitByContractName.has(name) && unitByContractName.size >= UNIT_CACHE_MAX) {
    const oldest = unitByContractName.keys().next();
    if (!oldest.done) unitByContractName.delete(oldest.value);
  }
  unitByContractName.set(name, unit);
}

/** Forget every contract spec. Test seam, like forgetBrokerDayPull() one layer up. */
export function forgetContractUnits(): void {
  unitByContractName.clear();
}

/**
 * The account ids this host says our trader is permitted to trade (REF-90
 * Stage 2), or null when there is no permission evidence to be had.
 *
 * ONE CALL, PER HOST, AND ONLY WHEN IT COULD CHANGE AN ANSWER. The caller asks
 * {@link permissionsCouldHelp} first, so a trader whose accounts are their own
 * never makes this request at all and Stage 2 costs them nothing. Permissions
 * are host-local like every other entity here: this host's list is read with
 * this host's reader and is never consulted for the other host's accounts.
 *
 * THE ONE PLACE IN THIS MODULE WHERE A FAILURE IS SWALLOWED, and it is an
 * explicit exception to {@link loadBrokerDay}'s second failure rule. Everywhere
 * else a failed read fails the pull, because a swallowed one would under-count
 * the day and an under-counted day makes every rule more permissive. Here the
 * direction is the other way round: no permission list means the OWNED-ONLY
 * rule, which is what this code did before Stage 2 and is strictly the stricter
 * answer. A 404 is also the expected reply from a host where this entity is not
 * exposed — the documentation page for the endpoint 404s and the path comes
 * from a naming convention — so failing a working pull on it would turn Stage 2
 * into a regression for every trader who does not need it.
 *
 * It cannot hide a dead token either: a 401 here means the next read in the
 * chain gets one too, and that one does fail the pull.
 */
async function readPermittedAccounts(
  reader: TradovateReader,
  tradovateUserId: number | null
): Promise<ReadonlySet<number> | null> {
  try {
    const body = await reader.get<unknown>('/tradingPermission/list');
    return permittedAccountIds(body, tradovateUserId);
  } catch {
    return null;
  }
}

/**
 * Stage one of the chain, on one host: the accounts whose fills count here.
 *
 * Hoisted out of the per-host chain on purpose. (a′) routes BY WHAT DISCOVERY
 * FOUND — ask both hosts for accounts, then continue the chain only where there
 * is something to continue with — so this stage has to be separable from the
 * six reads that follow it. It is also the stage whose failure is forgivable on
 * one host and fatal on the other, which is the same requirement stated as an
 * error path.
 *
 * EXPORTED SINCE REF-108. ./positions.ts asks the same question — which
 * accounts are this trader's — for a read that has nothing to do with the day,
 * and a second copy of it would be a second answer: the ownership rule, the
 * conditional permission read and the `withoutResponseBody` reduction below
 * are all things that must not exist twice.
 */
export async function discoverHostAccounts(
  reader: TradovateReader,
  tradovateUserId: number | null
): Promise<{
  accepted: TradovateAccount[];
  claimed: ClaimedAccount[];
  /** This trader's accounts dropped for their TYPE alone. See REF-112 §5.12. */
  unsupported: TradovateAccount[];
}> {
  // THE ONE READ IN THIS MODULE WHOSE FAILURE BODY IS THE TRADER'S OWN DATA.
  // `/account/list` answers with a list of account NAMES, and a
  // TradovateRequestError puts `body.slice(0, 300)` into its message — so an
  // upstream error here hands a prop firm's account names to whatever logs it,
  // four layers up, where nobody is thinking about this call. Reduced to a
  // status code at the only point that knows what the body held. See
  // withoutResponseBody() in ./errors.ts.
  //
  // This risk PREDATES REF-110 — the call has been made on every pull since
  // Stage 1 — and REF-110 is the ticket that made somebody look at it.
  let accounts: TradovateAccount[];
  try {
    accounts = (await reader.get<TradovateAccount[]>('/account/list')) ?? [];
  } catch (error) {
    throw withoutResponseBody(error);
  }

  // Owned OR permitted (REF-90 Stage 2). The permission list is read only when
  // some account on this host failed on ownership — see permissionsCouldHelp(),
  // and the REF-110 note on it for why tradeability is no longer part of that
  // question. A trader whose accounts are all their own still pays nothing.
  const permitted = permissionsCouldHelp(accounts, tradovateUserId)
    ? await readPermittedAccounts(reader, tradovateUserId)
    : null;

  // THREE ANSWERS OUT OF ONE LIST, AND NO SECOND REQUEST. `accepted` is what
  // the day has always counted; `claimed` is the same trader's accounts
  // WITHOUT the tradeability filter, which is what the accounts table records
  // (REF-110 Stage 1); `unsupported` is the ones neither of those will ever
  // hold, because their TYPE put them out of scope (REF-112 §5.12) — and
  // which, until now, nothing anywhere said a word about. None of the three is
  // derivable from another: `accepted` has thrown the closed ones away, the
  // raw list holds other traders', and `unsupported` is precisely what both
  // of the first two filter out. All from the one `/account/list` this pull
  // was always going to make.
  return {
    accepted: partitionAccounts(accounts, tradovateUserId, permitted).accepted,
    claimed: claimedAccounts(accounts, tradovateUserId, permitted),
    unsupported: unsupportedTypeAccounts(accounts, tradovateUserId, permitted),
  };
}

/** The other one. Two environments, so this is total. */
function otherHost(environment: TradovateEnvironment): TradovateEnvironment {
  return environment === 'live' ? 'demo' : 'live';
}

/**
 * Everything from `/position/list` through pricing, FOR ONE HOST.
 *
 * The logic is the old `loadBrokerDay()` body, unchanged line for line, with
 * two things lifted out: discovery (above, because routing depends on it) and
 * the day arithmetic (below, because it must see every host at once).
 *
 * WHAT MUST STAY INSIDE THIS FUNCTION, and why it is not a style preference:
 *
 * - **{@link groupIntoTrades}** is a union-find over `fill.id`. Run it over a
 *   pooled two-host list and two unrelated fills that happen to share an id are
 *   welded into one trade — a trader who scaled out of a demo loser and
 *   separately won on live would be told the two were one decision.
 * - **{@link loadContractUnits}** keys its returned map on `contractId` alone.
 *   Pooled, one host's `valuePerPoint` can price the other host's contract: a
 *   silent unit bug, which is the exact failure class this module's header
 *   exists to prevent. Note that its cache is a different matter and is shared
 *   across hosts on purpose — see {@link unitByContractName}, which is keyed by
 *   contract NAME precisely so that it cannot commit this sin.
 *
 * So both run per host, and what leaves is {@link BrokerTrade} — a finished row
 * whose ids are carried and never joined on again.
 *
 * Returns the trades the day could possibly need: every close inside the
 * requested window plus this host's own streak window. The pooled top ten is a
 * subset of the union of the per-host top tens, so nothing the streak reaches is
 * left behind here.
 */
export async function loadHostTrades(params: {
  reader: TradovateReader;
  /** Which host this reader addresses. Stamped on every row; see {@link BrokerTrade}. */
  host: TradovateEnvironment;
  /** This host's eligible accounts, from {@link discoverHostAccounts}. */
  accounts: readonly TradovateAccount[];
  dayStartMs: number;
  /**
   * The earliest close this pull has to be able to state, when that is before
   * the day boundary. See {@link BrokerDayRequest.windowStartMs}.
   */
  windowStartMs?: number;
}): Promise<BrokerTrade[]> {
  return (await scanHost(params)).trades;
}

/**
 * {@link loadHostTrades} plus what it REFUSED to state (REF-117 Stage 2).
 *
 * The second half is new and it is not decoration. A group ./cycles.ts holds —
 * fills that cannot account for the broker's own `netPos` — contributes no
 * trades, and this module's oldest rule is that an under-counted day makes every
 * rule MORE PERMISSIVE. So the absence travels beside the rows instead of being
 * swallowed, and {@link BrokerDay.held} is where it arrives.
 *
 * AND A THIRD (REF-112 §5). `notices` is what the pull could not do for
 * reasons that are about the ACCOUNT or the PRODUCT rather than about a
 * reconciliation — see {@link BrokerDay.notices} on why that is a second list
 * and not more `held` reasons.
 */
export async function scanHost(params: Parameters<typeof loadHostTrades>[0]): Promise<{
  trades: BrokerTrade[];
  held: HeldGroup[];
  notices: PullNotice[];
}> {
  const { reader, host, accounts, dayStartMs } = params;

  // Never later than the day boundary: the day's scalars are not negotiable by a
  // query parameter, so a window can only widen what gets priced.
  const windowStartMs = Math.min(dayStartMs, params.windowStartMs ?? dayStartMs);

  // No account of this trader's own that could have been traded. An honest
  // zero, not a failure: see the closing note in ./accounts.ts. The caller does
  // not even get here — it drops such a host before asking — but the guard
  // stays, because this function's contract should not depend on that.
  if (accounts.length === 0) return { trades: [], held: [], notices: [] };

  const accountIds = new Set(accounts.map((account) => account.id));

  // Positions exist to answer one question — whose trade is this — so they are
  // filtered by account and by nothing else. In particular NOT by `tradeDate`,
  // which the §4 note in ./trading-day.ts explains at length: the round trips
  // are dated by their closing fill's instant instead.
  //
  // REF-107 keeps the ANSWER to that question rather than just the filter it
  // fed: a journal row names the account it was traded on, which §E15 of the
  // investigation argues for on the grounds that a journal mixing a prop
  // evaluation account with a personal one is a journal nobody can read.
  // Positions are still read for exactly the two things only they can answer —
  // whose trade this is, and what the broker says is currently held — but
  // `netPos` is no longer reduced to a flat/not-flat SET here. ./cycles.ts needs
  // the signed figure itself, because it is the right-hand side of the
  // reconciliation identity that licenses trusting any cycle at all.
  const positions = await reader.get<TradovatePosition[]>('/position/list');
  const myPositions = (positions ?? []).filter((position) => accountIds.has(position.accountId));
  if (myPositions.length === 0) return { trades: [], held: [], notices: [] };

  const myPositionIds = new Set(myPositions.map((position) => position.id));
  const allPairs = await reader.get<TradovateFillPair[]>('/fillPair/list');
  const myPairs = (allPairs ?? []).filter((pair) => myPositionIds.has(pair.positionId));
  if (myPairs.length === 0) return { trades: [], held: [], notices: [] };

  const fills = await reader.get<TradovateFill[]>('/fill/list');

  // EVERY FILL GOES IN, NOT A PRE-FILTERED SET, and that is forced rather than
  // careless: a fill carries no account, so there is nothing to filter on. What
  // narrows them is the attribution inside ./cycles.ts — a fill one of MY pairs
  // names, or one on a contract exactly one of my accounts traded. A fill that
  // belongs to an account this host holds but that the ownership filter excluded
  // could in principle be inferred into an eligible account on the same
  // contract; the reconciliation is what catches it, because the walk would then
  // carry a term `netPos` does not, and the group is held rather than counted.
  const scan = cyclesFromFills({
    fills: fills ?? [],
    pairs: myPairs,
    positions: myPositions,
  });

  const pairById = new Map<number, TradovateFillPair>();
  for (const pair of myPairs) pairById.set(pair.id, pair);

  // What can become a journal row at all. Three refusals, and each one is the
  // honest answer to a question `BrokerTrade` has no shape for:
  //
  //   - NOTHING MATCHED YET. An open cycle the trader has not exited any of has
  //     `qty: 0` and no pair, so there is no round trip to state. This is the
  //     same silence as before: no pair, no trade.
  //   - INTERDAY. Stage 0 measured /fill/list, /fillPair/list AND /position/list
  //     at `depthDays = 0`, so a position opened yesterday has unreachable entry
  //     fills. `entryPrice` and `openedAtMs` are non-nullable on BrokerTrade and
  //     `submitted_at` is built from the second, so such a cycle cannot be
  //     expressed as a row without inventing both. ./cycles.ts marks it; a later
  //     stage is where it earns a nullable column, and until then it is a held
  //     absence rather than a fabricated entry.
  //   - NOT FULLY PRICED. A cycle whose pairs do not cover its exit quantity has
  //     no honest P&L, and a partial one would under-report a real loss.
  const usable = scan.cycles.filter(
    (cycle) => cycle.qty > 0 && !cycle.interday && cycle.pairedQty === cycle.qty
  );

  const unpriceable = scan.cycles.filter(
    (cycle) => cycle.qty > 0 && (cycle.interday || cycle.pairedQty !== cycle.qty)
  );

  const unnamedHeld: Omit<HeldGroup, 'symbol'>[] = [
    ...scan.held,
    ...unpriceable.map((cycle) => ({
      accountId: cycle.accountId,
      contractId: cycle.contractId,
      reason: cycle.interday ? ('interday' as const) : ('partly_priced' as const),
      fills: cycle.fillIds.length,
    })),
    // Money with nowhere to go. Reported once for the host rather than per pair:
    // the count is the finding, and there is no `(account, contract)` to name
    // because the pair's own cycle is the thing that does not exist.
    ...(scan.orphanPairs > 0
      ? [
          {
            accountId: null,
            contractId: 0,
            reason: 'orphan_pair' as const,
            fills: scan.orphanPairs,
          },
        ]
      : []),
  ];

  // ── What the trader is told a held group is ABOUT (REF-117 Stage 6) ───────
  //
  // ONE `/contract/item` PER HELD CONTRACT, SWALLOWED, AND ONLY WHEN SOMETHING
  // IS HELD — which on an ordinary day is never, so this costs nothing on the
  // path every pull takes. It is deliberately NOT folded into
  // `loadContractUnits` below: that chain THROWS on a gap, by REF-90 §4's
  // argument about a figure in points measured against a dollar threshold, and
  // a held group given the power to fail the pull would invert the entire
  // reason {@link HeldGroup} exists. `contractId: 0` — the orphan-pair row —
  // is not a contract and is not looked up.
  const heldNames = await loadContractNames(
    reader,
    host,
    new Set(unnamedHeld.map((group) => group.contractId).filter((id) => usableId(id)))
  );
  const held: HeldGroup[] = unnamedHeld.map((group) => ({
    ...group,
    symbol: heldNames.get(group.contractId) ?? null,
  }));

  const trades = [...usable].sort((a, b) => b.closedAtMs - a.closedAtMs);

  // Price only what is actually read: the window's closes, plus the streak
  // window, which reaches back past today. A trader with years of history has
  // those lists in hand by now and pricing all of it would be hundreds of
  // contract lookups for figures nothing reads.
  //
  // `windowStartMs` is what makes "since I connected" affordable and what bounds
  // it: §A2 found that the PULL costs the same whatever the window — the lists
  // are unfiltered — and that only PRICING grows, at one contract lookup per
  // distinct contract. A week reaches one or two; a full history reaches one per
  // expiry month the trader ever touched, which is why §A2 puts that behind a
  // separate job and not behind this parameter.
  const inWindow = trades.filter((t) => closedToday(t.closedAtMs, windowStartMs));
  const streakWindow = trades.slice(0, STREAK_WINDOW);
  const needed = new Set([...inWindow, ...streakWindow]);

  const { units, refused } = await loadContractUnits(
    reader,
    new Set([...needed].map((cycle) => cycle.contractId))
  );

  // ── What could not be priced, and who it belongs to (REF-112 §5.10) ───────
  //
  // THE SKIP IS PER ACCOUNT AND NOT PER TRADE, which is the one place item 1
  // is wider than it first looks and is deliberate. The currency is a property
  // of the PRODUCT — `/account/list` carries no currency field at all
  // (./types.ts) — so "a non-USD account" is only ever observed as "an account
  // that traded a non-USD product". Importing that account's dollar trades and
  // dropping its euro ones would produce a P&L that looks complete, reads
  // plausibly, and is short by every trade on the other side of the account:
  // a believable "no trades today" one level down, which is the exact failure
  // REF-112 exists to remove. Leaving the whole account out is legible, and
  // the sentence names it.
  //
  // THE OTHER ACCOUNTS ARE UNAFFECTED, which is the half that was broken: this
  // used to be a thrown `broker_unavailable` for the entire pull.
  const skippedAccounts = new Map<number, string>();
  for (const cycle of needed) {
    if (refused.get(cycle.contractId)?.reason !== 'foreign_currency') continue;
    const account = accounts.find((candidate) => candidate.id === cycle.accountId);
    // An account that is not in this host's accepted list cannot have produced
    // a cycle here, so this is unreachable — and if it ever is reached, the
    // fail-safe is to skip without claiming a name rather than to invent one.
    skippedAccounts.set(cycle.accountId, account?.name ?? '');
  }

  const notices: PullNotice[] = [...skippedAccounts].map(([accountId, name]) => ({
    kind: 'account_currency' as const,
    host,
    accountId,
    name,
  }));

  // Priced LAST, so that `describeCycle` is never handed a cycle whose contract
  // is in `refused` — it reads `units` and a missing unit is not a case it has.
  const priced = [...needed].filter((cycle) => !skippedAccounts.has(cycle.accountId));

  return {
    trades: priced.map((cycle) => describeCycle(cycle, host, units, pairById)),
    held,
    notices,
  };
}

/**
 * One grouped trade as a journal row.
 *
 * Everything here is read off the group, and three of the fields are the §A1
 * gaps closed: `symbol` from the contract body the pricing chain already
 * fetched, and `direction` and `openedAtMs` from the leg comparison
 * {@link datePair} already made.
 *
 * WHY ENTRY AND EXIT ARE QUANTITY-WEIGHTED, and why that is not a choice of
 * averaging method: for a group whose legs all share a contract — which they do,
 * because sharing a fill means sharing that fill's contract — the weighted means
 * satisfy
 *
 *   (avgSell − avgBuy) × totalQty  ≡  Σ (sellᵢ − buyᵢ) × qtyᵢ
 *
 * exactly, so the two prices a trader is shown reproduce the P&L they are shown
 * beside them. An unweighted mean does not, and a journal where entry, exit,
 * quantity and dollars disagree by a few cents is a journal the trader stops
 * trusting. For the single-leg trade this reduces to the two real fill prices.
 *
 * Direction decides which side is the entry, not the arithmetic: a long's entry
 * is its buy, a short's entry is its sell. The P&L expression above it still
 * reads neither — see the module header.
 */
function describeCycle(
  cycle: LogicalPosition,
  host: TradovateEnvironment,
  units: Map<number, ContractUnit>,
  pairById: ReadonlyMap<number, TradovateFillPair>
): BrokerTrade {
  const unit = units.get(cycle.contractId);
  if (!unit) {
    throw new TradovateUnpriceableError(
      `No value per point for contract ${cycle.contractId}.`,
      'no_value_per_point'
    );
  }

  return {
    // The host prefix is still this module's, because host-qualification is its
    // oldest rule and ./cycles.ts has no business knowing there are two hosts.
    brokerTradeKey: `${host}:${cycle.keyFillId}`,
    host,
    accountId: cycle.accountId,
    symbol: unit.name,
    direction: cycle.direction,
    qty: cycle.qty,
    // Non-null by the filter in scanHost: an interday cycle — the only one whose
    // entry is unknown — never reaches here.
    entryPrice: cycle.avgEntry!,
    exitPrice: cycle.avgExit!,
    openedAtMs: cycle.openedAtMs!,
    closedAtMs: cycle.closedAtMs,
    pnlUsd: priceCycle(cycle, unit, pairById),
    fillIds: cycle.fillIds,
    // EVERY ORDER OF THE CYCLE, which is what the field has always documented
    // itself to mean — "ENTRY *AND* EXIT, DESPITE THE NAME" — and not
    // ./cycles.ts' narrower `entryOrderIds`. REF-113's layer A depends on the
    // order that CLOSED the trade being in this list: a stop that fired is then
    // identified with no window, no tolerance and no inference, which its own
    // header calls the highest-confidence case in that feature. Narrowing this
    // to entries would delete that case silently.
    //
    // The entry/exit split now exists on the cycle for whoever wants it, and
    // REF-113 Stage 5 is where it gets a reader (the per-protective-order
    // verdict). Nothing here needs it.
    entryOrderIds: cycle.orderIds,
    cycleClosed: cycle.cycleClosed,
    // The legs, reduced to what a sentence needs (REF-117 Stage 6), and GROUPED
    // BY ORDER rather than left 1:1 with the fills (Stage 7). ./cycles.ts
    // already has them in time order and already split entry from exit by
    // whether the leg moved `netPos` AWAY from zero — which is the only
    // definition that survives a flip, where one FILL contributes a leg to each
    // of two cycles.
    stages: {
      entries: stagesFromLegs(cycle.legs.filter((leg) => leg.entry)),
      exits: stagesFromLegs(cycle.legs.filter((leg) => !leg.entry)),
    },
  };
}

/**
 * One side's legs as the pieces a TRADER chose, not the pieces a BROKER filled.
 *
 * WHY THIS IS NOT `legs.map(asStage)` ANY MORE (REF-117 Stage 7). A market order
 * for three contracts can come back as three partial fills, and the walk in
 * ./cycles.ts makes one leg per fill because that is what a leg is. Projecting
 * 1:1 then said `נכנסת ב-3 שלבים` about a trader who placed ONE order, and the
 * whole claim of the feature is "how many DECISIONS produced these four
 * numbers". So the grouping key is `orderId`, which the broker states on every
 * fill and {@link CycleLeg} carries all the way here. No timestamp window, no
 * tolerance: two separate orders inside one second are routine at the open, and
 * a resting order can fill over minutes, so proximity is wrong in both
 * directions. The cycle already aggregates by order for `orderIds` — this is
 * that same aggregation, finally performed for the stages.
 *
 * A LEG WITH NO ORDER IS ITS OWN STAGE, and this guard is load-bearing. Keying
 * the map on `leg.orderId` directly would collapse every order-less leg into one
 * `undefined` bucket and merge fills from genuinely different decisions — the
 * one outcome worse than counting too many. Degrading to one-stage-per-leg is
 * the honest floor: exactly the old behaviour, for exactly the legs that carry
 * no evidence.
 *
 * THE MERGED PRICE IS THE QUANTITY-WEIGHTED MEAN, which is a decision and not an
 * implementation detail. It is the same arithmetic as `entryPrice` and
 * `exitPrice` — see this module's note above {@link describeCycle} — so a merged
 * stage reproduces the row's average exactly: `price_g × qty_g ≡ Σ pᵢqᵢ`. The
 * consequence to know before reading it as a bug: a mean of fills at different
 * ticks is generally NOT ON A TICK. Two 1-lots one tick apart average to a half
 * tick, and `stagePieces` in lib/journal/stages.ts renders it with `toFixed(2)`,
 * so a trader reconciling the detail line against a broker statement can find a
 * price the exchange never printed. That is accepted: one decision gets one
 * price, consistent with the row it sits under. A single-leg group is returned
 * verbatim rather than put through the division, so every stage that was not
 * merged keeps the real fill price it had before this stage, bit for bit.
 *
 * KNOWN UNDER-MERGE, DELIBERATELY NOT FIXED HERE: Tradovate issues a NEW
 * `orderId` when a working order is modified, so an order partially filled and
 * then cancel-and-replaced reports two stages for what the trader experienced as
 * one decision. It is out of scope for Stage 7. It fails in the same direction
 * as the old code — too many stages, not too few — and that is the safe side: an
 * over-count over-reports scaling, which is wrong but legible, where an
 * over-merge erases a real decision. The replacement chain lives in
 * ./orders.ts, is built from a separate `/order/list` pass that can legitimately
 * resolve nothing, and reaching for it would make `broker_stages` conditional —
 * which `CONDITIONAL_FACTS` in scripts/broker-import-check.ts argues it must not
 * become, since it comes off the same `/fill/list` pass that produced the row.
 *
 * Groups are emitted in the order of their EARLIEST leg, which falls out of
 * creating a group's slot at its first leg. Order is data here: both
 * `040_broker_stages.sql` and `stableJson` in ./import.ts depend on it.
 */
export function stagesFromLegs(legs: readonly CycleLeg[]): TradeStage[] {
  const byOrder = new Map<number, CycleLeg[]>();
  const groups: CycleLeg[][] = [];

  for (const leg of legs) {
    // `undefined` never reaches the map, so order-less legs share no bucket.
    const open = leg.orderId === undefined ? undefined : byOrder.get(leg.orderId);
    if (open) {
      open.push(leg);
      continue;
    }
    const started = [leg];
    groups.push(started);
    if (leg.orderId !== undefined) byOrder.set(leg.orderId, started);
  }

  return groups.map((group) => {
    // The old projection, unchanged, for the overwhelmingly common case.
    if (group.length === 1) return { qty: group[0].qty, price: group[0].price };

    const qty = group.reduce((total, leg) => total + leg.qty, 0);
    return {
      qty,
      // Guarded the same way and for the same reason as `weighted()` in
      // ./cycles.ts: a zero-quantity group would divide to NaN, and the
      // all-or-nothing reader in lib/journal/stages.ts would then drop the whole
      // document rather than one piece of it.
      price:
        qty === 0
          ? group[0].price
          : group.reduce((acc, leg) => acc + leg.price * leg.qty, 0) / qty,
    };
  });
}

/**
 * One cycle's P&L in dollars, from the PAIRS, checked against the FILLS.
 *
 * THE PAIR ARITHMETIC IS STILL THE ONE IN PRODUCTION. `(sellPrice − buyPrice) ×
 * qty × valuePerPoint` has been shipping since REF-90, the module header argues
 * at length why it needs no direction branch, and REF-117 had no reason to
 * replace a correct expression — only to group its inputs differently.
 *
 * WHAT IS NEW IS THAT IT IS NOW CHECKED. ./cycles.ts reaches the same figure by
 * a completely different route — `−Σ (buy ? +qty : −qty) × price` over the
 * fills, which never consults a pair — so the two agreeing is a real statement
 * about the pair-to-cycle assignment, which is the one new thing Stage 2
 * introduced and the one thing that could be wrong. They disagree only if a pair
 * landed on the wrong cycle, and that is a bug, not a data condition: hence
 * {@link PNL_DRIFT_TOLERANCE_USD} rather than a float epsilon, and a throw
 * rather than a preference for one of them.
 *
 * The suite asserts the same equality on fixtures (`npm run
 * test:broker-cycles`); this is the production half of it, and it costs one
 * subtraction per trade.
 */
function priceCycle(
  cycle: LogicalPosition,
  unit: ContractUnit,
  pairById: ReadonlyMap<number, TradovateFillPair>
): number {
  let fromPairs = 0;
  for (const pairId of cycle.pairIds) {
    const pair = pairById.get(pairId);
    if (!pair) {
      throw new TradovateUnpriceableError(
        `Fill pair ${pairId} was assigned to a logical position and then not found, so ` +
          'the trade cannot be priced.',
        'missing_fill'
      );
    }
    fromPairs += (pair.sellPrice - pair.buyPrice) * pair.qty * unit.valuePerPoint;
  }

  const fromFills = (cycle.pointsPnl ?? 0) * unit.valuePerPoint;
  if (Math.abs(fromPairs - fromFills) > PNL_DRIFT_TOLERANCE_USD) {
    throw new TradovateUnpriceableError(
      `The fill pairs and the fills disagree about the P&L of the logical position keyed ` +
        `on fill ${cycle.keyFillId} by more than ${PNL_DRIFT_TOLERANCE_USD} USD. A pair was ` +
        'assigned to the wrong cycle; refusing to total a day over it.',
      'pnl_disagreement'
    );
  }

  return fromPairs;
}

export interface BrokerDayRequest {
  /**
   * One reader per host, each carrying THAT host's URL with the token.
   *
   * Partial because a caller may legitimately have only one — and because the
   * single-reader case is exactly today's behaviour, which is what makes this
   * change testable against itself.
   */
  readers: Partial<Record<TradovateEnvironment, TradovateReader>>;
  /**
   * The MINT environment, from the connection's `environment` column.
   *
   * Not "where the accounts are" — that is the bug this stage fixes. It is used
   * for exactly two things, both of them about which host to trust more: its
   * discovery failure is fatal while the other host's is not, and it wins a
   * cross-host account-id collision.
   */
  environment: TradovateEnvironment;
  /** The trader's local midnight, from startOfTodayIso(). See ./trading-day.ts. */
  dayStartMs: number;
  /** `tradovate_connections.tradovate_user_id`, for the ownership filter. */
  tradovateUserId: number | null;
  /**
   * The earliest close the returned `trades` have to reach back to, when that is
   * before `dayStartMs` (REF-107 Stage 1).
   *
   * Absent — which is every caller the rules have — means the day boundary, so
   * /api/tradovate/today behaves exactly as it did. It only ever WIDENS what
   * gets priced and returned, and it cannot touch `day`: the scalars are
   * measured from `dayStartMs` whatever this says, because a journal query must
   * not be able to restate a discipline figure.
   */
  windowStartMs?: number;
  /** Injected so the day pull is deterministic under test. */
  now?: number;
}

/**
 * Read today's closed round trips for one connected user, from both hosts.
 *
 * (a′) of the REF-90 fix design §1.3: DISCOVER ON BOTH HOSTS, CONTINUE ONLY
 * WHERE THERE IS SOMETHING TO CONTINUE WITH. The normal single-host trader pays
 * one extra `/account/list` — the cheapest call in the chain — and the dual-host
 * trader pays the doubled chain, which they pay because correctness requires it.
 *
 *
 * THE TWO FAILURE RULES, WHICH DECIDE WHETHER THIS IS A REGRESSION
 * ----------------------------------------------------------------
 *
 * 1. **Discovery fails on the host that is NOT the connection's mint host** →
 *    drop that host and carry on. Without this, an organization with no
 *    demo provisioning — a 401 or 403 on demo — would start failing every pull
 *    that works today. The mint host is known-good; the other host is additive.
 * 2. **Any failure on a host that DID return eligible accounts** → fail the
 *    whole pull → `broker_unavailable`. A swallowed failure under-counts the
 *    day, and an under-counted day makes every rule MORE PERMISSIVE — the one
 *    direction this integration must never fail in.
 *
 * The dedupe follows the same fail-safe direction. If the same `accountId` is
 * eligible on both hosts it is counted ONCE, preferring the mint host: if id
 * spaces are shared that is correct, and if they are host-local it drops a real
 * account. Double-counting a trade inflates today's loss and blocks a trader
 * over money they did not lose, which ./accounts.ts names as the worst failure
 * available here; an under-count falls back to Reflect's own data. Stage 3's
 * picker resolves the collision explicitly instead of preferring.
 *
 * A NON-USD PRODUCT NO LONGER THROWS (REF-112 §5.10). It skips the account
 * that traded it, imports every other account, and leaves a notice naming it
 * — see {@link scanHost} and {@link BrokerDay.notices}. What still throws
 * TradovateUnpriceableError is a trade that reaches {@link describeCycle} with
 * no unit, which is a backstop rather than a path: the pricing chain's
 * refusals are filtered out above it. Everything else it throws comes from a
 * reader — TradovateRequestError, TradovatePenaltyError, a network fault — and
 * the route maps those to `broker_unavailable`.
 */
export async function loadBrokerDay(request: BrokerDayRequest): Promise<BrokerDay> {
  const { readers, environment, dayStartMs, tradovateUserId, windowStartMs } = request;
  const now = request.now ?? Date.now();
  const asOf = new Date(now).toISOString();

  // The mint host first, and the order is load-bearing: it is the host that
  // wins a collision, so it has to claim its account ids before the other one
  // is looked at.
  const order = ([environment, otherHost(environment)] as const).filter((env) => readers[env]);

  const claimed = new Set<number>();
  const pooled: BrokerTrade[] = [];
  /** What no host could state. See {@link HeldGroup}. */
  const held: HeldGroup[] = [];
  /** What this pull could not do for the trader. See {@link BrokerDay.notices}. */
  const notices: PullNotice[] = [];
  /** One entry per host that ANSWERED discovery. See {@link HostAccounts}. */
  const accounts: HostAccounts[] = [];

  for (const env of order) {
    const reader = readers[env]!;

    let accepted: TradovateAccount[];
    try {
      const discovered = await discoverHostAccounts(reader, tradovateUserId);
      accepted = discovered.accepted;
      // PUSHED HERE AND NOWHERE ELSE: past the catch, so the list holds exactly
      // the hosts that returned something. A host dropped by rule 1 below is
      // absent, and the accounts sync reads that absence as "not asked" rather
      // than as "every account here is gone" (REF-110 §A.5).
      accounts.push({ host: env, claimed: discovered.claimed });

      // REF-112 §5.12. ONE NOTICE PER ACCOUNT THE TYPE FILTER DROPPED, raised
      // HERE and not in `scanHost`, because that function is never reached for
      // these: they are not in `accepted`, so a trader whose ONLY accounts are
      // `Omnibus` drops out at `fresh.length === 0` below and the six
      // remaining reads never happen. That early exit is the saving (a′) was
      // built for and it is also exactly how this failure stayed silent.
      //
      // NOT DEDUPLICATED ACROSS HOSTS HERE, for {@link HostAccounts}' reason:
      // an account identity is `(host, id)` and nothing documents the two id
      // spaces as shared. Two hosts reporting the same bare id produce two
      // notices, which ./sync.ts collapses to one line if and only if they
      // resolve to the same LABEL — the thing the trader actually reads.
      for (const account of discovered.unsupported) {
        notices.push({
          kind: 'account_type',
          host: env,
          accountId: account.id,
          name: account.name,
        });
      }
    } catch (error) {
      // Rule 1. The mint host answering with a failure is the failure this pull
      // has always had; the other host is new, additive, and must not be able
      // to take a working pull down with it.
      if (env === environment) throw error;
      continue;
    }

    // The dedupe, before the chain rather than after it: an account already
    // claimed must not contribute positions, pairs or dollars.
    const fresh = accepted.filter((account) => !claimed.has(account.id));
    for (const account of fresh) claimed.add(account.id);

    // Nothing eligible here — either the host holds none of this trader's
    // accounts, or every one it holds was the first host's. Either way there is
    // nothing to continue with, so the six remaining reads are not made. This
    // is (a′)'s whole saving.
    if (fresh.length === 0) continue;

    // Rule 2: no try/catch. This host returned eligible accounts, so a failure
    // from here on is a day that cannot be stated, and the pull fails whole.
    const scanned = await scanHost({
      reader,
      host: env,
      accounts: fresh,
      dayStartMs,
      windowStartMs,
    });
    pooled.push(...scanned.trades);
    held.push(...scanned.held);
    notices.push(...scanned.notices);
  }

  // ── Nothing to have traded with, which is now an error (REF-112 §5.12) ───
  //
  // THIS REVERSES THE CLOSING NOTE OF ./accounts.ts, deliberately and with its
  // argument in hand. That note says "a connection whose scope holds nothing
  // tradeable has honestly reported zero trades today, and calling that a
  // broker outage would put an orange warning in front of a user whose data is
  // fine." Every word of that is right about an ALLOWLIST, where the handful
  // of connected traders had accounts somebody had looked at. At open rollout
  // the probabilities invert: a trader who went through an OAuth consent
  // screen to connect a broker almost certainly has an account, so zero of
  // them surviving the filter is far more likely to mean the filter rejected
  // something real than that there was nothing there.
  //
  // IT IS STILL NOT AN OUTAGE, and this is not one. `source` stays
  // `broker_verified` — the broker answered, and what it said is that we
  // cannot use any of it. The day is an honest zero with a sentence attached,
  // not an error page.
  //
  // THE GUARD IS `accounts.length > 0`: at least one host ANSWERED discovery.
  // A pull where no host answered never reaches here (the mint host rethrows),
  // and a pull with no readers at all has nothing to say about a scope it
  // never saw.
  if (accounts.length > 0 && claimed.size === 0) {
    notices.push({ kind: 'no_accounts' });
  }

  // ── Pooled, and from here on there is one trader and one day ──────────────
  //
  // Sorted by close across every host, which is what the streak requires: three
  // hosts' worth of losses interleaved by close time, not two separate streaks.
  // The key breaks a tie so that the list a journal receives is in the same order
  // every time, which `/fillPair/list` gives no grounds for on its own.
  const trades = pooled.sort(
    (a, b) => b.closedAtMs - a.closedAtMs || a.brokerTradeKey.localeCompare(b.brokerTradeKey)
  );
  const todays = trades.filter((t) => closedToday(t.closedAtMs, dayStartMs));

  // THE SCALARS ARE THIS REDUCTION AND NOTHING ELSE — REF-107 Stage 1's one
  // structural requirement. `trades` is returned beside `day` below, so any
  // second count of the same pairs would be a number a trader could see
  // disagreeing with the rows beneath it.
  let net = 0;
  let lost = 0;
  let losingCount = 0;
  for (const trade of todays) {
    net += trade.pnlUsd;
    if (trade.pnlUsd < 0) {
      lost += Math.abs(trade.pnlUsd);
      losingCount++;
    }
  }

  // Newest first, stopping at the first non-loss — the same definition as
  // measureLossStreak() in lib/rules/tradeRuleContext.ts, deliberately down to
  // the `>= 0` boundary: a trade that netted exactly nothing ends a streak,
  // because a streak of losses is what a trader means by the word. A scaled-out
  // position is one entry here, netted across its legs, so a loser exited in
  // three pieces is one loss and not three.
  //
  // STREAK_WINDOW applies to the POOLED list, because the streak is about the
  // trader and not about a host.
  let lossStreak = 0;
  let minutesSinceLastClose: number | null = null;
  for (const trade of trades.slice(0, STREAK_WINDOW)) {
    if (trade.pnlUsd >= 0) break;
    if (minutesSinceLastClose === null) {
      minutesSinceLastClose = minutesSince(trade.closedAtMs, now);
    }
    lossStreak++;
  }

  return {
    day: {
      closedCount: todays.length,
      losingCount,
      net,
      lost,
      lossStreak,
      minutesSinceLastClose,
      asOf,
    },
    trades,
    held,
    notices,
    accounts,
  };
}

/**
 * THE TWO PAIR HELPERS THAT LIVED HERE ARE GONE (REF-117 Stage 2).
 *
 * `datePair` dated a pair through its two fills and derived the direction from
 * which leg executed first. Every one of its outputs now comes off the cycle,
 * computed once per logical position instead of once per pair — and its
 * `missing_fill` refusal is replaced by something strictly stronger: a pair
 * whose legs are not in `/fill/list` leaves the netPos walk unable to account
 * for the broker's own figure, so ./cycles.ts holds the group and names it,
 * rather than this module failing the whole pull on every contract at once.
 *
 * `pricePair` is inlined into {@link priceCycle}, which is where the pair
 * arithmetic now sits beside the walk it is checked against.
 */

/**
 * What each contract is worth per point, and the currency that value is in.
 *
 * The currency is CHECKED, not assumed. No endpoint states that an account's
 * P&L is in US dollars: `Account` has no currency field, the cash-balance
 * snapshot returns fields with USD in their NAMES but no `currencyId` for
 * `realizedPnL`, and the only place a currency id appears at all is
 * `CashBalance` and `Product`. REF-99 made every amount in this product
 * dollars, so a product denominated in anything else is not a conversion
 * problem — it is a figure that cannot go into the total at all.
 *
 * /currency/list is fetched once and only when there is something to price.
 *
 * THE ROUTE TO A PRODUCT IS THE DOCUMENTED ONE, AND IT IS THE ONLY ONE TAKEN.
 * `Contract` carries `contractMaturityId` (required), `ContractMaturity`
 * carries `productId` (required), and `/product/item` carries `valuePerPoint`
 * (required). The first version of this function read `Contract.productId`
 * instead — a field that appears in no published schema, that some hosts do
 * return, and that one production host omitted on 15 Oct 2026, turning a
 * perfectly priceable trade into a refused day (REF-90 §4).
 *
 * That contract copy is now not read AT ALL, even where a host offers it. As a
 * call-saver it is tempting and it is the wrong trade: it would make the
 * documented path the rarely-exercised one, so the branch running for most
 * contracts would be the undocumented shortcut and the branch that matters
 * would be cold. One path, always taken, and {@link unitByContractName} buys
 * the calls back many times over.
 *
 * There is also NO NAME PARSING anywhere here — no symbol root stripped off
 * `MNQZ6`, no `/product/find`, no `/product/list` filtered locally. Spreads,
 * options and continuous contracts all carry names that such a rule reads
 * wrongly, and every one of its failures is either a silent wrong product or a
 * 404 on a well-formed-looking request, which is exactly how hard this bug was
 * to read the first time (REF-90 §2).
 *
 * Every lookup fails LOUDLY and on ONE host. A contract that names no usable
 * maturity, a maturity that names no usable product, and an entity the fill's
 * own host does not have are all TradovateUnpriceableError here — never a retry
 * against the other host, whose id space nothing documents as shared (REF-90).
 */
async function loadContractUnits(
  reader: TradovateReader,
  contractIds: ReadonlySet<number>
): Promise<ContractUnits> {
  const units = new Map<number, ContractUnit>();
  const refused = new Map<number, UnitRefusal>();
  if (contractIds.size === 0) return { units, refused };

  const currencies = await reader.get<TradovateCurrency[]>('/currency/list');
  const currencyNames = new Map<number, string>();
  for (const currency of currencies ?? []) currencyNames.set(currency.id, currency.name);

  // Contracts in parallel, the three calls within one contract in sequence —
  // each id comes out of the call before it. A trader holds one or two
  // contracts, so this is the difference between three round trips and nine
  // while someone waits for a form to open.
  await Promise.all([...contractIds].map(async (contractId) => {
    const contract = await reader.get<TradovateContract>('/contract/item', { id: contractId });

    // The cache goes here, between the first read and the two it saves, because
    // its key is what the first read returns. A body with no usable name is not
    // a miss to be filled in later: it is a contract there is nothing to key
    // on, so it takes the long road every pull and is never remembered.
    const name = typeof contract?.name === 'string' && contract.name.length > 0 ? contract.name : null;
    const remembered = name === null ? undefined : unitByContractName.get(name);
    if (remembered) {
      units.set(contractId, remembered);
      return;
    }

    // Validated BETWEEN the calls rather than threaded into the next one's
    // query. buildUrl() drops an `undefined` query value by design, so an
    // absent id does not fail — it sends `GET /contractMaturity/item` with NO
    // query string and earns an upstream 404 that names nothing, which is the
    // undiagnosable shape REF-90 spent two days reading. An id Tradovate would
    // not have honoured is not worth a round trip.
    //
    // A null contract body lands here too, and that is the honest answer for
    // it: a body with no `contractMaturityId` cannot reach a product, whether
    // the field is missing or the whole response is.
    const maturityId = contract?.contractMaturityId;
    if (!usableId(maturityId)) {
      throw new TradovateUnpriceableError(
        `Contract ${contractId} states no usable contractMaturityId, so its product ` +
          'cannot be reached and its trades would have no value per point.',
        'no_value_per_point'
      );
    }

    // Same 404-only catch as the product read below, and for the same reason:
    // this is the hop that has never run in production, so if a documented
    // required id does not resolve, the one thing that must not happen is a
    // bare 404 naming neither end of it.
    let maturity: TradovateContractMaturity;
    try {
      maturity = await reader.get<TradovateContractMaturity>('/contractMaturity/item', {
        id: maturityId,
      });
    } catch (error) {
      if (error instanceof TradovateRequestError && error.status === 404) {
        throw new TradovateUnpriceableError(
          `Contract maturity ${maturityId} (contract ${contractId}) was not found on the ` +
            "host that reported the fill, so the contract's product cannot be reached.",
          'no_value_per_point'
        );
      }
      throw error;
    }

    // Required on a documented entity, reached by a required field of the
    // contract. This is the guarantee the old chain did not have.
    const productId = maturity?.productId;
    if (!usableId(productId)) {
      throw new TradovateUnpriceableError(
        `Contract maturity ${maturityId} (contract ${contractId}) states no usable ` +
          'productId, so its product cannot be looked up and its trades would have no ' +
          'value per point.',
        'no_value_per_point'
      );
    }

    // A 404 ALONE, and no cross-host retry. If the product genuinely is not on
    // the host that reported the fill, that is a trade this pull cannot price,
    // and asking the other host would price it with whatever product carries
    // that id there — the silent unit bug loadHostTrades' header exists to
    // prevent. A 401, 429 or 5xx stays a TradovateRequestError so the penalty
    // and transient handling above this layer keeps working.
    let product: TradovateProduct;
    try {
      product = await reader.get<TradovateProduct>('/product/item', { id: productId });
    } catch (error) {
      if (error instanceof TradovateRequestError && error.status === 404) {
        throw new TradovateUnpriceableError(
          `Product ${productId} (contract ${contractId}) was not found on the host that ` +
            'reported the fill, so the trade cannot be priced.',
          'no_value_per_point'
        );
      }
      throw error;
    }

    // The same boundary as the two ids above, which is why it is the same
    // function: a value per point of 0 would silently make every trade on this
    // contract worth nothing.
    const valuePerPoint = product?.valuePerPoint;
    if (!usableId(valuePerPoint)) {
      throw new TradovateUnpriceableError(
        `Product ${productId} (contract ${contractId}) states no usable ` +
          'valuePerPoint, so its trades would be counted in points against a dollar threshold.',
        'no_value_per_point'
      );
    }

    const currencyName = currencyNames.get(product.currencyId);
    if (!currencyName) {
      throw new TradovateUnpriceableError(
        `Currency ${product.currencyId} on product ${product.id} is not in /currency/list, ` +
          'so the unit of its P&L is unknown.',
        'unknown_currency'
      );
    }
    // REF-112 §5.10. NOT A THROW ANY MORE, AND THAT IS THE WHOLE OF ITEM 1.
    //
    // It was one, and the reasoning was sound as far as it went: a figure in
    // euros added to a dollar total is the unit bug this module exists to
    // prevent, and `foreign_currency` is explicitly non-transient — a non-USD
    // account stays non-USD. What that reasoning missed is what the refusal
    // COSTS. Mapped through ./errors.ts to `broker_unavailable`, it failed the
    // ENTIRE day pull, for every account and every contract, every day,
    // forever: a trader who touches one EUREX product gets a journal that
    // silently falls back to Reflect-only data and a rule engine with no
    // broker figures at all. REF-112 §5.10 calls it the most likely real-world
    // live breakage after the host issues.
    //
    // So the refusal is now PER CONTRACT and {@link scanHost} turns it into a
    // per-ACCOUNT skip: that account's trades are left out, every other
    // account imports normally, and the trader is told which account and why.
    // The unit bug is still impossible — nothing non-USD reaches `units`, so
    // nothing non-USD can be priced — and what changed is the blast radius.
    if (currencyName.toUpperCase() !== 'USD') {
      refused.set(contractId, { reason: 'foreign_currency', name });
      return;
    }

    // Remembered only HERE, past every refusal above. A contract that could not
    // be priced, or an entity a host answered with a 404, must be re-asked next
    // pull: a delisting that gets resolved or a host hiccup would otherwise be
    // remembered for the life of the process.
    const unit: ContractUnit = { valuePerPoint, currencyName, name };
    if (name !== null) rememberUnit(name, unit);
    units.set(contractId, unit);
  }));

  return { units, refused };
}
