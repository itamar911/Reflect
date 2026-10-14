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
 * count, two more calls plus one shared lookup turn points into dollars:
 *
 *   /contract/item   → productId
 *   /product/item    → valuePerPoint, currencyId
 *   /currency/list   → currencyId → 'USD'                     (once per pull)
 *
 * Seven to nine requests for a trader holding one or two contracts, against a
 * documented 5,000 per hour per user. The cost that matters is latency, not
 * quota, which is why the client caches the result briefly rather than pulling
 * once per enforcement path (lib/rules/brokerDayContext.ts).
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
 */

import { TradovateUnpriceableError } from './errors';
import { closedToday, minutesSince } from './trading-day';
import { partitionAccounts, permissionsCouldHelp, permittedAccountIds } from './accounts';
import type { TradovateEnvironment } from './hosts';
import type {
  TradovateAccount,
  TradovateContract,
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
 * Deliberately not a list of trades. Nothing downstream needs per-trade rows —
 * the streak is already reduced here — and a route that returned fills would be
 * sending a trader's positions to the browser for no purpose. Same discipline
 * as the connection summary: return the answer, not the data.
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
 * One finished trade, reduced to the two facts the day needs (REF-90 Stage 1).
 *
 * THIS IS THE ONLY SHAPE THAT CROSSES A HOST BOUNDARY, and that is a
 * correctness requirement rather than tidiness. Every other value in this
 * module is keyed by an integer id — `fill.id`, `contractId`, `accountId` — and
 * nothing documents whether live and demo share those id spaces. Pool the
 * id-bearing values and two unrelated fills that happen to share an id get
 * welded into one trade by {@link groupIntoTrades}, or one host's
 * `valuePerPoint` prices the other host's contract. Dollars and an instant
 * carry no id, so pooling them is safe under either assumption.
 */
export interface PricedTrade {
  /** The moment the trader was finally out. See {@link Trade}. */
  closedAtMs: number;
  /** Net dollars across the trade's legs. Signed. */
  pnl: number;
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

/** A fill pair joined to its instant and its contract, before pricing. */
interface DatedPair {
  pair: TradovateFillPair;
  closedAtMs: number;
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

/** What one contract is worth per point, and in what currency. */
interface ContractUnit {
  valuePerPoint: number;
  currencyName: string;
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
 * - **{@link loadContractUnits}** keys its map on `contractId` alone. Pooled,
 *   one host's `valuePerPoint` can price the other host's contract: a silent
 *   unit bug, which is the exact failure class this module's header exists to
 *   prevent.
 *
 * So both run per host, and what leaves is {@link PricedTrade} — dollars and an
 * instant, no ids.
 *
 * Returns the trades the day could possibly need: today's closes plus this
 * host's own streak window. The pooled top ten is a subset of the union of the
 * per-host top tens, so nothing the streak reaches is left behind here.
 */
export async function loadHostTrades(params: {
  reader: TradovateReader;
  /** This host's eligible accounts, from {@link discoverHostAccounts}. */
  accounts: readonly TradovateAccount[];
  dayStartMs: number;
}): Promise<PricedTrade[]> {
  const { reader, accounts, dayStartMs } = params;

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
  const positions = await reader.get<TradovatePosition[]>('/position/list');
  const myPositionIds = new Set(
    (positions ?? []).filter((p) => accountIds.has(p.accountId)).map((p) => p.id)
  );
  if (myPositionIds.size === 0) return [];

  const allPairs = await reader.get<TradovateFillPair[]>('/fillPair/list');
  const myPairs = (allPairs ?? []).filter((pair) => myPositionIds.has(pair.positionId));
  if (myPairs.length === 0) return [];

  const fills = await reader.get<TradovateFill[]>('/fill/list');
  const fillById = new Map<number, TradovateFill>();
  for (const fill of fills ?? []) fillById.set(fill.id, fill);

  const trades = groupIntoTrades(myPairs.map((pair) => datePair(pair, fillById))).sort(
    (a, b) => b.closedAtMs - a.closedAtMs
  );

  // Price only what is actually read: today's closes, plus the streak window,
  // which reaches back past today. A trader with years of history has those
  // lists in hand by now and pricing all of it would be hundreds of contract
  // lookups for figures nothing reads.
  const todays = trades.filter((t) => closedToday(t.closedAtMs, dayStartMs));
  const streakWindow = trades.slice(0, STREAK_WINDOW);
  const needed = new Set([...todays, ...streakWindow]);

  const units = await loadContractUnits(
    reader,
    new Set([...needed].flatMap((t) => t.legs.map((leg) => leg.contractId)))
  );

  const priced: PricedTrade[] = [];
  for (const trade of needed) {
    priced.push({
      closedAtMs: trade.closedAtMs,
      pnl: trade.legs.reduce((total, leg) => total + pricePair(leg, units), 0),
    });
  }

  return priced;
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
export async function loadBrokerDay(request: BrokerDayRequest): Promise<BrokerDayContext> {
  const { readers, environment, dayStartMs, tradovateUserId } = request;
  const now = request.now ?? Date.now();
  const asOf = new Date(now).toISOString();

  // The mint host first, and the order is load-bearing: it is the host that
  // wins a collision, so it has to claim its account ids before the other one
  // is looked at.
  const order = ([environment, otherHost(environment)] as const).filter((env) => readers[env]);

  const claimed = new Set<number>();
  const pooled: PricedTrade[] = [];

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
    pooled.push(...(await loadHostTrades({ reader, accounts: fresh, dayStartMs })));
  }

  // ── Pooled, and from here on there is one trader and one day ──────────────
  //
  // Sorted by close across every host, which is what the streak requires: three
  // hosts' worth of losses interleaved by close time, not two separate streaks.
  const trades = pooled.sort((a, b) => b.closedAtMs - a.closedAtMs);
  const todays = trades.filter((t) => closedToday(t.closedAtMs, dayStartMs));

  let net = 0;
  let lost = 0;
  let losingCount = 0;
  for (const trade of todays) {
    net += trade.pnl;
    if (trade.pnl < 0) {
      lost += Math.abs(trade.pnl);
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
    if (trade.pnl >= 0) break;
    if (minutesSinceLastClose === null) {
      minutesSinceLastClose = minutesSince(trade.closedAtMs, now);
    }
    lossStreak++;
  }

  return {
    closedCount: todays.length,
    losingCount,
    net,
    lost,
    lossStreak,
    minutesSinceLastClose,
    asOf,
  };
}

/**
 * Join a pair to the instant it closed and the contract it traded.
 *
 * The closing leg is whichever executed LATER — the sell closes a long, the buy
 * closes a short — so this reads the two timestamps rather than the direction.
 * Same reasoning as the P&L expression: there is no direction field to get
 * backwards if nothing consults direction.
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
    closedAtMs: Math.max(buyAt, sellAt),
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

  // Contracts in parallel, the two calls within one contract in sequence —
  // `productId` comes out of the first. A trader holds one or two contracts, so
  // this is the difference between two round trips and six while someone waits
  // for a form to open.
  await Promise.all([...contractIds].map(async (contractId) => {
    const contract = await reader.get<TradovateContract>('/contract/item', { id: contractId });
    const product = await reader.get<TradovateProduct>('/product/item', { id: contract?.productId });

    const valuePerPoint = product?.valuePerPoint;
    if (typeof valuePerPoint !== 'number' || !Number.isFinite(valuePerPoint) || valuePerPoint <= 0) {
      throw new TradovateUnpriceableError(
        `Product ${contract?.productId} (contract ${contractId}) states no usable ` +
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

    units.set(contractId, { valuePerPoint, currencyName });
  }));

  return units;
}
