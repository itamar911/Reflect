/**
 * A logical position: flat → open → flat is ONE trade (REF-117 Stage 1).
 *
 * PURE, AND NOBODY IMPORTS THIS YET. No reader, no Supabase client, no
 * `process.env`, no `Date.now()` — the same discipline ./match.ts keeps, and for
 * the same payoff: the ten cases in `scripts/broker-cycles-check.ts` drive this
 * directly, with no HTTP and no fixtures of a response shape. Stage 2 is what
 * wires it under {@link import('./fills').BrokerTrade}.
 *
 *
 * WHAT IT REPLACES, AND WHY THE OLD RULE WAS WRONG
 * -----------------------------------------------
 *
 * `groupIntoTrades` in ./fills.ts is a union-find over fill ids: two `FillPair`s
 * are one trade iff they share a fill. That rule is right whenever one leg of
 * the round trip filled in a single piece — the shared fill is the glue — and it
 * breaks the moment BOTH legs fill in pieces, because Tradovate then matches
 * them pairwise and the pairs have no fill in common at all.
 *
 * Measured in production on 20.10 (REF-117 Stage 0, twice): a short of two
 * covered in two pieces produced `components: 2, cycles: 1`, with
 * `bothSidesInPieces: true` — two buy fills, two sell fills, two pairs sharing
 * nothing. One decision, two journal rows, two scores, two entries in
 * `todayTradeCount`, and two consecutive losses where the trader took one.
 *
 * So the unit stops being "pairs joined by a shared fill" and becomes the thing
 * a trader means by a trade: **every fill on one contract in one account from the
 * moment `netPos` leaves 0 until it returns to 0.** Re-entering the same
 * contract after flat is a NEW logical position, the same day or not — which is
 * the whole of REF-117's 19.10 20:04 addendum, solved by the definition rather
 * than by a special case.
 *
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING HERE: A FILL HAS NO ACCOUNT
 * ----------------------------------------------------------------
 *
 * `TradovateFill` carries `id`, `orderId`, `contractId`, `timestamp`,
 * `tradeDate`, `action`, `qty` and `price`. It carries NO `accountId` and NO
 * `positionId` (./types.ts). The only path from a fill to an account in the whole
 * API is
 *
 *     fill → fillPair.positionId → position.accountId
 *
 * so a walk over `/fill/list` alone is not merely inelegant, it is WRONG: that
 * response pools every account the trader can see, and a prop trader holding
 * MNQZ6 on two accounts at once — REF-110's trader — would have the two
 * interleaved into one fabricated cycle. That bug does not exist today, because
 * the pair filter runs before the grouping, and a naive rewrite introduces it.
 *
 * **Therefore the pairs stay.** They stop being the grouping mechanism and keep
 * two jobs: resolving a fill's account, and pricing (Stage 2 keeps the pair
 * arithmetic and asserts it equals {@link LogicalPosition.pointsPnl}). The
 * change is much smaller than "drop fillPair", and every refusal ./fills.ts
 * already makes survives it.
 *
 * A fill no pair names yet — the opening fill of a position nothing has closed —
 * is resolved by the ONE SAFE INFERENCE: if every account known to have traded
 * that contract today is the same single account, the fill is theirs. Two
 * accounts on one contract plus an unattributable fill is genuinely ambiguous and
 * the contract is HELD. Stage 0 measured exactly one such fill (the open
 * position), so this path is the ordinary case and not an edge.
 *
 *
 * THE INVARIANT THAT LICENSES TRUSTING ANY OF IT
 * ----------------------------------------------
 *
 * For each `(accountId, contractId)`:
 *
 *     (prevPos ?? 0) + Σ signedQty over the fills  ===  position.netPos
 *
 * Agree, and the walk saw every fill. Disagree, and `/fill/list` is incomplete —
 * an overnight carry, a truncated response, a mis-resolved account — and the
 * whole group is HELD rather than imported. See {@link reconcile}. It replaces
 * `datePair`'s `missing_fill` refusal with one that covers strictly more, and
 * the direction is ./fills.ts' own: not importing corrects itself on the next
 * pull, importing something wrong does not.
 *
 * WHAT IT DOES NOT LICENSE, AND THIS COST SEVEN JOURNAL ROWS ON 28.10: the
 * identity is a SUM, so it is blind to ORDER. A walk that read the fills in the
 * wrong sequence satisfies it exactly, and the cycles it carves out of that
 * sequence can still be wrong — one per interleaved piece rather than one per
 * position. The sum says the fills are all present; it says nothing about which
 * came first. That is a second question, with its own refusal:
 * {@link HeldReason} `'ambiguous_order'`, and the long note on
 * `ambiguousOrder` is where the measurement lives.
 *
 * `prevPos` IS AN OPTIONAL FIELD AND ITS ABSENCE IS NOT GUESSED AROUND. The
 * identity above could be solved for it — `netPos − Σ` — and doing that would
 * make the check vacuous: it would pass on every input, including the broken
 * ones it exists to catch. So when `prevPos` is absent and the sums disagree,
 * the group is held and {@link HeldGroup.impliedPrevPos} reports what the
 * identity would have required, as a diagnostic the operator reads rather than
 * as a number the code acts on.
 *
 *
 * WHAT THE API'S DEPTH DOES TO THE INTERDAY CASE
 * ----------------------------------------------
 *
 * Stage 0 measured `/fill/list`, `/fillPair/list` AND `/position/list` at
 * `depthDays = 0`, with `/fillPair/deps` and `/fill/items` reaching nothing
 * further. Tradovate wipes all four at the daily reset. So a position opened
 * yesterday and closed today has UNREACHABLE ENTRY FILLS, at any price.
 *
 * Such a cycle is not thrown away and not silently priced. It is marked
 * {@link LogicalPosition.interday}, and three fields are null or empty on it
 * because the inputs do not exist: `avgEntry`, `openedAtMs` and `pointsPnl`. Its
 * exits are real and are reported. Whether it may be imported at all is a
 * question about MONEY and belongs to the caller — {@link
 * LogicalPosition.pairedQty} against `qty` is the test, and a cycle whose pairs
 * do not cover its exit quantity has no honest P&L to write.
 *
 * NOT `avgEntry` FROM THE ENTRY LEGS THAT *ARE* VISIBLE, which is the tempting
 * half-measure. A trader who added to an overnight position has one visible
 * entry and one unreachable one, and averaging the visible one alone produces a
 * price that looks like their entry, sits beside a P&L it does not reproduce, and
 * is wrong. A null is a gap the UI can say out loud; a plausible wrong number is
 * not.
 */

/**
 * One fill, as the walk needs it.
 *
 * STRUCTURAL RATHER THAN `TradovateFill`, for ./match.ts' reason: a pure module
 * that imported the wire types would drag ./types.ts' server-only neighbours
 * behind it, and three fields plus an action are the whole of what a netPos walk
 * reads. `TradovateFill` is assignable to this.
 */
export interface CycleFill {
  id: number;
  /** The order that produced it. Absent or unusable is carried as absent. */
  orderId?: number;
  contractId: number;
  /** ISO 8601. Parsed here; an unreadable one holds the group. */
  timestamp: string;
  action: 'Buy' | 'Sell';
  /** Contracts. Read as a magnitude — `action` carries the sign. */
  qty: number;
  price: number;
}

/** One matched quantity segment. Read for the account link and for pricing, never for grouping. */
export interface CyclePair {
  id: number;
  positionId: number;
  buyFillId: number;
  sellFillId: number;
  qty: number;
  buyPrice: number;
  sellPrice: number;
}

/** A position row, for the account link and for {@link reconcile}. */
export interface CyclePosition {
  id: number;
  accountId: number;
  contractId: number;
  /** Live, signed. The right-hand side of the reconciliation identity. */
  netPos: number;
  /**
   * What was held when the trading day opened, when the row states it.
   *
   * OPTIONAL BECAUSE NOTHING HAS MEASURED IT, AND NOW NOTHING IS POINTED AT IT.
   * The probe's live mode asked for it — Q9 of docs/tradovate-measurements.md —
   * and REF-108 Stage 0 did not report an answer; the route itself was deleted
   * on 21.10 (REF-107 small fixes), so the question is open rather than
   * pending. This is written to work either way regardless: present and
   * non-zero marks an interday cycle; absent turns an overnight carry into a
   * HELD group rather than a guess. See the header.
   */
  prevPos?: number;
}

/** One entry or exit inside a logical position. */
export interface CycleLeg {
  fillId: number;
  /** Absent when the fill named no usable order — never carried as `0`. */
  orderId?: number;
  atMs: number;
  /**
   * The side, carried rather than derived.
   *
   * `entry` plus the cycle's direction would imply it, and storing it instead
   * is what keeps {@link LogicalPosition.pointsPnl} free of a direction branch:
   * `−Σ (buy ? +qty : −qty) × price` is correct for a long and for a short with
   * nothing to get backwards. The same reasoning as the P&L expression in
   * ./fills.ts' header, which is the bug that module exists to prevent.
   */
  buy: boolean;
  /** Whether this leg moved `netPos` AWAY from zero. */
  entry: boolean;
  /** Contracts this leg contributed. See {@link splitFromFill}. */
  qty: number;
  price: number;
  /**
   * This leg is PART of a fill, because that fill reversed the position.
   *
   * A sell of six against a long of three closes three and opens a short of
   * three, in one fill at one price. The fill is split by quantity at the zero
   * crossing and both halves carry this, so the two cycles it produced can be
   * told from two cycles the trader entered separately. The price is the same on
   * both halves, so nothing is averaged and the two P&Ls still sum to the figure
   * a merged row would have shown.
   */
  splitFromFill: boolean;
}

/** Why a `(account, contract)` group was not turned into cycles. */
export type HeldReason =
  /** The reconciliation identity failed. The group's fills are incomplete. */
  | 'netpos_mismatch'
  /** No position row for this `(account, contract)`, so there is nothing to reconcile against. */
  | 'no_position_row'
  /** More than one position row, so which `netPos` is current cannot be decided. */
  | 'ambiguous_position'
  /** A fill on this contract could not be attributed to one account. */
  | 'unattributed_fill'
  /** A fill carried an unreadable instant or quantity, so the walk has no order. */
  | 'unreadable_fill'
  /**
   * Two fills share an instant and take OPPOSITE sides, so the execution order
   * is not in the data (REF-117 Stage 8).
   *
   * See {@link ambiguousOrder} for why this is a refusal and not a sort.
   */
  | 'ambiguous_order';

/** One group the scan refused to state cycles for. Counts and a reason, never a guess. */
export interface HeldGroup {
  /** Null when attribution itself was what failed. */
  accountId: number | null;
  contractId: number;
  reason: HeldReason;
  fills: number;
  /**
   * What `prevPos` would have had to be for the identity to hold.
   *
   * A DIAGNOSTIC AND NOT AN INPUT — see the header on why solving the identity
   * for its own unknown would make the check vacuous. Read it to tell an
   * overnight carry (a round number matching a position the trader remembers)
   * from a truncated response (anything else).
   */
  impliedPrevPos?: number;
}

/** One logical position. */
export interface LogicalPosition {
  accountId: number;
  contractId: number;
  /**
   * `min(fill.id)` over this cycle's own fills — what the trade's natural key is
   * built FROM, not the key itself.
   *
   * The host prefix stays the caller's job, because host-qualification is
   * ./fills.ts' oldest rule and this module has no business knowing there are
   * two hosts. `BrokerTrade.brokerTradeKey` is still `${host}:${this}`.
   *
   * `min` RATHER THAN "the first leg in time", though in practice they are the
   * same fill: `min` cannot be moved by a timestamp tie, and ./fills.ts has been
   * punished enough for trusting that ids and instants agree.
   *
   * AND THE §A3 HAZARD IS GONE, not merely smaller. Under union-find a later
   * pair could bridge two groups and move the key; a cycle ends at `netPos = 0`
   * and nothing executed after that point can join it, so no later fill can
   * change a closed cycle's membership.
   */
  keyFillId: number;
  /** Which side opened it, from the first leg's action. Never from the prices. */
  direction: 'long' | 'short';
  /**
   * Contracts closed — the total exit quantity.
   *
   * The same figure `BrokerTrade.qty` means today (the sum of the pairs' matched
   * quantities), so Stage 2 changes no consumer. For a closed cycle that is not
   * interday it equals {@link entryQty}, which the suite asserts.
   */
  qty: number;
  /** Contracts entered, over the legs that are visible. */
  entryQty: number;
  /** Contracts still held when the walk ran out of fills. Zero on a closed cycle. */
  openQty: number;
  /** Quantity-weighted over the entry legs. Null on {@link interday} — see the header. */
  avgEntry: number | null;
  /** Quantity-weighted over the exit legs. Null only when nothing has been closed yet. */
  avgExit: number | null;
  /** The first entry leg's instant. Null on {@link interday}. */
  openedAtMs: number | null;
  /** The last leg's instant, whether it closed the cycle or not. */
  closedAtMs: number;
  /**
   * `netPos` returned to zero. The replacement for `BrokerTrade.positionFlat`.
   *
   * THE DIFFERENCE IS THE WHOLE TICKET. `positionFlat` asks whether the CONTRACT
   * is flat right now, so re-entering turned it false on trades that had already
   * closed and withheld them from the journal — REF-117's 19.10 20:04 case, where
   * the trader thought something had broken. This asks whether THIS CYCLE closed,
   * which no later trade can undo.
   */
  cycleClosed: boolean;
  /** Opened before the earliest fill we can see. Entry side unknown. */
  interday: boolean;
  /** Realised P&L in POINTS, from the fills. Null on {@link interday}. */
  pointsPnl: number | null;
  /** This cycle's fills, ascending. Overlaps another cycle's by one id after a flip. */
  fillIds: number[];
  /** Every order that produced a fill here, ascending. Unusable ids omitted. */
  orderIds: number[];
  /** The subset of {@link orderIds} that produced an ENTRY leg. */
  entryOrderIds: number[];
  /** The subset that produced an EXIT leg. An order can be in both after a flip. */
  exitOrderIds: number[];
  /** The positions this cycle's fills were attributed through, ascending. */
  positionIds: number[];
  /** The pairs whose closing leg is in this cycle — what the caller prices with. */
  pairIds: number[];
  /** Matched quantity across {@link pairIds}. Equals {@link qty} when fully priced. */
  pairedQty: number;
  /** Entries and exits in time order. The journal's "you exited in three pieces". */
  legs: CycleLeg[];
}

export interface CycleScan {
  cycles: LogicalPosition[];
  held: HeldGroup[];
  /** Fills no pair named and no sole account could claim. Each one holds its contract. */
  unattributedFills: number;
  /** Fills attributed because exactly one account traded that contract. */
  inferredAttributions: number;
  /**
   * Pairs that landed in NO cycle, on a group that was not held.
   *
   * MONEY WITH NOWHERE TO GO, WHICH IS THE ONE FAILURE THIS MODULE MUST NOT HAVE
   * SILENTLY. Every pair is assigned to the cycle holding its CLOSING leg, and
   * for real data that always exists — a pair matches an opening fill against a
   * later closing one, and the closing one is an exit of the cycle it closed. A
   * non-zero count here therefore means either a pair shape nothing has seen
   * (an "exit" that the walk reads as an entry) or a genuine bug in the
   * assignment, and in both cases a P&L figure was quietly left out of the day.
   *
   * Pairs on a HELD group are not counted: that group states no cycles at all
   * and its absence is already reported.
   */
  orphanPairs: number;
}

const usable = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** A finite number, zero included — for `netPos`, which is legitimately 0. */
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Whether a group's fills can account for its current `netPos`.
 *
 * Exported because the suite drives it alone: it is the one rule in this module
 * that decides whether anything is imported at all, and a test that reached it
 * only through {@link cyclesFromFills} would be testing the walk as well.
 */
export function reconcile(params: {
  /** Σ signedQty over the group's fills. */
  walked: number;
  /** `position.netPos`. */
  netPos: number;
  /** `position.prevPos`, when the row stated one. */
  prevPos?: number;
}): { ok: boolean; seedNet: number; impliedPrevPos: number } {
  const { walked, netPos } = params;
  const impliedPrevPos = netPos - walked;
  const prevPos = finite(params.prevPos) ? params.prevPos : undefined;

  // Stated: a real check, and the only branch that can mark a cycle interday.
  if (prevPos !== undefined) {
    return { ok: prevPos + walked === netPos, seedNet: prevPos, impliedPrevPos };
  }

  // Not stated: the identity reduces to `walked === netPos`, and a failure is
  // information — the fills are incomplete — rather than a value to back out.
  return { ok: walked === netPos, seedNet: 0, impliedPrevPos };
}

/**
 * Whether this group's fills leave the walk's ORDER undecided (REF-117 Stage 8).
 *
 * THE WALK SORTS BY `(timestamp, fill.id)`, AND THE SECOND KEY IS A GUESS. When
 * two fills carry the same instant, nothing in `/fill/list` says which executed
 * first — `fill.id` is the tiebreak only because something had to be, and the
 * note on {@link LogicalPosition.keyFillId} already warns that this module has
 * "been punished enough for trusting that ids and instants agree".
 *
 * WHY A WRONG GUESS IS NOT A COSMETIC PROBLEM. Measured on 28.10 against the
 * production walk (~/Desktop/reflect-reports/ref-117-live-split-investigation.md,
 * shape 2): when the walk's order is not the execution order, `netPos` returns
 * to zero after each interleaved piece and the walk emits ONE CYCLE PER FILL
 * PAIR instead of one cycle per position — seven journal rows where the trader
 * took two or three. And it passes every check that exists. The reconciliation
 * identity in {@link reconcile} is a SUM over the group, and a sum does not
 * depend on order, so a mis-ordered walk reconciles perfectly. The pricing
 * oracle does not catch it either: Tradovate matches FIFO and an interleaved
 * walk reproduces that same FIFO, so the fill P&L and the pair P&L agree on
 * every one of the fabricated rows. This is the one place in the chain where a
 * wrong answer passes in silence.
 *
 * SO THE REFUSAL IS NARROW, AND THE NARROWNESS IS THE WHOLE DESIGN. Same
 * instant plus the SAME side is the ordinary case — one order coming back as
 * several partial fills, routine at the open — and the order WITHIN those fills
 * cannot change a thing: they all push `netPos` the same way, so every
 * permutation yields the same cycles, the same legs and the same P&L. Only
 * OPPOSITE sides at one instant can move `netPos` across zero in one order and
 * not in another, which is exactly the difference between two cycles and one.
 * `scripts/broker-cycles-check.ts` pins both directions.
 *
 * AND IT HOLDS RATHER THAN SORTS BETTER, because there is nothing better to
 * sort by. Resolving the true order needs evidence this module is not given —
 * `/fillPair`'s matching, which is a separate stage and needs a raw measurement
 * nobody has yet. Holding fails in the direction this module already chose:
 * "not importing corrects itself on the next pull, importing something wrong
 * does not."
 */
function ambiguousOrder(fills: readonly CycleFill[]): boolean {
  // Keyed on the PARSED instant and not on the timestamp string, because the
  // walk sorts on the parsed value: two spellings of one instant collide in the
  // sort and must collide here too.
  const sidesByInstant = new Map<number, 'Buy' | 'Sell'>();
  for (const fill of fills) {
    const atMs = Date.parse(fill.timestamp);
    // Unreadable is `unreadable_fill`'s refusal, already made before this runs.
    if (!Number.isFinite(atMs)) continue;
    const seen = sidesByInstant.get(atMs);
    if (seen === undefined) sidesByInstant.set(atMs, fill.action);
    else if (seen !== fill.action) return true;
  }
  return false;
}

/** `fillId → accountId`, plus the two counts that say how it was decided. */
function attribute(
  fills: readonly CycleFill[],
  pairs: readonly CyclePair[],
  positions: readonly CyclePosition[]
): {
  accountByFill: Map<number, number>;
  positionsByFill: Map<number, Set<number>>;
  unattributable: Set<number>;
  inferred: number;
} {
  const positionById = new Map(positions.map((position) => [position.id, position]));

  const accountByFill = new Map<number, number>();
  const positionsByFill = new Map<number, Set<number>>();

  // Pass 1: whatever a pair names. The only non-inferential source there is.
  for (const pair of pairs) {
    const position = positionById.get(pair.positionId);
    if (!position) continue;
    for (const fillId of [pair.buyFillId, pair.sellFillId]) {
      accountByFill.set(fillId, position.accountId);
      const seen = positionsByFill.get(fillId) ?? new Set<number>();
      seen.add(position.id);
      positionsByFill.set(fillId, seen);
    }
  }

  // The accounts known to have touched each contract — from the pairs just
  // resolved AND from the position rows, so the first trade of the day on a
  // contract nothing has closed yet is still attributable.
  const accountsByContract = new Map<number, Set<number>>();
  const note = (contractId: number, accountId: number) => {
    const seen = accountsByContract.get(contractId) ?? new Set<number>();
    seen.add(accountId);
    accountsByContract.set(contractId, seen);
  };
  for (const position of positions) note(position.contractId, position.accountId);
  for (const fill of fills) {
    const accountId = accountByFill.get(fill.id);
    if (accountId !== undefined) note(fill.contractId, accountId);
  }

  // Pass 2: the one safe inference. Exactly one account on the contract and the
  // fill is theirs; anything else is ambiguous and holds the contract.
  const unattributable = new Set<number>();
  let inferred = 0;
  for (const fill of fills) {
    if (accountByFill.has(fill.id)) continue;
    const candidates = accountsByContract.get(fill.contractId);
    if (candidates && candidates.size === 1) {
      accountByFill.set(fill.id, [...candidates][0]);
      inferred += 1;
    } else {
      unattributable.add(fill.id);
    }
  }

  return { accountByFill, positionsByFill, unattributable, inferred };
}

/** A cycle under construction. */
interface Building {
  legs: CycleLeg[];
  interday: boolean;
  /** Signed `netPos` when this cycle opened: 0 normally, `prevPos` when interday. */
  startNet: number;
  /** Signed `netPos` when it closed or when the fills ran out. */
  endNet: number;
  closed: boolean;
}

/**
 * Every logical position in one pull.
 *
 * Deterministic: the only ordering it reads is `(timestamp, fill.id)`, and every
 * output list is sorted. Two scans over the same three responses cannot
 * disagree, which is what makes {@link LogicalPosition.keyFillId} comparable
 * across pulls.
 */
export function cyclesFromFills(input: {
  fills: readonly CycleFill[];
  pairs: readonly CyclePair[];
  positions: readonly CyclePosition[];
}): CycleScan {
  const { fills, pairs, positions } = input;

  const { accountByFill, positionsByFill, unattributable, inferred } = attribute(
    fills,
    pairs,
    positions
  );

  // A contract carrying an unattributable fill is held WHOLE, cycles and all.
  // The fill is a real execution whose account we cannot name, so every netPos
  // walk on that contract is missing a term — including the walks that look
  // perfectly healthy.
  const heldContracts = new Set(
    [...unattributable].map((fillId) => fills.find((fill) => fill.id === fillId)?.contractId)
      .filter((contractId): contractId is number => contractId !== undefined)
  );

  /** `accountId|contractId` → its fills, in walk order. */
  const groups = new Map<string, { accountId: number; contractId: number; fills: CycleFill[] }>();
  const groupKey = (accountId: number, contractId: number) => `${accountId}|${contractId}`;

  const held: HeldGroup[] = [];
  const unreadableContracts = new Set<number>();

  for (const fill of fills) {
    const accountId = accountByFill.get(fill.id);
    if (accountId === undefined) continue;

    // Refused rather than coerced, like every number ./fills.ts reads off the
    // wire: a fill with no readable instant has no place in an ordered walk, and
    // a non-positive quantity is not an execution.
    const atMs = Date.parse(fill.timestamp);
    if (!Number.isFinite(atMs) || !usable(fill.qty) || !finite(fill.price)) {
      unreadableContracts.add(fill.contractId);
      continue;
    }

    const key = groupKey(accountId, fill.contractId);
    const group = groups.get(key) ?? { accountId, contractId: fill.contractId, fills: [] };
    group.fills.push(fill);
    groups.set(key, group);
  }

  const cycles: LogicalPosition[] = [];

  // Instants, resolved once. The pair-to-cycle assignment below needs to know
  // which leg of a pair executed later, and doing that with a `find` per pair
  // per cycle is quadratic on a busy day for no reason.
  const atMsByFill = new Map<number, number>();
  for (const fill of fills) {
    const atMs = Date.parse(fill.timestamp);
    if (Number.isFinite(atMs)) atMsByFill.set(fill.id, atMs);
  }

  for (const group of [...groups.values()].sort(
    (a, b) => a.accountId - b.accountId || a.contractId - b.contractId
  )) {
    if (unreadableContracts.has(group.contractId)) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'unreadable_fill',
        fills: group.fills.length,
      });
      continue;
    }

    if (heldContracts.has(group.contractId)) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'unattributed_fill',
        fills: group.fills.length,
      });
      continue;
    }

    // BEFORE THE POSITION ROWS, with the other two refusals that are about the
    // FILLS THEMSELVES rather than about what the broker says is held. A group
    // whose order is undecided has no walk to reconcile, so asking `netPos`
    // about it first would report whichever of the two failed — and the
    // reconciliation PASSES on a mis-ordered walk anyway (see `ambiguousOrder`),
    // so it would report nothing at all.
    if (ambiguousOrder(group.fills)) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'ambiguous_order',
        fills: group.fills.length,
      });
      continue;
    }

    const rows = positions.filter(
      (position) =>
        position.accountId === group.accountId && position.contractId === group.contractId
    );

    if (rows.length === 0) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'no_position_row',
        fills: group.fills.length,
      });
      continue;
    }

    // Unreachable while every list is `depthDays = 0` — there is one row per
    // contract per trading day and only today's survives — and NOT quietly
    // resolved by picking one. Which `netPos` is current is the whole input to
    // the reconciliation, and a wrong pick would pass the check with the wrong
    // number.
    if (rows.length > 1) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'ambiguous_position',
        fills: group.fills.length,
      });
      continue;
    }

    const position = rows[0];
    const ordered = [...group.fills].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id - b.id
    );
    const signedOf = (fill: CycleFill) => (fill.action === 'Buy' ? fill.qty : -fill.qty);
    const walked = ordered.reduce((total, fill) => total + signedOf(fill), 0);

    const check = reconcile({ walked, netPos: position.netPos, prevPos: position.prevPos });
    if (!check.ok) {
      held.push({
        accountId: group.accountId,
        contractId: group.contractId,
        reason: 'netpos_mismatch',
        fills: group.fills.length,
        impliedPrevPos: check.impliedPrevPos,
      });
      continue;
    }

    // ── The walk ───────────────────────────────────────────────────────────
    //
    // One pass, and the only two decisions in it are "did `netPos` reach zero"
    // and "did it change sign without reaching zero".
    let net = check.seedNet;
    const built: Building[] = [];
    let current: Building | null =
      net === 0 ? null : { legs: [], interday: true, startNet: net, endNet: net, closed: false };

    const leg = (fill: CycleFill, qty: number, entry: boolean, splitFromFill: boolean): CycleLeg => ({
      fillId: fill.id,
      ...(usable(fill.orderId) ? { orderId: fill.orderId } : {}),
      atMs: atMsByFill.get(fill.id)!,
      buy: fill.action === 'Buy',
      entry,
      qty,
      price: fill.price,
      splitFromFill,
    });

    const close = (cycle: Building, endNet: number, closed: boolean) => {
      cycle.endNet = endNet;
      cycle.closed = closed;
      built.push(cycle);
    };

    for (const fill of ordered) {
      const before = net;
      const after = before + signedOf(fill);

      // Away from flat: a new logical position starts here.
      if (before === 0) {
        current = { legs: [], interday: false, startNet: 0, endNet: 0, closed: false };
      }
      const cycle = current!;

      // A sign change that never landed on zero: the trader reversed in ONE
      // fill. Split it by quantity — the part that takes `netPos` to 0 closes
      // the old cycle, the remainder opens the new one — at one price, so
      // nothing is averaged and the two P&Ls still sum to what a merged row
      // would have shown.
      if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) {
        const closingQty = Math.abs(before);
        cycle.legs.push(leg(fill, closingQty, false, true));
        close(cycle, 0, true);
        current = {
          legs: [leg(fill, fill.qty - closingQty, true, true)],
          interday: false,
          startNet: 0,
          endNet: after,
          closed: false,
        };
        net = after;
        continue;
      }

      // An entry moves |netPos| AWAY from zero. Read off the magnitudes rather
      // than off the cycle's direction, so the interday case — whose direction
      // comes from `prevPos` and not from any visible leg — needs no branch.
      cycle.legs.push(leg(fill, fill.qty, Math.abs(after) > Math.abs(before), false));
      net = after;

      if (after === 0) {
        close(cycle, 0, true);
        current = null;
      }
    }

    if (current !== null) close(current, net, false);

    // ── Describe ───────────────────────────────────────────────────────────
    for (const cycle of built) {
      const legs = cycle.legs;
      if (legs.length === 0) continue;

      const entries = legs.filter((item) => item.entry);
      const exits = legs.filter((item) => !item.entry);
      const sum = (list: readonly CycleLeg[]) => list.reduce((total, item) => total + item.qty, 0);
      const weighted = (list: readonly CycleLeg[]): number | null => {
        const total = sum(list);
        return total === 0
          ? null
          : list.reduce((acc, item) => acc + item.price * item.qty, 0) / total;
      };

      const fillIds = [...new Set(legs.map((item) => item.fillId))].sort((a, b) => a - b);
      const orderIdsOf = (list: readonly CycleLeg[]) =>
        [...new Set(list.map((item) => item.orderId).filter(usable))].sort((a, b) => a - b);

      // The side the position was held on: the first entry leg's for an
      // ordinary cycle, `prevPos`' sign when the entries are yesterday's.
      const direction: 'long' | 'short' = cycle.interday
        ? cycle.startNet > 0
          ? 'long'
          : 'short'
        : entries[0]?.buy
          ? 'long'
          : 'short';

      // Pairs whose CLOSING leg is in this cycle. Unique even after a flip: the
      // reversing fill is an exit in the old cycle and an entry in the new one,
      // so a pair naming it lands on exactly one of the two.
      const exitFillIds = new Set(exits.map((item) => item.fillId));
      const mine = pairs.filter((pair) => {
        const buyAt = atMsByFill.get(pair.buyFillId);
        const sellAt = atMsByFill.get(pair.sellFillId);
        if (buyAt === undefined || sellAt === undefined) return false;
        return exitFillIds.has(buyAt > sellAt ? pair.buyFillId : pair.sellFillId);
      });

      cycles.push({
        accountId: group.accountId,
        contractId: group.contractId,
        keyFillId: fillIds[0],
        direction,
        qty: sum(exits),
        entryQty: sum(entries),
        openQty: Math.abs(cycle.endNet),
        avgEntry: cycle.interday ? null : weighted(entries),
        avgExit: weighted(exits),
        openedAtMs: cycle.interday ? null : (entries[0]?.atMs ?? null),
        closedAtMs: legs[legs.length - 1].atMs,
        cycleClosed: cycle.closed,
        interday: cycle.interday,
        // NO DIRECTION BRANCH, which is the point of carrying `buy` on the leg.
        // −Σ signed × price is the cash flow of the cycle, so a profitable short
        // — sold high, bought back low — comes out positive on its own.
        pointsPnl: cycle.interday
          ? null
          : -legs.reduce(
              (total, item) => total + (item.buy ? item.qty : -item.qty) * item.price,
              0
            ),
        fillIds,
        orderIds: orderIdsOf(legs),
        entryOrderIds: orderIdsOf(entries),
        exitOrderIds: orderIdsOf(exits),
        positionIds: [
          ...new Set(fillIds.flatMap((fillId) => [...(positionsByFill.get(fillId) ?? [])])),
        ].sort((a, b) => a - b),
        pairIds: mine.map((pair) => pair.id).sort((a, b) => a - b),
        pairedQty: mine.reduce((total, pair) => total + pair.qty, 0),
        legs,
      });
    }
  }

  // Pairs with nowhere to go. Scoped to the groups that DID state cycles, so a
  // held group's pairs — whose absence is already reported — are not counted
  // twice under a different name.
  const assignedPairs = new Set(cycles.flatMap((cycle) => cycle.pairIds));
  const heldKeys = new Set(held.map((item) => `${item.accountId}|${item.contractId}`));
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const orphanPairs = pairs.filter((pair) => {
    if (assignedPairs.has(pair.id)) return false;
    const position = positionById.get(pair.positionId);
    if (!position) return false;
    return !heldKeys.has(`${position.accountId}|${position.contractId}`);
  }).length;

  return {
    cycles: cycles.sort(
      (a, b) => a.closedAtMs - b.closedAtMs || a.keyFillId - b.keyFillId
    ),
    held: held.sort((a, b) => (a.accountId ?? 0) - (b.accountId ?? 0) || a.contractId - b.contractId),
    unattributedFills: unattributable.size,
    inferredAttributions: inferred,
    orphanPairs,
  };
}
