/**
 * Stop-history regression suite (REF-113 Stage 2).
 *
 * There is no unit-test runner in this repository, so this follows the
 * precedent of scripts/broker-import-check.ts and scripts/accounts-check.ts: a
 * plain `tsx` script of assertions that prints one line per group and exits
 * non-zero on any failure.
 *
 * NOTHING HERE TOUCHES THE NETWORK, SUPABASE, OR A CREDENTIAL. The reader is a
 * hand-built stub over in-memory order rows, and the half of the module that
 * matters — {@link deriveStopHistory} — is pure. Safe to run anywhere, with no
 * .env.local.
 *
 *
 * THE FIXTURES ARE THE MEASURED TRADE, NOT AN INVENTION
 *
 * {@link BRACKET} reproduces the shape the 19.10 measurement reported: a real
 * bracketed entry on a live account, a stop DRAGGED TWICE BY HAND (three
 * versions, three distinct stop prices, `id` and `stopPrice` the only fields
 * that changed), a target, and a MANUAL CLOSE that left the stop `Canceled`.
 * Every group below is a departure from that one shape, so a failure says which
 * property broke rather than which fixture.
 *
 *
 * WHAT IT COVERS, AND WHY EACH GROUP IS HERE
 *
 *   - **The measured case end to end.** Two moves, tightened, linked through
 *     the bracket, the stop furthest from entry, the target nearest it.
 *   - **A cancellation is not a move.** Edge case 5, and the one that would
 *     silently report a move the trader never made.
 *   - **`'none'` is a finding and `'unknown'` is our failure**, and the four
 *     ways the second happens: inter-day, ambiguous, capped, failed. A trade
 *     over the ceiling must read `'unknown'` and NEVER `'none'`.
 *   - **The transient half of `'unknown'` is not stored**, so the next run of
 *     the same trading day tries again. Storing it would take the row out of
 *     `stop_history IS NULL` forever.
 *   - **Several stops resolve to the furthest and several targets to the
 *     nearest** — the deliberate asymmetry (Imri, 19.10).
 *   - **`isAutomated` can only subtract.** Missing, true and false are three
 *     distinct inputs and two of them count the move.
 *   - **One request per order per run.** A bracket closing two trades is read
 *     once.
 *   - **Nothing identifying reaches a log or an error.** A stop price, an order
 *     id, an account id and a symbol are absent from every line the reader
 *     emits, including the line it emits when a read fails with the trader's
 *     prices in the response body.
 *
 * Usage: npm run test:broker-orders
 */

import {
  candidateOrders,
  deriveStopHistory,
  MAX_ORDER_DEPS_PER_RUN,
  readStopHistories,
  type StopEvidence,
  type StopHistory,
} from '../src/lib/tradovate/orders';
import type { BrokerTrade, TradovateReader } from '../src/lib/tradovate/fills';
import { TradovateRequestError } from '../src/lib/tradovate/errors';
import type {
  TradovateOrder,
  TradovateOrderStrategy,
  TradovateOrderStrategyLink,
  TradovateOrderVersion,
} from '../src/lib/tradovate/types';

// ── Harness ─────────────────────────────────────────────────────────────────

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

function group(name: string, cases: Case[]) {
  const bad = cases.filter((entry) => !same(entry.got, entry.want));
  console.log(
    `${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`
  );
  for (const entry of bad) {
    console.log(`         ${entry.label}: got ${show(entry.got)} want ${show(entry.want)}`);
    failures.push(`${name} / ${entry.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

async function captureLogs<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const sinks = ['info', 'warn', 'error', 'log'] as const;
  const originals = sinks.map((name) => console[name]);
  for (const name of sinks) {
    console[name] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  }
  try {
    const result = await run();
    return { result, lines };
  } finally {
    sinks.forEach((name, i) => {
      console[name] = originals[i];
    });
  }
}

// ── Fixtures: the measured trade ────────────────────────────────────────────

const ACCOUNT = 1_805_221;
const OTHER_ACCOUNT = 1_900_777;
const CONTRACT = 2_765_111;
const OTHER_CONTRACT = 2_765_999;

/** The entry, in trading-day time. The bracket is submitted WITH it. */
const SUBMITTED = Date.parse('2026-10-19T14:31:00.000Z');
const CLOSED = Date.parse('2026-10-19T15:12:00.000Z');

const ENTRY_PRICE = 4510.25;
/** The three stop prices the measurement saw, dragged up twice. */
const STOP_1 = 4504.0;
const STOP_2 = 4508.5;
const STOP_3 = 4512.0;
const TARGET = 4525.0;

const ENTRY_ORDER = 77_401;
const STOP_ORDER = 77_402;
const TARGET_ORDER = 77_403;
const EXIT_ORDER = 77_410;
const STRATEGY = 55_001;

/** A long on one contract, closed by hand — the measured shape. */
const TRADE: BrokerTrade = {
  brokerTradeKey: 'demo:88412',
  host: 'demo',
  accountId: ACCOUNT,
  symbol: 'ESZ6',
  direction: 'long',
  qty: 1,
  entryPrice: ENTRY_PRICE,
  exitPrice: 4518.5,
  openedAtMs: SUBMITTED + 2_000,
  closedAtMs: CLOSED,
  pnlUsd: 412.5,
  fillIds: [88_412, 88_490],
  // The entry order and the order that closed it. The stop is NOT here: it was
  // cancelled, so it produced no fill.
  entryOrderIds: [ENTRY_ORDER, EXIT_ORDER],
  positionFlat: true,
};

function order(
  id: number,
  overrides: Partial<TradovateOrder> = {}
): TradovateOrder {
  return {
    id,
    accountId: ACCOUNT,
    contractId: CONTRACT,
    action: 'Sell',
    ordStatus: 'Canceled',
    timestamp: new Date(SUBMITTED).toISOString(),
    ...overrides,
  };
}

function version(
  id: number,
  orderId: number,
  overrides: Partial<TradovateOrderVersion> = {}
): TradovateOrderVersion {
  return { id, orderId, ...overrides };
}

/** The bracket, as measured: entry + stop (three versions) + target + manual exit. */
const BRACKET = {
  orders: [
    order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
    order(STOP_ORDER),
    order(TARGET_ORDER),
    order(EXIT_ORDER, {
      ordStatus: 'Filled',
      timestamp: new Date(CLOSED - 1_000).toISOString(),
    }),
  ],
  versions: [
    version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
    // The New, then the two drags. `id` ascending is the only ordering there is.
    version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1, orderQty: 1 }),
    version(90_003, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_2, orderQty: 1 }),
    version(90_004, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_3, orderQty: 1 }),
    version(90_005, TARGET_ORDER, { orderType: 'Limit', price: TARGET, orderQty: 1 }),
    version(90_006, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
  ],
  links: [ENTRY_ORDER, STOP_ORDER, TARGET_ORDER],
};

/** Evidence assembled the way the reader assembles it, from plain arrays. */
function evidenceOf(params: {
  orders: readonly TradovateOrder[];
  versions: readonly TradovateOrderVersion[];
  /** Order ids belonging to one strategy. Empty means no bracket at all. */
  links?: readonly number[];
  /** Order ids whose versions were NOT read — the ceiling, or a failure. */
  unread?: readonly number[];
  strategiesComplete?: boolean;
  unscanned?: StopEvidence['unscanned'];
  automated?: ReadonlyMap<number, boolean>;
}): StopEvidence {
  const unread = new Set(params.unread ?? []);
  const orders = new Map(params.orders.map((row) => [row.id, row]));

  const versions = new Map<number, TradovateOrderVersion[]>();
  for (const row of params.versions) {
    if (unread.has(row.orderId)) continue;
    const list = versions.get(row.orderId) ?? [];
    list.push(row);
    versions.set(row.orderId, list);
  }
  // An order with no version row at all still counts as READ when it was not
  // named as unread — the reader records an empty array in that case.
  for (const row of params.orders) {
    if (!unread.has(row.id) && !versions.has(row.id)) versions.set(row.id, []);
  }

  const strategyByOrder = new Map<number, number>();
  for (const id of params.links ?? []) strategyByOrder.set(id, STRATEGY);

  return {
    orders,
    versions,
    strategyByOrder,
    strategiesComplete: params.strategiesComplete ?? true,
    unscanned: params.unscanned ?? (unread.size > 0 ? 'capped' : null),
    automated: params.automated,
  };
}

/** One trade's answer, from arrays. The shorthand every group below uses. */
function derive(
  params: Parameters<typeof evidenceOf>[0] & { trade?: BrokerTrade; trades?: BrokerTrade[] }
): StopHistory {
  const trade = params.trade ?? TRADE;
  return deriveStopHistory({
    trade,
    trades: params.trades ?? [trade],
    evidence: evidenceOf(params),
  });
}

// ── The reader stub ─────────────────────────────────────────────────────────

interface StubPlan {
  orders: readonly TradovateOrder[];
  versions: readonly TradovateOrderVersion[];
  strategies?: readonly TradovateOrderStrategy[];
  links?: Record<number, readonly TradovateOrderStrategyLink[]>;
  /** Paths that throw. The body is deliberately full of greppable secrets. */
  failing?: readonly string[];
}

/** The leak canary: a response body that is nothing but the trader's data. */
const SECRET_BODY = `[{"id":${STOP_ORDER},"accountId":${ACCOUNT},"stopPrice":${STOP_1},"symbol":"ESZ6"}]`;

class StubReader {
  readonly calls: { path: string; masterid?: number }[] = [];

  constructor(private readonly plan: StubPlan) {}

  reader(): TradovateReader {
    return {
      get: async <T,>(path: string, query?: Record<string, unknown>): Promise<T> => {
        const masterid = typeof query?.masterid === 'number' ? query.masterid : undefined;
        this.calls.push({ path, masterid });

        if (this.plan.failing?.includes(path)) {
          throw new TradovateRequestError(path, 500, SECRET_BODY);
        }

        if (path === '/order/list') return this.plan.orders as unknown as T;
        if (path === '/orderStrategy/list') return (this.plan.strategies ?? []) as unknown as T;
        if (path === '/orderStrategyLink/deps') {
          return ((masterid !== undefined ? this.plan.links?.[masterid] : []) ?? []) as unknown as T;
        }
        if (path === '/orderVersion/deps') {
          return this.plan.versions.filter((row) => row.orderId === masterid) as unknown as T;
        }
        return [] as unknown as T;
      },
    };
  }

  countOf(path: string): number {
    return this.calls.filter((call) => call.path === path).length;
  }
}

/** The stub wired to the measured bracket. */
function bracketPlan(overrides: Partial<StubPlan> = {}): StubPlan {
  return {
    orders: BRACKET.orders,
    versions: BRACKET.versions,
    strategies: [{ id: STRATEGY }],
    links: { [STRATEGY]: BRACKET.links.map((orderId, i) => ({ id: 1_000 + i, orderId })) },
    ...overrides,
  };
}

// ── Groups ──────────────────────────────────────────────────────────────────

function measuredCaseGroup() {
  const history = derive({ ...BRACKET });

  group('the 19.10 trade: a bracket, a stop dragged twice, a manual close', [
    c('(1) the verdict is `moved`, and it is not `unknown`',
      [history.verdict, history.reason], ['moved', null]),
    // The New plus two drags is TWO moves, not three versions.
    c('(2) two moves, tightened, over consecutive steps',
      [history.movedCount, history.direction], [2, 'tightened']),
    c('(3) the initial stop is the first version and the final is the last',
      [history.initialStop, history.finalStop], [STOP_1, STOP_3]),
    c('(4) every stated stop price is kept as evidence, oldest first',
      history.versions, [{ stopPrice: STOP_1 }, { stopPrice: STOP_2 }, { stopPrice: STOP_3 }]),
    c('(5) the target came out of the same bracket', history.initialTarget, TARGET),
    // The stop was reached through `orderStrategy`, not guessed from a window.
    c('(6) attribution is LINKED, never inferred', history.source, 'linked'),
    c('(7) not a trailing stop, and a stop was placed',
      [history.trailing, history.noStopPlaced], [false, false]),
    // v1 reads zero `/command/list`, so there is no instant to carry (§2.1).
    c('(8) movedAtMs is null, and says so rather than being absent',
      [history.movedAtMs, 'movedAtMs' in history], [null, true]),
    c('(9) one trade, so nothing is shared',
      [history.sharedWithTrades ?? null, history.capped ?? null], [null, null]),
  ]);
}

function cancellationGroup() {
  // The manual close cancelled the stop. If a host mints a version for that —
  // the measured one did not — it carries no stop price, and reading it as a
  // move would report a drag the trader never made.
  const cancelled = derive({
    ...BRACKET,
    versions: [
      ...BRACKET.versions,
      version(90_007, STOP_ORDER, { orderType: 'Stop', orderQty: 1 }),
    ],
  });

  // The same stop, never touched: one version, one price.
  const kept = derive({
    ...BRACKET,
    versions: BRACKET.versions.filter((row) => row.id !== 90_003 && row.id !== 90_004),
  });

  // Dragged up to break-even and back down again. End-to-end comparison would
  // say it never moved; it moved twice (§C).
  const thereAndBack = derive({
    ...BRACKET,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1 }),
      version(90_003, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_3 }),
      version(90_004, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1 }),
      version(90_005, TARGET_ORDER, { orderType: 'Limit', price: TARGET }),
    ],
  });

  // A short's stop is above the entry, so DOWN is toward it. This is the
  // comparison family the rule context's header records shipping backwards once.
  const short = derive({
    ...BRACKET,
    trade: { ...TRADE, direction: 'short', entryPrice: 4510.25 },
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: 4516 }),
      version(90_003, STOP_ORDER, { orderType: 'Stop', stopPrice: 4512 }),
    ],
  });

  group('a cancellation is not a move, and direction is read off the trade', [
    c('(1) a version with no stop price does not count as a third move',
      [cancelled.movedCount, cancelled.verdict], [2, 'moved']),
    c('(2) and does not become the final stop', cancelled.finalStop, STOP_3),
    c('(3) a stop that was never touched is `kept`, not `none`',
      [kept.verdict, kept.movedCount, kept.direction], ['kept', 0, null]),
    c('(4) and `kept` still reports the stop that was there',
      [kept.initialStop, kept.finalStop], [STOP_1, STOP_1]),
    c('(5) up then back down is TWO moves and `mixed`, not zero',
      [thereAndBack.movedCount, thereAndBack.direction], [2, 'mixed']),
    c('(6) a long tightens upward', derive({ ...BRACKET }).direction, 'tightened'),
    c('(7) a short tightens DOWNWARD', [short.movedCount, short.direction], [1, 'tightened']),
  ]);
}

function severalOrdersGroup() {
  // A long of three contracts: one stop at 98, two at 99. The risk taken was
  // 98 — the FURTHEST — and the nearer number would flatter the R:R.
  const twoStops = derive({
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(STOP_ORDER),
      order(STOP_ORDER + 100),
      order(TARGET_ORDER),
      order(TARGET_ORDER + 100),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 3 }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: 4506, orderQty: 1 }),
      version(90_003, STOP_ORDER + 100, { orderType: 'Stop', stopPrice: 4500, orderQty: 2 }),
      version(90_004, TARGET_ORDER, { orderType: 'Limit', price: 4530, orderQty: 1 }),
      version(90_005, TARGET_ORDER + 100, { orderType: 'Limit', price: 4520, orderQty: 2 }),
      version(90_006, EXIT_ORDER, { orderType: 'Market', orderQty: 3 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER, STOP_ORDER + 100, TARGET_ORDER, TARGET_ORDER + 100],
    trade: { ...TRADE, qty: 3 },
  });

  // A bracket with a target and no stop. A FINDING, and the one a coach can
  // act on: decision 2 says no stop is a fact in its own right.
  const targetOnly = derive({
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(TARGET_ORDER),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_005, TARGET_ORDER, { orderType: 'Limit', price: TARGET }),
      version(90_006, EXIT_ORDER, { orderType: 'Market' }),
    ],
    links: [ENTRY_ORDER, TARGET_ORDER],
  });

  group('several stops take the furthest; several targets take the nearest', [
    c('(1) the stop is the one FURTHEST from entry', twoStops.initialStop, 4500),
    c('(2) the target is the one NEAREST it', twoStops.initialTarget, 4520),
    c('(3) and the targets that lost are kept, nearest first', twoStops.otherTargets, [4530]),
    c('(4) a bracket with no stop is `none` and says so',
      [targetOnly.verdict, targetOnly.noStopPlaced, targetOnly.reason],
      ['none', true, null]),
    c('(5) `none` carries no stop price and no direction',
      [targetOnly.initialStop, targetOnly.finalStop, targetOnly.direction, targetOnly.movedCount],
      [null, null, null, 0]),
    c('(6) and still reports the target it did find', targetOnly.initialTarget, TARGET),
  ]);
}

function automatedGroup() {
  const versions = [
    version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
    version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1 }),
    version(90_003, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_2 }),
    version(90_004, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_3 }),
  ];

  const missing = derive({ ...BRACKET, versions });
  const stated = derive({
    ...BRACKET,
    versions,
    automated: new Map([
      [90_003, false],
      [90_004, false],
    ]),
  });
  const serverMoved = derive({
    ...BRACKET,
    versions,
    automated: new Map([
      [90_003, true],
      [90_004, true],
    ]),
  });
  const half = derive({ ...BRACKET, versions, automated: new Map([[90_003, true]]) });

  group('isAutomated can only take a move away, never confirm one', [
    // The flag was present on 8 of 15 measured commands, and "Tradovate omits
    // a false boolean" cannot be told from "not populated on this type".
    c('(1) ABSENT falls back to the version verdict — the move counts',
      [missing.verdict, missing.movedCount], ['moved', 2]),
    c('(2) false counts it too, and agrees with absent',
      [stated.verdict, stated.movedCount], ['moved', 2]),
    // The whole point: a wrong `moved_sl = true` arms `moved_sl_last_trade`,
    // which can be `block_day`. Muting is the affordable error.
    c('(3) true is NOT counted, so an all-server trail reads as `kept`',
      [serverMoved.verdict, serverMoved.movedCount, serverMoved.direction],
      ['kept', 0, null]),
    c('(4) and the stop prices are still reported in full',
      [serverMoved.initialStop, serverMoved.finalStop], [STOP_1, STOP_3]),
    c('(5) one of two attributed: one move, and still `moved`',
      [half.verdict, half.movedCount], ['moved', 1]),
  ]);
}

function trailingGroup() {
  // Decision 4's fallback (option 1): no `pegDifference` in the sample, so the
  // verdict comes from the prices and `trailing` is the flag that explains it.
  const noPeg = derive({
    ...BRACKET,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'TrailingStop', stopPrice: STOP_1 }),
      version(90_003, STOP_ORDER, { orderType: 'TrailingStop', stopPrice: STOP_2 }),
    ],
  });

  // Option 4: the trail distance GREW, so the trader loosened the trail itself
  // and that step is a genuine widening however the price moved.
  const loosened = derive({
    ...BRACKET,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'TrailingStop', stopPrice: STOP_1, pegDifference: 4 }),
      version(90_003, STOP_ORDER, { orderType: 'TrailingStop', stopPrice: STOP_2, pegDifference: 10 }),
    ],
  });

  // A StopLimit is a STOP, and the substring test must not read it as a target.
  const stopLimit = derive({
    ...BRACKET,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'StopLimit', stopPrice: STOP_1, price: STOP_1 - 1 }),
    ],
  });

  group('a trailing stop is tightened and flagged; a loosened trail is widened', [
    c('(1) trailing is flagged', noPeg.trailing, true),
    c('(2) and reads as tightened from the prices alone (option 1)',
      [noPeg.verdict, noPeg.movedCount, noPeg.direction], ['moved', 1, 'tightened']),
    c('(3) a GROWN pegDifference makes the step a widening (option 4)',
      [loosened.movedCount, loosened.direction], [1, 'widened']),
    c('(4) a StopLimit is a stop, not a target',
      [stopLimit.verdict, stopLimit.initialStop, stopLimit.initialTarget],
      ['kept', STOP_1, null]),
  ]);
}

function layerGroup() {
  // Layer A: the stop IS the exit. It is in `entryOrderIds` because it produced
  // the fill that closed the trade, so nothing is inferred and no bracket is
  // needed at all.
  const stopWasExit = derive({
    orders: [order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }), order(STOP_ORDER, { ordStatus: 'Filled' })],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1 }),
    ],
    links: [],
    trade: { ...TRADE, entryOrderIds: [ENTRY_ORDER, STOP_ORDER] },
  });

  // Layer C: a stop placed by hand after entering, with no bracket anywhere.
  const manualStop = derive({
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
      order(STOP_ORDER, { timestamp: new Date(SUBMITTED + 120_000).toISOString() }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_006, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: STOP_1, orderQty: 1 }),
    ],
    links: [],
  });

  // The window's four negative filters, one order each. None may be attributed.
  const rejected = derive({
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
      // Another account's stop.
      order(81_001, { accountId: OTHER_ACCOUNT }),
      // Another contract's.
      order(81_002, { contractId: OTHER_CONTRACT }),
      // The entry side: a scale-in, not a stop.
      order(81_003, { action: 'Buy' }),
      // Submitted an hour after the trade was closed.
      order(81_004, { timestamp: new Date(CLOSED + 3_600_000).toISOString() }),
      // Bigger than the position ever was.
      order(81_005),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_006, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(91_001, 81_001, { orderType: 'Stop', stopPrice: 4400, orderQty: 1 }),
      version(91_002, 81_002, { orderType: 'Stop', stopPrice: 4401, orderQty: 1 }),
      version(91_003, 81_003, { orderType: 'Stop', stopPrice: 4402, orderQty: 1 }),
      version(91_004, 81_004, { orderType: 'Stop', stopPrice: 4403, orderQty: 1 }),
      version(91_005, 81_005, { orderType: 'Stop', stopPrice: 4404, orderQty: 9 }),
    ],
    links: [],
  });

  // A LINKED stop and a window candidate in the same day: the link wins and the
  // inference is never even considered.
  const linkWins = derive({
    orders: [
      ...BRACKET.orders,
      order(81_006, { timestamp: new Date(SUBMITTED + 60_000).toISOString() }),
    ],
    versions: [
      ...BRACKET.versions,
      // Further from entry than the bracket's stop. If the window ran, this
      // would win on the furthest-stop rule — which is exactly why it must not.
      version(91_006, 81_006, { orderType: 'Stop', stopPrice: 4400, orderQty: 1 }),
    ],
    links: BRACKET.links,
  });

  const candidates = candidateOrders({
    trade: TRADE,
    evidence: {
      orders: new Map(BRACKET.orders.map((row) => [row.id, row])),
      strategyByOrder: new Map(BRACKET.links.map((id) => [id, STRATEGY])),
    },
  });

  group('three layers, strongest first — an inference never outranks a link', [
    c('(1) layer A: the stop that closed the trade needs no bracket',
      [stopWasExit.verdict, stopWasExit.initialStop, stopWasExit.source],
      ['kept', STOP_1, 'linked']),
    c('(2) layer C: a hand-placed stop with no bracket is found, as INFERRED',
      [manualStop.verdict, manualStop.initialStop, manualStop.source],
      ['kept', STOP_1, 'inferred']),
    // Every one of the five was rejected, so the answer is the FINDING `none`
    // and not a stop belonging to somebody else's position.
    c('(3) wrong account, wrong contract, entry side, out of window, too big',
      [rejected.verdict, rejected.initialStop], ['none', null]),
    c('(4) a bracket stop beats a window candidate that is further out',
      [linkWins.initialStop, linkWins.source], [STOP_1, 'linked']),
    c('(5) the candidate set is the trade\'s own orders plus its bracket siblings',
      candidates.map((entry) => entry.orderId).sort((a, b) => a - b),
      [ENTRY_ORDER, STOP_ORDER, TARGET_ORDER, EXIT_ORDER].sort((a, b) => a - b)),
    c('(6) and names the layer each came from',
      candidates.filter((entry) => entry.layer === 'strategy').map((entry) => entry.orderId),
      [STOP_ORDER, TARGET_ORDER]),
  ]);
}

function sharedAndAmbiguousGroup() {
  // §1.3. One entry order for three contracts, filling in three pieces paired
  // with three separate exits, produces three BrokerTrade rows that share the
  // entry order. There was ONE stop on ONE position.
  const siblings: BrokerTrade[] = [
    { ...TRADE, brokerTradeKey: 'demo:1', fillIds: [1, 2] },
    { ...TRADE, brokerTradeKey: 'demo:2', fillIds: [3, 4] },
    { ...TRADE, brokerTradeKey: 'demo:3', fillIds: [5, 6] },
  ];
  const shared = deriveStopHistory({
    trade: siblings[0],
    trades: siblings,
    evidence: evidenceOf({ ...BRACKET }),
  });

  // Two positions open at once in the same contract, sharing no order. Which
  // stop belonged to which is not recoverable, and a guess would put one
  // trade's risk on the other's row.
  const parallel: BrokerTrade[] = [
    TRADE,
    {
      ...TRADE,
      brokerTradeKey: 'demo:parallel',
      entryOrderIds: [78_501, 78_502],
      fillIds: [7, 8],
    },
  ];
  const ambiguous = deriveStopHistory({
    trade: parallel[0],
    trades: parallel,
    evidence: evidenceOf({
      orders: [
        ...BRACKET.orders,
        order(78_501, { action: 'Buy', ordStatus: 'Filled' }),
        order(78_502, { ordStatus: 'Filled' }),
      ],
      versions: [
        ...BRACKET.versions,
        version(92_001, 78_501, { orderType: 'Market' }),
        version(92_002, 78_502, { orderType: 'Market' }),
      ],
      links: BRACKET.links,
    }),
  });

  // The same two trades, not overlapping in time: ordinary attribution.
  const sequential = deriveStopHistory({
    trade: parallel[0],
    trades: [
      parallel[0],
      {
        ...parallel[1],
        openedAtMs: CLOSED + 600_000,
        closedAtMs: CLOSED + 900_000,
      },
    ],
    evidence: evidenceOf({
      orders: [
        ...BRACKET.orders,
        order(78_501, {
          action: 'Buy',
          ordStatus: 'Filled',
          timestamp: new Date(CLOSED + 600_000).toISOString(),
        }),
        order(78_502, { ordStatus: 'Filled', timestamp: new Date(CLOSED + 900_000).toISOString() }),
      ],
      versions: [
        ...BRACKET.versions,
        version(92_001, 78_501, { orderType: 'Market' }),
        version(92_002, 78_502, { orderType: 'Market' }),
      ],
      links: BRACKET.links,
    }),
  });

  group('one position split across rows is shared; two positions are refused', [
    c('(1) one stop, three rows, attributed to all of them',
      [shared.verdict, shared.initialStop], ['moved', STOP_1]),
    c('(2) and the row says how many it was shared with', shared.sharedWithTrades, 3),
    c('(3) two parallel positions sharing no order: `unknown`, reason ambiguous',
      [ambiguous.verdict, ambiguous.reason], ['unknown', 'ambiguous']),
    c('(4) and nothing is claimed about the prices',
      [ambiguous.initialStop, ambiguous.initialTarget, ambiguous.movedCount],
      [null, null, 0]),
    c('(5) the same two trades, not overlapping, attribute normally',
      [sequential.verdict, sequential.initialStop, sequential.sharedWithTrades ?? null],
      ['moved', STOP_1, null]),
  ]);
}

function unknownGroup() {
  // The inter-day trade: the entry order was submitted yesterday and
  // `/order/list` has already forgotten it. Every swing trade is this case.
  const interday = derive({
    orders: [order(81_100, { action: 'Buy' })],
    versions: [version(93_001, 81_100, { orderType: 'Market' })],
    links: [],
  });

  // The ceiling. The stop's versions were never asked for, so "there was no
  // stop" is not a conclusion this run is entitled to.
  const capped = derive({ ...BRACKET, unread: [STOP_ORDER, TARGET_ORDER] });

  // The same gap, from a failed read rather than from the ceiling.
  const failed = derive({
    ...BRACKET,
    unread: [STOP_ORDER, TARGET_ORDER],
    unscanned: 'failed',
  });

  // The bracket map could not be completed, so a bracket may have been missed.
  const noStrategyMap = derive({
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market' }),
      version(90_006, EXIT_ORDER, { orderType: 'Market' }),
    ],
    links: [],
    strategiesComplete: false,
    unscanned: 'failed',
  });

  // A trade with no usable order ids at all — `usableId` dropped them upstream.
  const noOrderIds = derive({
    ...BRACKET,
    trade: { ...TRADE, entryOrderIds: [] },
  });

  group('`unknown` is never `none`, and it says which kind of unknown it is', [
    c('(1) an inter-day trade is unknown, NOT `none`',
      [interday.verdict, interday.reason, interday.noStopPlaced],
      ['unknown', 'interday', false]),
    c('(2) over the ceiling: unknown, reason capped, and flagged',
      [capped.verdict, capped.reason, capped.capped], ['unknown', 'capped', true]),
    c('(3) a failed read is unknown too, and is told apart from the ceiling',
      [failed.verdict, failed.reason, failed.capped ?? null], ['unknown', 'failed', null]),
    c('(4) an incomplete bracket map refuses to conclude `none`',
      [noStrategyMap.verdict, noStrategyMap.reason], ['unknown', 'failed']),
    c('(5) a trade whose order ids were unusable is unknown',
      [noOrderIds.verdict, noOrderIds.reason], ['unknown', 'interday']),
    // Every unknown shape is a complete StopHistory, so a consumer never has to
    // test for a missing field.
    c('(6) an unknown still carries every field',
      [interday.source, interday.versions, interday.otherTargets, interday.movedAtMs],
      ['none', [], [], null]),
  ]);
}

async function readerGroup() {
  const stub = new StubReader(bracketPlan());
  const { result: histories } = await captureLogs(() =>
    readStopHistories({ readers: { demo: stub.reader() }, trades: [TRADE] })
  );

  // Two trades closed by the same bracket. The versions of each order are
  // fetched ONCE for the run — §4.3's first guard, the same discipline
  // `loadContractUnits` applies.
  const sharedStub = new StubReader(bracketPlan());
  const second: BrokerTrade = { ...TRADE, brokerTradeKey: 'demo:88500', fillIds: [3, 4] };
  const { result: both } = await captureLogs(() =>
    readStopHistories({ readers: { demo: sharedStub.reader() }, trades: [TRADE, second] })
  );

  // The other host's reader is never asked, because no trade came from it.
  const liveStub = new StubReader(bracketPlan());
  await captureLogs(() =>
    readStopHistories({
      readers: { demo: new StubReader(bracketPlan()).reader(), live: liveStub.reader() },
      trades: [TRADE],
    })
  );

  // An order belonging to another account is in the visible scope of
  // `/order/list` and must not be read at all.
  const scoped = new StubReader(
    bracketPlan({
      orders: [...BRACKET.orders, order(81_200, { accountId: OTHER_ACCOUNT })],
    })
  );
  await captureLogs(() =>
    readStopHistories({ readers: { demo: scoped.reader() }, trades: [TRADE] })
  );

  group('the reader: one request per order, per run, for this trader only', [
    c('(1) the measured trade comes back as moved',
      [histories.size, histories.get(TRADE.brokerTradeKey)?.verdict], [1, 'moved']),
    c('(2) one /order/list and one /orderStrategy/list, whatever the trade count',
      [stub.countOf('/order/list'), stub.countOf('/orderStrategy/list')], [1, 1]),
    // Four: the trade's own two orders plus the two bracket siblings. Not one
    // per TRADE, and not one per version.
    c('(3) one /orderVersion/deps per candidate order',
      stub.countOf('/orderVersion/deps'), 4),
    c('(4) two trades on one bracket: both answered, and the deps are not doubled',
      [both.size, sharedStub.countOf('/orderVersion/deps')], [2, 4]),
    c('(5) a host with no trades in the run is never asked', liveStub.calls.length, 0),
    c('(6) another account\'s order is never fetched',
      scoped.calls.some((call) => call.masterid === 81_200), false),
  ]);
}

async function readerFailureGroup() {
  // `/order/list` down: no evidence of any kind, so no trade is answered — and
  // nothing is thrown, because a failure here must not cost the trader their
  // journal rows.
  const listDown = new StubReader(bracketPlan({ failing: ['/order/list'] }));
  const { result: none, lines: listLines } = await captureLogs(() =>
    readStopHistories({ readers: { demo: listDown.reader() }, trades: [TRADE] })
  );

  // The versions read down. The gap is TRANSIENT, so the entry is dropped
  // rather than stored as `'unknown'` — storing it would take the row out of
  // `stop_history IS NULL` and the next run of the day would skip it.
  const depsDown = new StubReader(bracketPlan({ failing: ['/orderVersion/deps'] }));
  const { result: dropped } = await captureLogs(() =>
    readStopHistories({ readers: { demo: depsDown.reader() }, trades: [TRADE] })
  );

  // The ceiling, reached for real: a budget of two covers the strategy list's
  // one link call and one version call, and the rest are never asked.
  const ceiling = new StubReader(bracketPlan());
  const { result: cappedOut } = await captureLogs(() =>
    readStopHistories({ readers: { demo: ceiling.reader() }, trades: [TRADE], maxDeps: 2 })
  );

  // An inter-day trade: permanent, so it IS stored — that is what makes the
  // display able to say "we could not read the stop orders" rather than
  // nothing at all.
  const interdayStub = new StubReader(bracketPlan({ orders: [], versions: [] }));
  const { result: storedUnknown } = await captureLogs(() =>
    readStopHistories({ readers: { demo: interdayStub.reader() }, trades: [TRADE] })
  );

  group('a read that fails costs one nullable column, and is retried', [
    c('(1) /order/list down: nothing answered, nothing thrown', none.size, 0),
    c('(2) and it was logged as a KIND, with the status', listLines.length, 1),
    c('(3) deps down: the transient unknown is DROPPED, so the row stays a candidate',
      dropped.size, 0),
    c('(4) the ceiling stops the scan and drops those trades too',
      [cappedOut.size, ceiling.countOf('/orderVersion/deps') <= 2], [0, true]),
    // The permanent half of `'unknown'` is the opposite decision, and it is the
    // one that makes "לא ידוע" distinguishable from "not looked" on screen.
    c('(5) an inter-day trade IS stored, with its reason',
      [storedUnknown.size, storedUnknown.get(TRADE.brokerTradeKey)?.reason],
      [1, 'interday']),
    c('(6) the ceiling is a constant, not a magic number in a loop',
      MAX_ORDER_DEPS_PER_RUN, 60),
  ]);
}

async function leakGroup() {
  // Every read fails, and every failure body is nothing but the trader's data:
  // a stop price, an order id, an account id and a symbol. `withoutResponseBody`
  // runs before the error is even classified.
  const leaky = new StubReader(
    bracketPlan({
      failing: ['/order/list', '/orderStrategy/list', '/orderStrategyLink/deps', '/orderVersion/deps'],
    })
  );
  const { lines: failureLines } = await captureLogs(() =>
    readStopHistories({ readers: { demo: leaky.reader() }, trades: [TRADE] })
  );

  // And the successful path's own line, which is the one that runs every day.
  const quiet = new StubReader(bracketPlan());
  const { lines: successLines } = await captureLogs(() =>
    readStopHistories({ readers: { demo: quiet.reader() }, trades: [TRADE] })
  );

  const all = [...failureLines, ...successLines].join('\n');
  const secrets: [string, string][] = [
    ['a stop price', String(STOP_1)],
    ['the final stop', String(STOP_3)],
    ['the target', String(TARGET)],
    ['the entry price', String(ENTRY_PRICE)],
    ['an order id', String(STOP_ORDER)],
    ['an account id', String(ACCOUNT)],
    ['a contract id', String(CONTRACT)],
    ['the symbol', 'ESZ6'],
    ['the broker trade key', TRADE.brokerTradeKey],
    ['the whole response body', SECRET_BODY],
  ];

  group('not one price, id or symbol reaches a log line', [
    ...secrets.map(([what, value]) => c(`(1) ${what} is absent`, all.includes(value), false)),
    // What a line DOES carry: counts, and the error's name and status.
    c('(2) the failure line names the kind and the status',
      failureLines.some((line) => line.includes('TradovateRequestError:500')), true),
    c('(3) the daily line is counts only',
      successLines.some((line) => /orders=\d+ candidates=\d+ deps=\d+/.test(line)), true),
    c('(4) and it reports the verdict totals, never a per-symbol count',
      successLines.some((line) => /moved=1 kept=0 none=0 unknown=0/.test(line)), true),
  ]);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  measuredCaseGroup();
  cancellationGroup();
  severalOrdersGroup();
  automatedGroup();
  trailingGroup();
  layerGroup();
  sharedAndAmbiguousGroup();
  unknownGroup();
  await readerGroup();
  await readerFailureGroup();
  await leakGroup();

  console.log('');
  if (failures.length > 0) {
    console.log(`${failures.length} assertion(s) failed:`);
    for (const line of failures) console.log(`  - ${line}`);
    process.exit(1);
  }
  console.log('All stop-history assertions passed.');
}

void main();
