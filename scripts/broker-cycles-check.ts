/**
 * Logical-position regression suite — REF-117 Stage 1.
 *
 * There is no unit-test runner in this repository (see the header on
 * scripts/broker-import-check.ts, which explains why and sets the shape). This
 * is a plain `tsx` script of assertions: one line per group, non-zero exit on
 * any failure.
 *
 * NOTHING HERE TOUCHES THE NETWORK, SUPABASE, OR A CREDENTIAL, and this suite
 * could not if it tried: `src/lib/tradovate/cycles.ts` is pure by construction —
 * no reader, no client, no `process.env`, no clock — so every case below is
 * three arrays in and one object out.
 *
 * The one exception is `stagesFromLegs`, imported from
 * `src/lib/tradovate/fills.ts` for the STAGES group (REF-117 Stage 7). That
 * module is not pure as a whole — it is the one that calls the broker — but that
 * function is: legs in, pieces out, no reader and no clock. It is imported
 * rather than reimplemented because a second copy of the grouping rule in the
 * test would assert the copy and not the code.
 *
 *
 * WHY EACH GROUP IS HERE
 * ----------------------
 *
 * The first four are the four grouping shapes of REF-117, and the third and
 * fourth are the ones production gets WRONG today:
 *
 *   - **5 → 1+2+2** and **2+2 → 4** already worked, because one leg filled in a
 *     single piece and that shared fill is what union-find joins on. They are
 *     here so that fixing the broken pair cannot break the working one.
 *   - **2+2 → 2+2** is §1.3's third row: two pairs, no shared fill, two rows
 *     today.
 *   - **CASE א** is the measured one — 20.10, twice: a short covered in two
 *     pieces reported `components: 2, cycles: 1`. One decision, two journal
 *     rows, two scores, two entries in `todayTradeCount`, and TWO CONSECUTIVE
 *     LOSSES where the trader took one, which is `cooldown_after_losses`
 *     defaulting to three and locking them out over it.
 *
 * Then the five that are about the definition rather than the grouping:
 *
 *   - **CASE ב** — close, then re-enter the same contract immediately. Two
 *     cycles, and the first one is CLOSED. Under `positionFlat` the closed trade
 *     was withheld from the journal until the contract went flat again, and the
 *     trader thought something had broken (REF-117, 19.10 20:04).
 *   - **THE FLIP** — long 3, sell 6, short 3, in one reversing fill that never
 *     lands on zero. Two cycles, split by quantity, and the two P&Ls sum to the
 *     single figure today's merged row shows, so the day's `net` does not move.
 *   - **INTERDAY** — `prevPos ≠ 0`. Stage 0 measured every list at
 *     `depthDays = 0`, so the entry fills are unreachable at any price: the
 *     cycle is marked, `avgEntry` and `pointsPnl` are null, and the exits are
 *     still real.
 *   - **TWO ACCOUNTS, ONE CONTRACT** — the hazard a naive rewrite introduces.
 *     `/fill/list` pools accounts and a fill carries no `accountId`, so a walk
 *     that grouped by contract alone would interleave REF-110's prop trader into
 *     one fabricated cycle.
 *   - **HELD** — the reconciliation identity, which is what licenses trusting
 *     any of the above. Four ways to fail it, each with its own reason code.
 *   - **STAGES** — REF-117 Stage 7, and the only group that is about the
 *     PROJECTION rather than the walk. One order filled in three pieces is one
 *     stage, three orders in the same second are three, and an order-less leg is
 *     its own. The reported bug said `נכנסת ב-3 שלבים` about one market order.
 *
 * And one group that is not a case but a property: the P&L computed from the
 * FILLS equals the P&L computed from the PAIRS, on every fixture that has both.
 * Stage 2 keeps the pair arithmetic in production and asserts this equality
 * there too; here it is the oracle that says the new expression is right.
 *
 * Usage: npm run test:broker-cycles
 */

import {
  cyclesFromFills,
  reconcile,
  type CycleFill,
  type CyclePair,
  type CyclePosition,
  type LogicalPosition,
} from '../src/lib/tradovate/cycles';
import { stagesFromLegs } from '../src/lib/tradovate/fills';

// ── Harness ─────────────────────────────────────────────────────────────────
//
// Deliberately identical in shape to broker-import-check's and
// accounts-check's, down to the `c()` helper, so somebody reading any of them
// is reading one convention.

interface Case {
  label: string;
  got: unknown;
  want: unknown;
}

const failures: string[] = [];

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function c(label: string, got: unknown, want: unknown): Case {
  return { label, got, want };
}

function group(name: string, cases: Case[]): void {
  const bad = cases.filter((item) => !same(item.got, item.want));
  if (bad.length === 0) {
    console.log(`ok    ${name}  (${cases.length}/${cases.length})`);
    return;
  }
  console.log(`FAIL  ${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const item of bad) {
    console.log(`        ${item.label}`);
    console.log(`          got  ${show(item.got)}`);
    console.log(`          want ${show(item.want)}`);
    failures.push(`${name}: ${item.label}`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ACCOUNT = 7001;
const OTHER_ACCOUNT = 7002;
const MNQ = 5001;
const ES = 5002;

/** Fill ids ascend with time in every fixture, as Tradovate's do. */
let tick = 0;

function fill(
  id: number,
  action: 'Buy' | 'Sell',
  qty: number,
  price: number,
  opts: { contract?: number; order?: number; at?: string } = {}
): CycleFill {
  tick += 1;
  return {
    id,
    // `order: 0` survives the `??` and is what the STAGES group uses to make a
    // leg carry NO order — `usable()` rejects it, so nothing is carried as zero.
    orderId: opts.order ?? 900_000 + id,
    contractId: opts.contract ?? MNQ,
    // One minute apart, so the walk's order is unambiguous and readable. `at`
    // overrides it for the one fixture that needs fills inside ONE second.
    timestamp: opts.at ?? new Date(Date.UTC(2026, 9, 20, 14, tick)).toISOString(),
    action,
    qty,
    price,
  };
}

function pair(id: number, positionId: number, buy: CycleFill, sell: CycleFill, qty: number): CyclePair {
  return {
    id,
    positionId,
    buyFillId: buy.id,
    sellFillId: sell.id,
    qty,
    buyPrice: buy.price,
    sellPrice: sell.price,
  };
}

function position(
  id: number,
  netPos: number,
  opts: { account?: number; contract?: number; prevPos?: number } = {}
): CyclePosition {
  return {
    id,
    accountId: opts.account ?? ACCOUNT,
    contractId: opts.contract ?? MNQ,
    netPos,
    ...(opts.prevPos === undefined ? {} : { prevPos: opts.prevPos }),
  };
}

/** One scan, with the position row defaulted to flat on MNQ. */
function scan(fills: CycleFill[], pairs: CyclePair[], positions: CyclePosition[] = [position(101, 0)]) {
  return cyclesFromFills({ fills, pairs, positions });
}

/** The pair-side P&L in points, for the oracle group. */
function pairPoints(cycle: LogicalPosition, pairs: readonly CyclePair[]): number {
  return pairs
    .filter((p) => cycle.pairIds.includes(p.id))
    .reduce((total, p) => total + (p.sellPrice - p.buyPrice) * p.qty, 0);
}

// ── 1. 5 → 1+2+2: one entry fill, three exit fills. Worked before. ──────────

tick = 0;
const e5 = fill(101, 'Buy', 5, 100);
const x1 = fill(102, 'Sell', 1, 110);
const x2 = fill(103, 'Sell', 2, 111);
const x3 = fill(104, 'Sell', 2, 112);
const scaleOutPairs = [
  pair(1, 101, e5, x1, 1),
  pair(2, 101, e5, x2, 2),
  pair(3, 101, e5, x3, 2),
];
const scaleOut = scan([e5, x1, x2, x3], scaleOutPairs);

group('5 → 1+2+2 is one logical position (worked before, must keep working)', [
  c('(1) one cycle, closed', [scaleOut.cycles.length, scaleOut.cycles[0].cycleClosed], [1, true]),
  c('(2) five contracts in and five out', [scaleOut.cycles[0].entryQty, scaleOut.cycles[0].qty], [5, 5]),
  c('(3) the entry is the one fill, the exit is quantity-weighted', [
    scaleOut.cycles[0].avgEntry,
    scaleOut.cycles[0].avgExit,
  ], [100, (110 * 1 + 111 * 2 + 112 * 2) / 5]),
  c('(4) long, keyed on the lowest fill id, four legs', [
    scaleOut.cycles[0].direction,
    scaleOut.cycles[0].keyFillId,
    scaleOut.cycles[0].legs.length,
  ], ['long', 101, 4]),
  // (111.2 − 100) × 5 = 56. Written as the product rather than as a literal
  // because the literal is what got this wrong the first time — and the ORACLE
  // group below caught it, agreeing with the fills against a hand-typed 55.
  //
  // ROUNDED, AND THE ROUNDING IS A FINDING. ./fills.ts' header promises that
  // `(avgSell − avgBuy) × totalQty ≡ Σ (sellᵢ − buyᵢ) × qtyᵢ` holds "exactly",
  // and it does — in real arithmetic. In IEEE 754 the weighted-average route
  // gives 56.000000000000014 here while the cycle's own `−Σ signed × price`
  // gives exactly 56, because the latter never divides. So the two prices a
  // trader is shown still reproduce their P&L to any precision they can read,
  // and the fill expression is the better-conditioned of the two. Worth knowing
  // before anyone asserts bit equality between them in production.
  c('(5) the P&L reproduces the two prices shown beside it',
    Number((scaleOut.cycles[0].pointsPnl ?? 0).toFixed(8)),
    Number(
      (((scaleOut.cycles[0].avgExit ?? 0) - (scaleOut.cycles[0].avgEntry ?? 0)) *
        scaleOut.cycles[0].qty).toFixed(8)
    )),
]);

// ── 2. 2+2 → 4: two entry fills, one exit fill. Worked before. ──────────────

tick = 0;
const i1 = fill(201, 'Buy', 2, 100);
const i2 = fill(202, 'Buy', 2, 102);
const o4 = fill(203, 'Sell', 4, 110);
const scaleInPairs = [pair(1, 101, i1, o4, 2), pair(2, 101, i2, o4, 2)];
const scaleIn = scan([i1, i2, o4], scaleInPairs);

group('2+2 → 4 is one logical position (worked before)', [
  c('(1) one cycle, four contracts', [scaleIn.cycles.length, scaleIn.cycles[0].qty], [1, 4]),
  c('(2) the entry is quantity-weighted across both fills', scaleIn.cycles[0].avgEntry, 101),
  c('(3) two entry legs and one exit leg', [
    scaleIn.cycles[0].legs.filter((l) => l.entry).length,
    scaleIn.cycles[0].legs.filter((l) => !l.entry).length,
  ], [2, 1]),
  c('(4) P&L is (110 − 101) × 4', scaleIn.cycles[0].pointsPnl, 36),
]);

// ── 3. 2+2 → 2+2: §1.3's third row. TWO rows today, one cycle now. ──────────

tick = 0;
const s1 = fill(301, 'Buy', 2, 100);
const s2 = fill(302, 'Buy', 2, 102);
const t1 = fill(303, 'Sell', 2, 110);
const t2 = fill(304, 'Sell', 2, 111);
// Tradovate matches them PAIRWISE, so the two pairs share no fill at all —
// which is exactly why union-find yields two trades.
const bothSidesPairs = [pair(1, 101, s1, t1, 2), pair(2, 101, s2, t2, 2)];
const bothSides = scan([s1, s2, t1, t2], bothSidesPairs);

group('2+2 → 2+2 is ONE logical position (two rows in production today)', [
  c('(1) ONE cycle, not two — the pairs share no fill and it does not matter', bothSides.cycles.length, 1),
  c('(2) four contracts, closed', [bothSides.cycles[0].qty, bothSides.cycles[0].cycleClosed], [4, true]),
  c('(3) both averages span both fills', [
    bothSides.cycles[0].avgEntry,
    bothSides.cycles[0].avgExit,
  ], [101, 110.5]),
  c('(4) all four fills in one cycle, keyed on the lowest', [
    bothSides.cycles[0].fillIds,
    bothSides.cycles[0].keyFillId,
  ], [[301, 302, 303, 304], 301]),
  c('(5) every order of the cycle is carried, entries and exits apart', [
    bothSides.cycles[0].orderIds.length,
    bothSides.cycles[0].entryOrderIds.length,
    bothSides.cycles[0].exitOrderIds.length,
  ], [4, 2, 2]),
]);

// ── 4. CASE א, as measured on 20.10: a short covered in pieces ──────────────
//
// Short 2 entered as 1+1, covered as 1+1, matched pairwise. Stage 0 reported
// components=2, cycles=1, bothSidesInPieces=true on precisely this shape.

tick = 0;
const a1 = fill(6001, 'Sell', 1, 29853.75);
const a2 = fill(6003, 'Sell', 1, 29853.75);
const a3 = fill(6005, 'Buy', 1, 29796.5);
const a4 = fill(6006, 'Buy', 1, 29796.25);
const casePairs = [pair(1, 101, a3, a1, 1), pair(2, 101, a4, a2, 1)];
const caseA = scan([a1, a2, a3, a4], casePairs);

group('CASE א (measured 20.10): one short covered in pieces is ONE trade', [
  c('(1) ONE cycle where production reports two', caseA.cycles.length, 1),
  c('(2) a SHORT, from the first leg and never from the prices', caseA.cycles[0].direction, 'short'),
  c('(3) two contracts, closed, keyed on the lowest entry fill', [
    caseA.cycles[0].qty,
    caseA.cycles[0].cycleClosed,
    caseA.cycles[0].keyFillId,
  ], [2, true, 6001]),
  c('(4) a profitable short is POSITIVE with no direction branch', caseA.cycles[0].pointsPnl, 57.375 * 2),
  c('(5) the entry is the sell and the exit is the buy', [
    caseA.cycles[0].avgEntry,
    caseA.cycles[0].avgExit,
  ], [29853.75, 29796.375]),
  c('(6) two entry legs, two exit legs — "you covered in two pieces"', [
    caseA.cycles[0].legs.filter((l) => l.entry).length,
    caseA.cycles[0].legs.filter((l) => !l.entry).length,
  ], [2, 2]),
]);

// ── 5. CASE ב: close, then re-enter the same contract immediately ───────────

tick = 0;
const b1 = fill(401, 'Buy', 1, 100);
const b2 = fill(402, 'Sell', 1, 110);
const b3 = fill(403, 'Buy', 1, 112);
const b4 = fill(404, 'Sell', 1, 108);
const reentryPairs = [pair(1, 101, b1, b2, 1), pair(2, 101, b3, b4, 1)];
const reentry = scan([b1, b2, b3, b4], reentryPairs);

group('CASE ב: re-entering after flat is a NEW trade, and the first is CLOSED', [
  c('(1) two cycles, both closed', [
    reentry.cycles.length,
    reentry.cycles.map((cycle) => cycle.cycleClosed),
  ], [2, [true, true]]),
  c('(2) two distinct keys', reentry.cycles.map((cycle) => cycle.keyFillId), [401, 403]),
  c('(3) a winner and a loser, not one netted row', reentry.cycles.map((cycle) => cycle.pointsPnl), [10, -4]),
  c('(4) neither one is interday and neither is synthetic', [
    reentry.cycles.some((cycle) => cycle.interday),
    reentry.cycles.some((cycle) => cycle.legs.some((l) => l.splitFromFill)),
  ], [false, false]),
  // THE WHOLE OF THE 19.10 20:04 REPORT. Under `positionFlat` both of these
  // read false while the contract was open and neither reached the journal.
  c('(5) a closed cycle is closed whatever happened next on the contract',
    reentry.cycles.every((cycle) => cycle.cycleClosed), true),
]);

// Re-entry that is STILL OPEN: the first cycle must not be held hostage by it.
tick = 0;
const o1 = fill(411, 'Buy', 1, 100);
const o2 = fill(412, 'Sell', 1, 110);
const o3 = fill(413, 'Buy', 2, 112);
const openTailPairs = [pair(1, 101, o1, o2, 1)];
const openTail = scan([o1, o2, o3], openTailPairs, [position(101, 2)]);

group('CASE ב with the re-entry still OPEN — the closed one is still importable', [
  c('(1) two cycles: one closed, one open', [
    openTail.cycles.length,
    openTail.cycles.map((cycle) => cycle.cycleClosed),
  ], [2, [true, false]]),
  c('(2) the open one carries what is still held', [
    openTail.cycles[1].openQty,
    openTail.cycles[1].qty,
  ], [2, 0]),
  // The unpaired entry fill resolved because exactly one account traded MNQ.
  // Without that inference the walk would be missing a term, reconcile would
  // fail, and the CLOSED cycle would be held with it — case ב all over again.
  c('(3) the unpaired fill was attributed by sole account, not dropped', [
    openTail.inferredAttributions,
    openTail.unattributedFills,
    openTail.held.length,
  ], [1, 0, 0]),
]);

// ── 6. THE FLIP: long 3 → Sell 6 → short 3, one reversing fill ──────────────

tick = 0;
const f1 = fill(501, 'Buy', 3, 100);
const f2 = fill(502, 'Sell', 6, 110);
const f3 = fill(503, 'Buy', 3, 105);
const flipPairs = [pair(1, 101, f1, f2, 3), pair(2, 101, f3, f2, 3)];
const flip = scan([f1, f2, f3], flipPairs);

// What today's merged row shows: qty 6 and the two halves netted.
const mergedPoints = (110 - 100) * 3 + (110 - 105) * 3;

group('THE FLIP is two logical positions, split by quantity at the zero crossing', [
  c('(1) two cycles, not the one merged row production shows', flip.cycles.length, 2),
  c('(2) a long then a short — a row that is both is not representable',
    flip.cycles.map((cycle) => cycle.direction), ['long', 'short']),
  c('(3) three contracts each, both closed', [
    flip.cycles.map((cycle) => cycle.qty),
    flip.cycles.map((cycle) => cycle.cycleClosed),
  ], [[3, 3], [true, true]]),
  c('(4) the reversing fill is marked split in BOTH halves', [
    flip.cycles[0].legs.filter((l) => l.splitFromFill).length,
    flip.cycles[1].legs.filter((l) => l.splitFromFill).length,
  ], [1, 1]),
  c('(5) one price for both halves, so nothing is averaged', [
    flip.cycles[0].avgExit,
    flip.cycles[1].avgEntry,
  ], [110, 110]),
  // THE PROPERTY THAT MAKES THE SPLIT FREE: the day's net does not move.
  c('(6) the two P&Ls sum to the merged figure exactly', [
    flip.cycles[0].pointsPnl,
    flip.cycles[1].pointsPnl,
    (flip.cycles[0].pointsPnl ?? 0) + (flip.cycles[1].pointsPnl ?? 0),
  ], [30, 15, mergedPoints]),
  c('(7) distinct keys, and the shared fill is in both fill lists', [
    flip.cycles.map((cycle) => cycle.keyFillId),
    flip.cycles[0].fillIds.includes(502) && flip.cycles[1].fillIds.includes(502),
  ], [[501, 502], true]),
]);

// ── 7. PARTIAL FILL: entered 3, exited 1, still holding 2 ───────────────────

tick = 0;
const p1 = fill(601, 'Buy', 3, 100);
const p2 = fill(602, 'Sell', 1, 110);
const partialPairs = [pair(1, 101, p1, p2, 1)];
const partial = scan([p1, p2], partialPairs, [position(101, 2)]);

group('PARTIAL FILL: an open cycle with one exit is one open trade', [
  c('(1) one cycle, NOT closed', [partial.cycles.length, partial.cycles[0].cycleClosed], [1, false]),
  c('(2) three in, one out, two still held', [
    partial.cycles[0].entryQty,
    partial.cycles[0].qty,
    partial.cycles[0].openQty,
  ], [3, 1, 2]),
  c('(3) the entry price is known and the exit so far is too', [
    partial.cycles[0].avgEntry,
    partial.cycles[0].avgExit,
  ], [100, 110]),
  c('(4) nothing is held — an open cycle is a state, not a refusal', partial.held.length, 0),
]);

// ── 8. INTERDAY: prevPos ≠ 0, entries unreachable at any price ──────────────

tick = 0;
const n1 = fill(701, 'Sell', 2, 110);
const n2 = fill(702, 'Sell', 1, 111);
// Today's exits of a long of three carried in from yesterday. The entry fills
// are gone: Stage 0 measured /fill/list, /fillPair/list AND /position/list at
// depthDays = 0.
const interdayPairs: CyclePair[] = [];
const interday = scan([n1, n2], interdayPairs, [position(101, 0, { prevPos: 3 })]);

group('INTERDAY: a cycle opened yesterday is marked, never silently priced', [
  c('(1) one cycle, closed, and flagged', [
    interday.cycles.length,
    interday.cycles[0].cycleClosed,
    interday.cycles[0].interday,
  ], [1, true, true]),
  c('(2) direction comes from prevPos, since no entry leg is visible',
    interday.cycles[0].direction, 'long'),
  c('(3) three contracts closed, none entered as far as we can see', [
    interday.cycles[0].qty,
    interday.cycles[0].entryQty,
  ], [3, 0]),
  // THE REFUSAL THAT MATTERS. A partial average of the visible entries would be
  // a price the trader can compare against and that is wrong.
  c('(4) avgEntry, openedAtMs and pointsPnl are NULL — not a plausible guess', [
    interday.cycles[0].avgEntry,
    interday.cycles[0].openedAtMs,
    interday.cycles[0].pointsPnl,
  ], [null, null, null]),
  c('(5) the exits are real and are reported', interday.cycles[0].avgExit, (110 * 2 + 111) / 3),
  c('(6) and with no pairs it cannot be priced, which the caller can see',
    [interday.cycles[0].pairIds, interday.cycles[0].pairedQty], [[], 0]),
]);

// Without `prevPos` the same input must be HELD, not guessed at.
const interdayNoPrev = scan([n1, n2], interdayPairs, [position(101, 0)]);

group('INTERDAY without prevPos: HELD, and the identity is not solved for it', [
  c('(1) no cycle is stated', interdayNoPrev.cycles.length, 0),
  c('(2) held on the reconciliation, with the account named', [
    interdayNoPrev.held.length,
    interdayNoPrev.held[0].reason,
    interdayNoPrev.held[0].accountId,
  ], [1, 'netpos_mismatch', ACCOUNT]),
  // Reported as a DIAGNOSTIC. Acting on it would make the check vacuous: it
  // would pass on every input, including the broken ones it exists to catch.
  c('(3) what prevPos would have had to be is reported, never used',
    interdayNoPrev.held[0].impliedPrevPos, 3),
]);

// ── 9. TWO ACCOUNTS, ONE CONTRACT: the hazard a naive rewrite introduces ────
//
// `/fill/list` pools every account the trader can see and a fill carries no
// accountId, so grouping by contract alone welds REF-110's prop trader's two
// positions into one fabricated cycle.

tick = 0;
const m1 = fill(801, 'Buy', 1, 100);
const m2 = fill(802, 'Buy', 1, 200);
const m3 = fill(803, 'Sell', 1, 110);
const m4 = fill(804, 'Sell', 1, 210);
const twoAccountPairs = [
  pair(1, 101, m1, m3, 1), // account A's position
  pair(2, 102, m2, m4, 1), // account B's, SAME contract
];
const twoAccounts = scan([m1, m2, m3, m4], twoAccountPairs, [
  position(101, 0, { account: ACCOUNT }),
  position(102, 0, { account: OTHER_ACCOUNT }),
]);

group('TWO ACCOUNTS on one contract do not interleave', [
  c('(1) two cycles, one per account', [
    twoAccounts.cycles.length,
    twoAccounts.cycles.map((cycle) => cycle.accountId).sort((a, b) => a - b),
  ], [2, [ACCOUNT, OTHER_ACCOUNT]]),
  c('(2) each one holds only its own fills', [
    twoAccounts.cycles.find((cycle) => cycle.accountId === ACCOUNT)!.fillIds,
    twoAccounts.cycles.find((cycle) => cycle.accountId === OTHER_ACCOUNT)!.fillIds,
  ], [[801, 803], [802, 804]]),
  c('(3) and their money is not pooled', [
    twoAccounts.cycles.find((cycle) => cycle.accountId === ACCOUNT)!.pointsPnl,
    twoAccounts.cycles.find((cycle) => cycle.accountId === OTHER_ACCOUNT)!.pointsPnl,
  ], [10, 10]),
  c('(4) nothing held, nothing inferred — the pairs named every fill', [
    twoAccounts.held.length,
    twoAccounts.inferredAttributions,
  ], [0, 0]),
]);

// And when an UNPAIRED fill lands on a contract two accounts traded, the
// inference is unsafe and the contract is held whole.
tick = 0;
const amb = fill(811, 'Buy', 1, 100);
const ambiguous = cyclesFromFills({
  fills: [m1, m2, m3, m4, amb],
  pairs: twoAccountPairs,
  positions: [
    position(101, 1, { account: ACCOUNT }),
    position(102, 0, { account: OTHER_ACCOUNT }),
  ],
});

group('An unpaired fill on a two-account contract HOLDS the contract whole', [
  c('(1) no cycle is stated for that contract', ambiguous.cycles.length, 0),
  c('(2) the fill is counted as unattributable, not guessed', ambiguous.unattributedFills, 1),
  // Both accounts are held, not just the one that happens to be non-flat: the
  // fill is a real execution whose account we cannot name, so EVERY walk on
  // that contract is missing a term, including the ones that look healthy.
  c('(3) both accounts on the contract are held, with the reason', [
    ambiguous.held.length,
    [...new Set(ambiguous.held.map((item) => item.reason))],
  ], [2, ['unattributed_fill']]),
]);

// ── 10. HELD: the reconciliation identity, four ways to fail it ─────────────

tick = 0;
const r1 = fill(901, 'Buy', 3, 100);
const r2 = fill(902, 'Sell', 1, 110);
const reconPairs = [pair(1, 101, r1, r2, 1)];

// The walk says 2 held; the broker says 3. A fill is missing.
const mismatch = scan([r1, r2], reconPairs, [position(101, 3)]);
// No position row at all: nothing to reconcile against.
const noRow = scan([r1, r2], reconPairs, [position(101, 0, { contract: ES })]);
// Two rows for one (account, contract): which netPos is current is undecidable.
const ambiguousRow = scan([r1, r2], reconPairs, [position(101, 2), position(102, 0)]);
// An unreadable instant has no place in an ordered walk.
const unreadable = scan(
  [{ ...r1, timestamp: 'not a date' }, r2],
  reconPairs,
  [position(101, 2)]
);

group('HELD: the identity that licenses trusting every cycle above', [
  c('(1) the walk disagreeing with netPos holds the group', [
    mismatch.cycles.length,
    mismatch.held[0].reason,
    mismatch.held[0].impliedPrevPos,
  ], [0, 'netpos_mismatch', 1]),
  c('(2) no position row is held, not defaulted to flat', [
    noRow.cycles.length,
    noRow.held[0].reason,
  ], [0, 'no_position_row']),
  c('(3) two position rows are held, not silently picked between', [
    ambiguousRow.cycles.length,
    ambiguousRow.held[0].reason,
  ], [0, 'ambiguous_position']),
  c('(4) an unreadable fill holds its contract', [
    unreadable.cycles.length,
    unreadable.held[0].reason,
  ], [0, 'unreadable_fill']),
  // The direction of every refusal above: not importing corrects itself on the
  // next pull, importing something wrong does not.
  c('(5) a held group states a count, never a partial cycle',
    [mismatch.held[0].fills, mismatch.cycles], [2, []]),
]);

group('reconcile() alone, since it is the one rule that gates every import', [
  c('(1) prevPos stated and consistent', reconcile({ walked: -3, netPos: 0, prevPos: 3 }).ok, true),
  c('(2) prevPos stated and inconsistent', reconcile({ walked: -3, netPos: 0, prevPos: 5 }).ok, false),
  c('(3) prevPos stated seeds the walk, which is what marks interday',
    reconcile({ walked: -3, netPos: 0, prevPos: 3 }).seedNet, 3),
  c('(4) absent prevPos reduces to walked === netPos', [
    reconcile({ walked: 2, netPos: 2 }).ok,
    reconcile({ walked: 2, netPos: 3 }).ok,
  ], [true, false]),
  c('(5) absent prevPos seeds zero — it is never back-solved',
    reconcile({ walked: 2, netPos: 3 }).seedNet, 0),
  c('(6) and the implied value is reported for the operator to read',
    reconcile({ walked: 2, netPos: 3 }).impliedPrevPos, 1),
  c('(7) a non-finite prevPos is treated as absent, not as zero', [
    reconcile({ walked: 2, netPos: 2, prevPos: Number.NaN }).ok,
    reconcile({ walked: 2, netPos: 2, prevPos: Number.NaN }).seedNet,
  ], [true, 0]),
]);

// ── 11. STAGES: one ORDER is one stage, however many fills it took ──────────
//
// REF-117 Stage 7, and the only group here about the PROJECTION rather than the
// walk. The reported bug: a market order for three contracts came back as three
// partial fills, and the card said `נכנסת ב-3 שלבים` about one decision.
//
// `stagesFromLegs` is the production function; these two lines are
// describeCycle's own call site, per side, and nothing else.
const stagesOf = (cycle: LogicalPosition) => ({
  entries: stagesFromLegs(cycle.legs.filter((leg) => leg.entry)),
  exits: stagesFromLegs(cycle.legs.filter((leg) => !leg.entry)),
});

// No pairs anywhere in this group: the projection reads none, and attribution
// falls back to the sole account trading the contract — the INTERDAY precedent.
const noPairs: CyclePair[] = [];

// One order id, shared. Outside the `900_000 + id` range `fill()` defaults to,
// so a fixture that MEANT to share cannot accidentally collide with one that
// did not.
const SHARED_ENTRY_ORDER = 910_001;
const SHARED_EXIT_ORDER = 910_002;
const SHARED_FLIP_ORDER = 910_003;

// 11a. THE REPORTED CASE. Three 1-lot entry fills, two distinct prices, one
// order. Placed beside CASE א deliberately: both cycles have FOUR legs, and the
// only difference between 1+1 stages and 2+2 stages is the order id.
tick = 0;
const pieceA = fill(8001, 'Buy', 1, 100, { order: SHARED_ENTRY_ORDER });
const pieceB = fill(8002, 'Buy', 1, 100, { order: SHARED_ENTRY_ORDER });
const pieceC = fill(8003, 'Buy', 1, 101, { order: SHARED_ENTRY_ORDER });
const pieceExit = fill(8004, 'Sell', 3, 110);
const onePiece = scan([pieceA, pieceB, pieceC, pieceExit], noPairs);
const onePieceStages = stagesOf(onePiece.cycles[0]);

group('STAGES: one order filled in three pieces is ONE stage (the reported bug)', [
  c('(1) still one cycle, three in and three out', [
    onePiece.cycles.length,
    onePiece.cycles[0].entryQty,
    onePiece.cycles[0].qty,
  ], [1, 3, 3]),
  // The walk is unchanged: one leg per fill, as a leg is defined.
  c('(2) FOUR legs — three entry, one exit — exactly as before', [
    onePiece.cycles[0].legs.filter((l) => l.entry).length,
    onePiece.cycles[0].legs.filter((l) => !l.entry).length,
  ], [3, 1]),
  c('(3) ONE entry stage, quantity summed and price quantity-weighted',
    onePieceStages.entries, [{ qty: 3, price: (100 + 100 + 101) / 3 }]),
  c('(4) one exit stage, the single fill carried verbatim',
    onePieceStages.exits, [{ qty: 3, price: 110 }]),
  // §2.2 and migration 040's VERIFY 6: the arrays still sum to `quantity`.
  c('(5) the stages sum to the row quantity on both sides', [
    onePieceStages.entries.reduce((t, s) => t + s.qty, 0),
    onePieceStages.exits.reduce((t, s) => t + s.qty, 0),
  ], [onePiece.cycles[0].entryQty, onePiece.cycles[0].qty]),
  // The grouped stage reproduces the row's average, which is what licenses
  // showing a mean in the detail line under two means in the row.
  c('(6) the grouped stage price IS the row entry price', [
    onePieceStages.entries[0].price,
    onePiece.cycles[0].avgEntry,
  ], [(100 + 100 + 101) / 3, (100 + 100 + 101) / 3]),
  // CASE א re-derived here rather than referenced, so the contrast is one read.
  c('(7) CASE א is untouched: four legs, 2+2 stages, because FOUR orders', [
    stagesOf(caseA.cycles[0]).entries.length,
    stagesOf(caseA.cycles[0]).exits.length,
    caseA.cycles[0].legs.length,
  ], [2, 2, 4]),
]);

// 11b. THE OVER-MERGE GUARD. Three 1-lot entry fills under THREE orders, inside
// ONE SECOND. This is the fixture that fails under a same-second timestamp
// heuristic, which is why the refusal is pinned in a test and not only in prose:
// two separate market orders inside one second are routine at the open, and
// merging them would erase a decision rather than miscount one.
tick = 0;
const ONE_SECOND = new Date(Date.UTC(2026, 9, 20, 14, 31, 7)).toISOString();
// The exit is stated explicitly too. `at` leaves `tick` behind, so a defaulted
// exit would land BEFORE this second and the walk would read the whole fixture
// as a short entered at 110 — which is how the first draft of this fixture
// failed, and worth the extra line to make impossible.
const AFTER_THAT_SECOND = new Date(Date.UTC(2026, 9, 20, 14, 32, 0)).toISOString();
const secA = fill(8101, 'Buy', 1, 100, { at: ONE_SECOND });
const secB = fill(8102, 'Buy', 1, 100, { at: ONE_SECOND });
const secC = fill(8103, 'Buy', 1, 101, { at: ONE_SECOND });
const secExit = fill(8104, 'Sell', 3, 110, { at: AFTER_THAT_SECOND });
const sameSecond = scan([secA, secB, secC, secExit], noPairs);
const sameSecondStages = stagesOf(sameSecond.cycles[0]);

group('STAGES: three orders in ONE SECOND stay three stages', [
  c('(1) the three entry fills really do share an instant',
    new Set([secA.timestamp, secB.timestamp, secC.timestamp]).size, 1),
  // Pins the fixture itself: a long entered in three and exited in one. Without
  // this the mis-ordering above would read as a passing 1-stage entry.
  c('(1b) and the fixture is the long it claims to be', [
    sameSecond.cycles[0].direction,
    sameSecond.cycles[0].legs.filter((l) => l.entry).length,
    sameSecond.cycles[0].legs.filter((l) => !l.entry).length,
  ], ['long', 3, 1]),
  c('(2) three distinct orders, so THREE entry stages',
    sameSecondStages.entries.length, 3),
  c('(3) each stage is its own fill, nothing averaged',
    sameSecondStages.entries, [
      { qty: 1, price: 100 },
      { qty: 1, price: 100 },
      { qty: 1, price: 101 },
    ]),
  // Identical fills, identical prices, identical second as 11a — the order id is
  // the ONLY input that differs, and it decides 3 stages against 1.
  c('(4) same shape as 11a, and only the order id decides the count', [
    sameSecondStages.entries.length,
    onePieceStages.entries.length,
  ], [3, 1]),
]);

// 11c. THE MIRROR, on the exit side (§3). Same code, same fix: a 3-lot scale-out
// order filled in pieces is one exit, not three.
tick = 0;
const mirrorEntry = fill(8201, 'Buy', 3, 100);
const mirrorX1 = fill(8202, 'Sell', 1, 110, { order: SHARED_EXIT_ORDER });
const mirrorX2 = fill(8203, 'Sell', 1, 111, { order: SHARED_EXIT_ORDER });
const mirrorX3 = fill(8204, 'Sell', 1, 111, { order: SHARED_EXIT_ORDER });
const mirror = scan([mirrorEntry, mirrorX1, mirrorX2, mirrorX3], noPairs);
const mirrorStages = stagesOf(mirror.cycles[0]);

group('STAGES: the mirror — one exit order filled in pieces is ONE stage', [
  c('(1) one entry leg and THREE exit legs, as the walk sees it', [
    mirror.cycles[0].legs.filter((l) => l.entry).length,
    mirror.cycles[0].legs.filter((l) => !l.entry).length,
  ], [1, 3]),
  c('(2) 1 → 1 stages, where the old projection said 1 → 3', [
    mirrorStages.entries.length,
    mirrorStages.exits.length,
  ], [1, 1]),
  c('(3) the exit stage is summed and weighted',
    mirrorStages.exits, [{ qty: 3, price: (110 + 111 + 111) / 3 }]),
  c('(4) and it reproduces the row exit price',
    mirrorStages.exits[0].price, mirror.cycles[0].avgExit),
]);

// 11d. ORDER-LESS LEGS. `{ order: 0 }` is rejected by `usable()`, so the leg
// carries no order at all. Each such leg is ITS OWN stage, never pooled into one
// `undefined` bucket — which would merge fills from different decisions, the one
// outcome worse than counting too many.
tick = 0;
const bareA = fill(8301, 'Buy', 1, 100, { order: 0 });
const bareB = fill(8302, 'Buy', 1, 101, { order: 0 });
const bareExit = fill(8303, 'Sell', 2, 110);
const orderless = scan([bareA, bareB, bareExit], noPairs);
const orderlessStages = stagesOf(orderless.cycles[0]);

group('STAGES: legs with no order are never merged with each other', [
  c('(1) neither entry leg carries an order',
    orderless.cycles[0].legs.filter((l) => l.entry).map((l) => l.orderId), [undefined, undefined]),
  c('(2) TWO entry stages, not one — the degraded floor is the old behaviour',
    orderlessStages.entries, [{ qty: 1, price: 100 }, { qty: 1, price: 101 }]),
  c('(3) and the cycle states no entry order either',
    orderless.cycles[0].entryOrderIds.length, 0),
]);

// 11e. THE FLIP, filled in pieces. Long 3, then ONE order to sell 6 that comes
// back as 2+2+2 and reverses through zero, then a buy to close the short. §2.3's
// benign case, pinned so a future refactor cannot quietly average across the
// zero crossing: the crossing fill's two halves carry the SAME price, and the
// grouping is per-cycle AND per-side, so they are never candidates to merge.
tick = 0;
const flipEntry = fill(8401, 'Buy', 3, 100);
const flipS1 = fill(8402, 'Sell', 2, 110, { order: SHARED_FLIP_ORDER });
const flipS2 = fill(8403, 'Sell', 2, 111, { order: SHARED_FLIP_ORDER });
const flipS3 = fill(8404, 'Sell', 2, 112, { order: SHARED_FLIP_ORDER });
const flipClose = fill(8405, 'Buy', 3, 105);
const flipPieces = scan([flipEntry, flipS1, flipS2, flipS3, flipClose], noPairs);
const flipA = stagesOf(flipPieces.cycles[0]);
const flipB = stagesOf(flipPieces.cycles[1]);

group('STAGES: a reversing order filled in pieces is one stage on each side', [
  c('(1) still two cycles, a long then a short, three contracts each', [
    flipPieces.cycles.length,
    flipPieces.cycles.map((cycle) => cycle.direction),
    flipPieces.cycles.map((cycle) => cycle.qty),
  ], [2, ['long', 'short'], [3, 3]]),
  // The old projection: 1 → 2 on the long, 2 → 1 on the short.
  c('(2) the long reports 1 → 1, not 1 → 2', [
    flipA.entries.length,
    flipA.exits.length,
  ], [1, 1]),
  c('(3) the short reports 1 → 1, not 2 → 1', [
    flipB.entries.length,
    flipB.exits.length,
  ], [1, 1]),
  // The 111 fill is the one split at the crossing: 1 to the long's exit, 1 to
  // the short's entry, both at 111. So the long's exit averages 110 and 111 and
  // the short's entry averages 111 and 112 — and 111 is never averaged ACROSS
  // the two cycles, which is what the per-cycle grouping guarantees.
  c('(4) the exit of the long weights 2@110 with the split 1@111',
    flipA.exits, [{ qty: 3, price: (110 * 2 + 111) / 3 }]),
  c('(5) the entry of the short weights the split 1@111 with 2@112',
    flipB.entries, [{ qty: 3, price: (111 + 112 * 2) / 3 }]),
  c('(6) both still reproduce their row prices', [
    flipA.exits[0].price,
    flipB.entries[0].price,
  ], [flipPieces.cycles[0].avgExit, flipPieces.cycles[1].avgEntry]),
  c('(7) the split is still marked in both halves', [
    flipPieces.cycles[0].legs.filter((l) => l.splitFromFill).length,
    flipPieces.cycles[1].legs.filter((l) => l.splitFromFill).length,
  ], [1, 1]),
]);

// ── The oracle: fills and pairs must agree about the money ──────────────────
//
// Stage 2 keeps the PAIR arithmetic in production and asserts it equals the
// fill walk. This is the same equality asserted here, over every fixture that
// has both, so the new expression is checked against the one that has been
// shipping since REF-90.

const oracleCases: Case[] = [
  ['5 → 1+2+2', scaleOut, scaleOutPairs],
  ['2+2 → 4', scaleIn, scaleInPairs],
  ['2+2 → 2+2', bothSides, bothSidesPairs],
  ['case א', caseA, casePairs],
  ['case ב', reentry, reentryPairs],
  ['the flip', flip, flipPairs],
].flatMap(([label, result, pairs]) =>
  (result as ReturnType<typeof scan>).cycles
    .filter((cycle) => cycle.cycleClosed && !cycle.interday)
    .map((cycle, index) =>
      c(
        `${label as string} cycle ${index + 1}: fills ≡ pairs`,
        Number((cycle.pointsPnl ?? 0).toFixed(8)),
        Number(pairPoints(cycle, pairs as CyclePair[]).toFixed(8))
      )
    )
);

group('THE ORACLE: P&L from the fills equals P&L from the pairs', [
  ...oracleCases,
  // And the pairs cover the cycle's whole quantity, which is what tells a
  // priceable cycle from one Stage 2 must refuse.
  c('every closed non-interday cycle is fully covered by its pairs', [
    scaleOut.cycles[0].pairedQty === scaleOut.cycles[0].qty,
    bothSides.cycles[0].pairedQty === bothSides.cycles[0].qty,
    caseA.cycles[0].pairedQty === caseA.cycles[0].qty,
    flip.cycles.every((cycle) => cycle.pairedQty === cycle.qty),
  ], [true, true, true, true]),
]);

// ── Determinism ─────────────────────────────────────────────────────────────
//
// `/fillPair/list` and `/fill/list` promise no ordering, so nothing a journal
// keys on may depend on one. The same property assertion the REF-107 suite
// makes about `groupIntoTrades`.

const reversed = cyclesFromFills({
  fills: [a4, a3, a2, a1],
  pairs: [...casePairs].reverse(),
  positions: [position(101, 0)],
});

group('The scan is deterministic under input order', [
  c('(1) case א reversed is the same cycle', [
    reversed.cycles.length,
    reversed.cycles[0].keyFillId,
    reversed.cycles[0].direction,
    reversed.cycles[0].qty,
    reversed.cycles[0].pointsPnl,
  ], [1, 6001, 'short', 2, caseA.cycles[0].pointsPnl]),
  c('(2) down to the leg order, which is what the journal renders',
    reversed.cycles[0].legs.map((l) => l.fillId),
    caseA.cycles[0].legs.map((l) => l.fillId)),
]);

// ── Result ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.log(`\n${failures.length} failed:`);
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
console.log('\nAll groups passed.');
