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

import {
  partitionAccounts,
  permissionsCouldHelp,
  permittedAccountIds,
  selectTradingAccounts,
} from '../src/lib/tradovate/accounts';
import {
  TradovateNotConnectedError,
  TradovatePenaltyError,
  TradovateRequestError,
  TradovateTransientError,
  TradovateUnpriceableError,
} from '../src/lib/tradovate/errors';
import {
  loadBrokerDay,
  type BrokerDayContext,
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
  TradovateTradingPermission,
} from '../src/lib/tradovate/types';
import {
  classifyDayPullFailure,
  describeDayPullFailure,
  readBrokerDayResponse,
  type BrokerDayPull,
} from '../src/lib/rules/brokerDayContext';
import { redactSecrets } from '../src/lib/tradovate/redact';
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

/**
 * The four fields on `TradingPermission` that must never leave this file.
 *
 * Every one of them is a REQUIRED field on the documented entity, so a fixture
 * carrying them is not contrived — it is the shape the real call returns. Two
 * names and two email addresses, so that the Stage 2 group's leak assertion
 * has something real to look for.
 */
const PERMISSION_PII = {
  accountHolderContact: 'Yael Brandwein',
  accountHolderEmail: 'yael.brandwein@lucidtrading.example',
  ctaContact: 'Dov Halperin',
  ctaEmail: 'dov.halperin@lucidtrading.example',
} as const;

/** The documented entity in full: the three fields read, and the five not. */
interface PermissionRow extends TradovateTradingPermission {
  id: number;
  accountHolderContact: string;
  accountHolderEmail: string;
  ctaContact: string;
  ctaEmail: string;
}

/** The one permission id every fixture uses, so a leak test can look for it. */
const PERMISSION_ID = 4401;

/** A permission row, PII and all. `userId` defaults to the trader's own. */
function permission(fields: {
  userId?: number;
  accountId: number;
  status: TradovateTradingPermission['status'];
}): PermissionRow {
  return {
    id: PERMISSION_ID,
    userId: fields.userId ?? ACCOUNT.userId,
    accountId: fields.accountId,
    status: fields.status,
    ...PERMISSION_PII,
  };
}

interface Scene {
  accounts: TradovateAccount[];
  positions: TradovatePosition[];
  pairs: TradovateFillPair[];
  fills: TradovateFill[];
  contracts: TradovateContract[];
  products: TradovateProduct[];
  currencies: TradovateCurrency[];
  /**
   * The /tradingPermission/list body, or null for a host that 404s it.
   *
   * NULL IS THE DEFAULT, AND DELIBERATELY SO: every fixture written before
   * Stage 2 therefore exercises the fail-safe — no readable permission list
   * means the owned-only rule — which is why none of their assertions had to
   * change in meaning. A scene that wants the join sets it explicitly.
   */
  permissions: PermissionRow[] | null;
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
    permissions: null,
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
        case '/tradingPermission/list':
          // A 404 for a scene with no permissions: the documentation page for
          // this endpoint 404s, the path is a naming convention, and a host
          // that does not expose the entity is the case the fail-safe is for.
          return data.permissions === null
            ? Promise.reject(
                new TradovateRequestError(path, 404, '{"errorText":"Not found"}')
              )
            : Promise.resolve(data.permissions as T);
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
 * The day figures, from ONE host.
 *
 * Passes ONE reader where the signature takes a record of them, which is the
 * point: a connection with a single usable host must behave exactly as the
 * whole suite below has always asserted. Every group above the Stage 1 group is
 * therefore a regression test for the routing change, without a line of it
 * being rewritten.
 */
function pull(data: Scene, dayStartMs = DAY_START): Promise<BrokerDayContext> {
  return loadBrokerDay({
    readers: { live: reader(data) },
    environment: 'live',
    dayStartMs,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
}

/** Both hosts, for the Stage 1 group. */
function pullHosts(params: {
  live?: Scene;
  demo?: Scene;
  environment?: TradovateEnvironment;
  tradovateUserId?: number | null;
  dayStartMs?: number;
}) {
  const readers: Partial<Record<TradovateEnvironment, TradovateReader>> = {};
  if (params.live) readers.live = reader(params.live);
  if (params.demo) readers.demo = reader(params.demo);

  return loadBrokerDay({
    readers,
    environment: params.environment ?? 'live',
    dayStartMs: params.dayStartMs ?? DAY_START,
    tradovateUserId: params.tradovateUserId === undefined ? ACCOUNT.userId : params.tradovateUserId,
    now: NOW,
  });
}

/** A reader that fails on one path and answers from a scene on the others. */
function failingReader(data: Scene, failOn: string, error: () => Error): TradovateReader {
  const inner = reader(data);
  return {
    get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
      if (path === failOn) return Promise.reject(error());
      return inner.get<T>(path, query);
    },
  };
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
  const noAccount = await pullHosts({
    live: scene(),
    tradovateUserId: 999, // not the account's owner
  });
  const unknownOwner = await pullHosts({ live: scene(), tradovateUserId: null });
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
  await loadBrokerDay({
    readers: { live: cheapReader },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
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

  // ── Stage 1: routing by purpose ───────────────────────────────────────────
  //
  // Measured in production on 14.10: live held nothing, demo held the account.
  // `environment` is the token's MINT server, so routing trading reads by it
  // asked the wrong host. (a′) discovers on both and continues only where there
  // is something to continue with.
  //
  // The sharpest cases here are the two about id spaces (§1.2): nothing
  // documents whether live and demo share them, so the design must be correct
  // either way, and these are that requirement in executable form.

  /** One −$500 close on the trader's own account. The mint host's fixture. */
  const closedToday1 = roundTrip({
    side: 'long',
    openAt: '2026-10-14T05:00:00Z',
    closeAt: '2026-10-14T06:00:00Z',
    entry: 5000,
    exit: 4990,
  });

  /** A second eligible account, for the host that is not the mint host. */
  const DEMO_ACCOUNT: TradovateAccount = { ...ACCOUNT, id: 7002, name: 'DEMO7002' };

  /** A demo scene holding one of the trader's own accounts and one closed trip. */
  const demoWin = roundTrip({
    side: 'long',
    openAt: '2026-10-14T05:00:00Z',
    closeAt: '2026-10-14T06:30:00Z',
    entry: 5000,
    exit: 5020,
  });
  const demoScene = withTrips([demoWin], {
    accounts: [DEMO_ACCOUNT],
    positions: [{ ...POSITION, accountId: DEMO_ACCOUNT.id }],
  });

  // (1) The regression guard. Live holds the account, demo holds nothing, and
  // the answer must be the one this suite has always asserted.
  const liveOnlyLive = reader(withTrips([closedToday1]));
  const liveOnlyDemo = reader(scene({ accounts: [] }));
  const liveOnly = await loadBrokerDay({
    readers: { live: liveOnlyLive, demo: liveOnlyDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (2) THE REF-90 CASE, in both of its halves. Routing is fixed here;
  // ownership is not, and Stage 2 is the PR that changes what counts.
  const demoOwned = await pullHosts({ live: scene({ accounts: [] }), demo: demoScene });
  const demoLucid = await pullHosts({
    live: scene({ accounts: [] }),
    // The row as production actually reports it: the account is on demo and
    // its userId is the firm admin's, not ours.
    demo: withTrips([demoWin], {
      accounts: [{ ...DEMO_ACCOUNT, userId: 999 }],
      positions: [{ ...POSITION, accountId: DEMO_ACCOUNT.id }],
    }),
  });

  // (3) Both hosts hold eligible accounts: the day is the sum.
  const bothHosts = await pullHosts({ live: withTrips([closedToday1]), demo: demoScene });

  // (4) Colliding ids across hosts, which is §1.2 in executable form. The same
  // `fill.id` 10 and 11 and the same `contractId` on both hosts, and the two
  // hosts disagree about what that contract is worth. Welding would report one
  // trade; cross-pricing would price demo's loss at live's $50 a point.
  const COLLIDING_CONTRACT = 777;
  const collidingTrip = (buyPrice: number, sellPrice: number, closeAt: string) => ({
    pair: { id: 1, positionId: 9001, buyFillId: 10, sellFillId: 11, qty: 1, buyPrice, sellPrice },
    fills: [
      {
        id: 10,
        orderId: 10,
        contractId: COLLIDING_CONTRACT,
        timestamp: '2026-10-14T04:00:00.000Z',
        tradeDate: { year: 2026, month: 10, day: 14 },
        action: 'Buy' as const,
        qty: 1,
        price: buyPrice,
      },
      {
        id: 11,
        orderId: 11,
        contractId: COLLIDING_CONTRACT,
        timestamp: closeAt,
        tradeDate: { year: 2026, month: 10, day: 14 },
        action: 'Sell' as const,
        qty: 1,
        price: sellPrice,
      },
    ],
  });
  const collidingScene = (
    accountId: number,
    valuePerPoint: number,
    trip: { pair: TradovateFillPair; fills: TradovateFill[] }
  ) =>
    withTrips([trip], {
      accounts: [{ ...ACCOUNT, id: accountId }],
      positions: [{ ...POSITION, id: 9001, accountId }],
      contracts: [{ id: COLLIDING_CONTRACT, name: 'ESZ6', productId: PRODUCT_ID }],
      products: [{ ...PRODUCT, valuePerPoint }],
    });

  const colliding = await pullHosts({
    // +10 points at $50 = +$500
    live: collidingScene(1, 50, collidingTrip(5000, 5010, '2026-10-14T06:00:00.000Z')),
    // −10 points at $2 = −$20, and NOT −$500
    demo: collidingScene(2, 2, collidingTrip(4000, 3990, '2026-10-14T05:30:00.000Z')),
  });

  // (5) The streak runs on the pooled, sorted list, because the streak is about
  // the trader. Per host it would read 2 on demo; interleaved it is 1.
  const streakAcross = await pullHosts({
    live: withTrips(
      [roundTrip({ side: 'long', openAt: '2026-10-14T04:30:00Z', closeAt: '2026-10-14T05:00:00Z', entry: 5000, exit: 5010 })],
      { accounts: [ACCOUNT], positions: [POSITION] }
    ),
    demo: withTrips(
      [
        roundTrip({ side: 'long', openAt: '2026-10-14T03:30:00Z', closeAt: '2026-10-14T04:00:00Z', entry: 5000, exit: 4990 }),
        roundTrip({ side: 'long', openAt: '2026-10-14T05:30:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 4990 }),
      ],
      { accounts: [DEMO_ACCOUNT], positions: [{ ...POSITION, accountId: DEMO_ACCOUNT.id }] }
    ),
  });

  // (6) The same accountId eligible on both hosts: counted once, preferring the
  // mint host. Double-counting would block a trader over money they did not
  // lose, which ./accounts.ts names as the worst failure available here.
  const sameAccountDemo = reader(withTrips([closedToday1]));
  const dedupe = await loadBrokerDay({
    readers: { live: reader(withTrips([closedToday1])), demo: sameAccountDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (7) Discovery fails on the non-mint host. An organization with no demo
  // provisioning must not start failing pulls that work today.
  const demoRefused = await loadBrokerDay({
    readers: {
      live: reader(withTrips([closedToday1])),
      demo: failingReader(
        demoScene,
        '/account/list',
        () => new TradovateRequestError('/account/list', 403, '{"errorText":"Forbidden"}')
      ),
    },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (8) A failure on a host that DID return eligible accounts. Never a partial
  // day: an under-counted day makes every rule more permissive.
  const failureSource = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return 'no throw';
    } catch (error) {
      return classifyDayPullFailure(error);
    }
  };

  const demoHadAccounts = await failureSource(() =>
    loadBrokerDay({
      readers: {
        live: reader(scene({ accounts: [] })),
        demo: failingReader(
          demoScene,
          '/position/list',
          () => new TradovateRequestError('/position/list', 500, 'upstream')
        ),
      },
      environment: 'live',
      dayStartMs: DAY_START,
      tradovateUserId: ACCOUNT.userId,
      now: NOW,
    })
  );

  const mintDiscoveryFailed = await failureSource(() =>
    loadBrokerDay({
      readers: {
        live: failingReader(
          scene(),
          '/account/list',
          () => new TradovateRequestError('/account/list', 500, 'upstream')
        ),
        demo: reader(demoScene),
      },
      environment: 'live',
      dayStartMs: DAY_START,
      tradovateUserId: ACCOUNT.userId,
      now: NOW,
    })
  );

  group('trading reads are routed by purpose, not by the mint environment', [
    // (1)
    c('live holds the account, demo empty: byte-identical to today', liveOnly, await pull(withTrips([closedToday1]))),
    c(
      "and (a′)'s whole cost is one /account/list on the other host",
      liveOnlyDemo.calls,
      ['/account/list']
    ),

    // (2)
    c(
      'demo holds the account: a non-zero day, which is the routing fix',
      [demoOwned.closedCount, demoOwned.net],
      [1, 1000]
    ),
    c(
      "REF-90's actual row is still dropped without a permission naming us",
      [demoLucid.closedCount, demoLucid.net],
      [0, 0]
    ),
    c(
      'and the reason is ownership, which is what Stage 2 then answers',
      partitionAccounts([{ ...DEMO_ACCOUNT, userId: 999 }], ACCOUNT.userId).counts.noOwner,
      1
    ),

    // (3)
    c(
      'both hosts hold accounts: the day is the sum',
      [bothHosts.closedCount, bothHosts.net, bothHosts.lost, bothHosts.losingCount],
      [2, -500 + 1000, 500, 1]
    ),

    // (4) The sharpest two assertions in the file.
    c(
      'colliding fill ids are not welded into one trade',
      colliding.closedCount,
      2
    ),
    c(
      "and one host's valuePerPoint never prices the other host's contract",
      [colliding.net, colliding.lost],
      [500 - 20, 20]
    ),

    // (5)
    c(
      'the streak is interleaved by close time across hosts, not per host',
      streakAcross.lossStreak,
      1
    ),
    c('and the day still counts all three closes', streakAcross.closedCount, 3),

    // (6) The dedupe is visible in the day itself: doubled, this would read two
    // closes and −$1,000.
    c(
      'the same accountId on both hosts is counted once, not doubled',
      [dedupe.closedCount, dedupe.net],
      [1, -500]
    ),
    c(
      'and the host that lost the collision is not asked for positions',
      sameAccountDemo.calls,
      ['/account/list']
    ),

    // (7)
    c(
      'discovery failing on the non-mint host drops it and the pull succeeds',
      [demoRefused.closedCount, demoRefused.net],
      [1, -500]
    ),

    // (8)
    c('a failure on a host that held accounts fails the whole pull', demoHadAccounts, 'broker_unavailable'),
    c('and discovery failing on the mint host still fails it', mintDiscoveryFailed, 'broker_unavailable'),
  ]);

  // ── Stage 2: owned OR permitted ───────────────────────────────────────────
  //
  // Measured in production on 14.10, after Stage 1's routing question was
  // settled: the account the trader actually trades is owned by the firm's
  // admin user and our trader holds a TradingPermission on it with status
  // `Approved`, so ownership alone drops it — which is the second of REF-90's
  // two stacked bugs and the one that decides what counts against a limit.
  //
  // THE TWO CASES THAT MATTER MOST HERE ARE THE REFUSALS, not the acceptance.
  // A rule that accepts too much blocks a trader over money they did not lose,
  // which ./accounts.ts names as the worst failure available in this
  // integration: hence the admin-scope leak case, the wrong-account case, the
  // wrong-host case, and one case per non-accepted status word.

  /** The firm's admin user, who owns the evaluation account by `userId`. */
  const ADMIN_USER_ID = 999;
  /** REF-90's actual row: Customer, tradeable, and not ours by ownership. */
  const FIRM_ACCOUNT: TradovateAccount = {
    ...ACCOUNT,
    id: 7004,
    name: 'FIRM7004',
    userId: ADMIN_USER_ID,
  };

  /** That account, one +$1,000 close on it, and whatever the host permits. */
  const firmScene = (permissions: PermissionRow[] | null) =>
    withTrips([demoWin], {
      accounts: [FIRM_ACCOUNT],
      positions: [{ ...POSITION, accountId: FIRM_ACCOUNT.id }],
      permissions,
    });

  const firmPull = (permissions: PermissionRow[] | null) =>
    pullHosts({ live: firmScene(permissions) });

  const grant = (status: TradovateTradingPermission['status']) =>
    permission({ accountId: FIRM_ACCOUNT.id, status });

  /**
   * The same verdict the pull reaches, restated at the level the rule lives on.
   *
   * `discoverHostAccounts()` composes exactly these two functions in exactly
   * this order, so this is the pull's own claim decision on FIRM_ACCOUNT — and
   * unlike the day figures it says WHY an account was dropped, which is what
   * separates "we read the list and you hold no permission" from "there was no
   * list to read". Both drop the account; only one of them is evidence.
   */
  const firmClaim = (permissions: PermissionRow[] | null) =>
    partitionAccounts(
      [FIRM_ACCOUNT],
      ACCOUNT.userId,
      permissions === null ? null : permittedAccountIds(permissions, ACCOUNT.userId)
    ).counts;

  /** THE ROW. Owned by another userId, permitted to ours, status Approved. */
  const approved = await firmPull([grant('Approved')]);

  const accepted = await firmPull([grant('Accepted')]);
  const requested = await firmPull([grant('Requested')]);
  const declined = await firmPull([grant('Declined')]);
  const revoked = await firmPull([grant('Revoked')]);

  /**
   * The admin-scope leak. An admin's visible scope returns every trader's
   * permission, so the list naming OTHER people on this very account must not
   * move this trader's limits. Both rows are `Approved`; neither is ours.
   */
  const otherTraders = await firmPull([
    permission({ userId: ADMIN_USER_ID, accountId: FIRM_ACCOUNT.id, status: 'Approved' }),
    permission({ userId: 888, accountId: FIRM_ACCOUNT.id, status: 'Approved' }),
  ]);

  /** Ours, Approved — on a different account. */
  const otherAccount = await firmPull([permission({ accountId: ACCOUNT.id, status: 'Approved' })]);

  /**
   * Permissions are host-local, like every other entity in this API. Live says
   * the trader holds none; the grant exists only on demo, which holds no
   * account of ours and is therefore never asked for its list at all.
   */
  const permOtherHostDemo = reader(scene({ accounts: [], permissions: [grant('Approved')] }));
  const permOtherHost = await loadBrokerDay({
    readers: { live: reader(firmScene([])), demo: permOtherHostDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  /** The fail-safe, three ways the list can fail to say anything. */
  const list404 = await firmPull(null);
  const listEmpty = await firmPull([]);
  const list401 = await loadBrokerDay({
    // The grant IS in the scene, and a 401 on the read must still leave the
    // account out: an unreadable join is the owned-only rule, never a guess.
    readers: {
      live: failingReader(
        firmScene([grant('Approved')]),
        '/tradingPermission/list',
        () => new TradovateRequestError('/tradingPermission/list', 401, '{"errorText":"expired"}')
      ),
    },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  /** A permitted account that is closed is still closed. */
  const PERMITTED_CLOSED: TradovateAccount = {
    ...FIRM_ACCOUNT,
    id: 7005,
    name: 'FIRM7005',
    closed: true,
  };
  const permittedAndClosed = await pullHosts({
    live: withTrips([demoWin], {
      accounts: [FIRM_ACCOUNT, PERMITTED_CLOSED],
      positions: [{ ...POSITION, accountId: FIRM_ACCOUNT.id }],
      permissions: [grant('Approved'), permission({ accountId: PERMITTED_CLOSED.id, status: 'Approved' })],
    }),
  });

  /** What the ordinary trader pays for Stage 2, asserted as calls made. */
  const ownedReader = reader(withTrips([closedToday1]));
  await loadBrokerDay({
    readers: { live: ownedReader },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  const firmReader = reader(firmScene([grant('Approved')]));
  await loadBrokerDay({
    readers: { live: firmReader },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  /**
   * BOTH STAGES AT ONCE, which is the connection this ticket was opened for:
   * the token was minted on live, live holds nothing, and the account on demo
   * is the firm's with a permission naming our trader. Stage 1 made us ask the
   * right host and Stage 2 makes the answer count. The Stage 1 group asserts
   * the same fixture reading zero with no permission list — the two cases are
   * the before and after of this PR.
   */
  const refNinety = await pullHosts({
    live: scene({ accounts: [] }),
    demo: firmScene([grant('Approved')]),
    environment: 'live',
  });

  /** The partition, on a mixed bag with a permitted account in it. */
  const stage2Filter = partitionAccounts(
    [...candidates, FIRM_ACCOUNT, PERMITTED_CLOSED],
    ACCOUNT.userId,
    new Set([FIRM_ACCOUNT.id, PERMITTED_CLOSED.id])
  ).counts;

  group('an account counts when it is tradeable and the trader may trade it', [
    // THE REF-90 ROW, which is what this whole stage is for.
    c(
      'owned by the firm admin, Approved for our trader: counted',
      [approved.closedCount, approved.net],
      [1, 1000]
    ),
    c(
      'and it got in on a permission, not on ownership',
      firmClaim([grant('Approved')]),
      {
        total: 1,
        noOwner: 0,
        noPermission: 0,
        notCustomer: 0,
        closed: 0,
        restricted: 0,
        readonly: 0,
        futuresDisabled: 0,
        inactive: 0,
        permitted: 1,
      }
    ),
    c('Accepted counts too', accepted.closedCount, 1),
    c(
      'and the whole of REF-90: minted on live, held on demo, permitted to us',
      [refNinety.closedCount, refNinety.net],
      [1, 1000]
    ),

    // The three statuses that must not count. One case each, because "only
    // Accepted and Approved" is a claim about four other words.
    c(
      'Requested is a pending offer, not an arrangement',
      [requested.closedCount, firmClaim([grant('Requested')]).noPermission],
      [0, 1]
    ),
    c(
      'Declined does not count',
      [declined.closedCount, firmClaim([grant('Declined')]).noPermission],
      [0, 1]
    ),
    c(
      'Revoked does not count',
      [revoked.closedCount, firmClaim([grant('Revoked')]).noPermission],
      [0, 1]
    ),

    // The leak the rule is keyed to prevent: the permission's OWN userId.
    c(
      "another trader's Approved permission on the same account does not count",
      [
        otherTraders.closedCount,
        otherTraders.net,
        firmClaim([
          permission({ userId: ADMIN_USER_ID, accountId: FIRM_ACCOUNT.id, status: 'Approved' }),
          permission({ userId: 888, accountId: FIRM_ACCOUNT.id, status: 'Approved' }),
        ]).noPermission,
      ],
      [0, 0, 1]
    ),
    c(
      'our permission on a different account does not count',
      [
        otherAccount.closedCount,
        firmClaim([permission({ accountId: ACCOUNT.id, status: 'Approved' })]).noPermission,
      ],
      [0, 1]
    ),
    c(
      "the other host's permission does not reach this host's account",
      permOtherHost.closedCount,
      0
    ),
    c(
      'and a host with no account of ours is never asked for its permissions',
      permOtherHostDemo.calls,
      ['/account/list']
    ),

    // The fail-safe. Under-count, never over-count. An unreadable list and an
    // empty one are both refusals, and the reason distinguishes them: no
    // evidence to consult is `noOwner`, a list that does not name us is
    // `noPermission`.
    c(
      'a 404 on the list is the owned-only rule',
      [list404.closedCount, firmClaim(null).noOwner, firmClaim(null).noPermission],
      [0, 1, 0]
    ),
    c(
      'so is a 401, even with a grant sitting in the response behind it',
      list401.closedCount,
      0
    ),
    c(
      'an empty list is read, and says this trader holds no permission',
      [listEmpty.closedCount, firmClaim([]).noOwner, firmClaim([]).noPermission],
      [0, 0, 1]
    ),
    c('a body that is not a list is no evidence at all', permittedAccountIds({ errorText: 'x' }, ACCOUNT.userId), null),
    c('and neither is any list, when the connection has no identity', permittedAccountIds([grant('Approved')], null), null),

    // The reading itself, where every uncertainty resolves to "not permitted".
    c(
      'a row whose accountId is not a number grants nothing',
      permittedAccountIds(
        [{ userId: ACCOUNT.userId, accountId: String(FIRM_ACCOUNT.id), status: 'Approved' }],
        ACCOUNT.userId
      )?.size,
      0
    ),
    c(
      'nor does one with no status at all',
      permittedAccountIds([{ userId: ACCOUNT.userId, accountId: FIRM_ACCOUNT.id }], ACCOUNT.userId)?.size,
      0
    ),
    c(
      'and a grant of ours is one id, read from three fields',
      [...(permittedAccountIds([grant('Approved')], ACCOUNT.userId) ?? [])],
      [FIRM_ACCOUNT.id]
    ),

    // A permission says WHOSE account it is. It says nothing about tradeability.
    c(
      'a permitted account that is closed lands in closed, not in the day',
      [
        permittedAndClosed.closedCount,
        (() => {
          const f = partitionAccounts(
            [FIRM_ACCOUNT, PERMITTED_CLOSED],
            ACCOUNT.userId,
            new Set([FIRM_ACCOUNT.id, PERMITTED_CLOSED.id])
          );
          return [f.accepted.length, f.counts.closed, f.counts.permitted];
        })(),
      ],
      [1, [1, 1, 1]]
    ),

    // The cost. A normal trader pays nothing for any of the above.
    c(
      'a trader whose accounts are their own never asks for a permission list',
      ownedReader.calls.includes('/tradingPermission/list'),
      false
    ),
    c(
      'and a trader who needs it asks exactly once, after /account/list',
      [
        firmReader.calls.filter((p) => p === '/tradingPermission/list').length,
        firmReader.calls.slice(0, 2),
      ],
      [1, ['/account/list', '/tradingPermission/list']]
    ),
    c(
      'the question is "would a permission change this verdict", so an untradeable stranger does not provoke it',
      [
        permissionsCouldHelp([FIRM_ACCOUNT], ACCOUNT.userId),
        permissionsCouldHelp([{ ...FIRM_ACCOUNT, closed: true }], ACCOUNT.userId),
        permissionsCouldHelp([{ ...FIRM_ACCOUNT, accountType: 'House' }], ACCOUNT.userId),
        permissionsCouldHelp([ACCOUNT], ACCOUNT.userId),
        permissionsCouldHelp([FIRM_ACCOUNT], null),
      ],
      [true, false, false, false, false]
    ),

    // The partition stays a partition, with noPermission in the fixture.
    c(
      'every row is still counted exactly once',
      (() => {
        const f = stage2Filter;
        const dropped =
          f.noOwner + f.noPermission + f.notCustomer + f.closed + f.restricted + f.readonly + f.futuresDisabled + f.inactive;
        const accepted = selectTradingAccounts(
          [...candidates, FIRM_ACCOUNT, PERMITTED_CLOSED],
          ACCOUNT.userId,
          new Set([FIRM_ACCOUNT.id, PERMITTED_CLOSED.id])
        ).length;
        return [dropped + accepted === f.total, f.noPermission, f.permitted, f.noOwner];
      })(),
      // The one stranger in `candidates` is not permitted, so it is the
      // noPermission; FIRM_ACCOUNT is the permitted acceptance; PERMITTED_CLOSED
      // is permitted and closed, so it lands in `closed` and not in `permitted`.
      // Nothing is `noOwner`, because with a list in hand the precise reason is
      // available for every stranger.
      [true, 1, 1, 0]
    ),

    // The privacy property, and the reason this group needed a fixture with PII
    // in it rather than a tidy one. `TradingPermission` is the first entity in
    // this integration that carries a person's name and email address, both as
    // REQUIRED fields, and the pull reads a list of them.
    //
    // Asserted against what the pull RETURNS, which is also what the route
    // sends to the browser: six numbers and a timestamp. The fixture figures
    // are chosen so that no amount could coincide with an id either.
    c(
      'not one field of the permission entity reaches the answer',
      [
        PERMISSION_PII.accountHolderEmail,
        PERMISSION_PII.ctaEmail,
        PERMISSION_PII.accountHolderContact,
        PERMISSION_PII.ctaContact,
        'Yael',
        'Halperin',
        'lucidtrading.example',
        String(PERMISSION_ID),
        String(FIRM_ACCOUNT.id),
        String(ADMIN_USER_ID),
        FIRM_ACCOUNT.name,
        // Not PII, and the design note would allow it — a status is a closed
        // enum word. It is still absent, because nothing from this entity is
        // carried out of the reader at all.
        'Approved',
      ].filter((leak) =>
        [approved, otherTraders, permittedAndClosed].some((day) =>
          JSON.stringify(day).includes(leak)
        )
      ),
      []
    ),
  ]);

  // ── The product lookup ────────────────────────────────────────────────────
  //
  // Production, 14.10, five identical attempts: discovery, positions, pairs and
  // fills all succeeded, and then
  // `TradovateRequestError: Tradovate /product/item failed with HTTP 404` —
  // naming no contract, no product and no host, because it was thrown inside the
  // HTTP client before any of loadContractUnits' own checks could run.
  //
  // The request was ours. `/product/item?id=` was built from
  // `contract?.productId`, which nothing validated, and buildUrl() drops an
  // `undefined` query value by documented design — so a contract body without
  // the field sent `GET /product/item` with NO query string, and a parameterless
  // item endpoint answers 404. The documented /contract/item response schema
  // does not list `productId` at all, so that body is not contrived.
  //
  // THE CASE THAT CARRIES THE MOST WEIGHT IS (6), THE ONE THAT DOES NOT ASK.
  // Nothing documents live and demo as sharing reference-data id spaces, so
  // retrying demo's product id against live could return a DIFFERENT product and
  // price the trade at the wrong dollars per point — no error, no log line, and
  // a wrong figure into max_daily_loss. A loud 404 falls back to Reflect's own
  // data and says so on screen, which is the affordable direction.

  /** A reader answering /contract/item with `body` verbatim, calls recorded. */
  const contractItemReader = (body: unknown): TradovateReader & { calls: string[] } => {
    const inner = reader(withTrips([oneTrip]));
    return {
      calls: inner.calls,
      get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        if (path !== '/contract/item') return inner.get<T>(path, query);
        inner.calls.push(path);
        return Promise.resolve(body as T);
      },
    };
  };

  /** One host, that contract body: how it failed, and whether we still asked. */
  const onContractBody = async (body: unknown): Promise<[string, boolean]> => {
    const host = contractItemReader(body);
    const reason = await thrown(() =>
      loadBrokerDay({
        readers: { live: host },
        environment: 'live',
        dayStartMs: DAY_START,
        tradovateUserId: ACCOUNT.userId,
        now: NOW,
      })
    );
    return [reason, host.calls.includes('/product/item')];
  };

  /** The refusal every one of (1)–(4) must reach, without a second call. */
  const refusedUnasked: [string, boolean] = ['unpriceable:no_value_per_point', false];

  /** One host whose /product/item fails with `status`, everything else fine. */
  const productFails = (status: number) =>
    loadBrokerDay({
      readers: {
        live: failingReader(
          withTrips([oneTrip]),
          '/product/item',
          () => new TradovateRequestError('/product/item', status, status === 404 ? '' : '{"errorText":"Denied"}')
        ),
      },
      environment: 'live',
      dayStartMs: DAY_START,
      tradovateUserId: ACCOUNT.userId,
      now: NOW,
    });

  const errorFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
      return null;
    } catch (error) {
      return error;
    }
  };

  // (5) A genuine reference-data 404, on a productId that was perfectly usable.
  const genuine404 = await errorFrom(() => productFails(404));
  /** The one line today/route.ts logs for it, built exactly as the route does. */
  const warnLine = redactSecrets(describeDayPullFailure(genuine404));

  // (6) The REF-90 production shape: the mint host holds nothing, the account
  // and the trade are on demo, and demo cannot resolve the product.
  const idleLive = reader(scene({ accounts: [] }));
  const noRetry = await errorFrom(() =>
    loadBrokerDay({
      readers: {
        live: idleLive,
        demo: failingReader(
          demoScene,
          '/product/item',
          () => new TradovateRequestError('/product/item', 404, '')
        ),
      },
      environment: 'live',
      dayStartMs: DAY_START,
      tradovateUserId: ACCOUNT.userId,
      now: NOW,
    })
  );

  // (8) The Q1 regression guard: pricing goes to the host that reported the
  // fill, and the other host is not asked for reference data at all.
  const pricedLive = reader(scene({ accounts: [] }));
  const pricedDemo = reader(demoScene);
  const pricedDay = await loadBrokerDay({
    readers: { live: pricedLive, demo: pricedDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  const itemCalls = (calls: string[]) =>
    calls.filter((path) => path === '/contract/item' || path === '/product/item');

  group('a product that cannot be looked up fails loudly and on one host', [
    // (1)–(4) The malformed lookup, never sent. The second element of each
    // tuple is the whole point of Fix 1: no /product/item call was made.
    c('(1) a contract body with no productId', await onContractBody({ id: CONTRACT_ID, name: 'ESZ6' }), refusedUnasked),
    c('(2) a null contract body', await onContractBody(null), refusedUnasked),
    c('(3) a null productId is not dropped by buildUrl, so no ?id=null goes out', await onContractBody({ ...CONTRACT, productId: null }), refusedUnasked),
    c('(4) zero is finite and is still not an entity id', await onContractBody({ ...CONTRACT, productId: 0 }), refusedUnasked),

    // (5) Mechanism (c): the product really is not on that host.
    c('(5) a genuine 404 is the day the user is shown', classifyDayPullFailure(genuine404), 'broker_unavailable'),
    c(
      'and it is ours, naming the ids the upstream 404 never did',
      [
        genuine404 instanceof TradovateUnpriceableError,
        warnLine.includes('no_value_per_point'),
        warnLine.includes(String(PRODUCT_ID)),
        warnLine.includes(String(CONTRACT_ID)),
        // Ids are not secrets; a symbol, a price or a hostname would be.
        ['ESZ6', '5000', '4990', 'tradovate.com'].filter((leak) => warnLine.includes(leak)),
      ],
      [true, true, true, true, []]
    ),

    // (6) The Q3 decision in executable form.
    c('(6) demo cannot price it and live is never asked to', itemCalls(idleLive.calls), []),
    c('and the healthy live host paid one call, not none and not seven', idleLive.calls, ['/account/list']),
    c('and the pull fails whole rather than reporting a partial day', classifyDayPullFailure(noRetry), 'broker_unavailable'),

    // (7) Fix 2's narrowness. A 401 must stay a TradovateRequestError or the
    // penalty and transient handling above this layer stops seeing it.
    c('(7) a 401 on the product read is not an unpriceable day', await thrown(() => productFails(401)), 'TradovateRequestError'),
    c('and neither is a 500', await thrown(() => productFails(500)), 'TradovateRequestError'),

    // (8)
    c('(8) the host that reported the fill is the host that prices it', itemCalls(pricedDemo.calls), ['/contract/item', '/product/item']),
    c('and the other host is asked for nothing but its accounts', pricedLive.calls, ['/account/list']),
    c('and the day is the one that host priced', [pricedDay.closedCount, pricedDay.net], [1, 1000]),
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
