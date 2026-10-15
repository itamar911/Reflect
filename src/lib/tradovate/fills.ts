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

import { TradovateRequestError, TradovateUnpriceableError } from './errors';
import { closedToday, minutesSince } from './trading-day';
import { partitionAccounts, permissionsCouldHelp, permittedAccountIds } from './accounts';
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
   * Whether every position this group's legs belong to is FLAT — `netPos = 0`
   * on all of them (REF-107 Stage 2).
   *
   * THIS IS THE FIELD THAT MAKES {@link brokerTradeKey} SAFE TO PERSIST, and it
   * exists because of that field's own caveat. The key is the group's lowest
   * fill id, and a group can still GROW: while the trader is holding contracts
   * in a position, a later fill pair can bridge two groups that were separate,
   * and the merged group's lowest fill id may be the other group's. Write a key
   * mid-position and the next sync writes a SECOND row for the same trade under
   * a different key — a duplicate the partial UNIQUE cannot catch, because both
   * keys are genuinely distinct.
   *
   * So a trade is persisted only when this is true. §A3 named the hazard and
   * Stage 1 pinned it by test; this is the measurement that acts on it, and the
   * only new read it needs is a field /position/list already returns.
   *
   * FALSE WHEN UNKNOWN, not true. A `netPos` that is absent or not a finite
   * number means we cannot say the position is flat, and the two failure
   * directions are not symmetric: not importing is a trade missing from the
   * journal until the next pull, while importing early is a duplicate row in it
   * that nothing removes. The quiet absence is recoverable; the duplicate is
   * not.
   */
  positionFlat: boolean;
}

/**
 * One pull's two answers (REF-107 Stage 1).
 *
 * `day` is byte-for-byte what {@link loadBrokerDay} returned before this stage,
 * and `trades` is the list it reduced to produce it — not a second pass over the
 * same pairs. See the module header on why that matters more than the shape.
 */
export interface BrokerDay {
  day: BrokerDayContext;
  trades: BrokerTrade[];
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

/** A fill pair joined to its two instants and its contract, before pricing. */
interface DatedPair {
  pair: TradovateFillPair;
  /** The earlier leg: when this slice was entered. */
  openedAtMs: number;
  /** The later leg: when it was closed. */
  closedAtMs: number;
  /** Which side was the earlier leg. See {@link BrokerTrade.direction}. */
  direction: 'long' | 'short';
  contractId: number;
}

/**
 * ONE TRADE: every fill pair that shares a fill with another, joined up.
 *
 * A `FillPair` is not a trade, and the gap between the two is the sharpest
 * thing the investigation found about counting (§3.3א). An entry of three
 * contracts closed in three instalments produces THREE pairs for one decision;
 * so does one exit that closes three separate entries. Counted as pairs, a
 * trader who scaled out of a single loser would be told they had three
 * consecutive losses — and `cooldown_after_losses` defaults to three, so the
 * app would lock them out of their next trade over one.
 *
 * The join is the fills themselves. Two pairs that share a fill id are two
 * slices of the same decision, and sharing is transitive: pair A shares its buy
 * with B, B shares its sell with C, all three are one trade. That makes this a
 * union-find over fill ids, which is six lines and exactly right, rather than a
 * time-window heuristic, which would be neither.
 *
 * `closedAtMs` is the LATEST close in the group — the moment the trader was
 * finally out — so a trade that finished this morning counts today even if it
 * was entered yesterday. The same rule Reflect uses for a plan: the loss is
 * realised on the close.
 */
interface Trade {
  legs: DatedPair[];
  closedAtMs: number;
}

/**
 * The group's legs in the one order every derived field is read from.
 *
 * Earliest open first, `pair.id` breaking a tie. Order matters because the
 * group's direction, its entry instant and its account all come from the leg
 * that OPENED FIRST, and `/fillPair/list` promises no order at all — so without
 * a sort of our own, two pulls of the same unchanged day could disagree about
 * which leg that was. Determinism here is what makes {@link BrokerTrade}
 * comparable across pulls, which is the property Stage 2's de-duplication rests
 * on.
 */
function legsInOpeningOrder(trade: Trade): DatedPair[] {
  return [...trade.legs].sort(
    (a, b) => a.openedAtMs - b.openedAtMs || a.pair.id - b.pair.id
  );
}

/** Union-find over fill ids. See {@link Trade} for why. */
function groupIntoTrades(pairs: readonly DatedPair[]): Trade[] {
  const parent = new Map<number, number>();

  const find = (id: number): number => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };

  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const entry of pairs) union(entry.pair.buyFillId, entry.pair.sellFillId);

  const groups = new Map<number, DatedPair[]>();
  for (const entry of pairs) {
    const key = find(entry.pair.buyFillId);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  return [...groups.values()].map((legs) => ({
    legs,
    closedAtMs: Math.max(...legs.map((leg) => leg.closedAtMs)),
  }));
}

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
 */
async function discoverHostAccounts(
  reader: TradovateReader,
  tradovateUserId: number | null
): Promise<TradovateAccount[]> {
  const accounts = (await reader.get<TradovateAccount[]>('/account/list')) ?? [];

  // Owned OR permitted (REF-90 Stage 2). The permission list is read only when
  // some account on this host failed on ownership ALONE — see
  // permissionsCouldHelp() — which is what keeps the normal trader at the one
  // extra /account/list that Stage 1 costs them and no more.
  const permitted = permissionsCouldHelp(accounts, tradovateUserId)
    ? await readPermittedAccounts(reader, tradovateUserId)
    : null;

  return partitionAccounts(accounts, tradovateUserId, permitted).accepted;
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
  const { reader, host, accounts, dayStartMs } = params;

  // Never later than the day boundary: the day's scalars are not negotiable by a
  // query parameter, so a window can only widen what gets priced.
  const windowStartMs = Math.min(dayStartMs, params.windowStartMs ?? dayStartMs);

  // No account of this trader's own that could have been traded. An honest
  // zero, not a failure: see the closing note in ./accounts.ts. The caller does
  // not even get here — it drops such a host before asking — but the guard
  // stays, because this function's contract should not depend on that.
  if (accounts.length === 0) return [];

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
  const positions = await reader.get<TradovatePosition[]>('/position/list');
  const accountByPositionId = new Map<number, number>();
  // The second answer this same read already carried: whether the trader is
  // still holding anything in that position. Read here rather than asked for,
  // and it is what decides whether a trade's key may be persisted — see
  // BrokerTrade.positionFlat. Only a flat position is recorded as flat; an
  // absent or unreadable netPos leaves the id out of this set, which reads as
  // "not known to be flat".
  const flatPositionIds = new Set<number>();
  for (const position of positions ?? []) {
    if (!accountIds.has(position.accountId)) continue;
    accountByPositionId.set(position.id, position.accountId);
    if (typeof position.netPos === 'number' && Number.isFinite(position.netPos) && position.netPos === 0) {
      flatPositionIds.add(position.id);
    }
  }
  if (accountByPositionId.size === 0) return [];

  const allPairs = await reader.get<TradovateFillPair[]>('/fillPair/list');
  const myPairs = (allPairs ?? []).filter((pair) => accountByPositionId.has(pair.positionId));
  if (myPairs.length === 0) return [];

  const fills = await reader.get<TradovateFill[]>('/fill/list');
  const fillById = new Map<number, TradovateFill>();
  for (const fill of fills ?? []) fillById.set(fill.id, fill);

  const trades = groupIntoTrades(myPairs.map((pair) => datePair(pair, fillById))).sort(
    (a, b) => b.closedAtMs - a.closedAtMs
  );

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

  const units = await loadContractUnits(
    reader,
    new Set([...needed].flatMap((t) => t.legs.map((leg) => leg.contractId)))
  );

  return [...needed].map((trade) =>
    describeTrade(trade, host, units, accountByPositionId, flatPositionIds)
  );
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
function describeTrade(
  trade: Trade,
  host: TradovateEnvironment,
  units: Map<number, ContractUnit>,
  accountByPositionId: Map<number, number>,
  flatPositionIds: ReadonlySet<number>
): BrokerTrade {
  const legs = legsInOpeningOrder(trade);
  const opener = legs[0];

  const qty = legs.reduce((total, leg) => total + leg.pair.qty, 0);
  const weighted = (price: (leg: DatedPair) => number) =>
    legs.reduce((total, leg) => total + price(leg) * leg.pair.qty, 0) / qty;
  const avgBuy = weighted((leg) => leg.pair.buyPrice);
  const avgSell = weighted((leg) => leg.pair.sellPrice);

  // Deduplicated: a scale-out shares its entry fill between legs, so the raw
  // concatenation names it once per leg. Ascending, because the lowest is the
  // key and a reader should be able to see that at a glance.
  const fillIds = [
    ...new Set(legs.flatMap((leg) => [leg.pair.buyFillId, leg.pair.sellFillId])),
  ].sort((a, b) => a - b);

  return {
    brokerTradeKey: `${host}:${fillIds[0]}`,
    host,
    // The opening leg's account and contract stand for the group's. Both are
    // properties of the position and of the fill, and a fill cannot be in two
    // contracts, so a group connected by shared fills cannot straddle either.
    //
    // The assertion is sound by construction and not by optimism: every pair
    // here survived a filter on `accountByPositionId.has(pair.positionId)`. A
    // `?? 0` instead would put a plausible-looking account id on a row rather
    // than failing, which is the silent-wrongness direction this module refuses
    // everywhere else.
    accountId: accountByPositionId.get(opener.pair.positionId)!,
    symbol: units.get(opener.contractId)?.name ?? null,
    direction: opener.direction,
    qty,
    entryPrice: opener.direction === 'long' ? avgBuy : avgSell,
    exitPrice: opener.direction === 'long' ? avgSell : avgBuy,
    openedAtMs: opener.openedAtMs,
    closedAtMs: trade.closedAtMs,
    pnlUsd: legs.reduce((total, leg) => total + pricePair(leg, units), 0),
    fillIds,
    // EVERY leg, not the opener's. A group is connected by shared fills and
    // cannot straddle two contracts, but it CAN straddle two positions —
    // /position/list keys a position per contract per trading day, so a trade
    // entered yesterday and closed today has legs in two of them. One of those
    // still carrying contracts is exactly the state that can still grow this
    // group, so `every` is the question and not `opener`.
    positionFlat: legs.every((leg) => flatPositionIds.has(leg.pair.positionId)),
  };
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
 * Throws TradovateUnpriceableError when a trade that would be counted cannot be
 * expressed in dollars. Everything else it throws comes from a reader —
 * TradovateRequestError, TradovatePenaltyError, a network fault — and the route
 * maps those to `broker_unavailable`.
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

  for (const env of order) {
    const reader = readers[env]!;

    let accepted: TradovateAccount[];
    try {
      accepted = await discoverHostAccounts(reader, tradovateUserId);
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
    pooled.push(
      ...(await loadHostTrades({ reader, host: env, accounts: fresh, dayStartMs, windowStartMs }))
    );
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
  };
}

/**
 * Join a pair to the instants it opened and closed, the side that opened it, and
 * the contract it traded.
 *
 * The closing leg is whichever executed LATER — the sell closes a long, the buy
 * closes a short — so this reads the two timestamps rather than the direction.
 * Same reasoning as the P&L expression: there is no direction field to get
 * backwards if nothing consults direction.
 *
 * AND THEREFORE THE OPENING LEG IS THE OTHER ONE, which is REF-107 §A1's second
 * gap closed for free: this function computed both instants and returned only
 * the later one. A pair whose BUY opened is a long and whose SELL opened is a
 * short — that is the definition, in this direction only. Equal timestamps read
 * as a long: it is the convention the field names already imply, and a round
 * trip whose legs executed in the same millisecond has no earlier leg to find.
 *
 * A pair whose legs are not in /fill/list is refused rather than dropped. Both
 * lists cover the same visible scope, so a missing leg is a truncated response,
 * and a pair that cannot be dated cannot be excluded from today either — the
 * honest answer is that this pull failed.
 */
function datePair(pair: TradovateFillPair, fillById: Map<number, TradovateFill>): DatedPair {
  const buy = fillById.get(pair.buyFillId);
  const sell = fillById.get(pair.sellFillId);

  if (!buy || !sell) {
    throw new TradovateUnpriceableError(
      `Fill pair ${pair.id} references a fill that /fill/list did not return, so it ` +
        'cannot be dated. Refusing to total a day with a trade missing from it.',
      'missing_fill'
    );
  }

  const buyAt = Date.parse(buy.timestamp);
  const sellAt = Date.parse(sell.timestamp);

  if (!Number.isFinite(buyAt) || !Number.isFinite(sellAt)) {
    throw new TradovateUnpriceableError(
      `Fill pair ${pair.id} has a leg with an unreadable timestamp, so it cannot be dated.`,
      'missing_fill'
    );
  }

  return {
    pair,
    openedAtMs: Math.min(buyAt, sellAt),
    closedAtMs: Math.max(buyAt, sellAt),
    direction: buyAt <= sellAt ? 'long' : 'short',
    // Both legs are the same contract by construction; the buy leg is read so
    // there is one answer rather than a choice.
    contractId: buy.contractId,
  };
}

/** Points into dollars. See the header for why there is no direction branch. */
function pricePair(entry: DatedPair, units: Map<number, ContractUnit>): number {
  const unit = units.get(entry.contractId);
  if (!unit) {
    throw new TradovateUnpriceableError(
      `No value per point for contract ${entry.contractId}.`,
      'no_value_per_point'
    );
  }
  return (entry.pair.sellPrice - entry.pair.buyPrice) * entry.pair.qty * unit.valuePerPoint;
}

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
): Promise<Map<number, ContractUnit>> {
  const units = new Map<number, ContractUnit>();
  if (contractIds.size === 0) return units;

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
    if (currencyName.toUpperCase() !== 'USD') {
      throw new TradovateUnpriceableError(
        `Product ${product.id} is denominated in ${currencyName}, and every trading amount ` +
          'in Reflect is US dollars (REF-99). Refusing to add it to a dollar total.',
        'foreign_currency'
      );
    }

    // Remembered only HERE, past every refusal above. A contract that could not
    // be priced, or an entity a host answered with a 404, must be re-asked next
    // pull: a delisting that gets resolved or a host hiccup would otherwise be
    // remembered for the life of the process.
    const unit: ContractUnit = { valuePerPoint, currencyName, name };
    if (name !== null) rememberUnit(name, unit);
    units.set(contractId, unit);
  }));

  return units;
}
