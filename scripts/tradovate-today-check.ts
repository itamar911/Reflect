/**
 * Broker day-pull regression suite (REF-90).
 *
 * There is no unit-test runner in this repository — `package.json` has `dev`,
 * `build`, `start`, `lint`, the three `tradovate:*` diagnostics and two check
 * scripts, and no `*.test.*` file exists. So this follows the precedent set by
 * scripts/money-format-check.ts: a plain `tsx` script of assertions that prints
 * one line per group and exits non-zero on the first failure. Adding vitest to
 * cover one ticket would be a bigger change than the ticket.
 *
 * Nothing here touches the network, Supabase, or a credential. Every upstream
 * response is a fixture handed to the reader seam in lib/tradovate/fills.ts,
 * and the Supabase client is a hand-built stub — so this is safe to run
 * anywhere, with no .env.local.
 *
 * WHAT IT COVERS, AND WHY EACH GROUP IS HERE
 *
 *   - the day boundary, including the two hour-offsets Israel uses and the
 *     window where Tradovate's own `tradeDate` would disagree. The boundary is
 *     the one thing in REF-90 that no amount of reading the docs could settle
 *     (§4), so it is pinned by test instead.
 *   - the USD arithmetic, in all four direction/outcome combinations. A
 *     PROFITABLE SHORT COUNTING AS A LOSS is a mistake this codebase has
 *     already shipped once (see the header of lib/rules/tradeRuleContext.ts);
 *     this is the group that stops it happening again one layer down.
 *   - value-per-point and currency, because without them the figure is points
 *     or it is not dollars, and either way it is being compared to a dollar
 *     threshold.
 *   - the loss streak, including the window that reaches back past today and
 *     the win in the middle that must reset it.
 *   - account selection — the ownership filter above all, since counting
 *     another trader's fills would block this one.
 *   - every one of the four `rule_context_source` states, from the error that
 *     produces it through to the wire shape the client parses.
 *   - THE TWO ENFORCEMENT PATHS AGREEING, which is the invariant the whole
 *     design rests on: one context object into the gate's evaluators and into
 *     validateTradePlan, and the same verdict out of both.
 *
 * Usage: npm run test:broker-day
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { partitionAccounts, selectTradingAccounts } from '../src/lib/tradovate/accounts';
import type { ResolvedApiUrl } from '../src/lib/tradovate/api-hosts';
import {
  formatHostProbe,
  formatPermProbe,
  probeAccountHosts,
  probeTradingPermissions,
} from '../src/lib/tradovate/diag-hosts';
import {
  TradovateNotConnectedError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateTransientError,
  TradovateUnpriceableError,
} from '../src/lib/tradovate/errors';
import {
  formatDayPullCounts,
  loadBrokerDay,
  type BrokerDayContext,
  type DayPullCounts,
  type TradovateReader,
} from '../src/lib/tradovate/fills';
import type { TradovateEnvironment } from '../src/lib/tradovate/hosts';
import { closedToday, parseDayStart } from '../src/lib/tradovate/trading-day';
import type {
  TradovateAccount,
  TradovateContract,
  TradovateCurrency,
  TradovateFill,
  TradovateFillPair,
  TradovatePosition,
  TradovateProduct,
} from '../src/lib/tradovate/types';
import {
  classifyDayPullFailure,
  readBrokerDayResponse,
  type BrokerDayPull,
} from '../src/lib/rules/brokerDayContext';
import { loadTradeRuleContext, type TradeRuleContext } from '../src/lib/rules/tradeRuleContext';
import {
  checkActiveViolation,
  checkCustomRules,
  validateTradePlan,
  DEFAULT_PRESET_RULES,
} from '../src/lib/validators/RulesetValidator';
import type { CustomRule, PresetRules, TradePlanInput } from '../src/lib/types';

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
  const bad = cases.filter((c) => !same(c.got, c.want));
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const c of bad) {
    console.log(`         ${c.label}: got ${show(c.got)} want ${show(c.want)}`);
    failures.push(`${name} / ${c.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

/** Run something that should throw, and report what came back. */
async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no throw';
  } catch (error) {
    if (error instanceof TradovateUnpriceableError) return `unpriceable:${error.reason}`;
    return error instanceof Error ? error.name : 'non-error';
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The trader's local midnight, as the browser would send it.
 *
 * 14 Oct 2026, 00:00 in Tel Aviv. Israel is on IDT (UTC+3) in October, so that
 * instant is 21:00Z on the 13th. Every timestamp below is written with an
 * explicit Z offset, so none of this depends on the timezone of the machine
 * running it.
 */
const DAY_START = Date.parse('2026-10-13T21:00:00.000Z');
/** 10:00 Tel Aviv the same morning. */
const NOW = Date.parse('2026-10-14T07:00:00.000Z');

const CONTRACT_ID = 2606306;
const PRODUCT_ID = 42;
const USD = { id: 1, name: 'USD' };

const ACCOUNT: TradovateAccount = {
  id: 7001,
  name: 'DEMO7001',
  userId: 555,
  accountType: 'Customer',
};

const POSITION: TradovatePosition = {
  id: 9001,
  accountId: ACCOUNT.id,
  contractId: CONTRACT_ID,
  timestamp: '2026-10-14T05:00:00.000Z',
  tradeDate: { year: 2026, month: 10, day: 14 },
  netPos: 0,
};

const CONTRACT: TradovateContract = { id: CONTRACT_ID, name: 'ESZ6', productId: PRODUCT_ID };
/** ES: $50 a point. */
const PRODUCT: TradovateProduct = { id: PRODUCT_ID, name: 'ES', currencyId: USD.id, valuePerPoint: 50 };

interface Scene {
  accounts: TradovateAccount[];
  positions: TradovatePosition[];
  pairs: TradovateFillPair[];
  fills: TradovateFill[];
  contracts: TradovateContract[];
  products: TradovateProduct[];
  currencies: TradovateCurrency[];
}

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    accounts: [ACCOUNT],
    positions: [POSITION],
    pairs: [],
    fills: [],
    contracts: [CONTRACT],
    products: [PRODUCT],
    currencies: [USD],
    ...overrides,
  };
}

let nextId = 1;

/**
 * One round trip, as the four endpoints would report it.
 *
 * `openAt`/`closeAt` are when the two legs executed; `side` says which leg
 * closed, which is what makes a short a short. The pair itself names its legs
 * by side and carries no direction, exactly as the API does — so a test that
 * gets the P&L sign right for `side: 'short'` is testing the thing that was
 * wrong before.
 */
function roundTrip(opts: {
  side: 'long' | 'short';
  openAt: string;
  closeAt: string;
  entry: number;
  exit: number;
  qty?: number;
  contractId?: number;
  positionId?: number;
}): { pair: TradovateFillPair; fills: TradovateFill[] } {
  const qty = opts.qty ?? 1;
  const contractId = opts.contractId ?? CONTRACT_ID;
  const buyId = nextId++;
  const sellId = nextId++;

  // A long buys to open and sells to close; a short does the reverse.
  const buy = {
    id: buyId,
    orderId: buyId,
    contractId,
    timestamp: opts.side === 'long' ? opts.openAt : opts.closeAt,
    tradeDate: { year: 2026, month: 10, day: 14 },
    action: 'Buy' as const,
    qty,
    price: opts.side === 'long' ? opts.entry : opts.exit,
  };
  const sell = {
    id: sellId,
    orderId: sellId,
    contractId,
    timestamp: opts.side === 'long' ? opts.closeAt : opts.openAt,
    tradeDate: { year: 2026, month: 10, day: 14 },
    action: 'Sell' as const,
    qty,
    price: opts.side === 'long' ? opts.exit : opts.entry,
  };

  return {
    pair: {
      id: nextId++,
      positionId: opts.positionId ?? POSITION.id,
      buyFillId: buyId,
      sellFillId: sellId,
      qty,
      buyPrice: buy.price,
      sellPrice: sell.price,
    },
    fills: [buy, sell],
  };
}

function withTrips(trips: { pair: TradovateFillPair; fills: TradovateFill[] }[], overrides: Partial<Scene> = {}): Scene {
  return scene({
    pairs: trips.map((t) => t.pair),
    fills: trips.flatMap((t) => t.fills),
    ...overrides,
  });
}

/** The reader seam, answering from a scene. Records the paths it was asked for. */
function reader(data: Scene): TradovateReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
      calls.push(path);
      const id = Number(query?.id);
      switch (path) {
        case '/account/list':
          return Promise.resolve(data.accounts as T);
        case '/position/list':
          return Promise.resolve(data.positions as T);
        case '/fillPair/list':
          return Promise.resolve(data.pairs as T);
        case '/fill/list':
          return Promise.resolve(data.fills as T);
        case '/currency/list':
          return Promise.resolve(data.currencies as T);
        case '/contract/item':
          return Promise.resolve(data.contracts.find((x) => x.id === id) as T);
        case '/product/item':
          return Promise.resolve(data.products.find((x) => x.id === id) as T);
        default:
          return Promise.reject(new Error(`unexpected path ${path}`));
      }
    },
  };
}

/**
 * The day figures alone.
 *
 * loadBrokerDay() returns `{ day, counts }` since diag/ref-90-counts; this
 * unwraps it so every assertion written before that still reads the thing it
 * was written about. {@link pullCounts} is the other half.
 */
async function pull(data: Scene, dayStartMs = DAY_START): Promise<BrokerDayContext> {
  const { day } = await loadBrokerDay({
    reader: reader(data),
    dayStartMs,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
  return day;
}

/** The diagnostic tally alone, for the counts group. */
async function pullCounts(
  data: Scene,
  tradovateUserId: number | null = ACCOUNT.userId,
  dayStartMs = DAY_START
): Promise<DayPullCounts> {
  const { counts } = await loadBrokerDay({
    reader: reader(data),
    dayStartMs,
    tradovateUserId,
    now: NOW,
  });
  return counts;
}

async function main() {
  // ── The day boundary ──────────────────────────────────────────────────────

  group('dayStart is validated, never defaulted', [
    c('missing', parseDayStart(null, NOW).ok ? 'ok' : parseDayStart(null, NOW), { ok: false, reason: 'missing' }),
    c('empty string', parseDayStart('', NOW), { ok: false, reason: 'missing' }),
    c('not a date', parseDayStart('yesterday', NOW), { ok: false, reason: 'unparseable' }),
    c('carries seconds (a "now" sent by mistake)', parseDayStart('2026-10-14T06:59:30.000Z', NOW), {
      ok: false,
      reason: 'not_midnight',
    }),
    c('ahead of now', parseDayStart('2026-10-14T21:00:00.000Z', NOW), { ok: false, reason: 'out_of_range' }),
    c('older than a local day can be', parseDayStart('2026-10-11T21:00:00.000Z', NOW), {
      ok: false,
      reason: 'out_of_range',
    }),
    c('Tel Aviv summer midnight (UTC+3)', parseDayStart('2026-10-13T21:00:00.000Z', NOW), {
      ok: true,
      dayStartMs: DAY_START,
    }),
    c('a half-hour offset zone (UTC+3:30)', parseDayStart('2026-10-13T20:30:00.000Z', NOW).ok, true),
    c('UTC itself', parseDayStart('2026-10-14T00:00:00.000Z', Date.parse('2026-10-14T09:00:00Z')).ok, true),
  ]);

  // Winter: Israel is on UTC+2, so local midnight is 22:00Z the day before. The
  // day boundary has to follow the offset the browser was on, which is exactly
  // why it is sent rather than computed here.
  const winterStart = Date.parse('2026-01-14T22:00:00.000Z');
  group('a close belongs to the day the trader was in', [
    c('one minute before midnight is not today', closedToday(DAY_START - 60_000, DAY_START), false),
    c('midnight itself is today', closedToday(DAY_START, DAY_START), true),
    c('one minute after is today', closedToday(DAY_START + 60_000, DAY_START), true),
    c('00:30 Tel Aviv, inside the window tradeDate would call yesterday', closedToday(Date.parse('2026-10-13T21:30:00Z'), DAY_START), true),
    c('23:30 Tel Aviv the night before is not today', closedToday(Date.parse('2026-10-13T20:30:00Z'), DAY_START), false),
    c('winter offset: 00:30 IST is today', closedToday(Date.parse('2026-01-14T22:30:00Z'), winterStart), true),
    c('winter offset: 23:30 IST the night before is not', closedToday(Date.parse('2026-01-14T21:30:00Z'), winterStart), false),
    c('an unreadable instant is not today', closedToday(Number.NaN, DAY_START), false),
  ]);

  // ── The USD arithmetic ────────────────────────────────────────────────────

  const longWin = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 5010 }),
    ])
  );
  const longLoss = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 4990 }),
    ])
  );
  const shortWin = await pull(
    withTrips([
      roundTrip({ side: 'short', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 4990 }),
    ])
  );
  const shortLoss = await pull(
    withTrips([
      roundTrip({ side: 'short', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 5010 }),
    ])
  );
  const scaled = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 5002, qty: 3 }),
    ])
  );

  group('P&L is dollars, and direction is not a special case', [
    c('long win: 10 points x 1 x $50', longWin.net, 500),
    c('long win is not a loss', longWin.lost, 0),
    c('long loss', longLoss.net, -500),
    c('long loss is counted as lost money', longLoss.lost, 500),
    c('SHORT WIN is a win (sold 5000, bought back 4990)', shortWin.net, 500),
    c('short win contributes nothing to losses', shortWin.lost, 0),
    c('short win does not count as a losing trade', shortWin.losingCount, 0),
    c('short loss', shortLoss.net, -500),
    c('short loss is lost money', shortLoss.lost, 500),
    c('qty multiplies: 2 points x 3 x $50', scaled.net, 300),
    c('one close, counted once', longWin.closedCount, 1),
    c('asOf is the instant of the pull', longWin.asOf, new Date(NOW).toISOString()),
  ]);

  const mixedDay = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T04:00:00Z', closeAt: '2026-10-14T04:30:00Z', entry: 5000, exit: 4996 }),
      roundTrip({ side: 'short', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T05:30:00Z', entry: 5000, exit: 5002 }),
      roundTrip({ side: 'long', openAt: '2026-10-14T06:00:00Z', closeAt: '2026-10-14T06:30:00Z', entry: 5000, exit: 5010 }),
      // Closed at 23:30 the night before: in the streak window, not in today.
      roundTrip({ side: 'long', openAt: '2026-10-13T19:00:00Z', closeAt: '2026-10-13T20:30:00Z', entry: 5000, exit: 4980 }),
    ])
  );

  group("a day's totals", [
    c('three closes today, not four', mixedDay.closedCount, 3),
    c('two of them lost', mixedDay.losingCount, 2),
    c('gross losses, winners not deducted', mixedDay.lost, 300),
    c('net is wins minus losses', mixedDay.net, 200),
    c("yesterday's loss is not in today's money", mixedDay.lost === 300 + 1000 ? 'leaked' : 'excluded', 'excluded'),
  ]);

  // ── The loss streak ───────────────────────────────────────────────────────

  const streakReset = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T03:00:00Z', closeAt: '2026-10-14T03:30:00Z', entry: 5000, exit: 4990 }),
      roundTrip({ side: 'long', openAt: '2026-10-14T04:00:00Z', closeAt: '2026-10-14T04:30:00Z', entry: 5000, exit: 5010 }),
      roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T05:30:00Z', entry: 5000, exit: 4990 }),
      roundTrip({ side: 'long', openAt: '2026-10-14T06:00:00Z', closeAt: '2026-10-14T06:30:00Z', entry: 5000, exit: 4990 }),
    ])
  );

  const breakEven = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T05:30:00Z', entry: 5000, exit: 4990 }),
      roundTrip({ side: 'long', openAt: '2026-10-14T06:00:00Z', closeAt: '2026-10-14T06:30:00Z', entry: 5000, exit: 5000 }),
    ])
  );

  // Yesterday evening's three losses, nothing since. Reflect would still call
  // that a streak of three this morning, so the broker must too — a streak
  // measured over today alone would report zero and lift the cooldown.
  const overnight = await pull(
    withTrips([
      roundTrip({ side: 'long', openAt: '2026-10-13T17:00:00Z', closeAt: '2026-10-13T17:30:00Z', entry: 5000, exit: 4990 }),
      roundTrip({ side: 'long', openAt: '2026-10-13T18:00:00Z', closeAt: '2026-10-13T18:30:00Z', entry: 5000, exit: 4990 }),
      roundTrip({ side: 'long', openAt: '2026-10-13T19:00:00Z', closeAt: '2026-10-13T19:30:00Z', entry: 5000, exit: 4990 }),
    ])
  );

  const manyLosses = await pull(
    withTrips(
      Array.from({ length: 12 }, (_, i) =>
        roundTrip({
          side: 'long',
          openAt: '2026-10-14T02:00:00Z',
          closeAt: new Date(Date.parse('2026-10-14T02:30:00Z') + i * 60_000).toISOString(),
          entry: 5000,
          exit: 4999,
        })
      )
    )
  );

  group('the loss streak counts back from the most recent close', [
    c('two losses after a win', streakReset.lossStreak, 2),
    c('the win reset it rather than being skipped', streakReset.losingCount, 3),
    c('minutes since the streak started losing (06:30Z -> 07:00Z)', streakReset.minutesSinceLastClose, 30),
    c('a break-even close ends the streak', breakEven.lossStreak, 0),
    c('no streak means no minutes', breakEven.minutesSinceLastClose, null),
    c("yesterday's streak survives midnight", overnight.lossStreak, 3),
    c('and it is not in today\'s money', overnight.lost, 0),
    c('nor in today\'s count', overnight.closedCount, 0),
    c('the window caps the streak at ten', manyLosses.lossStreak, 10),
    c('the day itself is not capped', manyLosses.closedCount, 12),
  ]);

  // ── Scale-outs: a fill pair is not a trade ────────────────────────────────
  //
  // One entry of three contracts, exited in three pieces, all at a loss. As
  // pairs that is three consecutive losses, and cooldown_after_losses defaults
  // to three — so counting pairs would lock the trader out over ONE trade.
  const sharedBuyId = 9100;
  const scaleOut = scene({
    fills: [
      { id: sharedBuyId, orderId: sharedBuyId, contractId: CONTRACT_ID, timestamp: '2026-10-14T04:00:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Buy', qty: 3, price: 5000 },
      { id: 9101, orderId: 9101, contractId: CONTRACT_ID, timestamp: '2026-10-14T05:00:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Sell', qty: 1, price: 4998 },
      { id: 9102, orderId: 9102, contractId: CONTRACT_ID, timestamp: '2026-10-14T05:30:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Sell', qty: 1, price: 4997 },
      { id: 9103, orderId: 9103, contractId: CONTRACT_ID, timestamp: '2026-10-14T06:00:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Sell', qty: 1, price: 4996 },
    ],
    pairs: [
      { id: 9201, positionId: POSITION.id, buyFillId: sharedBuyId, sellFillId: 9101, qty: 1, buyPrice: 5000, sellPrice: 4998 },
      { id: 9202, positionId: POSITION.id, buyFillId: sharedBuyId, sellFillId: 9102, qty: 1, buyPrice: 5000, sellPrice: 4997 },
      { id: 9203, positionId: POSITION.id, buyFillId: sharedBuyId, sellFillId: 9103, qty: 1, buyPrice: 5000, sellPrice: 4996 },
    ],
  });
  const scaled3 = await pull(scaleOut);

  // The mirror image: three separate entries closed by one exit order.
  const sharedSellId = 9300;
  const scaleIn = scene({
    fills: [
      { id: 9301, orderId: 9301, contractId: CONTRACT_ID, timestamp: '2026-10-14T04:00:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Buy', qty: 1, price: 5000 },
      { id: 9302, orderId: 9302, contractId: CONTRACT_ID, timestamp: '2026-10-14T04:30:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Buy', qty: 1, price: 4999 },
      { id: sharedSellId, orderId: sharedSellId, contractId: CONTRACT_ID, timestamp: '2026-10-14T06:00:00Z', tradeDate: { year: 2026, month: 10, day: 14 }, action: 'Sell', qty: 2, price: 4990 },
    ],
    pairs: [
      { id: 9401, positionId: POSITION.id, buyFillId: 9301, sellFillId: sharedSellId, qty: 1, buyPrice: 5000, sellPrice: 4990 },
      { id: 9402, positionId: POSITION.id, buyFillId: 9302, sellFillId: sharedSellId, qty: 1, buyPrice: 4999, sellPrice: 4990 },
    ],
  });
  const scaled2 = await pull(scaleIn);

  group('scaling out of one position is one trade', [
    c('three exits of one entry: one trade', scaled3.closedCount, 1),
    c('and one losing trade, not three', scaled3.losingCount, 1),
    c('AND A STREAK OF ONE, not the three that trips a cooldown', scaled3.lossStreak, 1),
    c('the money is the whole position: (2+3+4) points x $50', scaled3.lost, 450),
    c('net matches', scaled3.net, -450),
    c('dated by the LAST exit (06:00Z -> 07:00Z is 60 minutes)', scaled3.minutesSinceLastClose, 60),
    c('two entries closed by one exit: one trade', scaled2.closedCount, 1),
    c('netted across both legs: (10+9) x $50', scaled2.lost, 950),
    c('one loss for the streak', scaled2.lossStreak, 1),
  ]);

  // ── Nothing to report, which is not a failure ─────────────────────────────

  const noPairs = await pull(scene());
  const { day: noAccount } = await loadBrokerDay({
    reader: reader(scene()),
    dayStartMs: DAY_START,
    tradovateUserId: 999, // not the account's owner
    now: NOW,
  });
  const { day: unknownOwner } = await loadBrokerDay({
    reader: reader(scene()),
    dayStartMs: DAY_START,
    tradovateUserId: null,
    now: NOW,
  });
  const otherAccountsPairs = await pull(
    withTrips(
      [roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 4000, positionId: 123456 })],
      // A position that is not ours: the pair hangs off it, so it must not count.
      { positions: [{ ...POSITION, id: 123456, accountId: 8002 }] }
    )
  );

  const empty = { closedCount: 0, losingCount: 0, net: 0, lost: 0, lossStreak: 0, minutesSinceLastClose: null };
  const figures = (d: BrokerDayContext) => ({
    closedCount: d.closedCount,
    losingCount: d.losingCount,
    net: d.net,
    lost: d.lost,
    lossStreak: d.lossStreak,
    minutesSinceLastClose: d.minutesSinceLastClose,
  });

  group('an honest zero', [
    c('no round trips at all', figures(noPairs), empty),
    c('no account belonging to this user', figures(noAccount), empty),
    c('ownership unknown: count nothing rather than guess', figures(unknownOwner), empty),
    c("another account's $50,000 loss is not counted", figures(otherAccountsPairs), empty),
  ]);

  const cheapReader = reader(scene());
  await loadBrokerDay({ reader: cheapReader, dayStartMs: DAY_START, tradovateUserId: ACCOUNT.userId, now: NOW });
  group('a quiet day costs little', [
    c('no contract pricing when there is nothing to price', cheapReader.calls.includes('/contract/item'), false),
    c('and no currency lookup either', cheapReader.calls.includes('/currency/list'), false),
  ]);

  // ── Unpriceable: refuse rather than under-report ──────────────────────────

  const oneTrip = roundTrip({
    side: 'long',
    openAt: '2026-10-14T05:00:00Z',
    closeAt: '2026-10-14T06:00:00Z',
    entry: 5000,
    exit: 4990,
  });

  group('a figure that cannot be stated in dollars is refused', [
    c(
      'no valuePerPoint: points are not money',
      await thrown(() => pull(withTrips([oneTrip], { products: [{ ...PRODUCT, valuePerPoint: undefined }] }))),
      'unpriceable:no_value_per_point'
    ),
    c(
      'a zero valuePerPoint is not a value',
      await thrown(() => pull(withTrips([oneTrip], { products: [{ ...PRODUCT, valuePerPoint: 0 }] }))),
      'unpriceable:no_value_per_point'
    ),
    c(
      'a euro-denominated product cannot join a dollar total',
      await thrown(() =>
        pull(
          withTrips([oneTrip], {
            products: [{ ...PRODUCT, currencyId: 2 }],
            currencies: [USD, { id: 2, name: 'EUR' }],
          })
        )
      ),
      'unpriceable:foreign_currency'
    ),
    c(
      'a currency id with no name is an unknown unit',
      await thrown(() => pull(withTrips([oneTrip], { products: [{ ...PRODUCT, currencyId: 77 }] }))),
      'unpriceable:unknown_currency'
    ),
    c(
      'a pair whose fill is missing cannot be dated',
      await thrown(() => pull(scene({ pairs: [oneTrip.pair], fills: [] }))),
      'unpriceable:missing_fill'
    ),
    c(
      'USD is accepted case-insensitively',
      (await pull(withTrips([oneTrip], { currencies: [{ id: 1, name: 'usd' }] }))).lost,
      500
    ),
  ]);

  // ── Account selection ─────────────────────────────────────────────────────

  const candidates: TradovateAccount[] = [
    ACCOUNT,
    { ...ACCOUNT, id: 1, userId: 999 },
    { ...ACCOUNT, id: 2, accountType: 'House' },
    { ...ACCOUNT, id: 3, closed: true },
    { ...ACCOUNT, id: 4, restricted: true },
    { ...ACCOUNT, id: 5, readonly: true },
    { ...ACCOUNT, id: 6, futuresDisabled: true },
    { ...ACCOUNT, id: 7, active: false },
    { ...ACCOUNT, id: 8, name: 'DEMO8' },
  ];

  group('which accounts count', [
    c(
      'own, Customer, tradeable',
      selectTradingAccounts(candidates, ACCOUNT.userId).map((a) => a.id),
      [ACCOUNT.id, 8]
    ),
    c('no connection identity means no accounts', selectTradingAccounts(candidates, null).length, 0),
    c('a flag that is absent is not a flag that is false', selectTradingAccounts([ACCOUNT], ACCOUNT.userId).length, 1),
  ]);

  // ── The counts that tell four zeros apart (diag/ref-90-counts) ────────────
  //
  // Each case below is one of loadBrokerDay()'s honest-zero exits. The day
  // figures are identical in all of them — that is the bug being diagnosed —
  // so what is asserted is that the COUNTS differ, and differ at the stage
  // that actually emptied.

  const closedToday1 = roundTrip({
    side: 'long',
    openAt: '2026-10-14T05:00:00Z',
    closeAt: '2026-10-14T06:00:00Z',
    entry: 5000,
    exit: 4990,
  });

  // Exit 1: the account was filtered out. One account came back, none was
  // this trader's. This is the shape the 13.10 prop-account report would show.
  const filteredOut = await pullCounts(scene(), 999);

  // The same exit, reached because the connection has no stored identity.
  const unknownIdentity = await pullCounts(scene(), null);

  // Exit 2: the account counts, but the position belongs to another one — so
  // the pair has no link to it. `mine` is 1 here, which is what separates this
  // from the case above.
  const noPositionOfMine = await pullCounts(
    withTrips([closedToday1], { positions: [{ ...POSITION, accountId: 8002 }] })
  );

  // A full day: every stage populated, nothing dropped.
  const fullDay = await pullCounts(withTrips([closedToday1]));

  group('the counts tell the four zeros apart', [
    // Exit 1 — and the filter breakdown names the reason.
    c('filtered-out account: one seen, none mine', [filteredOut.accounts, filteredOut.mine], [1, 0]),
    c('and the reason is ownership', filteredOut.filter.noOwner, 1),
    c('counted once, under the first reason only', filteredOut.filter, {
      total: 1,
      noOwner: 1,
      notCustomer: 0,
      closed: 0,
      restricted: 0,
      readonly: 0,
      futuresDisabled: 0,
      inactive: 0,
    }),
    c(
      'the stages after it were never reached, so they are zero',
      [filteredOut.positions, filteredOut.pairs, filteredOut.trades, filteredOut.todays],
      [0, 0, 0, 0]
    ),

    // Exit 1 again, by the other route into it: a connection stored before
    // /auth/me was recorded, so ownership cannot be checked at all. It has to
    // read as an ownership failure and not as some other flag, because it is
    // one of the live candidates for the 13.10 report and the log line is what
    // would name it.
    c('null identity: ownership is the reason, for every account', [unknownIdentity.mine, unknownIdentity.filter.noOwner], [0, 1]),
    c('and it is not attributed to any other flag', unknownIdentity.filter.inactive + unknownIdentity.filter.notCustomer, 0),

    // Exit 2 — distinguishable from exit 1 precisely because mine is 1.
    c('position of another account: mine is 1, minePositions is 0', [noPositionOfMine.mine, noPositionOfMine.minePositions], [1, 0]),
    c('so the pair stage was never reached', [noPositionOfMine.pairs, noPositionOfMine.minePairs], [0, 0]),
    c('and no account was dropped', noPositionOfMine.filter.noOwner, 0),

    // A closed pair that did land in the day — the control for all of the above.
    c('closed pair today: one trade, one of them today', [fullDay.trades, fullDay.todays], [1, 1]),
    c('every stage populated', [fullDay.accounts, fullDay.mine, fullDay.minePositions, fullDay.minePairs], [1, 1, 1, 1]),
    c('and it is the same trade the day figures counted', (await pull(withTrips([closedToday1]))).closedCount, fullDay.todays),

    // The whole-partition property, on the mixed bag from the group above.
    c(
      'the filter breakdown accounts for every row it was given',
      (() => {
        const f = partitionAccounts(candidates, ACCOUNT.userId).counts;
        const dropped = f.noOwner + f.notCustomer + f.closed + f.restricted + f.readonly + f.futuresDisabled + f.inactive;
        return dropped + selectTradingAccounts(candidates, ACCOUNT.userId).length === f.total;
      })(),
      true
    ),
  ]);

  // The log line itself. The route decides whether to emit it and runs it
  // through redactSecrets(); the text is this, and it is asserted in full
  // because a format string is wrong silently or not at all.
  group('the diagnostic line says counts and nothing else', [
    c(
      'the exact format, for the filtered-out account',
      formatDayPullCounts(filteredOut),
      'accounts=1 mine=0 positions=0 minePositions=0 pairs=0 minePairs=0 trades=0 todays=0' +
        ' | filter: total=1 noOwner=1 notCustomer=0 closed=0 restricted=0 readonly=0 futuresDisabled=0 inactive=0'
    ),
    c(
      'and for a day that had a trade in it',
      formatDayPullCounts(fullDay),
      'accounts=1 mine=1 positions=1 minePositions=1 pairs=1 minePairs=1 trades=1 todays=1' +
        ' | filter: total=1 noOwner=0 notCustomer=0 closed=0 restricted=0 readonly=0 futuresDisabled=0 inactive=0'
    ),
    // The privacy property, asserted rather than reviewed. Every number the
    // line carries is a count, so nothing that identifies a person or a
    // position can appear in it — these are the values that WOULD identify
    // one, drawn from the fixtures the counts were computed from.
    c(
      'no account id, contract id, symbol, price or timestamp',
      [
        String(ACCOUNT.id),
        String(ACCOUNT.userId),
        String(CONTRACT_ID),
        CONTRACT.name,
        String(POSITION.id),
        '5000',
        '4990',
        '2026-10-14',
      ].filter((leak) => formatDayPullCounts(fullDay).includes(leak)),
      []
    ),
  ]);

  // ── The host probe (diag/ref-90-hosts) ────────────────────────────────────
  //
  // TEMPORARY, with the probe it covers. `accounts=0 … filter: total=0` proved
  // the account list came back empty rather than filtered, so the remaining
  // question is which host was asked — see lib/tradovate/diag-hosts.ts. These
  // cases pin the line's format and the one property that matters more than the
  // format: that a hostname cannot reach the log, because apiHosts.demo varies
  // by organization and would name the prop firm.

  /** A per-organization demo host, the kind that must never be logged. */
  const PROBE_HOSTS: Record<TradovateEnvironment, ResolvedApiUrl> = {
    live: { url: 'https://live.tradovateapi.com/v1', source: 'fallback' },
    demo: { url: 'https://lucid-demo-7f3.tradovateapi.com/v1', source: 'stored' },
  };

  /** The shape REF-90 predicts: nothing on live, the trader's account on demo. */
  const probeFound = await probeAccountHosts({
    configured: 'live',
    hosts: PROBE_HOSTS,
    tradovateUserId: ACCOUNT.userId,
    get: async (apiUrl) =>
      apiUrl.includes('live.tradovateapi.com')
        ? []
        : [ACCOUNT, { ...ACCOUNT, id: 7002, name: 'FIRM7002', userId: 999 }],
  });

  /** Each host failing differently, to prove neither answer hides the other. */
  const probeFailed = await probeAccountHosts({
    configured: 'live',
    hosts: PROBE_HOSTS,
    tradovateUserId: ACCOUNT.userId,
    get: async (apiUrl) => {
      if (apiUrl.includes('live.tradovateapi.com')) throw new TypeError('socket hang up');
      throw new TradovateRequestError('/account/list', 401, '{"errorText":"Access token is expired"}');
    },
  });

  /** A 200 that is not a list at all — the body REF-90 §1 had to deduce. */
  const probeNotAList = await probeAccountHosts({
    configured: 'demo',
    hosts: PROBE_HOSTS,
    tradovateUserId: null,
    get: async () => ({ errorText: 'something' }),
  });

  group('the host probe reports counts and never a hostname', [
    c(
      'the line REF-90 is waiting for: empty on live, the account on demo',
      formatHostProbe(probeFound),
      'configured=live live: source=fallback status=200 n=0 owned=0' +
        ' | demo: source=stored status=200 n=2 owned=1'
    ),
    c(
      'a 401 on one host and a thrown fault on the other, both reported',
      formatHostProbe(probeFailed),
      'configured=live live: source=fallback status=err n=0 owned=0' +
        ' | demo: source=stored status=401 n=0 owned=0'
    ),
    c(
      'a non-array 200 is n=-1, not an empty list, and a null identity owns nothing',
      formatHostProbe(probeNotAList),
      'configured=demo live: source=fallback status=200 n=-1 owned=0' +
        ' | demo: source=stored status=200 n=-1 owned=0'
    ),
    // The privacy property, asserted rather than reviewed — the hostname first,
    // because it is the field this diagnostic holds and the counts one did not.
    c(
      'no hostname, account id, account name, userId or response body',
      [
        'lucid-demo-7f3.tradovateapi.com',
        'lucid',
        'tradovateapi.com',
        'https',
        String(ACCOUNT.id),
        String(ACCOUNT.userId),
        ACCOUNT.name,
        'FIRM7002',
        '999',
        'errorText',
        'Access token is expired',
      ].filter((leak) =>
        [probeFound, probeFailed, probeNotAList].some((p) => formatHostProbe(p).includes(leak))
      ),
      []
    ),
  ]);

  // ── The permission probe (diag/ref-90-perms, Stage 0) ─────────────────────
  //
  // TEMPORARY, with the probe it covers. The host line came back `demo n=1
  // owned=0`: the account is there and it is not ours by userId. These cases
  // pin the second line's format for each hypothesis it has to tell apart, and
  // the property that matters more than the format — that this probe reads two
  // entities carrying REAL PII (two names and two email addresses on
  // TradingPermission, name and email on /user/list) and cannot put any of it
  // in a log line.

  /**
   * One permission, dressed in exactly the fields that must never be logged.
   *
   * Every one of these four is a REQUIRED field on the documented entity, so
   * this is not a contrived fixture — it is the shape the real call returns.
   */
  const PERMISSION = {
    id: 4401,
    userId: ACCOUNT.userId,
    accountId: ACCOUNT.id,
    status: 'Accepted',
    accountHolderContact: 'Yael Brandwein',
    accountHolderEmail: 'yael.brandwein@lucidtrading.example',
    ctaContact: 'Dov Halperin',
    ctaEmail: 'dov.halperin@lucidtrading.example',
  };

  /** /user/list's shape: the id we read, and the two fields we must not. */
  const USER_ROW = { id: ACCOUNT.userId, name: 'Yael Brandwein', email: 'yael.brandwein@lucidtrading.example' };

  /** Hypothesis A: the firm admin owns the account, our trader is permitted. */
  const permA = await probeTradingPermissions({
    hosts: PROBE_HOSTS,
    tradovateUserId: ACCOUNT.userId,
    get: async (apiUrl, path) => {
      // Identity is central under A, so both hosts know us; the permission
      // lives only where the account does. The first permission in demo's list
      // is another trader's, which is also the assertion that `mine` counts by
      // the permission's own userId and `status` reports OUR one.
      if (path !== '/tradingPermission/list') {
        return [USER_ROW, { id: 999, name: 'Lucid Admin', email: 'admin@lucidtrading.example' }];
      }
      return apiUrl.includes('live.tradovateapi.com')
        ? []
        : [{ ...PERMISSION, id: 4400, userId: 999, status: 'Revoked' }, PERMISSION];
    },
  });

  /**
   * Hypothesis B: demo has a user registry, and we are not in it. No
   * permission of ours anywhere, so §2.3's rule could never fire.
   */
  const permB = await probeTradingPermissions({
    hosts: PROBE_HOSTS,
    tradovateUserId: ACCOUNT.userId,
    get: async (_apiUrl, path) =>
      path === '/tradingPermission/list' ? [] : [{ id: 888, name: 'Other Person', email: 'other@lucidtrading.example' }],
  });

  /**
   * The unverified path, both ways it can fail to be a list: a 404 (the slug
   * is a naming convention, not a documented endpoint) and a 200 that is not an
   * array. Both are perms=-1, and `status` is what separates them. /user/list
   * answers on live and faults on demo, so one endpoint cannot hide the other.
   *
   * Demo's permission also carries a `status` that is not one of the five
   * documented words — and an email, because that is the worst thing an
   * unvalidated string from this entity could be.
   */
  const permUnknown = await probeTradingPermissions({
    hosts: PROBE_HOSTS,
    tradovateUserId: ACCOUNT.userId,
    get: async (apiUrl, path) => {
      const live = apiUrl.includes('live.tradovateapi.com');
      if (path === '/tradingPermission/list') {
        if (live) throw new TradovateRequestError('/tradingPermission/list', 404, '{"errorText":"Not found"}');
        return [{ ...PERMISSION, status: 'ctaEmail:dov.halperin@lucidtrading.example' }];
      }
      if (live) return [USER_ROW];
      throw new TypeError('socket hang up');
    },
  });

  group('the permission probe settles A against B, and carries no PII', [
    c(
      'hypothesis A: a permission of ours on demo, and its status word',
      formatPermProbe(permA),
      'live: perms=0 mine=0 status=- users=2 self=1' +
        ' | demo: perms=2 mine=1 status=Accepted users=2 self=1'
    ),
    c(
      'hypothesis B: a user registry on demo that does not contain us',
      formatPermProbe(permB),
      'live: perms=0 mine=0 status=- users=1 self=0' +
        ' | demo: perms=0 mine=0 status=- users=1 self=0'
    ),
    c(
      'a 404 is status=err, an undocumented status word is other, and each endpoint fails alone',
      formatPermProbe(permUnknown),
      'live: perms=-1 mine=0 status=err users=1 self=1' +
        ' | demo: perms=1 mine=1 status=other users=-1 self=0'
    ),
    // The privacy property, asserted rather than reviewed, and the reason this
    // group exists: TradingPermission and /user/list are the first PII this
    // integration reads. Two names, two email addresses, a per-organization
    // hostname, and the response body of the 404.
    c(
      'no email, name, hostname, account id, permission id or response body',
      [
        PERMISSION.accountHolderEmail,
        PERMISSION.ctaEmail,
        PERMISSION.accountHolderContact,
        PERMISSION.ctaContact,
        'admin@lucidtrading.example',
        'Lucid Admin',
        'Yael',
        'Halperin',
        'lucidtrading.example',
        'lucid-demo-7f3.tradovateapi.com',
        'tradovateapi.com',
        'https',
        String(PERMISSION.id),
        String(PERMISSION.accountId),
        String(ACCOUNT.userId),
        'errorText',
        'Not found',
      ].filter((leak) => [permA, permB, permUnknown].some((p) => formatPermProbe(p).includes(leak))),
      []
    ),
  ]);

  // ── The four provenance states ────────────────────────────────────────────

  group('a failure maps to the state the user is shown', [
    c('never connected is not expired', classifyDayPullFailure(new TradovateNotConnectedError('u', 'missing')), 'reflect_only'),
    c('expired connection', classifyDayPullFailure(new TradovateNotConnectedError('u', 'expired')), 'broker_expired'),
    c('revoked connection', classifyDayPullFailure(new TradovateNotConnectedError('u', 'revoked')), 'broker_expired'),
    c(
      'a rate limit is not an expiry (REF-101)',
      classifyDayPullFailure(new TradovateTransientError('x', { reason: 'penalty' })),
      'broker_unavailable'
    ),
    c('a penalty straight off the client', classifyDayPullFailure(new TradovatePenaltyError('x')), 'broker_unavailable'),
    c('a 500', classifyDayPullFailure(new TradovateRequestError('/fill/list', 500, '')), 'broker_unavailable'),
    c('a 401 on a read is still not a verdict on the connection', classifyDayPullFailure(new TradovateRequestError('/fill/list', 401, '')), 'broker_unavailable'),
    c('an unpriceable day', classifyDayPullFailure(new TradovateUnpriceableError('x', 'foreign_currency')), 'broker_unavailable'),
    c('a bug of ours', classifyDayPullFailure(new TypeError('x')), 'broker_unavailable'),
    c('something that is not an error at all', classifyDayPullFailure('nope'), 'broker_unavailable'),
  ]);

  const wireDay: BrokerDayContext = {
    closedCount: 2,
    losingCount: 1,
    net: -100,
    lost: 300,
    lossStreak: 1,
    minutesSinceLastClose: 12,
    asOf: '2026-10-14T07:00:00.000Z',
  };

  group('the wire shape is trusted no further than it can be checked', [
    c('verified, with figures', readBrokerDayResponse({ source: 'broker_verified', day: wireDay }), {
      source: 'broker_verified',
      day: wireDay,
    }),
    c('expired', readBrokerDayResponse({ source: 'broker_expired' }), { source: 'broker_expired' }),
    c('unavailable', readBrokerDayResponse({ source: 'broker_unavailable' }), { source: 'broker_unavailable' }),
    c('reflect only', readBrokerDayResponse({ source: 'reflect_only' }), { source: 'reflect_only' }),
    c('null streak is a value, not an absence', readBrokerDayResponse({ source: 'broker_verified', day: { ...wireDay, minutesSinceLastClose: null } }), {
      source: 'broker_verified',
      day: { ...wireDay, minutesSinceLastClose: null },
    }),
    c('verified with no day is not verified', readBrokerDayResponse({ source: 'broker_verified' }), { source: 'broker_unavailable' }),
    c('a half-built day does not become zeros', readBrokerDayResponse({ source: 'broker_verified', day: { closedCount: 2 } }), {
      source: 'broker_unavailable',
    }),
    c('a string where a number belongs', readBrokerDayResponse({ source: 'broker_verified', day: { ...wireDay, lost: '300' } }), {
      source: 'broker_unavailable',
    }),
    c('NaN is not a figure', readBrokerDayResponse({ source: 'broker_verified', day: { ...wireDay, lost: Number.NaN } }), {
      source: 'broker_unavailable',
    }),
    c('an unknown source', readBrokerDayResponse({ source: 'broker_maybe' }), { source: 'broker_unavailable' }),
    c('no body', readBrokerDayResponse(null), { source: 'broker_unavailable' }),
  ]);

  // ── The two enforcement paths ─────────────────────────────────────────────

  await bothPathsAgree();

  console.log();
  if (failures.length) {
    console.log(`${failures.length} failing case(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('All groups passed.');
}

// ── The Supabase stub ───────────────────────────────────────────────────────

interface ReflectRow {
  status: string;
  exit_price: number | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  closed_at?: string | null;
  fomo_entry?: boolean | null;
}

/**
 * Just enough of the PostgREST builder for loadTradeRuleContext's three
 * queries: every filter returns `this` and the object is awaitable.
 */
class FakeQuery implements PromiseLike<{ data: unknown[] }> {
  constructor(private readonly rows: unknown[]) {}
  eq() { return this; }
  neq() { return this; }
  gte() { return this; }
  lt() { return this; }
  order() { return this; }
  limit() { return this; }
  then<R1 = { data: unknown[] }, R2 = never>(
    onfulfilled?: ((value: { data: unknown[] }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve({ data: this.rows }).then(onfulfilled, onrejected);
  }
}

/**
 * The three queries are told apart by their column list, which is the only
 * thing that distinguishes them before the filters are applied: 'id' is the
 * trades-taken count, the one that also selects closed_at is the recent-closes
 * window, and the remaining money-only select is today's closes.
 */
function fakeSupabase(data: { taken: number; closedToday: ReflectRow[]; recent: ReflectRow[] }): SupabaseClient {
  const client = {
    from: () => ({
      select: (columns: string) => {
        if (columns === 'id') return new FakeQuery(Array.from({ length: data.taken }, (_, i) => ({ id: `${i}` })));
        if (columns.includes('closed_at')) return new FakeQuery(data.recent);
        return new FakeQuery(data.closedToday);
      },
    }),
  };
  return client as unknown as SupabaseClient;
}

const closed = (pnl: number, closedAt: string): ReflectRow => ({
  status: 'closed',
  exit_price: 1,
  pnl_amount: pnl,
  actual_pnl: null,
  closed_at: closedAt,
});

/**
 * One context object, both evaluators, one verdict.
 *
 * The gate (lib/rules/fetchActiveRuleViolation.ts) runs checkCustomRules and
 * checkActiveViolation; the form runs validateTradePlan. Those are the two
 * enforcement paths named in the ticket, and the invariant is that they cannot
 * reach different conclusions about the same day. This asserts it over the four
 * provenance states, including the two failure states where the broker figures
 * must not be allowed to lift a block Reflect's own data imposes.
 */
async function bothPathsAgree() {
  const rules: PresetRules = {
    ...DEFAULT_PRESET_RULES,
    id: 'r',
    user_id: 'u',
    created_at: '',
    updated_at: '',
    max_daily_loss: 500,
    max_daily_trades: 5,
    cooldown_after_losses: 3,
  };

  const lossRule: CustomRule = {
    id: 'cr',
    user_id: 'u',
    name: 'הפסד יומי',
    condition_type: 'daily_loss_dollar',
    threshold_value: 400,
    action_type: 'block_day',
    cooldown_minutes: null,
    is_active: true,
    created_at: '',
  } as CustomRule;

  const plan: TradePlanInput = {
    symbol: 'ES',
    direction: 'long',
    strategy: 'Breakout',
    entry_price: '5000',
    stop_loss: '4990',
    take_profit: '5030',
    trade_reason: 'test',
    emotional_state: 4,
    confidence_level: 4,
    timeframe: '5m',
    units: '1',
    point_value: '50',
  } as TradePlanInput;

  /** What each path concludes, reduced to the shape they can be compared in. */
  function verdicts(ctx: TradeRuleContext) {
    const gatePreset = checkActiveViolation(rules, {
      todayTradeCount: ctx.todayTradeCount,
      recentLossCount: ctx.lossStreak,
      todayLossAmount: ctx.todayLossAmount,
      minutesSinceLastClose: ctx.minutesSinceLastClose,
    });
    const gateCustom = checkCustomRules([lossRule], {
      todayLossAmount: ctx.todayLossAmount,
      todayLossPercent: null,
      todayTradeCount: ctx.todayTradeCount,
      lossStreak: ctx.lossStreak,
      currentHour: 10,
      lastTradeFomo: ctx.lastTradeFomo,
      lastTradeExitedEarly: ctx.lastTradeExitedEarly,
      lastTradeMovedSl: ctx.lastTradeMovedSl,
    });
    const form = validateTradePlan(plan, rules, ctx.todayTradeCount, ctx.lossStreak, ctx.todayLossAmount);

    return {
      gateBlocks: gatePreset !== null || gateCustom !== null,
      gateKeys: [gatePreset?.ruleKey, gateCustom ? 'daily_loss_dollar' : undefined].filter(Boolean),
      formBlocks: form.status === 'blocked',
      formKeys: form.violations.filter((v) => v.severity === 'block').map((v) => v.ruleKey),
    };
  }

  // Reflect's own record of the day: one $800 loss, which is over both the
  // preset $500 limit and the custom $400 rule.
  const reflectBlocked = {
    taken: 1,
    closedToday: [closed(-800, '2026-10-14T06:00:00Z')],
    recent: [closed(-800, '2026-10-14T06:00:00Z')],
  };

  const brokerVerified: BrokerDayPull = {
    source: 'broker_verified',
    day: {
      closedCount: 2,
      losingCount: 2,
      net: -900,
      lost: 900,
      lossStreak: 2,
      minutesSinceLastClose: 20,
      asOf: new Date(NOW).toISOString(),
    },
  };

  const quietBroker: BrokerDayPull = {
    source: 'broker_verified',
    day: {
      closedCount: 0,
      losingCount: 0,
      net: 0,
      lost: 0,
      lossStreak: 0,
      minutesSinceLastClose: null,
      asOf: new Date(NOW).toISOString(),
    },
  };

  const cases: { label: string; broker: BrokerDayPull; reflect: typeof reflectBlocked; wantSource: string; wantLoss: number; wantBlocked: boolean }[] = [
    { label: 'broker_verified, broker over the limit', broker: brokerVerified, reflect: { taken: 1, closedToday: [], recent: [] }, wantSource: 'broker_verified', wantLoss: 900, wantBlocked: true },
    { label: 'broker_expired falls back to Reflect, still blocked', broker: { source: 'broker_expired' }, reflect: reflectBlocked, wantSource: 'broker_expired', wantLoss: 800, wantBlocked: true },
    { label: 'broker_unavailable falls back to Reflect, still blocked', broker: { source: 'broker_unavailable' }, reflect: reflectBlocked, wantSource: 'broker_unavailable', wantLoss: 800, wantBlocked: true },
    { label: 'reflect_only is Reflect, still blocked', broker: { source: 'reflect_only' }, reflect: reflectBlocked, wantSource: 'reflect_only', wantLoss: 800, wantBlocked: true },
    // Option A's accepted cost, asserted rather than left implicit: a verified
    // broker that paired nothing REPLACES Reflect's figure, so the block lifts.
    // Both paths lift it together, which is the property under test.
    { label: 'broker_verified and quiet replaces Reflect (option A)', broker: quietBroker, reflect: reflectBlocked, wantSource: 'broker_verified', wantLoss: 0, wantBlocked: false },
  ];

  const results: Case[] = [];
  for (const scenario of cases) {
    const ctx = await loadTradeRuleContext('u', scenario.broker, fakeSupabase(scenario.reflect));
    const v = verdicts(ctx);

    results.push(c(`${scenario.label}: source`, ctx.source, scenario.wantSource));
    results.push(c(`${scenario.label}: loss total`, ctx.todayLossAmount, scenario.wantLoss));
    results.push(c(`${scenario.label}: gate blocks`, v.gateBlocks, scenario.wantBlocked));
    results.push(c(`${scenario.label}: THE TWO PATHS AGREE`, v.gateBlocks, v.formBlocks));
    results.push(
      c(
        `${scenario.label}: and on the same rule`,
        v.formKeys.includes('max_daily_loss'),
        v.gateKeys.includes('max_daily_loss')
      )
    );
  }

  // The display figures and the rule inputs come off one object, so the panel
  // cannot describe a day the rules did not act on (REF-82 §4.5).
  const verifiedCtx = await loadTradeRuleContext('u', brokerVerified, fakeSupabase(reflectBlocked));
  results.push(c('panel count is the broker count', verifiedCtx.todayClosed.count, 2));
  results.push(c('panel money matches the threshold input', verifiedCtx.todayClosed.money?.lost, verifiedCtx.todayLossAmount));
  results.push(c('trades TAKEN stays Reflect\'s', verifiedCtx.todayTradeCount, 1));
  results.push(c('self-reported flags stay Reflect\'s', verifiedCtx.lastTradeFomo, false));

  const quietCtx = await loadTradeRuleContext('u', quietBroker, fakeSupabase(reflectBlocked));
  results.push(c('no broker closes means no money line, not a zero', quietCtx.todayClosed.money, null));

  group('both enforcement paths, one context', results);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
