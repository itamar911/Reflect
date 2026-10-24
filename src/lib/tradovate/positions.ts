/**
 * What the trader is holding right now (REF-108 Stage 1).
 *
 * SERVER ONLY. Driven from GET /api/tradovate/live and nothing else.
 *
 *
 * THERE IS STILL NO PRICE IN THIS FILE — THE FIGURE IS THE BROKER'S
 * -----------------------------------------------------------------
 *
 * REF-108 asked for an unrealised P&L in dollars and we cannot COMPUTE one: a
 * mark price needs the Market Data feed, **Market Data is Denied in our OAuth
 * registration**, and the feed itself needs CME sub-vendor registration
 * Reflect does not have (./types.ts:66, ./api-hosts.ts:181). That is an
 * entitlement and not an endpoint we have not found, so no REST path and no
 * WebSocket changes it. Nothing below multiplies anything by anything.
 *
 * The investigation weighed the three fallbacks and rejected two. The one that
 * looks reasonable — price the position against the trader's own last fill —
 * is the dangerous one: on a position nobody has scaled into since opening,
 * the last fill IS the entry, so it computes a P&L of exactly zero and dresses
 * it as a measurement. Where it is not zero it is worse, because it is an hour
 * old and moves only when the trader trades. **A number that refreshes every
 * fifteen seconds from an event that happened an hour ago looks live and is
 * not**, on a screen whose entire purpose is to say what is happening now.
 *
 * WHAT STAGE 4A ADDS IS NOT THAT. `/cashBalance/getcashbalancesnapshot` returns
 * an `openPnL` the BROKER computes, measured 19.10 with Market Data still
 * denied, and {@link readOpenPnl} reads that one field and no other. So this
 * module still carries no price, no average entry and no arithmetic of ours —
 * it carries one number somebody else computed, per account.
 *
 * **ACCOUNT-LEVEL, NOT PER POSITION, AND THERE IS NO WAY TO ASK OTHERWISE.**
 * The request body takes `accountId` and nothing else. That is why `openPnl`
 * sits on {@link HostAccountPositions} and not on {@link LivePosition}: an
 * account holding ES and NQ has ONE figure covering both, and a copy of it on
 * each position would be read as two.
 *
 *
 * WHAT IT COSTS, AND WHY THAT IS THE CONSTRAINT
 * ---------------------------------------------
 *
 * Per poll: `/account/list` + `/position/list` PER HOST — four requests — plus
 * one `/contract/item` per open contract, warm-cached by host-qualified id,
 * plus **one snapshot per account that is actually holding something**. The
 * pricing chain is still NOT walked: `loadContractUnits` would add
 * `/contractMaturity/item` and `/product/item` to reach a `valuePerPoint` that
 * nothing here multiplies by.
 *
 * **THE SNAPSHOT IS ASKED ONLY AFTER WE KNOW WHO IS HOLDING, AND THAT ORDER IS
 * THE RATE LIMIT.** A flat account is never asked, so a flat poll costs exactly
 * what it cost before Stage 4a — zero extra requests, which is most of the day
 * for most traders. One account in a position is four requests becoming five.
 * Issuing the snapshot concurrently with `/position/list` to save a round trip
 * would ask for every account the trader has, which is the one shape that turns
 * a prop trader with forty accounts into forty requests every poll.
 *
 * Four requests sounds free and is not, because this runs on a timer. The
 * vendor FAQ is explicit that there is no hard cap and that limits vary by
 * hour, minute AND second, and the penalty for crossing one escalates to
 * `p-captcha`, which **a third-party application cannot clear** — the trader
 * waits about an hour, and they wait for all of it: the rule engine's day pull
 * goes down with this. That is strictly worse than a missing figure, which is
 * why ./liveClock.ts polls at fifteen seconds rather than ten and why the
 * route holds its answer for ten.
 *
 *
 * THE TWO FAILURE RULES ARE loadBrokerDay'S, DELIBERATELY
 * -------------------------------------------------------
 *
 * 1. Discovery fails on the host that is NOT the connection's mint host → drop
 *    that host and carry on. An organization with no demo provisioning answers
 *    401/403 there, and that must not take down a read that works.
 * 2. A failure on the mint host → throw, and the route classifies it into one
 *    of the three non-verified states.
 *
 * The direction differs from the day pull's second rule and the difference is
 * intentional. There, a swallowed failure under-counts a loss and makes every
 * rule MORE PERMISSIVE, so anything unknown is fatal. Here, nothing feeds a
 * rule (./liveClock.ts's header, and the suite asserts lib/rules imports none
 * of this), so the worst a dropped host costs is a card that does not mention
 * a position. Still fatal on the mint host, because silence about a position
 * the trader IS holding is the failure this feature exists to prevent.
 */

import { loadContractNames } from './contract-names';
import { discoverHostAccounts, type TradovateReader } from './fills';
import type { TradovateEnvironment } from './hosts';
import type { TradovateCashBalanceSnapshot, TradovatePosition } from './types';

/**
 * A {@link TradovateReader} that can also POST a read (REF-108 Stage 4a).
 *
 * DECLARED HERE RATHER THAN WIDENING `TradovateReader`, and that is a decision
 * about twelve call sites. The cash-balance snapshot is the only POST read in
 * the integration, and `TradovateReader` is implemented or consumed by the three
 * routes, ./sync.ts, ./orders.ts (four places), this module, ./index.ts and the
 * regression suite. Adding a REQUIRED `post` breaks all of them for one caller;
 * adding an OPTIONAL one makes every existing caller branch on "maybe there is
 * no post", which is a seam that erodes the first time somebody is in a hurry.
 *
 * So the extra verb lives in the one module that needs it, and
 * `/api/tradovate/live` — the only route that builds these — is the only place
 * that has to supply it. `tradovateGet` and `TradovateReader` do not move.
 */
export interface LiveReader extends TradovateReader {
  post<T>(path: string, body: unknown): Promise<T>;
}

/** One open position. SERVER-SIDE SHAPE — see `contractId`. No price. */
export interface LivePosition {
  /**
   * The broker's contract id. SERVER-SIDE ONLY, AND IT MUST NOT REACH THE WIRE.
   *
   * It is here for one reader: the flat-transition check in
   * app/api/tradovate/live/route.ts (REF-113 Stage 4b), which has to decide
   * whether a contract that was held on the previous poll is held on this one.
   * {@link contractName} cannot do that job — it is null whenever
   * `/contract/item` refused, and two unnamed contracts in one account would
   * collapse into one key and hide a transition.
   *
   * THE ROUTE PROJECTS THIS SHAPE ONTO ITS OWN `LivePositionLine` RATHER THAN
   * PASSING IT THROUGH, which is the only reason this is safe. Before Stage 4b
   * the route did pass it through, so the two shapes had to be identical; it
   * now names the three fields the browser gets, and
   * scripts/tradovate-today-check.ts asserts the response's EXACT KEY SET, so a
   * change that re-introduces the spread fails there rather than in
   * production. The browser has no use for a contract id once the account is
   * resolved to our UUID, and a numeric broker identifier is not worth
   * publishing for nothing.
   */
  contractId: number;
  /**
   * The contract's name, or null when `/contract/item` said nothing usable.
   *
   * Null is rendered rather than dropped: "you are holding 2 contracts" is
   * still worth saying when we cannot say of what.
   */
  contractName: string | null;
  /** Signed. Negative is short. Never zero — a flat position is not a position. */
  netPos: number;
  /**
   * `position.timestamp`, parsed.
   *
   * NAMED FOR WHAT IT PROBABLY IS AND DOCUMENTED FOR WHAT IT CERTAINLY IS.
   * `/position/list` keys a position per contract per trading day, and nothing
   * in this repository documents whether its `timestamp` is the moment the
   * position was opened or the moment the row was last touched. Nothing
   * renders it today for exactly that reason. Measure before computing a
   * duration from it.
   */
  openedAtMs?: number;
}

/** One account's open positions, keyed the way `accounts` is keyed. */
export interface HostAccountPositions {
  /** The broker's own numeric id. Joined to `accounts` by the ROUTE, not here. */
  brokerAccountId: number;
  host: TradovateEnvironment;
  positions: LivePosition[];
  /**
   * The broker's own unrealised P&L for this ACCOUNT, in dollars, or null
   * (REF-108 Stage 4a).
   *
   * ON THE ACCOUNT BECAUSE THAT IS WHERE THE BROKER PUTS IT — see the header.
   * One figure covers every contract the account holds.
   *
   * **`null` IS NOT `0`, AND CONFLATING THEM IS THE BUG THIS FIELD IS MOST
   * LIKELY TO GROW.** A position can genuinely sit at break-even, so zero is an
   * answer a trader can act on; null means we could not get one. Four
   * independent ways to arrive at null, all of them in {@link readOpenPnl}: the
   * call failed, the body carried `errorText`, `openPnL` was absent or
   * non-finite. A zero substituted for any of them is a number the trader reads
   * as fact.
   *
   * Dollars by the same assumption every amount in this product makes (REF-99,
   * lib/money.ts) — the snapshot carries no `currencyId` for this field, and
   * ./fills.ts' pricing note records the same gap. True for the CME futures
   * accounts this integration serves.
   */
  openPnl: number | null;
}

export { forgetContractNames } from './contract-names';

export interface OpenPositionsPull {
  accounts: HostAccountPositions[];
  /** When this was read, ISO 8601. The same field name /today and /trades use. */
  asOf: string;
}

/**
 * CONTRACT NAMES MOVED TO ./contract-names.ts (REF-117 Stage 6).
 *
 * The cache, its host-qualified key and the swallow-and-return-null rule all
 * lived here. They have a second caller now — ./fills.ts names the contract of
 * a HELD group for the sentence the trader is shown — and the failure rule is
 * the thing being shared rather than the lookup: a name that cannot be read
 * costs the name and never the position or the pull. {@link forgetContractNames}
 * is re-exported so the suites that clear it keep their one import.
 */

/** The one endpoint Stage 4a adds. A POST, and a read — see ./client.ts. */
const SNAPSHOT_PATH = '/cashBalance/getcashbalancesnapshot';

/**
 * The broker's own `openPnL` for one account, or null (REF-108 Stage 4a).
 *
 * EVERY FAILURE PATH RETURNS NULL AND NONE OF THEM THROWS, which is the whole
 * contract. The failure rule is {@link loadContractNames}' and NOT
 * `discoverHostAccounts`': a name that cannot be read costs the name and not the
 * position, and the figure is in the same category. The day pull takes the
 * opposite line and throws, because there a missing contract means a missing
 * `valuePerPoint` and the figure would be in points against a dollar threshold —
 * nothing of the sort is at stake here.
 *
 * The direction that matters: **silence about a position the trader IS holding
 * is the failure this feature exists to prevent; silence about what it is worth
 * is not.** So a snapshot that refuses must not take the position line down with
 * it, and must not take the OTHER accounts' figures down either — hence per
 * account, inside the loop, rather than one `Promise.all` that one rejection
 * spoils.
 *
 * FOUR WAYS TO NULL, AND `0` IS NOT ONE OF THEM:
 *
 * 1. the call threw — a refusal, a penalty, a host that does not expose it;
 * 2. `errorText` is set — this endpoint can answer 200 with no figures at all,
 *    a shape no `/list` read in this integration has;
 * 3. `openPnL` is absent — every field on the entity is documented `Optional`;
 * 4. `openPnL` is present and not finite — a type is a claim about the
 *    documentation, not about the wire.
 *
 * A finite zero is returned AS zero. A position sitting at break-even is a
 * fact, and `null` would hide it behind "we could not say".
 *
 * NOTHING IS LOGGED HERE, not even a count. This runs up to 240 times an hour
 * per trader, the common outcome is success, and the one thing a line could
 * carry — which account, holding what, worth how much — is the subject matter
 * the route's privacy note refuses. A figure that silently stops arriving shows
 * up as a missing number on the screen, which is where the trader is looking.
 */
async function readOpenPnl(reader: LiveReader, brokerAccountId: number): Promise<number | null> {
  try {
    const snapshot = await reader.post<TradovateCashBalanceSnapshot>(SNAPSHOT_PATH, {
      accountId: brokerAccountId,
    });

    // `errorText` is checked BEFORE the figure, because a body can carry both
    // and the error is the more specific claim.
    if (typeof snapshot?.errorText === 'string' && snapshot.errorText !== '') return null;

    const openPnl = snapshot?.openPnL;
    if (typeof openPnl !== 'number' || !Number.isFinite(openPnl)) return null;
    return openPnl;
  } catch {
    return null;
  }
}

export interface OpenPositionsRequest {
  /** {@link LiveReader} rather than `TradovateReader`: the snapshot is a POST. */
  readers: Record<TradovateEnvironment, LiveReader>;
  /** The connection's mint host. Its failure is fatal; the other host's is not. */
  environment: TradovateEnvironment;
  /** From the connection row. Decides whose accounts these are (./accounts.ts). */
  tradovateUserId: number | null;
  /** Now, ms. Injected so a suite can assert `asOf` at a fixed point. */
  nowMs?: number;
}

/**
 * Every open position across both hosts, with the account it is in.
 *
 * `netPos === 0` IS EXCLUDED, and it is not the same as "no row": a position
 * the trader closed today still has a row, with `netPos` zero, for the rest of
 * the trading day. Treating that as a position would tell a trader who has
 * gone flat that they are still holding something, which is the one wrong
 * statement this feature could make that would change what they do next.
 *
 * A non-finite `netPos` is excluded too, on the day pull's rule: a type is a
 * claim about the documentation, not about the wire, and the failure direction
 * is to say nothing rather than to invent a holding.
 */
export async function loadOpenPositions(
  request: OpenPositionsRequest
): Promise<OpenPositionsPull> {
  const { readers, environment, tradovateUserId, nowMs = Date.now() } = request;
  const accounts: HostAccountPositions[] = [];

  for (const host of Object.keys(readers) as TradovateEnvironment[]) {
    const reader = readers[host];

    let claimedIds: Set<number>;
    try {
      // `/account/list`, with the ownership rule and the conditional
      // permission read that ./accounts.ts owns — and with its
      // `withoutResponseBody` reduction, which is why this is the shared
      // function and not a second copy. The body of a failed `/account/list`
      // is a list of the trader's account names.
      const discovered = await discoverHostAccounts(reader, tradovateUserId);
      claimedIds = new Set(discovered.claimed.map((entry) => entry.account.id));
    } catch (error) {
      // Rule 1. See the header: the mint host is known-good and its failure is
      // the failure this read has; the other host is additive.
      if (host === environment) throw error;

      // REF-112 §5.2 — the same swallow as ./fills.ts, and the same fix as
      // far as it goes here: COUNTED RATHER THAN SILENT.
      //
      // IT DOES NOT REACH THE TRADER, and that is a scope line rather than an
      // omission. This is a 15-second poll of what is open right now, so a
      // notice raised from it would appear and vanish four times a minute;
      // the day pull raises the real one on the same failure, on the surface
      // that reports what went into the journal.
      //
      // THE ERROR NAME AND NOTHING ELSE. The body of a failed `/account/list`
      // is a list of the trader's account names — see the comment above, and
      // `withoutResponseBody` in ./errors.ts, which is what keeps it out of
      // the error in the first place.
      console.warn(
        '[tradovate][live] a non-mint host did not answer discovery ' +
          `(${error instanceof Error ? error.name : 'non-Error throw'})`
      );
      continue;
    }

    if (claimedIds.size === 0) continue;

    const positions = (await reader.get<TradovatePosition[]>('/position/list')) ?? [];

    // The contract id is carried on the row — and as of Stage 4b it STAYS on
    // it (see {@link LivePosition.contractId}) — so each position is named by
    // ITS OWN contract. Resolving names first and zipping them onto the list
    // afterwards is the shape that silently mislabels a two-contract account,
    // and a mislabelled holding is worse than an unlabelled one.
    type HeldRow = LivePosition;

    const byAccount = new Map<number, HeldRow[]>();
    const contractIds = new Set<number>();

    for (const position of positions) {
      if (!claimedIds.has(position.accountId)) continue;
      const netPos = position.netPos;
      if (typeof netPos !== 'number' || !Number.isFinite(netPos) || netPos === 0) continue;

      contractIds.add(position.contractId);
      const openedAtMs = Date.parse(String(position.timestamp ?? ''));
      const entry: HeldRow = { contractId: position.contractId, contractName: null, netPos };
      if (Number.isFinite(openedAtMs)) entry.openedAtMs = openedAtMs;

      const list = byAccount.get(position.accountId);
      if (list) list.push(entry);
      else byAccount.set(position.accountId, [entry]);
    }

    if (byAccount.size === 0) continue;

    // Only the contracts actually held. A trader with years of history has a
    // long `/position/list`; this reaches one or two rows of it.
    const names = await loadContractNames(reader, host, contractIds);

    for (const [accountId, list] of byAccount) {
      // ONE SNAPSHOT PER HOLDING ACCOUNT, AND ONLY HERE (REF-108 Stage 4a).
      //
      // `byAccount` is already the accounts with a non-zero `netPos` on this
      // host, so reaching the snapshot from inside this loop is what makes "a
      // flat account is never asked" a property of the control flow rather than
      // a condition somebody has to remember. See the header on why that
      // ordering IS the rate limit.
      //
      // SEQUENTIAL, like the contract-name walk above it. A trader holding in
      // three accounts at once is three requests either way; firing them
      // together only makes the burst sharper against a limit the FAQ measures
      // per SECOND as well as per hour.
      const openPnl = await readOpenPnl(reader, accountId);

      accounts.push({
        brokerAccountId: accountId,
        host,
        positions: list.map((row) => ({
          ...row,
          contractName: names.get(row.contractId) ?? null,
        })),
        openPnl,
      });
    }
  }

  return { accounts, asOf: new Date(nowMs).toISOString() };
}
