/**
 * `?mode=orders` → `answers.Q8` — a TEMPORARY extension, and the most temporary
 * thing in a route that is already temporary. REF-113 §4.2 of
 * `ref-113-direction-investigation.md` asked for it and said to delete it after.
 *
 * WHAT IT IS FOR, IN ONE PARAGRAPH. The 19.10 sync stored
 * `broker_stop_loss = 29701.25` where the trader's stop was 29671.25, with
 * `movedCount = 5` against an expected 2 and `direction = 'mixed'`. §2 of that
 * report narrows the cause to two hypotheses that the database cannot separate:
 * either the entry trigger won the selection (i), or a real but wrong stop did
 * (ii). The SQL in §4.1 says WHICH order won — by its version count — but not
 * WHAT it was, and `action`, the final `orderType` and `ordStatus` are exactly
 * what decides between the two and what the regression fixture has to be built
 * from. `/order/list` is `depthDays = 0` with no backfill (./types.ts on
 * {@link TradovateOrder}), so after tonight's session rolls there is nothing
 * left to ask.
 *
 *
 * DISTANCES, NEVER PRICES
 * -----------------------
 *
 * The privacy precedent is in this directory already: `relativeSeconds`
 * (./survey.ts) carries OFFSETS and never INSTANTS, because a duration between
 * two of the trader's own events is the measurement and an absolute instant is
 * what identifies them. The price twin of that rule is this file's whole design:
 * a signed distance from the entry is the measurement, and a price LEVEL is what
 * identifies the position.
 *
 * So every number here is a tick COUNT or a row COUNT, and three properties keep
 * it that way:
 *
 *   - **The base is read by the server, never passed in.** The entry price comes
 *     from this host's own `/fill/list`. It is deliberately NOT a query
 *     parameter: every approved command is written verbatim to
 *     `.claude/settings.local.json` and to the session transcript, so a price on
 *     a URL is a price in two files that outlive the probe.
 *   - **Integers only.** A tick distance is an integer by construction, and a
 *     raw price that leaked into this block would almost certainly not be — so
 *     {@link scanForLeaks}' companion check in ../route.ts asserts integrality
 *     over this subtree and that assertion has teeth.
 *   - **Ticks or nothing.** When the tick size cannot be resolved the distances
 *     are `null` and {@link Q8_UNRESOLVED_TICKS} says so. Reporting the same
 *     number in points was the fallback §4.2 allowed, and it is refused here for
 *     the reason above: points are fractional on every instrument this trader
 *     uses, and a block with one fractional number in it is a block whose
 *     integrality check no longer means anything.
 *
 * NO MUTATION, NO NEW MUTATION-SHAPED CALL. The four endpoints this adds to the
 * allowlist are reads, three of them already read by `src/lib/tradovate/fills.ts`
 * on every single pull, and each passes the denylist in ./guard.ts unchanged.
 */

import { callEndpoint, reportOf, type CallResult } from './call';
import { ENUM_SHAPED, rowTime, type Row } from './survey';

/** Why a per-order distance list is `null`. See the header on ticks-or-nothing. */
export const Q8_UNRESOLVED_TICKS = 'tick_size_unresolved';

/**
 * How many distinct contracts get their tick size resolved.
 *
 * Three sequential reads each — contract, maturity, product — and a trader holds
 * one or two contracts in a day, so three is headroom rather than a limit that
 * is expected to bite. It is here at all for the reason ./orders.ts caps its deps
 * fan-out: Tradovate's rate-limit penalty escalates to a `p-captcha` that a
 * third-party application cannot clear, and a diagnostic is never worth that.
 */
const MAX_TICK_CONTRACTS = 3;

/** How many orders Q8 describes. Bounds the response, not the measurement. */
const MAX_ORDERS_REPORTED = 60;

const usableId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * An enum member, or null.
 *
 * The same test `enumValues` applies, used here one value at a time. Null rather
 * than a type placeholder because this is the answer to "is `text` a short enum",
 * and a `text` carrying a broker's free-form rejection sentence must come out as
 * "not an enum", not as a truncated sentence.
 */
const enumOrNull = (value: unknown): string | null =>
  typeof value === 'string' && ENUM_SHAPED.test(value) ? value : null;

/** The condition price of one version: a stop's trigger, else a limit's price. */
function conditionPrice(version: Row): { price: number | null; field: 'stopPrice' | 'price' | null } {
  const stop = finite(version['stopPrice']);
  if (stop !== null) return { price: stop, field: 'stopPrice' };
  const limit = finite(version['price']);
  if (limit !== null) return { price: limit, field: 'price' };
  return { price: null, field: null };
}

/** What one contract's day was anchored on. The price never leaves this module. */
interface EntryBase {
  price: number;
  /** `Buy` on the opening fill means the day's first position there was a long. */
  action: string | null;
}

/**
 * The opening fill per contract — the base every distance below is measured from.
 *
 * THE EARLIEST FILL ON THE CONTRACT, which is the fill that opened the day's
 * first position on it. That is a weaker definition than the quantity-weighted
 * `BrokerTrade.entryPrice` the product computes, and the difference is stated
 * rather than hidden: with two round trips on one contract in a day, the second
 * trade's distances are measured from the FIRST trade's entry. For the single
 * question this file exists to answer — was the stored stop on the far side of
 * the entry, and by how much — the sign is what matters and a shared base keeps
 * every order on one contract comparable. `loadBrokerDay` would give the exact
 * per-trade base and costs the account-discovery and pricing chains, which is a
 * production code path this probe has no business driving.
 */
function entryBases(fills: Row[]): Map<number, EntryBase> {
  const bases = new Map<number, EntryBase>();
  const stampOf = new Map<number, { ms: number; id: number }>();

  for (const fill of fills) {
    const contractId = fill['contractId'];
    const price = finite(fill['price']);
    if (!usableId(contractId) || price === null) continue;

    // A fill with no readable instant still anchors a contract nothing else has
    // anchored, and `id` ascending breaks the tie — fill ids do not move
    // (fills.ts on `brokerTradeKey`).
    const here = { ms: rowTime(fill) ?? Number.POSITIVE_INFINITY, id: finite(fill['id']) ?? 0 };
    const held = stampOf.get(contractId);
    if (held && (held.ms < here.ms || (held.ms === here.ms && held.id <= here.id))) continue;

    stampOf.set(contractId, here);
    bases.set(contractId, { price, action: enumOrNull(fill['action']) });
  }

  return bases;
}

/** What the tick-size walk cost and what it learned. */
export interface TickSizeLookup {
  sizes: Map<number, number>;
  calls: Omit<CallResult, 'rows'>[];
  contractsAvailable: number;
  contractsAsked: number;
  capped: boolean;
}

/**
 * Tick size per contract, by the documented chain, non-fatally.
 *
 * `contract → contractMaturity → product` is the same walk `loadContractUnits`
 * takes for `valuePerPoint`, and it is re-walked here rather than imported
 * because that function is private, needs a `TradovateReader`, and throws
 * `TradovateUnpriceableError` — a probe must record a dead end as an answer, not
 * raise one (./call.ts). Every hop goes through {@link callEndpoint}, so every
 * hop is allowlisted, denylisted and body-free on failure like every other call
 * this route makes.
 *
 * A failed hop leaves the contract out of the map, which the caller reports as
 * {@link Q8_UNRESOLVED_TICKS} rather than as a distance in some other unit.
 */
export async function resolveTickSizes(
  contractIds: number[],
  options: { accessToken: string; apiUrl: string }
): Promise<TickSizeLookup> {
  const asked = contractIds.slice(0, MAX_TICK_CONTRACTS);
  const sizes = new Map<number, number>();
  const calls: Omit<CallResult, 'rows'>[] = [];

  for (const contractId of asked) {
    const contract = await callEndpoint('/contract/item', { ...options, query: { id: contractId } });
    calls.push(reportOf(contract));
    const maturityId = contract.rows[0]?.['contractMaturityId'];
    if (!usableId(maturityId)) continue;

    const maturity = await callEndpoint('/contractMaturity/item', {
      ...options,
      query: { id: maturityId },
    });
    calls.push(reportOf(maturity));
    const productId = maturity.rows[0]?.['productId'];
    if (!usableId(productId)) continue;

    const product = await callEndpoint('/product/item', { ...options, query: { id: productId } });
    calls.push(reportOf(product));
    const tickSize = finite(product.rows[0]?.['tickSize']);
    // A non-positive tick size would divide the distances into nonsense, and
    // zero would divide them into Infinity. Both are "unresolved".
    if (tickSize !== null && tickSize > 0) sizes.set(contractId, tickSize);
  }

  return {
    sizes,
    calls,
    contractsAvailable: contractIds.length,
    contractsAsked: asked.length,
    capped: contractIds.length > MAX_TICK_CONTRACTS,
  };
}

/**
 * Everything Q8 is allowed to know. All of it is already in hand in ./orders.ts.
 *
 * `versionsAskedFor` IS A SET AND ITS ABSENCE IS A VALUE, the same encoding
 * `StopEvidence.versions` uses in the product: a missing id means the deps call
 * was never made because the fan-out cap was reached, which is a different fact
 * from "this order has no versions" and must not read as one.
 */
export interface Q8Input {
  orders: Row[];
  versionsByOrder: Map<number, Row[]>;
  versionsAskedFor: Set<number>;
  fills: Row[];
  commands: Row[];
  strategyLinks: Row[];
  ticks: TickSizeLookup;
}

export function buildQ8(input: Q8Input): Record<string, unknown> {
  const { orders, versionsByOrder, versionsAskedFor, fills, commands, strategyLinks, ticks } = input;

  const bases = entryBases(fills);

  // Commands and links, indexed by the order they belong to. Both lists are
  // already fetched; this is the join ./orders.ts' Q4 and Q6 answer in aggregate
  // and Q8 needs per order.
  const commandsByOrder = new Map<number, Row[]>();
  for (const command of commands) {
    const orderId = command['orderId'];
    if (!usableId(orderId)) continue;
    const list = commandsByOrder.get(orderId) ?? [];
    list.push(command);
    commandsByOrder.set(orderId, list);
  }

  const linksByOrder = new Map<number, Row[]>();
  for (const link of strategyLinks) {
    const orderId = link['orderId'];
    if (!usableId(orderId)) continue;
    const list = linksByOrder.get(orderId) ?? [];
    list.push(link);
    linksByOrder.set(orderId, list);
  }

  // A dense index per contract, so a reader can see which orders shared one
  // instrument without any contract id being emitted. Assigned in the order the
  // orders are reported, which makes `0` "the contract of the first order".
  const contractIndex = new Map<number, number>();
  const indexOf = (contractId: number): number => {
    const held = contractIndex.get(contractId);
    if (held !== undefined) return held;
    const next = contractIndex.size;
    contractIndex.set(contractId, next);
    return next;
  };

  const sorted = [...orders].sort(
    (a, b) =>
      (rowTime(a) ?? 0) - (rowTime(b) ?? 0) || (finite(a['id']) ?? 0) - (finite(b['id']) ?? 0)
  );
  const reported = sorted.slice(0, MAX_ORDERS_REPORTED);

  const perOrder = reported.map((order) => {
    const orderId = finite(order['id']);
    const contractId = order['contractId'];
    const base = usableId(contractId) ? (bases.get(contractId) ?? null) : null;
    const tickSize = usableId(contractId) ? (ticks.sizes.get(contractId) ?? null) : null;

    const versions = orderId !== null ? (versionsByOrder.get(orderId) ?? []) : [];
    const asked = orderId !== null && versionsAskedFor.has(orderId);

    // The newest `orderType` the versions state, read off the LAST version for
    // the reason `orderTypeOf` in src/lib/tradovate/orders.ts gives: a modify can
    // change an order's type, and what it finally was is what it was protecting
    // with. This is the field that separates hypothesis (i) from (ii).
    let finalOrderType: string | null = null;
    for (let i = versions.length - 1; i >= 0 && finalOrderType === null; i -= 1) {
      finalOrderType = enumOrNull(versions[i]?.['orderType']);
    }

    const measurable = base !== null && tickSize !== null;
    const distinct = new Set<number>();

    const versionRows = versions.map((version) => {
      const { price, field } = conditionPrice(version);
      if (price !== null) distinct.add(price);
      return {
        // Signed, and `+` means ABOVE the entry — not "on the risk side". The
        // side a given sign implies depends on the trade's direction, and
        // reporting the raw geometry leaves that reading to the owner instead of
        // folding this file's guess about the direction into the number.
        stopTicksFromEntry:
          base !== null && tickSize !== null && price !== null
            ? Math.round((price - base.price) / tickSize)
            : null,
        hasStopPrice: version['stopPrice'] !== null && version['stopPrice'] !== undefined,
        hasPrice: version['price'] !== null && version['price'] !== undefined,
        priceField: field,
        text: enumOrNull(version['text']),
      };
    });

    const orderCommands = orderId !== null ? (commandsByOrder.get(orderId) ?? []) : [];
    const byType: Record<string, number> = {};
    let automatedTrue = 0;
    let automatedFalse = 0;
    let automatedAbsent = 0;
    for (const command of orderCommands) {
      // An unrecognised `commandType` becomes the `other` bucket rather than a
      // KEY in this object: a key is a value in JSON, and a free-text type would
      // be emitted verbatim by being one.
      const type = enumOrNull(command['commandType']) ?? 'other';
      byType[type] = (byType[type] ?? 0) + 1;
      const automated = command['isAutomated'];
      if (automated === true) automatedTrue += 1;
      else if (automated === false) automatedFalse += 1;
      else automatedAbsent += 1;
    }

    const links = orderId !== null ? (linksByOrder.get(orderId) ?? []) : [];

    return {
      contractIndex: usableId(contractId) ? indexOf(contractId) : null,
      action: enumOrNull(order['action']),
      ordStatus: enumOrNull(order['ordStatus']),
      finalOrderType,
      versionsAsked: asked,
      // Null, not 0, when the deps call was never made — see Q8Input.
      versionCount: asked ? versions.length : null,
      distinctConditionValues: asked ? distinct.size : null,
      entryBaseKnown: base !== null,
      entryAction: base?.action ?? null,
      ticksMeasured: measurable,
      unmeasuredReason: measurable ? null : base === null ? 'no_entry_fill' : Q8_UNRESOLVED_TICKS,
      versions: versionRows,
      strategyLinked: links.length > 0,
      // Presence only. A link label can be the trader's own name for a strategy
      // — the one value ./survey.ts deliberately dropped from its vocabulary.
      strategyLabelPresent: links.some((l) => l['label'] !== null && l['label'] !== undefined),
      commandCount: orderCommands.length,
      commandsByType: byType,
      commandsAutomated: { true: automatedTrue, false: automatedFalse, absent: automatedAbsent },
    };
  });

  return {
    question:
      'Q8  לכל פקודה של היום: מה היא הייתה, ובאיזה צד של הכניסה ישבה כל גרסה (בטיקים חתומים)',
    note:
      'הרחבה זמנית לפי §4.2 של ref-113-direction-investigation.md — נמחקת עם הפרוב. ' +
      'כל מספר הוא מרחק או ספירה; מחיר הכניסה נקרא מ-/fill/list בשרת ולא עובר ב-query.',
    ordersInWindow: orders.length,
    ordersReported: perOrder.length,
    ordersCapped: sorted.length > MAX_ORDERS_REPORTED,
    versionsAskedFor: versionsAskedFor.size,
    fillRowsRead: fills.length,
    contractsSeen: contractIndex.size,
    tickSizesResolved: ticks.sizes.size,
    perOrder,
  };
}
