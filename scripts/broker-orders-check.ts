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
 *   - **The initial stop is the one the position OPENED under.** Q8's seven
 *     measured versions, where version one is eleven ticks from the entry and
 *     the stop the trader actually took is a hundred and thirty-one; plus the
 *     clock that decides it, every way that clock can be unavailable, and the
 *     drag onto the market that is an exit rather than a move.
 *   - **`isAutomated` can only subtract.** Missing, true and false are three
 *     distinct inputs and two of them count the move.
 *   - **One request per order per run.** A bracket closing two trades is read
 *     once, `/command/list` is one call per host however many orders the day
 *     held, and it does not spend the deps ceiling.
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
  TradovateCommand,
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
  /**
   * `orderId` → its versions' instants, as `/command/list` supplies them.
   *
   * Written as a plain object because every fixture below states it per order,
   * and OMITTING IT IS A CASE IN ITS OWN RIGHT: no instants means the fill
   * anchor falls back to version one, which is what every group written before
   * this one is now also testing.
   */
  commandTimes?: Record<number, readonly number[]>;
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

  const commandTimes = new Map<number, readonly number[]>();
  for (const [orderId, stamps] of Object.entries(params.commandTimes ?? {})) {
    commandTimes.set(Number(orderId), stamps);
  }

  return {
    orders,
    versions,
    strategyByOrder,
    strategiesComplete: params.strategiesComplete ?? true,
    unscanned: params.unscanned ?? (unread.size > 0 ? 'capped' : null),
    automated: params.automated,
    commandTimes: params.commandTimes === undefined ? undefined : commandTimes,
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
  /** The day's commands, in no particular order — the reader sorts them. */
  commands?: readonly TradovateCommand[];
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
        if (path === '/command/list') return (this.plan.commands ?? []) as unknown as T;
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

/**
 * One command per version of the bracket's stop, all after the entry fill —
 * which is what a bracket submitted with a MARKET entry looks like.
 *
 * DELIBERATELY OUT OF ORDER, and one of them belongs to another account's order
 * entirely. The reader sorts, and it scopes through the orders map rather than
 * through a field on the command.
 */
const BRACKET_COMMANDS: readonly TradovateCommand[] = [
  { id: 701, orderId: STOP_ORDER, timestamp: new Date(TRADE.openedAtMs + 200_000).toISOString() },
  { id: 702, orderId: STOP_ORDER, timestamp: new Date(TRADE.openedAtMs + 10_000).toISOString() },
  { id: 703, orderId: STOP_ORDER, timestamp: new Date(TRADE.openedAtMs + 100_000).toISOString() },
  { id: 704, orderId: 81_200, timestamp: new Date(TRADE.openedAtMs).toISOString() },
];

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
    // No commands in this fixture, so the fill anchor fell back to version one
    // — which on a market entry with one stop is the same version it would have
    // anchored on anyway. `fillAnchorGroup` is where the two diverge.
    c('(10) the anchor fell back, and the shape says so rather than implying it',
      [history.preFillVersions, history.anchoredAtFill], [0, false]),
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
  //
  // THE ORDERS ARE MIRRORED TOO, AND THEY HAVE TO BE. A short is ENTERED with a
  // sell and PROTECTED with a buy, so reusing the long BRACKET's actions under
  // `direction: 'short'` describes a state no broker can produce — which is
  // what this fixture did until the side test started reading `action`, and the
  // incoherence was invisible precisely because nothing read it.
  const short = derive({
    ...BRACKET,
    orders: [
      order(ENTRY_ORDER, { action: 'Sell', ordStatus: 'Filled' }),
      order(STOP_ORDER, { action: 'Buy' }),
      order(TARGET_ORDER, { action: 'Buy' }),
      order(EXIT_ORDER, {
        action: 'Buy',
        ordStatus: 'Filled',
        timestamp: new Date(CLOSED - 1_000).toISOString(),
      }),
    ],
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

/**
 * The side of the entry, in both places that test it. REF-113 follow-up.
 *
 * EVERY CASE HERE IS A REGRESSION AND THE FIRST ONE IS THE PRODUCTION ROW. On
 * 19.10, MNQZ6 long, entry 29704.00: the trade stored `broker_stop_loss =
 * 29741` — 148 ticks ABOVE the entry, where a long's sell stop fills on arrival
 * — with `direction = 'widened'`, while the trader's actual stop had gone from
 * 29671.25 out to 29650 and then up to break-even, which is `'mixed'`. Two
 * independent defects had to line up to produce it, so the cases below pin them
 * separately and then together:
 *
 *   - ADMISSION. Layers A and B offered candidates without testing `action`, so
 *     a breakout entry — a BUY stop on a long — was eligible to be the
 *     protective stop it opened the position against.
 *   - SELECTION. "The furthest from entry" was `Math.abs`, which has no side,
 *     so a wrong-side price won whenever it was further out. 37.00 > 32.75.
 *
 * AND THE SUITE MISSED IT BY ONE FIXTURE FIELD. `severalOrdersGroup` had always
 * tested two stops against each other, but both were below the entry, where an
 * absolute distance gives the right answer for the wrong reason; and every
 * fixture in this file made the entry a `Market` order, which no side test can
 * fail. Case (7) is here to keep the fix from over-reaching in the other
 * direction.
 */
function wrongSideGroup() {
  // ── The production row, as a fixture ──────────────────────────────────────
  const MNQ_ENTRY = 29_704.0;
  const PLAN_STOP = 29_671.25; // 131 ticks below the entry
  const WIDENED = 29_650.0; // the drag that increased risk
  const GHOST = 29_741.0; // what was stored: 148 ticks ABOVE the entry
  const MNQ_TARGET = 29_790.0;
  const SECOND_STOP = STOP_ORDER + 3;

  const mnq: BrokerTrade = {
    ...TRADE,
    symbol: 'MNQZ6',
    entryPrice: MNQ_ENTRY,
    exitPrice: 29_714.75,
  };

  // The 19.10 shape, reconstructed: the entry is a BUY STOP whose trigger the
  // trader walked down twice before it filled (seven versions, three distinct
  // prices, the rest qty/TIF modifies), beside the real protective stop with
  // the two drags they remember.
  const breakoutEntry = derive({
    trade: mnq,
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
      version(90_001, ENTRY_ORDER, { orderType: 'Stop', stopPrice: GHOST, orderQty: 1 }),
      version(90_002, ENTRY_ORDER, { orderType: 'Stop', stopPrice: GHOST, orderQty: 1 }),
      version(90_003, ENTRY_ORDER, { orderType: 'Stop', stopPrice: 29_720.0, orderQty: 1 }),
      version(90_004, ENTRY_ORDER, { orderType: 'Stop', stopPrice: 29_720.0, orderQty: 1 }),
      version(90_005, ENTRY_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      version(90_006, ENTRY_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      version(90_007, ENTRY_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      version(90_010, STOP_ORDER, { orderType: 'Stop', stopPrice: PLAN_STOP, orderQty: 1 }),
      version(90_011, STOP_ORDER, { orderType: 'Stop', stopPrice: WIDENED, orderQty: 1 }),
      version(90_012, STOP_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      version(90_020, TARGET_ORDER, { orderType: 'Limit', price: MNQ_TARGET, orderQty: 1 }),
      version(90_021, TARGET_ORDER, { orderType: 'Limit', price: MNQ_TARGET, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER, TARGET_ORDER],
  });

  // The same breakout entry with NO protective stop behind it. The entry order
  // is a stop order and it is the only one — and the honest answer is the
  // FINDING, not a verdict derived from the trigger. Decision 2.
  const breakoutNoStop = derive({
    trade: mnq,
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(EXIT_ORDER, {
        ordStatus: 'Filled',
        timestamp: new Date(CLOSED - 1_000).toISOString(),
      }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Stop', stopPrice: GHOST, orderQty: 1 }),
      version(90_002, ENTRY_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER],
  });

  // Two SELL stops — both honestly on the closing side, so the admission test
  // cannot separate them — and the wrong-side one is FURTHER from the entry.
  // This is the case `Math.abs` lost and the only one `riskOf` can win.
  const twoSellStops = derive({
    trade: mnq,
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(STOP_ORDER),
      order(SECOND_STOP),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: PLAN_STOP, orderQty: 1 }),
      version(90_010, SECOND_STOP, { orderType: 'Stop', stopPrice: GHOST, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER, SECOND_STOP, TARGET_ORDER],
  });

  // EVERY candidate on the wrong side. The partition has nothing good to
  // prefer, and what it must not do is empty the set — an empty set is `'none'`,
  // which would tell a coach this trader had no stop at all.
  const allWrongSide = derive({
    trade: mnq,
    orders: [
      order(ENTRY_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
      order(STOP_ORDER),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: GHOST, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER],
  });

  // The target's twin defect, and the fixture OMITS `action` on the entry order
  // on purpose: the admission test is fail-open on an absent side, so this case
  // reaches the selection test and nothing else can save it. A resting BUY
  // LIMIT entry is `isTargetType` and sits at distance zero from the fill it
  // produced, so under "nearest the entry" it outranked the real target.
  const limitEntry = derive({
    trade: mnq,
    orders: [
      order(ENTRY_ORDER, { action: undefined, ordStatus: 'Filled' }),
      order(STOP_ORDER),
      order(TARGET_ORDER),
      order(EXIT_ORDER, { ordStatus: 'Filled' }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Limit', price: MNQ_ENTRY, orderQty: 1 }),
      version(90_002, STOP_ORDER, { orderType: 'Stop', stopPrice: PLAN_STOP, orderQty: 1 }),
      version(90_020, TARGET_ORDER, { orderType: 'Limit', price: MNQ_TARGET, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER, TARGET_ORDER],
  });

  // ── The mirror, on a short ────────────────────────────────────────────────
  // A short is entered with a sell and protected with a buy, and its stop is
  // ABOVE the entry — so every sign in both tests has to invert. Two stops,
  // the wrong-side one further out, and a sell-stop entry to be excluded.
  const shortTrade: BrokerTrade = { ...mnq, direction: 'short' };
  const shortTwoStops = derive({
    trade: shortTrade,
    orders: [
      order(ENTRY_ORDER, { action: 'Sell', ordStatus: 'Filled' }),
      order(STOP_ORDER, { action: 'Buy' }),
      order(SECOND_STOP, { action: 'Buy' }),
      order(EXIT_ORDER, { action: 'Buy', ordStatus: 'Filled' }),
    ],
    versions: [
      // The entry: a SELL stop breakdown trigger, walked UP twice. Admissible
      // under the old code, and further from the entry than the real stop.
      version(90_001, ENTRY_ORDER, { orderType: 'Stop', stopPrice: 29_667.0, orderQty: 1 }),
      version(90_002, ENTRY_ORDER, { orderType: 'Stop', stopPrice: MNQ_ENTRY, orderQty: 1 }),
      // The real stop, above the entry, and a wrong-side sibling below it.
      version(90_010, STOP_ORDER, { orderType: 'Stop', stopPrice: 29_736.75, orderQty: 1 }),
      version(90_020, SECOND_STOP, { orderType: 'Stop', stopPrice: 29_663.0, orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER, SECOND_STOP],
  });

  // The measured 19.10 bracket, unchanged, as the guard against over-reach:
  // STOP_3 (4512.00) is ABOVE the 4510.25 entry because the trader dragged the
  // stop into profit, which is the healthiest thing in the fixture set. A side
  // test anchored to the LAST version instead of the first would call it a
  // defect and throw the number away.
  const draggedIntoProfit = derive({ ...BRACKET });

  group('the side of the entry: an entry order is never a protective stop', [
    c('(1) REGRESSION, 19.10 MNQZ6: the stop is the trader\'s, not the breakout trigger',
      [breakoutEntry.initialStop, breakoutEntry.finalStop, breakoutEntry.direction],
      [PLAN_STOP, MNQ_ENTRY, 'mixed']),
    c('(2) and the whole row the production bug wrote is gone',
      [breakoutEntry.movedCount, breakoutEntry.initialStopSide, breakoutEntry.initialTarget,
       breakoutEntry.verdict],
      [2, 'risk', MNQ_TARGET, 'moved']),
    c('(3) a breakout entry with no protective stop is the FINDING `none`',
      [breakoutNoStop.verdict, breakoutNoStop.noStopPlaced, breakoutNoStop.initialStop,
       breakoutNoStop.reason],
      ['none', true, null, null]),
    c('(4) two sell stops: the one on the RISK side wins, not the further one',
      [twoSellStops.initialStop, twoSellStops.initialStopSide],
      [PLAN_STOP, 'risk']),
    c('(5) all candidates wrong-side is reported and flagged, NEVER `none`',
      [allWrongSide.verdict, allWrongSide.initialStop, allWrongSide.initialStopSide,
       allWrongSide.noStopPlaced],
      ['kept', GHOST, 'wrong', false]),
    c('(6) a resting LIMIT ENTRY does not become the target, even with no `action`',
      [limitEntry.initialTarget, limitEntry.otherTargets],
      [MNQ_TARGET, [MNQ_ENTRY]]),
    c('(7) a short mirrors both tests: its stop is ABOVE the entry',
      [shortTwoStops.initialStop, shortTwoStops.initialStopSide, shortTwoStops.verdict],
      [29_736.75, 'risk', 'kept']),
    // The guard. See the comment above `draggedIntoProfit`.
    c('(8) a stop dragged INTO PROFIT is still a risk-side stop — only v1 is tested',
      [draggedIntoProfit.initialStop, draggedIntoProfit.finalStop,
       draggedIntoProfit.initialStopSide],
      [STOP_1, STOP_3, 'risk']),
  ]);
}

/**
 * The fill anchor, and the fixture is Q8's own numbers. REF-113 follow-up.
 *
 * THE MEASUREMENT. `?mode=orders` on 19.10 reported the MNQZ6 long's protective
 * stop as SEVEN versions, as signed tick distances from the 29704.00 entry:
 *
 *     -11   -132   -131   -131   -211   -90   +1
 *
 * and the trader's account of the same trade is two drags. Both are true. The
 * entry was a BUY STOP they walked down twice before it filled, and a bracket
 * re-prices its stop every time the entry it hangs off moves, so versions one
 * to three are the broker following the trigger — the third minted at the fill,
 * where 132 ticks off the trigger became 131 off the price that actually filled.
 * Version four is a modify that restates the price. Five and six are the drags.
 * Seven is the stop pulled onto the market to get out.
 *
 * WHAT THE PRE-ANCHOR CODE STORED, AND IT IS CASE (2) BELOW: `initialStop`
 * 29701.25, which is version one, ELEVEN TICKS of risk on a trade that risked a
 * hundred and thirty-one, with `movedCount = 5`. That row is in the database and
 * `ref-113-direction-investigation.md` §2 is the reading of it.
 *
 * AND THE EXIT PRICE IS THE ONE THING HERE THAT IS A READING RATHER THAN A
 * MEASUREMENT. Q8 reports the version at +1 tick; whether the trade got out AT
 * that price (the stop dragged onto the market, which is what makes it an exit
 * and not a move) or ABOVE it (the stop tightened to break-even and cancelled
 * while the market ran on, which makes it a third move) is not in the version
 * list. Both are fixtures — (1) and (8) — because the two differ by one move on
 * a real row and the difference should be visible in the suite rather than
 * assumed in the module.
 */
function fillAnchorGroup() {
  const ENTRY = 29_704.0;
  const TICK = 0.25;
  /** A signed tick distance from the entry, which is how Q8 reported these. */
  const at = (ticks: number) => ENTRY + ticks * TICK;

  /** Q8's seven versions, in ticks. The whole fixture is derived from this. */
  const Q8 = [-11, -132, -131, -131, -211, -90, 1];
  const PRICES = Q8.map(at);

  const FILL = Date.parse('2026-10-19T11:16:00.000Z');
  const EXIT = FILL + 240_000;
  /**
   * One instant per version, as `/command/list` supplies them.
   *
   * THE THIRD IS THE FILL ITSELF, and that is the `<=` the anchor turns on: the
   * version the broker minted as the position opened is the stop the position
   * opened under. A `<` here would anchor on -132 and report three moves.
   */
  const STAMPS = [
    FILL - 180_000,
    FILL - 60_000,
    FILL,
    FILL + 30_000,
    FILL + 90_000,
    FILL + 150_000,
    EXIT,
  ];

  const mnq: BrokerTrade = {
    ...TRADE,
    symbol: 'MNQZ6',
    entryPrice: ENTRY,
    // The stop was dragged onto the market, so the trade got out at it.
    exitPrice: at(1),
    openedAtMs: FILL,
    closedAtMs: EXIT,
  };

  const orders = [
    order(ENTRY_ORDER, {
      action: 'Buy',
      ordStatus: 'Filled',
      timestamp: new Date(FILL - 180_000).toISOString(),
    }),
    order(STOP_ORDER, { timestamp: new Date(FILL - 180_000).toISOString() }),
    order(EXIT_ORDER, { ordStatus: 'Filled', timestamp: new Date(EXIT).toISOString() }),
  ];

  /** The stop's seven versions, plus the entry trigger's and the exit's. */
  const versions = [
    // The breakout trigger, as +148 ticks. A `Buy` on a long, so the side test
    // keeps it out of the candidate set — pinned in `wrongSideGroup`.
    version(90_001, ENTRY_ORDER, { orderType: 'Stop', stopPrice: at(148), orderQty: 1 }),
    ...PRICES.map((stopPrice, i) =>
      version(90_010 + i, STOP_ORDER, { orderType: 'Stop', stopPrice, orderQty: 1 })
    ),
    version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
  ];

  const base = { trade: mnq, orders, versions, links: [ENTRY_ORDER, STOP_ORDER] };

  // ── (1) The measurement, anchored ─────────────────────────────────────────
  const anchored = derive({ ...base, commandTimes: { [STOP_ORDER]: STAMPS } });

  // ── (2) No clock: the production answer, and flagged as one ───────────────
  const noClock = derive({ ...base });

  // ── (3) A command list shorter than the version list is REFUSED ───────────
  // Three instants for seven versions cannot be paired positionally, and a
  // partial pairing would anchor on whichever version happened to be timed.
  const short = derive({ ...base, commandTimes: { [STOP_ORDER]: STAMPS.slice(0, 3) } });

  // ── (4) The version's own timestamp outranks the commands ─────────────────
  // Measured absent, so this branch is live only on a host that sends it — and
  // it needs no pairing, so it is tried first. The commands here are deliberate
  // nonsense: all before the fill, which would anchor on the last version.
  const stamped = derive({
    ...base,
    versions: versions.map((row) =>
      row.orderId === STOP_ORDER
        ? { ...row, timestamp: new Date(STAMPS[row.id - 90_010]).toISOString() }
        : row
    ),
    commandTimes: { [STOP_ORDER]: STAMPS.map(() => FILL - 300_000) },
  });

  // ── (5) A stop placed by hand AFTER the trader was already in ─────────────
  // Every version is after the fill, so nothing precedes the initial stop — the
  // same `preFillVersions: 0` as case (2) and the opposite `anchoredAtFill`.
  const afterFill = derive({
    ...base,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_010, STOP_ORDER, { orderType: 'Stop', stopPrice: at(-131), orderQty: 1 }),
      version(90_011, STOP_ORDER, { orderType: 'Stop', stopPrice: at(-90), orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    commandTimes: { [STOP_ORDER]: [FILL + 30_000, FILL + 60_000] },
  });

  // ── (6) Restated prices are not moves ────────────────────────────────────
  // A quantity or TIF modify mints a version at the price it already had. Four
  // of them inside the window is a stop that was never touched.
  const restated = derive({
    ...base,
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      ...[at(-131), at(-131), at(-131), at(-131)].map((stopPrice, i) =>
        version(90_010 + i, STOP_ORDER, { orderType: 'Stop', stopPrice, orderQty: 1 })
      ),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    commandTimes: { [STOP_ORDER]: [FILL - 1_000, FILL + 1_000, FILL + 2_000, FILL + 3_000] },
  });

  // ── (7) The mirror, on a short ───────────────────────────────────────────
  // Every sign inverts: the entry is a SELL stop walked UP, the protective stop
  // is ABOVE the entry, and the drag onto the market goes DOWN through the exit.
  const shortTrade: BrokerTrade = { ...mnq, direction: 'short', exitPrice: at(-1) };
  const short_ = derive({
    trade: shortTrade,
    orders: [
      order(ENTRY_ORDER, {
        action: 'Sell',
        ordStatus: 'Filled',
        timestamp: new Date(FILL - 180_000).toISOString(),
      }),
      order(STOP_ORDER, { action: 'Buy', timestamp: new Date(FILL - 180_000).toISOString() }),
      order(EXIT_ORDER, {
        action: 'Buy',
        ordStatus: 'Filled',
        timestamp: new Date(EXIT).toISOString(),
      }),
    ],
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Stop', stopPrice: at(-148), orderQty: 1 }),
      ...Q8.map((ticks, i) =>
        version(90_010 + i, STOP_ORDER, { orderType: 'Stop', stopPrice: at(-ticks), orderQty: 1 })
      ),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    links: [ENTRY_ORDER, STOP_ORDER],
    commandTimes: { [STOP_ORDER]: STAMPS },
  });

  // ── (8) The other reading of the exit ────────────────────────────────────
  // The trade got out ABOVE the stop's last version — `ref-113-direction-
  // investigation.md` records a manual exit at 29714.75 — so the +1 tick
  // version is a stop tightened to break-even and then cancelled, which is a
  // real move. The last step crossed nothing, and the cut must not fire.
  const exitAbove = derive({
    ...base,
    trade: { ...mnq, exitPrice: 29_714.75 },
    commandTimes: { [STOP_ORDER]: STAMPS },
  });

  // ── (9) The cut never empties the window ─────────────────────────────────
  // One version, beyond the exit, on a cancelled order: the trader placed a
  // stop, closed by hand, and the market ran past where the stop had been.
  // There is no step to have crossed anything and `initialStop` has to exist.
  const onlyVersion = derive({
    ...base,
    trade: { ...mnq, exitPrice: at(-200) },
    versions: [
      version(90_001, ENTRY_ORDER, { orderType: 'Market', orderQty: 1 }),
      version(90_010, STOP_ORDER, { orderType: 'Stop', stopPrice: at(-131), orderQty: 1 }),
      version(90_030, EXIT_ORDER, { orderType: 'Market', orderQty: 1 }),
    ],
    commandTimes: { [STOP_ORDER]: [FILL + 10_000] },
  });

  group('the fill anchor: the stop the position OPENED under, not version one', [
    c('(1) REGRESSION, Q8 19.10: the anchor is the version minted at the fill',
      [anchored.initialStop, anchored.preFillVersions, anchored.anchoredAtFill],
      [at(-131), 2, true]),
    c('(1b) two moves and `mixed` — the drags the trader remembers, and no more',
      [anchored.movedCount, anchored.direction, anchored.verdict],
      [2, 'mixed', 'moved']),
    c('(1c) the final stop is the last PROTECTIVE version, not the exit drag',
      anchored.finalStop, at(-90)),
    c('(1d) and all seven versions are still there as evidence',
      anchored.versions.map((v) => v.stopPrice), PRICES),
    c('(1e) the side is read off the anchored version',
      anchored.initialStopSide, 'risk'),
    // The row production actually wrote. 29701.25 is eleven ticks of risk on a
    // trade that risked a hundred and thirty-one.
    c('(2) no clock: the pre-anchor answer, and `anchoredAtFill` says so',
      [noClock.initialStop, noClock.anchoredAtFill, noClock.preFillVersions],
      [29_701.25, false, 0]),
    c('(3) a command list shorter than the versions is refused outright',
      [short.initialStop, short.anchoredAtFill], [29_701.25, false]),
    c('(4) a version that carries its own timestamp outranks the commands',
      [stamped.initialStop, stamped.movedCount, stamped.anchoredAtFill],
      [at(-131), 2, true]),
    // Both are `preFillVersions: 0`. The flag is the only thing that separates
    // "nothing preceded the stop" from "we could not tell".
    c('(5) a stop placed after the fill anchors on version one, and the clock RAN',
      [afterFill.initialStop, afterFill.preFillVersions, afterFill.anchoredAtFill,
       afterFill.movedCount],
      [at(-131), 0, true, 1]),
    // The anchor is version one here — it was already in force at the fill —
    // so nothing precedes it and all four restatements are inside the window.
    c('(6) a version that restates its price is not a move',
      [restated.verdict, restated.movedCount, restated.initialStop, restated.preFillVersions],
      ['kept', 0, at(-131), 0]),
    c('(7) a short mirrors every sign of it',
      [short_.initialStop, short_.finalStop, short_.movedCount, short_.direction,
       short_.preFillVersions],
      [at(131), at(90), 2, 'mixed', 2]),
    // The boundary of the exit cut: a last step that crossed nothing.
    c('(8) a stop tightened to break-even and cancelled is a MOVE, not an exit',
      [exitAbove.movedCount, exitAbove.finalStop, exitAbove.direction],
      [3, at(1), 'mixed']),
    c('(9) the exit cut never empties the window',
      [onlyVersion.initialStop, onlyVersion.finalStop, onlyVersion.verdict],
      [at(-131), at(-131), 'kept']),
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
    // THREE AND NOT FOUR, AND THE FOURTH IS THE 19.10 DEFECT. This assertion
    // used to expect ENTRY_ORDER in the set, which is a `Buy` on a long — an
    // order that cannot protect the position it opened. The entry is still what
    // anchors the window and what carries the bracket link; it is simply no
    // longer offered as something that might be the stop.
    c('(5) the candidate set is the trade\'s CLOSING-side orders and bracket siblings',
      candidates.map((entry) => entry.orderId).sort((a, b) => a - b),
      [STOP_ORDER, TARGET_ORDER, EXIT_ORDER].sort((a, b) => a - b)),
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

  // The anchor's clock, end to end through the reader. The bracket's stop has
  // three versions and three commands, all after the fill, so the anchor is
  // version one — and the point is that it got there by READING a clock.
  const timed = new StubReader(bracketPlan({ commands: BRACKET_COMMANDS }));
  const { result: withClock } = await captureLogs(() =>
    readStopHistories({ readers: { demo: timed.reader() }, trades: [TRADE] })
  );

  // THE CEILING IS NOT SPENT ON IT. A budget of four is exactly one strategy
  // link plus the three candidate orders' versions; if `/command/list` took one
  // the scan would cap out, the trade would be dropped, and this would be 0.
  const tight = new StubReader(bracketPlan({ commands: BRACKET_COMMANDS }));
  const { result: onBudget } = await captureLogs(() =>
    readStopHistories({ readers: { demo: tight.reader() }, trades: [TRADE], maxDeps: 4 })
  );

  group('the reader: one request per order, per run, for this trader only', [
    c('(1) the measured trade comes back as moved',
      [histories.size, histories.get(TRADE.brokerTradeKey)?.verdict], [1, 'moved']),
    c('(2) one /order/list and one /orderStrategy/list, whatever the trade count',
      [stub.countOf('/order/list'), stub.countOf('/orderStrategy/list')], [1, 1]),
    c('(2b) and one /command/list, which is a list and not a per-order deps call',
      [stub.countOf('/command/list'), stub.countOf('/commandReport/deps')], [1, 0]),
    // Three: the exit order plus the two bracket siblings. Not one per TRADE,
    // and not one per version. WAS FOUR BEFORE THE SIDE TEST — the entry order
    // is no longer a candidate, so the run is one request cheaper as well as
    // one answer more honest. The ceiling spends on fewer orders too.
    c('(3) one /orderVersion/deps per candidate order',
      stub.countOf('/orderVersion/deps'), 3),
    c('(4) two trades on one bracket: both answered, and the deps are not doubled',
      [both.size, sharedStub.countOf('/orderVersion/deps')], [2, 3]),
    c('(5) a host with no trades in the run is never asked', liveStub.calls.length, 0),
    c('(6) another account\'s order is never fetched',
      scoped.calls.some((call) => call.masterid === 81_200), false),
    // The clock reached the derivation. Without the commands this same trade
    // comes back `anchoredAtFill: false` — assertion (1) above runs that plan.
    c('(7) the commands reach the anchor, and the fallback flag clears',
      [withClock.get(TRADE.brokerTradeKey)?.anchoredAtFill,
       histories.get(TRADE.brokerTradeKey)?.anchoredAtFill],
      [true, false]),
    c('(8) and the anchored answer is still the measured one',
      [withClock.get(TRADE.brokerTradeKey)?.initialStop,
       withClock.get(TRADE.brokerTradeKey)?.movedCount],
      [STOP_1, 2]),
    c('(9) /command/list does not spend the deps ceiling',
      [onBudget.size, onBudget.get(TRADE.brokerTradeKey)?.verdict], [1, 'moved']),
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

  // `/command/list` down. THE ONLY READ HERE WHOSE FAILURE IS NOT A GAP IN THE
  // EVIDENCE: it costs the anchor and nothing else, so the trade is answered,
  // stored, and never retried — the alternative is withholding a verdict, a
  // stop price and a target over a field that says how the anchor was reached.
  const clockDown = new StubReader(
    bracketPlan({ commands: BRACKET_COMMANDS, failing: ['/command/list'] })
  );
  const { result: unanchored, lines: clockLines } = await captureLogs(() =>
    readStopHistories({ readers: { demo: clockDown.reader() }, trades: [TRADE] })
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
    // A worse anchor, not an unreadable one. This is the one failure in the
    // module that does not reach for `'unknown'`.
    c('(7) /command/list down: the trade is still answered, with the flag down',
      [unanchored.size, unanchored.get(TRADE.brokerTradeKey)?.verdict,
       unanchored.get(TRADE.brokerTradeKey)?.anchoredAtFill,
       unanchored.get(TRADE.brokerTradeKey)?.reason],
      [1, 'moved', false, null]),
    c('(8) and it was logged as a KIND, like every other failure',
      clockLines.some((line) => line.includes('TradovateRequestError:500')), true),
    // An inter-day day has no candidate orders, so there is nothing for a clock
    // to place and the request is not made rather than made and discarded.
    c('(9) a day with no candidate orders never asks for the commands',
      interdayStub.countOf('/command/list'), 0),
  ]);
}

async function leakGroup() {
  // Every read fails, and every failure body is nothing but the trader's data:
  // a stop price, an order id, an account id and a symbol. `withoutResponseBody`
  // runs before the error is even classified.
  const leaky = new StubReader(
    bracketPlan({
      failing: [
        '/order/list',
        '/command/list',
        '/orderStrategy/list',
        '/orderStrategyLink/deps',
        '/orderVersion/deps',
      ],
    })
  );
  const { lines: failureLines } = await captureLogs(() =>
    readStopHistories({ readers: { demo: leaky.reader() }, trades: [TRADE] })
  );

  // And the successful path's own line, which is the one that runs every day.
  // With the commands read, so the line that carries a command COUNT is the one
  // the secrets below are grepped out of.
  const quiet = new StubReader(bracketPlan({ commands: BRACKET_COMMANDS }));
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
      successLines.some((line) =>
        /orders=\d+ candidates=\d+ commands=\d+ deps=\d+/.test(line)), true),
    c('(4) and it reports the verdict totals, never a per-symbol count',
      successLines.some((line) => /moved=1 kept=0 none=0 unknown=0/.test(line)), true),
  ]);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  measuredCaseGroup();
  cancellationGroup();
  severalOrdersGroup();
  wrongSideGroup();
  fillAnchorGroup();
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
