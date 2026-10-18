/**
 * What the trader is holding right now (REF-108 Stage 1).
 *
 * SERVER ONLY. Driven from GET /api/tradovate/live and nothing else.
 *
 *
 * THERE IS NO PRICE IN THIS FILE, AND THAT IS THE DESIGN
 * ------------------------------------------------------
 *
 * REF-108 asked for an unrealised P&L in dollars. We cannot produce one: a
 * mark price needs the Market Data feed, **Market Data is Denied in our OAuth
 * registration**, and the feed itself needs CME sub-vendor registration
 * Reflect does not have (./types.ts:66, ./api-hosts.ts:181). That is an
 * entitlement and not an endpoint we have not found, so no REST path and no
 * WebSocket changes it.
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
 * So this module answers the question it can answer honestly — WHAT ARE YOU
 * HOLDING — and carries no price, no average entry and no P&L field of any
 * kind. The regression suite asserts the absence over the route's exact key
 * set, so a later change cannot add one by accident.
 *
 * If `--live` (REF-108 Stage 0) finds that the broker computes an open figure
 * per account, that figure arrives here as one more field and still needs no
 * mark price from us. Until it is measured, there is nothing to add.
 *
 *
 * WHAT IT COSTS, AND WHY THAT IS THE CONSTRAINT
 * ---------------------------------------------
 *
 * Per poll: `/account/list` + `/position/list` PER HOST — four requests — plus
 * one `/contract/item` per open contract, warm-cached by host-qualified id.
 * The pricing chain is NOT walked: `loadContractUnits` would add
 * `/contractMaturity/item` and `/product/item` to reach a `valuePerPoint` that
 * nothing here multiplies by.
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

import { discoverHostAccounts, type TradovateReader } from './fills';
import type { TradovateEnvironment } from './hosts';
import type { TradovateContract, TradovatePosition } from './types';

/** One open position, as the browser receives it. No price. See the header. */
export interface LivePosition {
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
}

export interface OpenPositionsPull {
  accounts: HostAccountPositions[];
  /** When this was read, ISO 8601. The same field name /today and /trades use. */
  asOf: string;
}

/**
 * Contract names, by host-qualified id.
 *
 * KEYED `${host}:${contractId}` AND NOT BY ID ALONE, which is the opposite of
 * {@link import('./fills').ContractUnit}'s cache and for the same underlying
 * rule. That one is keyed by contract NAME precisely so it can be shared
 * across hosts — a name is an exchange fact. This one is keyed BY ID, because
 * the id is what we have before the lookup, and nothing documents live and
 * demo as sharing an id space. An id-keyed cache without the host prefix would
 * eventually label one host's contract with the other host's name, which is a
 * quiet wrong answer on a screen the trader is watching.
 *
 * No expiry: a contract's name does not change, and the natural TTL is the
 * process, which on Vercel is short. The cap is what stops a long-lived
 * instance from growing an entry per contract per trader forever.
 */
const nameByHostContract = new Map<string, string | null>();
const MAX_CACHED_CONTRACTS = 500;

/** Test seam. Nothing in production calls this. */
export function forgetContractNames(): void {
  nameByHostContract.clear();
}

async function loadContractNames(
  reader: TradovateReader,
  host: TradovateEnvironment,
  contractIds: ReadonlySet<number>
): Promise<Map<number, string | null>> {
  const names = new Map<number, string | null>();

  for (const contractId of contractIds) {
    const key = `${host}:${contractId}`;
    const cached = nameByHostContract.get(key);
    if (cached !== undefined) {
      names.set(contractId, cached);
      continue;
    }

    // A name is decoration on this screen, so a lookup that fails costs the
    // name and not the position. The day pull takes the opposite line and
    // throws, because there a missing contract means a missing VALUE PER
    // POINT and the figure would be in points against a dollar threshold.
    let name: string | null = null;
    try {
      const contract = await reader.get<TradovateContract>('/contract/item', { id: contractId });
      const raw = contract?.name;
      name = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
    } catch {
      name = null;
    }

    if (nameByHostContract.size >= MAX_CACHED_CONTRACTS) {
      nameByHostContract.delete(nameByHostContract.keys().next().value as string);
    }
    nameByHostContract.set(key, name);
    names.set(contractId, name);
  }

  return names;
}

export interface OpenPositionsRequest {
  readers: Record<TradovateEnvironment, TradovateReader>;
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
      continue;
    }

    if (claimedIds.size === 0) continue;

    const positions = (await reader.get<TradovatePosition[]>('/position/list')) ?? [];

    // The contract id is carried on the row until the names are in hand, so
    // each position is named by ITS OWN contract. Resolving names first and
    // zipping them onto the list afterwards is the shape that silently
    // mislabels a two-contract account, and a mislabelled holding is worse
    // than an unlabelled one.
    interface HeldRow extends LivePosition {
      contractId: number;
    }

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
      accounts.push({
        brokerAccountId: accountId,
        host,
        positions: list.map(({ contractId, ...rest }) => ({
          ...rest,
          contractName: names.get(contractId) ?? null,
        })),
      });
    }
  }

  return { accounts, asOf: new Date(nowMs).toISOString() };
}
