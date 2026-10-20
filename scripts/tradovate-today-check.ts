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

import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  claimedAccounts,
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
  forgetContractUnits,
  loadBrokerDay,
  type BrokerDay,
  type BrokerDayContext,
  type BrokerTrade,
  type TradovateReader,
} from '../src/lib/tradovate/fills';
import type { TradovateEnvironment } from '../src/lib/tradovate/hosts';
import {
  closedToday,
  parseDayStart,
  parseTradesWindow,
  MAX_SINCE_AGE_MS,
} from '../src/lib/tradovate/trading-day';
import { respondToTradesRequest, type TradesRouteDeps } from '../src/app/api/tradovate/trades/route';
import {
  CAPTURE_MIN_GAP_MS,
  FRESH_MS,
  forgetLivePull,
  respondToLiveRequest,
  type LiveRouteDeps,
} from '../src/app/api/tradovate/live/route';
import { forgetContractNames, loadOpenPositions } from '../src/lib/tradovate/positions';
import type { BrokerLivePull } from '../src/app/api/tradovate/live/route';
import {
  FLAT_MS,
  HOLDING_MS,
  forgetLivePoll,
  lastLivePull,
  nextPollMs,
  shareLivePull,
  shouldKeepPolling,
} from '../src/lib/tradovate/liveClock';
import { openAccounts } from '../src/lib/tradovate/useLivePositions';
import {
  NO_PRICE_NOTE,
  contractsLabel,
  positionLines,
} from '../src/components/tradovate/LivePositionLines';
import type {
  TradovateAccount,
  TradovateContract,
  TradovateContractMaturity,
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
  describeDayPullFailureKind,
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
/**
 * The hop between a contract and its product.
 *
 * A distinct number from both the contract id and the product id, so that an
 * assertion about a message naming "the maturity" cannot pass by naming
 * something else, and so that a chain that read the wrong id would fail rather
 * than coincide.
 */
const MATURITY_ID = 880011;
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

/**
 * The contract body as the documentation describes it, which is the fixture
 * repair this ticket turns on.
 *
 * It carries `contractMaturityId` and NO `productId` — the schema lists four
 * fields and `productId` is in none of them. The old fixture declared
 * `productId` and so could never have reproduced 15.10's production body, which
 * is exactly how a chain built on an undocumented field shipped green. Same
 * fixture gap the previous report recorded for `valuePerPoint`.
 */
const CONTRACT: TradovateContract = { id: CONTRACT_ID, name: 'ESZ6', contractMaturityId: MATURITY_ID };
/** The documented hop: a maturity's `productId` is required. */
const MATURITY: TradovateContractMaturity = { id: MATURITY_ID, productId: PRODUCT_ID };
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
  /** The documented step from a contract to a product. */
  maturities: TradovateContractMaturity[];
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
    maturities: [MATURITY],
    products: [PRODUCT],
    currencies: [USD],
    permissions: null,
    ...overrides,
  };
}

let nextId = 1;

/**
 * Order ids live in their own id space, and before REF-113 Stage 1 they did not.
 *
 * Every fixture in this file used to set `orderId: <the fill's own id>`, which
 * was harmless while nothing read the field and actively dangerous the moment
 * something did: a join that read `fill.id` where it meant `fill.orderId` would
 * have produced exactly the right answer in every test here and the wrong one in
 * production. So the two spaces are now disjoint by construction, and this offset
 * is what makes the difference visible in a failure message.
 *
 * Large enough that no fill id in this file can reach it, and `usableId` still
 * accepts every value it produces.
 */
const ORDER_ID_OFFSET = 600_000;
const orderIdFor = (fillId: number) => ORDER_ID_OFFSET + fillId;

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
    // Not `buyId`. See ORDER_ID_OFFSET: a fixture that conflates the two id
    // spaces cannot fail when the code under test conflates them too.
    orderId: orderIdFor(buyId),
    contractId,
    timestamp: opts.side === 'long' ? opts.openAt : opts.closeAt,
    tradeDate: { year: 2026, month: 10, day: 14 },
    action: 'Buy' as const,
    qty,
    price: opts.side === 'long' ? opts.entry : opts.exit,
  };
  const sell = {
    id: sellId,
    orderId: orderIdFor(sellId),
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

/**
 * A fill with an id THE TEST CHOOSES, for the REF-107 groups.
 *
 * `roundTrip()` above allocates ids from a counter, which is right for every
 * group that only cares about the money — and useless for the groups about
 * `brokerTradeKey`, which IS a fill id and so has to be written into the
 * assertion rather than discovered from the fixture. These helpers also let ONE
 * FILL BE SHARED BETWEEN PAIRS, which is what a scale-out and a position flip
 * are made of and what the counter-based helper cannot express at all.
 */
function handFill(f: {
  id: number;
  at: string;
  action: 'Buy' | 'Sell';
  qty: number;
  price: number;
  contractId?: number;
  /**
   * The order that produced this fill (REF-113 Stage 1).
   *
   * Defaults to a value derived from the fill id but NOT equal to it, so every
   * pre-existing fixture exercises the disjoint id spaces for free. The groups
   * that are ABOUT the join pass it explicitly — sharing one order id between
   * two fills is what a partially-filled entry is, and the default cannot
   * express it.
   */
  orderId?: number;
}): TradovateFill {
  return {
    id: f.id,
    orderId: f.orderId ?? orderIdFor(f.id),
    contractId: f.contractId ?? CONTRACT_ID,
    timestamp: f.at,
    tradeDate: { year: 2026, month: 10, day: 14 },
    action: f.action,
    qty: f.qty,
    price: f.price,
  };
}

/** A pair over two hand-built fills. Prices come off the fills, as the API's do. */
function handPair(p: {
  id: number;
  buy: TradovateFill;
  sell: TradovateFill;
  qty: number;
  positionId?: number;
}): TradovateFillPair {
  return {
    id: p.id,
    positionId: p.positionId ?? POSITION.id,
    buyFillId: p.buy.id,
    sellFillId: p.sell.id,
    qty: p.qty,
    buyPrice: p.buy.price,
    sellPrice: p.sell.price,
  };
}

/** A scene built from hand-chosen fills and pairs. */
function handScene(
  fills: TradovateFill[],
  pairs: TradovateFillPair[],
  overrides: Partial<Scene> = {}
): Scene {
  return scene({ fills, pairs, ...overrides });
}

/**
 * Every path any reader in this file was asked for, in order, for the whole run.
 *
 * One list rather than per-reader, because one of the assertions this ticket
 * adds is about the SUITE and not about a case: `/product/find`,
 * `/product/list` and `/contract/find` must never be requested anywhere, which
 * is REF-90 §2's refusal of symbol-root parsing in executable form. A
 * per-reader log cannot state that.
 */
const allCalls: string[] = [];

/** The reader seam, answering from a scene. Records the paths it was asked for. */
function reader(data: Scene): TradovateReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
      calls.push(path);
      allCalls.push(path);
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
        case '/contractMaturity/item':
          return Promise.resolve(data.maturities.find((x) => x.id === id) as T);
        case '/product/item':
          return Promise.resolve(data.products.find((x) => x.id === id) as T);
        default:
          return Promise.reject(new Error(`unexpected path ${path}`));
      }
    },
  };
}

/**
 * A day pull with a COLD contract-spec cache, which is what every group in this
 * file but the cache group wants.
 *
 * `unitByContractName` in lib/tradovate/fills.ts lives for the life of the
 * process and is shared across pulls by design, so without this one group's
 * warm `ESZ6` would answer the next group's question. That is not a hypothetical
 * — the unpriceable group varies the PRODUCT behind the same contract name and
 * asserts a refusal, and a remembered spec would price it instead and the
 * refusal would never be reached. Several call-count assertions would go the
 * same way.
 *
 * So the default is cold and the cache is exercised deliberately, by the one
 * group that calls `loadBrokerDay` directly and says why.
 */
function coldPull(request: Parameters<typeof loadBrokerDay>[0]): Promise<BrokerDay> {
  forgetContractUnits();
  return loadBrokerDay(request);
}

/**
 * {@link coldPull}, reduced to the scalars.
 *
 * Every group written before REF-107 asserts on the seven figures, and that is
 * still what `loadBrokerDay` computes — it just answers with the rows beside
 * them now. So the groups below reach for this and read exactly as they did,
 * which is the property that makes them a regression test of REF-90's numbers
 * against REF-107's list rather than a rewrite of them.
 */
async function coldDay(
  request: Parameters<typeof loadBrokerDay>[0]
): Promise<BrokerDayContext> {
  return (await coldPull(request)).day;
}

/**
 * The day figures, from ONE host.
 *
 * Passes ONE reader where the signature takes a record of them, which is the
 * point: a connection with a single usable host must behave exactly as the
 * whole suite below has always asserted. Every group above the Stage 1 group is
 * therefore a regression test for the routing change, without a line of it
 * being rewritten.
 *
 * Returns the SCALARS, not the pull, which is why REF-107 did not touch a single
 * assertion written against it: `loadBrokerDay` now answers `{ day, trades }`
 * and this helper unwraps the half that existed before. The groups that are
 * about the rows use {@link pullRows} or drive the pull directly.
 */
function pull(data: Scene, dayStartMs = DAY_START): Promise<BrokerDayContext> {
  return pullFull(data, dayStartMs).then((result) => result.day);
}

/** The whole pull from one host: the scalars and the rows (REF-107). */
function pullFull(data: Scene, dayStartMs = DAY_START, windowStartMs?: number): Promise<BrokerDay> {
  return coldPull({
    readers: { live: reader(data) },
    environment: 'live',
    dayStartMs,
    windowStartMs,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
}

/** Just the rows, newest close first. */
function pullRows(data: Scene, dayStartMs = DAY_START, windowStartMs?: number): Promise<BrokerTrade[]> {
  return pullFull(data, dayStartMs, windowStartMs).then((result) => result.trades);
}

/** Both hosts, for the Stage 1 group. The scalars, like {@link pull}. */
function pullHosts(params: {
  live?: Scene;
  demo?: Scene;
  environment?: TradovateEnvironment;
  tradovateUserId?: number | null;
  dayStartMs?: number;
}) {
  return pullHostsFull(params).then((result) => result.day);
}

function pullHostsFull(params: {
  live?: Scene;
  demo?: Scene;
  environment?: TradovateEnvironment;
  tradovateUserId?: number | null;
  dayStartMs?: number;
}): Promise<BrokerDay> {
  const readers: Partial<Record<TradovateEnvironment, TradovateReader>> = {};
  if (params.live) readers.live = reader(params.live);
  if (params.demo) readers.demo = reader(params.demo);

  return coldPull({
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
      if (path === failOn) {
        allCalls.push(path);
        return Promise.reject(error());
      }
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

  // TWELVE SEPARATE ROUND TRIPS, AND THE ENTRY INSTANTS ARE WHAT MAKE THEM
  // SEPARATE (repaired, REF-117 Stage 2). Every trip used to open at
  // 02:00:00Z and close a minute apart, which is not twelve trades — it is ONE
  // position of twelve contracts scaled out in twelve pieces, and the trader
  // was never flat in between. Nothing noticed while grouping was union-find
  // over shared fills, because those trips share none; under logical positions
  // the walk reads what the fixture actually says and answers `lossStreak: 1`.
  //
  // Which is the RIGHT answer for that shape, and precisely the distortion this
  // module's own `Trade` comment warned about for scale-outs: "a trader who
  // scaled out of a single loser would be told they had three consecutive
  // losses — and `cooldown_after_losses` defaults to three". So the fixture is
  // repaired rather than the expectation: each trip now opens and closes inside
  // its own window, which is what "twelve losing trades" means.
  const manyLosses = await pull(
    withTrips(
      Array.from({ length: 12 }, (_, i) =>
        roundTrip({
          side: 'long',
          openAt: new Date(Date.parse('2026-10-14T02:00:00Z') + i * 120_000).toISOString(),
          closeAt: new Date(Date.parse('2026-10-14T02:01:00Z') + i * 120_000).toISOString(),
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
  await coldPull({
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
      // REWRITTEN ON PURPOSE (REF-117 Stage 2). This asserted
      // `unpriceable:missing_fill` — `datePair` threw, and the WHOLE PULL
      // failed, on every contract and every account, because one pair named a
      // fill `/fill/list` had not returned. That refusal was argued from the
      // right principle (an under-counted day makes every rule more permissive)
      // and reached for too large a hammer: `/fill/list` is `depthDays = 0`, so
      // a single position carried overnight could take the integration down for
      // the session.
      //
      // The replacement is narrower and visible. A pair whose fills the walk
      // never saw cannot be placed on any cycle, so it is reported as an
      // `orphan_pair` hold and the rest of the day is stated. The money is still
      // not counted — it cannot be — but the absence is named instead of either
      // thrown or swallowed.
      'a pair whose fill is missing is HELD, and does not fail the pull',
      await (async () => {
        const stranded = await pullFull(scene({ pairs: [oneTrip.pair], fills: [] }));
        return [
          stranded.day.closedCount,
          stranded.held.map((item) => item.reason),
          stranded.held[0]?.fills,
        ];
      })(),
      [0, ['orphan_pair'], 1]
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
  const liveOnly = await coldDay({
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
  // The two hosts' contracts now carry DIFFERENT NAMES, which is what makes
  // this case say what it has always claimed to say. The spec cache is keyed by
  // contract name (REF-90 §4), so one name on both hosts would be one spec by
  // definition and the assertion below would be measuring the fixture rather
  // than the code. Colliding ids, distinct instruments: the realistic shape of
  // two id spaces that are not documented as shared.
  const collidingScene = (
    accountId: number,
    name: string,
    valuePerPoint: number,
    trip: { pair: TradovateFillPair; fills: TradovateFill[] }
  ) =>
    withTrips([trip], {
      accounts: [{ ...ACCOUNT, id: accountId }],
      // `contractId` IS NOT DECORATION HERE (repaired, REF-117 Stage 2). The row
      // used to inherit POSITION's CONTRACT_ID while the fills traded
      // COLLIDING_CONTRACT — a broker state that cannot exist, and one nothing
      // noticed because the grouping never compared a fill's contract against a
      // position's. ./cycles.ts reconciles per (account, contract), so the row
      // has to name the contract its fills are on.
      positions: [{ ...POSITION, id: 9001, accountId, contractId: COLLIDING_CONTRACT }],
      contracts: [{ id: COLLIDING_CONTRACT, name, contractMaturityId: MATURITY_ID }],
      products: [{ ...PRODUCT, valuePerPoint }],
    });

  const colliding = await pullHosts({
    // +10 points at $50 = +$500
    live: collidingScene(1, 'ESZ6', 50, collidingTrip(5000, 5010, '2026-10-14T06:00:00.000Z')),
    // −10 points at $2 = −$20, and NOT −$500
    demo: collidingScene(2, 'MYMZ6', 2, collidingTrip(4000, 3990, '2026-10-14T05:30:00.000Z')),
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
  const dedupe = await coldDay({
    readers: { live: reader(withTrips([closedToday1])), demo: sameAccountDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (7) Discovery fails on the non-mint host. An organization with no demo
  // provisioning must not start failing pulls that work today.
  const demoRefused = await coldDay({
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
    coldPull({
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
    coldPull({
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
  const permOtherHost = await coldDay({
    readers: { live: reader(firmScene([])), demo: permOtherHostDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  /** The fail-safe, three ways the list can fail to say anything. */
  const list404 = await firmPull(null);
  const listEmpty = await firmPull([]);
  const list401 = await coldDay({
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
  await coldDay({
    readers: { live: ownedReader },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  const firmReader = reader(firmScene([grant('Approved')]));
  await coldDay({
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
    // REF-110 Stage 1 MOVED THIS LINE, deliberately, and this case is where it
    // moved to. It used to read "an untradeable stranger does not provoke it"
    // and expected `false` for the closed firm account on the second row.
    //
    // Why it had to move: the gate's question was "would a permission change
    // which fills count today", and a closed account's answer is no. Once the
    // accounts TABLE exists the question is also "would a permission let us
    // RECORD this account", and a closed prop evaluation is exactly the row
    // REF-110 exists to keep. Under the old rule the permission list was never
    // read for a trader whose only prop account had just been breached, so the
    // account was never claimed and never recorded — the ticket's whole promise
    // lost on the one case it was written for.
    //
    // THE TYPE TEST STAYS, and that is the half worth protecting: `House` is
    // what an account IS, not a state it is in, so a permission naming one
    // still changes nothing and a trader whose visible scope holds a firm's
    // House accounts still pays nothing.
    c(
      'a stranger CUSTOMER account provokes the permission read, closed or not — a House one never does',
      [
        permissionsCouldHelp([FIRM_ACCOUNT], ACCOUNT.userId),
        permissionsCouldHelp([{ ...FIRM_ACCOUNT, closed: true }], ACCOUNT.userId),
        permissionsCouldHelp([{ ...FIRM_ACCOUNT, restricted: true }], ACCOUNT.userId),
        permissionsCouldHelp([{ ...FIRM_ACCOUNT, accountType: 'House' }], ACCOUNT.userId),
        permissionsCouldHelp([ACCOUNT], ACCOUNT.userId),
        permissionsCouldHelp([FIRM_ACCOUNT], null),
      ],
      [true, true, true, false, false, false]
    ),

    // And the half the widening must not have cost: the DAY. An account that
    // becomes `permitted` only under the new gate is one that failed a state
    // flag — otherwise the old gate would have fired on it — so `untradeable`
    // drops it either way. Measured against the same fixture the group above
    // uses, with the permission list readable, which is the arrangement that
    // could have gone wrong.
    c(
      'widening the gate cannot add an account to the day',
      (() => {
        const closedStranger = { ...FIRM_ACCOUNT, closed: true };
        const permitted = new Set([FIRM_ACCOUNT.id, closedStranger.id]);
        const f = partitionAccounts([ACCOUNT, closedStranger], ACCOUNT.userId, permitted);
        return [
          f.accepted.map((a) => a.id),
          // It is claimed now — the count moved out of noOwner — and still
          // dropped, which is the whole of the property.
          [f.counts.noOwner, f.counts.closed],
        ];
      })(),
      [[ACCOUNT.id], [0, 1]]
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
  // WHAT THIS GROUP NO LONGER SAYS. Four of its assertions pinned the refusal
  // that `Contract.productId` made necessary, and the maturity hop reverses the
  // first of them: a body with no `productId` is the production case and it must
  // PRICE. The other three were never about `productId` as such — they were
  // about the `> 0` boundary on an id read off a JSON body — so they are
  // repointed at `contractMaturityId`, where the same boundary still decides
  // whether a request is worth sending. See the group below for the hop itself.
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
        allCalls.push(path);
        return Promise.resolve(body as T);
      },
    };
  };

  /**
   * One host, that contract body: how it failed, and whether we still asked.
   *
   * "Asked" is now the MATURITY call, because that is the request this
   * validation exists to withhold. `/contractMaturity/item` is the first hop
   * out of the contract body, so an id the API would not have honoured shows up
   * here as a call that should not have been made — the same property the old
   * version of this helper asserted one endpoint further along.
   */
  const onContractBody = async (body: unknown): Promise<[string, boolean]> => {
    const host = contractItemReader(body);
    const reason = await thrown(() =>
      coldPull({
        readers: { live: host },
        environment: 'live',
        dayStartMs: DAY_START,
        tradovateUserId: ACCOUNT.userId,
        now: NOW,
      })
    );
    return [reason, host.calls.includes('/contractMaturity/item')];
  };

  /** The refusal (2)–(4) must reach, without a second call. */
  const refusedUnasked: [string, boolean] = ['unpriceable:no_value_per_point', false];

  /** One host whose /product/item fails with `status`, everything else fine. */
  const productFails = (status: number) =>
    coldPull({
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
    coldPull({
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
  const pricedDay = await coldDay({
    readers: { live: pricedLive, demo: pricedDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  /** The reference-data reads, in the order they were made. */
  const itemCalls = (calls: string[]) =>
    calls.filter(
      (path) =>
        path === '/contract/item' || path === '/contractMaturity/item' || path === '/product/item'
    );

  group('a product that cannot be looked up fails loudly and on one host', [
    // (1) REWRITTEN, and it is the assertion this ticket exists for. This exact
    // body — the documented four fields, no `productId` — is what production
    // answered at 11:17 on 15.10, and the old chain refused it. It must now
    // walk on to the maturity instead of throwing.
    c(
      '(1) a contract body with no productId is the production case, and it is not a refusal',
      await onContractBody({ id: CONTRACT_ID, name: 'ESZ6', contractMaturityId: MATURITY_ID }),
      ['no throw', true]
    ),

    // (2)–(4) The malformed lookup, never sent. Still true, and now about the
    // field the documentation actually promises. The second element of each
    // tuple is the whole point of Fix 1: no further call was made.
    c('(2) a null contract body states no contractMaturityId either', await onContractBody(null), refusedUnasked),
    c('(3) a null contractMaturityId is not dropped by buildUrl, so no ?id=null goes out', await onContractBody({ ...CONTRACT, contractMaturityId: null }), refusedUnasked),
    c('(4) zero is finite and is still not an entity id', await onContractBody({ ...CONTRACT, contractMaturityId: 0 }), refusedUnasked),

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
    c('(8) the host that reported the fill is the host that prices it', itemCalls(pricedDemo.calls), ['/contract/item', '/contractMaturity/item', '/product/item']),
    c('and the other host is asked for nothing but its accounts', pricedLive.calls, ['/account/list']),
    c('and the day is the one that host priced', [pricedDay.closedCount, pricedDay.net], [1, 1000]),
  ]);

  // ── A contract reaches its product the documented way ─────────────────────
  //
  // Production, 15.10 11:17, with the fix above shipped: the refusal fired, it
  // named the contract, and it saved a request that could never have worked —
  // and it was still the wrong final answer. `/contract/item` had answered with
  // a body that has no `productId`, which is not a broken host but the
  // DOCUMENTED shape: the schema lists `name`, `contractMaturityId`,
  // `timestamp`, `id`, and both doc mirrors publish the same four. Some hosts
  // return `productId` anyway, which is why a chain built on it shipped.
  //
  // `ContractMaturity.productId` is required on a documented entity, reached by
  // a required field of the contract we already fetch. So the chain gains one
  // hop and loses its guess:
  //
  //   /contract/item → contractMaturityId → /contractMaturity/item
  //                  → productId          → /product/item
  //
  // AND THERE IS NO STRING PARSING ANYWHERE IN IT, which case 9 asserts over
  // the whole run. A symbol root stripped off `MNQZ6` is derivable and was
  // rejected on purpose (REF-90 §2): spreads carry two maturities, continuous
  // contracts carry none, options carry a strike, and the documentation's own
  // example product name is `ES_Futures` rather than `ES` — so every failure of
  // such a rule is either a silently wrong product or a 404 on a
  // well-formed-looking request, which is the exact shape that made this bug
  // take two days to read.

  /** A reader answering /contractMaturity/item with `body` verbatim. */
  const maturityItemReader = (body: unknown): TradovateReader & { calls: string[] } => {
    const inner = reader(withTrips([oneTrip]));
    return {
      calls: inner.calls,
      get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        if (path !== '/contractMaturity/item') return inner.get<T>(path, query);
        inner.calls.push(path);
        allCalls.push(path);
        return Promise.resolve(body as T);
      },
    };
  };

  /** One host: the refusal it reached, what the message named, and what it read. */
  const refusalOn = async (host: TradovateReader & { calls: string[] }) => {
    const error = await errorFrom(() =>
      coldPull({
        readers: { live: host },
        environment: 'live',
        dayStartMs: DAY_START,
        tradovateUserId: ACCOUNT.userId,
        now: NOW,
      })
    );
    const message = error instanceof Error ? error.message : '';
    return {
      reason: error instanceof TradovateUnpriceableError ? `unpriceable:${error.reason}` : String(error),
      namesContract: message.includes(String(CONTRACT_ID)),
      namesMaturity: message.includes(String(MATURITY_ID)),
      reads: itemCalls(host.calls),
    };
  };

  // (1)–(2) THE PRODUCTION BODY, and the whole ticket in two assertions. The
  // default fixture IS that body now — `CONTRACT` carries no `productId`,
  // because the entity does not — so every group above this one has been
  // pricing the documented shape all along, which is the fixture repair.
  const documented = reader(withTrips([oneTrip]));
  const documentedDay = await coldDay({
    readers: { live: documented },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (3) A host that DOES return `Contract.productId`, pointing at a product
  // that says a point is worth $7. Reading it would price this trade at −$70;
  // the maturity's product says $50 and −$500. The one-path decision, in the
  // only form that can be measured from outside: a number.
  // The decoy product is in the scene and perfectly resolvable, which is what
  // makes this case sharp: a chain that read the contract's own copy would not
  // fail, it would quietly report a different number.
  const DECOY_PRODUCT_ID = 4242;
  const decoyHost = ((): TradovateReader & { calls: string[] } => {
    const inner = reader(
      withTrips([oneTrip], {
        products: [PRODUCT, { ...PRODUCT, id: DECOY_PRODUCT_ID, valuePerPoint: 7 }],
      })
    );
    return {
      calls: inner.calls,
      get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
        if (path !== '/contract/item') return inner.get<T>(path, query);
        inner.calls.push(path);
        allCalls.push(path);
        return Promise.resolve({ ...CONTRACT, productId: DECOY_PRODUCT_ID } as TradovateContract as T);
      },
    };
  })();
  const decoyDay = await coldDay({
    readers: { live: decoyHost },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // (4)–(5) The `usableId` boundary, which is now one function serving both ids
  // and the value per point, so these three cases pin one place instead of
  // three that could drift.
  const noMaturityId = await refusalOn(contractItemReader({ id: CONTRACT_ID, name: 'ESZ6' }));
  const nullMaturityId = await refusalOn(
    contractItemReader({ ...CONTRACT, contractMaturityId: null })
  );
  const zeroMaturityId = await refusalOn(
    contractItemReader({ ...CONTRACT, contractMaturityId: 0 })
  );

  // (6) The maturity resolves and names no product. The message has to name
  // BOTH ends — the maturity it asked about and the contract that sent it there
  // — because a maturity id alone is not something anyone can look up from a
  // log line.
  const noProductId = await refusalOn(maturityItemReader({ id: MATURITY_ID }));
  const nullProductId = await refusalOn(maturityItemReader({ ...MATURITY, productId: null }));
  const zeroProductId = await refusalOn(maturityItemReader({ ...MATURITY, productId: 0 }));

  // (7)–(8) The new call's own 404-only catch. This is the hop that has never
  // run in production, so the one thing that must not happen if a documented
  // required id does not resolve is a bare upstream 404 naming neither end of
  // it — and a 401 or a 500 must stay a TradovateRequestError, or the penalty
  // and transient handling above this layer stops seeing them.
  const maturityFails = (status: number) =>
    coldPull({
      readers: {
        live: failingReader(
          withTrips([oneTrip]),
          '/contractMaturity/item',
          () =>
            new TradovateRequestError(
              '/contractMaturity/item',
              status,
              status === 404 ? '' : '{"errorText":"Denied"}'
            )
        ),
      },
      environment: 'live',
      dayStartMs: DAY_START,
      tradovateUserId: ACCOUNT.userId,
      now: NOW,
    });

  const maturity404 = await errorFrom(() => maturityFails(404));
  const maturity404Line = redactSecrets(describeDayPullFailure(maturity404));

  // (10) One name, two hosts, one pull. The hosts run in sequence, so demo's
  // `ESZ6` meets a warm key and never asks what it is worth — which is sound
  // for the reason §3 sets out and a `contractId`-keyed cache could not claim:
  // a name is an exchange fact, not a host-local row.
  const SHARED_NAME_CONTRACT_ID = 999777;
  const sharedNameLive = reader(withTrips([oneTrip]));
  const sharedNameDemo = reader(
    withTrips(
      [
        roundTrip({
          side: 'long',
          openAt: '2026-10-14T05:00:00Z',
          closeAt: '2026-10-14T06:30:00Z',
          entry: 5000,
          exit: 5020,
          contractId: SHARED_NAME_CONTRACT_ID,
        }),
      ],
      {
        accounts: [DEMO_ACCOUNT],
        positions: [
          { ...POSITION, accountId: DEMO_ACCOUNT.id, contractId: SHARED_NAME_CONTRACT_ID },
        ],
        // The same instrument, a different host, therefore a different id and
        // the same name — and the same $50 a point, because two hosts naming
        // one instrument cannot disagree about what it is.
        contracts: [{ id: SHARED_NAME_CONTRACT_ID, name: 'ESZ6', contractMaturityId: 990011 }],
        maturities: [{ id: 990011, productId: 7777 }],
        products: [{ ...PRODUCT, id: 7777, valuePerPoint: 50 }],
      }
    )
  );
  const sharedName = await coldDay({
    readers: { live: sharedNameLive, demo: sharedNameDemo },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
  const productCalls = (calls: string[]) => calls.filter((p) => p === '/product/item').length;

  // (11) A SECOND PULL IN THE SAME PROCESS, which is the case the cache exists
  // for: a pull runs at most every 30 seconds (FRESH_MS) and re-read all three
  // endpoints every time, for numbers that change when a contract is relisted.
  // Note what is NOT saved — the name comes out of /contract/item, so that read
  // still happens once per contract per pull. Three calls become one.
  //
  // Driven through loadBrokerDay directly, because coldPull() would defeat it.
  forgetContractUnits();
  const firstPullHost = reader(withTrips([oneTrip]));
  const secondPullHost = reader(withTrips([oneTrip]));
  const warmRequest = (host: TradovateReader) => ({
    readers: { live: host },
    environment: 'live' as const,
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
  const firstPull = (await loadBrokerDay(warmRequest(firstPullHost))).day;
  const secondPull = (await loadBrokerDay(warmRequest(secondPullHost))).day;

  // (12) Two names that happen to share a product. Each name is a key of its
  // own, so each resolves on its own — the cache is not a product cache, and
  // two contracts of one product are two specs as far as it is concerned. They
  // are also resolved concurrently, so neither can see the other's entry.
  const SIBLING_CONTRACT_ID = 2606307;
  const SIBLING_MATURITY_ID = 880012;
  const siblingHost = reader(
    withTrips(
      [
        roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 5010 }),
        roundTrip({
          side: 'long',
          openAt: '2026-10-14T05:00:00Z',
          closeAt: '2026-10-14T06:30:00Z',
          entry: 5000,
          exit: 5020,
          contractId: SIBLING_CONTRACT_ID,
        }),
      ],
      {
        // ONE ROW PER CONTRACT, because that is what Tradovate returns and what
        // the reconciliation reads. The sibling contract had no position row at
        // all before REF-117 Stage 2, so its fills could not be attributed and
        // the whole group would be held.
        positions: [POSITION, { ...POSITION, id: 9003, contractId: SIBLING_CONTRACT_ID }],
        contracts: [CONTRACT, { id: SIBLING_CONTRACT_ID, name: 'ESH7', contractMaturityId: SIBLING_MATURITY_ID }],
        // Two maturities of ONE product: the March contract and the December
        // one are both ES, and both are worth $50 a point.
        maturities: [MATURITY, { id: SIBLING_MATURITY_ID, productId: PRODUCT_ID }],
      }
    )
  );
  const siblings = await coldDay(warmRequest(siblingHost));

  // (13) A failure is not remembered. A delisting that gets resolved, or a host
  // hiccup, has to be re-asked — otherwise one 404 would refuse this trader's
  // day for the life of the process.
  forgetContractUnits();
  const failedThenFixed = await thrown(() =>
    loadBrokerDay(
      warmRequest(
        failingReader(
          withTrips([oneTrip]),
          '/product/item',
          () => new TradovateRequestError('/product/item', 404, '')
        )
      )
    )
  );
  const afterFailure = (await loadBrokerDay(warmRequest(reader(withTrips([oneTrip]))))).day;

  group('a contract reaches its product the documented way', [
    // (1) The production case: the body that refused at 11:17 now prices.
    c(
      '(1) a contract with contractMaturityId and no productId prices normally',
      [documentedDay.closedCount, documentedDay.net, documentedDay.lost],
      [1, -500, 500]
    ),

    // (2) And the route it took.
    c(
      '(2) the calls are the documented three, in order',
      itemCalls(documented.calls),
      ['/contract/item', '/contractMaturity/item', '/product/item']
    ),

    // (3) The one-path decision, which is the recommendation this fix adopted.
    // −$70 here would mean the undocumented shortcut was taken.
    c(
      "(3) a host's own Contract.productId is not read even when it is there",
      [decoyDay.net, decoyDay.lost],
      [-500, 500]
    ),

    // (4)
    c(
      '(4) no contractMaturityId: refused, named, and the maturity never asked for',
      noMaturityId,
      {
        reason: 'unpriceable:no_value_per_point',
        namesContract: true,
        namesMaturity: false,
        reads: ['/contract/item'],
      }
    ),

    // (5) The same boundary, one function, three shapes of the same lie.
    c(
      '(5) null and 0 are not ids either, and cost no request',
      [nullMaturityId, zeroMaturityId],
      [
        { reason: 'unpriceable:no_value_per_point', namesContract: true, namesMaturity: false, reads: ['/contract/item'] },
        { reason: 'unpriceable:no_value_per_point', namesContract: true, namesMaturity: false, reads: ['/contract/item'] },
      ]
    ),

    // (6) Both ends named, and the product never asked for.
    c(
      '(6) a maturity that states no usable productId names the maturity AND the contract',
      [noProductId, nullProductId, zeroProductId],
      Array.from({ length: 3 }, () => ({
        reason: 'unpriceable:no_value_per_point',
        namesContract: true,
        namesMaturity: true,
        reads: ['/contract/item', '/contractMaturity/item'],
      }))
    ),

    // (7) The 404-only catch, extended to the new call.
    c(
      '(7) a 404 on the maturity is an unpriceable day naming both ids',
      [
        maturity404 instanceof TradovateUnpriceableError,
        classifyDayPullFailure(maturity404),
        maturity404Line.includes(String(MATURITY_ID)),
        maturity404Line.includes(String(CONTRACT_ID)),
        // Same discipline as the product 404: ids are not secrets, a symbol or
        // a price or a hostname would be.
        ['ESZ6', '5000', '4990', 'tradovate.com'].filter((leak) => maturity404Line.includes(leak)),
      ],
      [true, 'broker_unavailable', true, true, []]
    ),

    // (8) And the narrowness of it.
    c('(8) a 401 on the maturity read is not an unpriceable day', await thrown(() => maturityFails(401)), 'TradovateRequestError'),
    c('and neither is a 500', await thrown(() => maturityFails(500)), 'TradovateRequestError'),

    // (9) REF-90 §2's refusal, over the WHOLE RUN rather than one case. Every
    // reader in this file logs to `allCalls`, and the groups that drive one all
    // sit above this line.
    c(
      '(9) no symbol parsing: /product/find, /product/list and /contract/find are never called',
      ['/product/find', '/product/list', '/contract/find'].filter((path) => allCalls.includes(path)),
      []
    ),

    // (10) The cache, within one pull, across two hosts.
    c(
      '(10) one name on two hosts is one spec: a single /product/item, both trades priced',
      [
        productCalls(sharedNameLive.calls) + productCalls(sharedNameDemo.calls),
        sharedName.closedCount,
        sharedName.net,
      ],
      [1, 2, -500 + 1000]
    ),

    // (11) The cache, across pulls.
    c(
      '(11) a second pull in the same process pays one call, not three',
      [
        itemCalls(secondPullHost.calls),
        secondPull.net,
        // The first pull paid all three, which is what the second one saved.
        itemCalls(firstPullHost.calls).length,
        firstPull.net,
      ],
      [['/contract/item'], -500, 3, -500]
    ),

    // (12) Keyed by name, not by product.
    c(
      '(12) two names sharing one product are two keys, each resolved on its own',
      [siblings.closedCount, siblings.net, productCalls(siblingHost.calls)],
      [2, 500 + 1000, 2]
    ),

    // (13) Nothing is remembered on failure.
    c(
      '(13) a failed lookup is not remembered, so the next pull prices',
      [failedThenFixed, afterFailure.net],
      ['unpriceable:no_value_per_point', -500]
    ),

    // (14) THE ONE TO WRITE FIRST, and the only way a name-keyed cache could go
    // wrong is if it were quietly keyed on something else. Restated from the
    // Stage 1 group rather than re-driven: that is the same `colliding` pull,
    // whose fixture now gives the two hosts' colliding contractIds DIFFERENT
    // names, which is what makes it a test of the cache as well as of pooling.
    c(
      '(14) nothing crosses hosts by id: colliding contractIds, different names, different values',
      [colliding.closedCount, colliding.net, colliding.lost],
      [2, 500 - 20, 20]
    ),

    // (15) The Q1 guard, restated for three calls. Same two readers as case (8)
    // of the group above.
    c(
      '(15) all three reads go to the host that reported the fill',
      [itemCalls(pricedDemo.calls), pricedLive.calls],
      [['/contract/item', '/contractMaturity/item', '/product/item'], ['/account/list']]
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

  // ── REF-108: live positions ───────────────────────────────────────────────

  await liveLoaderGroup();
  await liveRouteGroup();
  await liveCacheGroup();
  await liveFlatTransitionGroup();
  await liveClockGroup();
  liveNeverReachesRulesGroup();

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

  // ══ REF-107 STAGE 1 — the rows, and the route that serves them ════════════
  //
  // Everything above this line is REF-90's: seven scalars, and a suite that
  // asserts them. Stage 1 returns the LIST those scalars reduce, so these groups
  // are about three things and in this order: that the three §A1 fields are
  // right, that the key is stable enough for Stage 2 to hang a UNIQUE on, and
  // that the two routes send what each of them says it sends and nothing more.

  // ── The journal row ───────────────────────────────────────────────────────

  const ONE_LONG = roundTrip({
    side: 'long',
    openAt: '2026-10-14T05:00:00Z',
    closeAt: '2026-10-14T06:00:00Z',
    entry: 5000,
    exit: 5010,
  });
  const longRow = (await pullRows(withTrips([ONE_LONG])))[0];

  // A PROFITABLE SHORT, which is the case this codebase has got wrong once
  // before (lib/rules/tradeRuleContext.ts' header). Sold at 5000, bought back at
  // 4990: the direction must read 'short' off the leg order, the entry must be
  // the SELL, and the money must be positive.
  const shortWinRow = (
    await pullRows(
      withTrips([
        roundTrip({
          side: 'short',
          openAt: '2026-10-14T05:00:00Z',
          closeAt: '2026-10-14T06:00:00Z',
          entry: 5000,
          exit: 4990,
        }),
      ])
    )
  )[0];
  const shortLossRow = (
    await pullRows(
      withTrips([
        roundTrip({
          side: 'short',
          openAt: '2026-10-14T05:00:00Z',
          closeAt: '2026-10-14T06:00:00Z',
          entry: 5000,
          exit: 5010,
        }),
      ])
    )
  )[0];

  // A contract whose body names nothing usable. It is already priced rather than
  // refused (loadContractUnits remembers nothing it cannot key, but it does not
  // reject it), and REF-107 must not change that: failing a day REF-90 totals
  // today over a DISPLAY field would be REF-90 §4 happening twice.
  const namelessPull = await pullFull(
    withTrips([ONE_LONG], { contracts: [{ id: CONTRACT_ID, name: '', contractMaturityId: MATURITY_ID }] })
  );

  group('a finished trade reads as a journal row (REF-107 §A1)', [
    c('(1) a long: direction off the leg order, never off the prices', longRow.direction, 'long'),
    c('(2) a long enters on its buy and exits on its sell', [longRow.entryPrice, longRow.exitPrice], [5000, 5010]),
    c('(3) a profitable short is a short, and it is a WIN', [shortWinRow.direction, shortWinRow.pnlUsd], ['short', 500]),
    c('(4) a short enters on its SELL and exits on its buy', [shortWinRow.entryPrice, shortWinRow.exitPrice], [5000, 4990]),
    c('(5) a losing short is still a short', [shortLossRow.direction, shortLossRow.pnlUsd], ['short', -500]),
    c(
      '(6) the entry instant is kept, not just the close (§A1 gap 2)',
      [longRow.openedAtMs, longRow.closedAtMs],
      [Date.parse('2026-10-14T05:00:00Z'), Date.parse('2026-10-14T06:00:00Z')]
    ),
    c('(7) opened before closed, for a long and a short alike', [
      longRow.openedAtMs < longRow.closedAtMs,
      shortWinRow.openedAtMs < shortWinRow.closedAtMs,
    ], [true, true]),
    // The product in every fixture is named 'ES' and the contract 'ESZ6', so
    // this assertion can only pass by reading the contract.
    c('(8) the symbol is the CONTRACT name, not the product name (§A1 gap 1)', longRow.symbol, 'ESZ6'),
    c('(9) quantity, account and host ride along', [longRow.qty, longRow.accountId, longRow.host], [1, ACCOUNT.id, 'live']),
    c('(10) the fills are named, ascending, and the lowest keys the trade', [
      longRow.fillIds.length,
      longRow.fillIds[0] < longRow.fillIds[1],
      longRow.brokerTradeKey,
    ], [2, true, `live:${longRow.fillIds[0]}`]),
    c(
      '(11) a contract that names nothing is priced, with a null symbol — not refused',
      [namelessPull.trades[0].symbol, namelessPull.day.closedCount, namelessPull.day.net],
      [null, 1, 500]
    ),
  ]);

  // ── The key ───────────────────────────────────────────────────────────────

  // One entry of three, exited in three instalments: three pairs sharing fill
  // 101. The same decision as a single pair of qty 3, and the key and the money
  // must not be able to tell the two fixtures apart — that is what makes a
  // re-pull after a scale-out idempotent in Stage 2 instead of a duplicate.
  const entry101 = handFill({ id: 101, at: '2026-10-14T05:00:00Z', action: 'Buy', qty: 3, price: 5000 });
  const scaledOutPairs = [
    handPair({ id: 1001, buy: entry101, sell: handFill({ id: 102, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 1, price: 4990 }), qty: 1 }),
    handPair({ id: 1002, buy: entry101, sell: handFill({ id: 103, at: '2026-10-14T06:30:00Z', action: 'Sell', qty: 1, price: 4980 }), qty: 1 }),
    handPair({ id: 1003, buy: entry101, sell: handFill({ id: 104, at: '2026-10-14T07:00:00Z', action: 'Sell', qty: 1, price: 4970 }), qty: 1 }),
  ];
  const scaledOutFills = [
    entry101,
    handFill({ id: 102, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 1, price: 4990 }),
    handFill({ id: 103, at: '2026-10-14T06:30:00Z', action: 'Sell', qty: 1, price: 4980 }),
    handFill({ id: 104, at: '2026-10-14T07:00:00Z', action: 'Sell', qty: 1, price: 4970 }),
  ];
  const scaledOut = (await pullRows(handScene(scaledOutFills, scaledOutPairs)))[0];

  // THE SAME PULL WITH THE PAIRS IN THE OPPOSITE ORDER. `/fillPair/list`
  // documents no ordering, so this is the shape a re-pull can genuinely arrive
  // in, and nothing a journal keys on may depend on it.
  const reordered = (await pullRows(handScene([...scaledOutFills].reverse(), [...scaledOutPairs].reverse())))[0];

  const oneBigExit = (
    await pullRows(
      handScene(
        [entry101, handFill({ id: 102, at: '2026-10-14T07:00:00Z', action: 'Sell', qty: 3, price: 4980 })],
        [
          handPair({
            id: 1001,
            buy: entry101,
            sell: handFill({ id: 102, at: '2026-10-14T07:00:00Z', action: 'Sell', qty: 3, price: 4980 }),
            qty: 3,
          }),
        ]
      )
    )
  )[0];

  // §A3's CAVEAT, PINNED RATHER THAN FIXED. Two separate trades; then a later
  // pull sees one more pair that shares a fill with each of them, so union-find
  // welds all three into one group whose lowest fill id belongs to the earlier
  // trade. `live:320` stops existing. Stage 2 must not write a key for a
  // position that is still open, and this is the test that will fail if someone
  // decides it can.
  const b310 = handFill({ id: 310, at: '2026-10-14T05:00:00Z', action: 'Buy', qty: 1, price: 5000 });
  const s311 = handFill({ id: 311, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 1, price: 5010 });
  const b320 = handFill({ id: 320, at: '2026-10-14T06:30:00Z', action: 'Buy', qty: 1, price: 5020 });
  const s321 = handFill({ id: 321, at: '2026-10-14T07:00:00Z', action: 'Sell', qty: 1, price: 5030 });
  const separatePair = handPair({ id: 1101, buy: b310, sell: s311, qty: 1 });
  const otherPair = handPair({ id: 1102, buy: b320, sell: s321, qty: 1 });
  const bridgePair = handPair({ id: 1103, buy: b320, sell: s311, qty: 1 });

  const beforeMerge = await pullRows(handScene([b310, s311, b320, s321], [separatePair, otherPair]));
  const afterMerge = await pullRows(handScene([b310, s311, b320, s321], [separatePair, otherPair, bridgePair]));

  group("a trade's key is its group's lowest fill id (REF-107 §A3)", [
    c('(1) the key is host-qualified, because fill ids are host-local', scaledOut.brokerTradeKey, 'live:101'),
    c('(2) every fill in the group is named, deduplicated and ascending', scaledOut.fillIds, [101, 102, 103, 104]),
    c('(3) a scale-out is ONE trade, summed, from first entry to last exit', [
      scaledOut.qty,
      scaledOut.openedAtMs,
      scaledOut.closedAtMs,
      scaledOut.pnlUsd,
    ], [3, Date.parse('2026-10-14T05:00:00Z'), Date.parse('2026-10-14T07:00:00Z'), -3000]),
    // The weighted means and the P&L are the same arithmetic seen twice:
    // (4980 − 5000) × 3 × $50 is −3000, which is the sum of the three legs.
    c('(4) entry and exit are quantity-weighted, so they reproduce the P&L', [
      scaledOut.entryPrice,
      scaledOut.exitPrice,
      (scaledOut.exitPrice - scaledOut.entryPrice) * scaledOut.qty * 50,
    ], [5000, 4980, scaledOut.pnlUsd]),
    c('(5) the pairs arriving in another order change nothing', [
      reordered.brokerTradeKey,
      reordered.direction,
      reordered.openedAtMs,
      reordered.entryPrice,
      reordered.pnlUsd,
    ], [scaledOut.brokerTradeKey, scaledOut.direction, scaledOut.openedAtMs, scaledOut.entryPrice, scaledOut.pnlUsd]),
    c('(6) THE KEY SURVIVES THE GROUPING SHAPE: one exit of 3 keys the same as three of 1', [
      oneBigExit.brokerTradeKey,
      oneBigExit.qty,
      oneBigExit.pnlUsd,
    ], [scaledOut.brokerTradeKey, scaledOut.qty, scaledOut.pnlUsd]),
    c('(7) two trades sharing no fill are two keys', beforeMerge.map((t) => t.brokerTradeKey).sort(), ['live:310', 'live:320']),
    // REWRITTEN ON PURPOSE (REF-117 Stage 2), AND THIS IS THE ASSERTION THAT
    // SAYS THE HAZARD IS GONE.
    //
    // It used to read: "KNOWN (§A3): a later pair bridging two groups merges
    // them and the higher key is lost", expecting `['live:310']`. That was the
    // central caveat of the whole key design — union-find joins on shared fills,
    // so a pair arriving later could weld two separate trades together and the
    // merged group's lowest fill id might belong to the other one. `live:320`
    // stopped existing, and because both keys were genuinely distinct the
    // partial UNIQUE could not catch the duplicate. `positionFlat` existed
    // almost entirely to keep a key from being written while that was still
    // possible.
    //
    // A cycle cannot be bridged. It ends when `netPos` reaches 0, and nothing
    // executed afterwards can be part of it — so the bridging pair changes
    // nothing and BOTH keys survive. Same fixture, opposite expectation.
    c(
      '(8) a later pair bridging two groups no longer merges them (§A3 hazard gone)',
      afterMerge.map((t) => t.brokerTradeKey).sort(),
      ['live:310', 'live:320']
    ),
    // The bridging pair itself has nowhere to go: its closing leg by time is
    // `b320`, which the walk reads as an ENTRY, so no cycle claims it. That is
    // exactly the shape `orphan_pair` exists to name — and the fixture is a
    // hand-built one Tradovate would never produce, which is why it is the only
    // place in this suite that reaches it.
    c('(9) and the bridging pair is reported rather than silently dropped',
      (await pullFull(handScene([b310, s311, b320, s321], [separatePair, otherPair, bridgePair])))
        .held.map((item) => item.reason),
      ['orphan_pair']),
  ]);

  // ── The orders behind the fills (REF-113 Stage 1) ─────────────────────────

  // ONE ORDER OF 3 THAT FILLED IN THREE PIECES. This is the fixture the old
  // `orderId: f.id` default could not express at all, and it is the case §B of
  // the REF-113 investigation turns on: the trader placed ONE entry, the
  // exchange filled it in three, and the protective-order window has to be
  // anchored on that one order's submission.
  const ENTRY_ORDER = orderIdFor(1);
  const partialA = handFill({ id: 501, at: '2026-10-14T05:00:00Z', action: 'Buy', qty: 1, price: 5000, orderId: ENTRY_ORDER });
  const partialB = handFill({ id: 502, at: '2026-10-14T05:00:01Z', action: 'Buy', qty: 1, price: 5001, orderId: ENTRY_ORDER });
  const partialC = handFill({ id: 503, at: '2026-10-14T05:00:02Z', action: 'Buy', qty: 1, price: 5002, orderId: ENTRY_ORDER });

  // The exit came from a DIFFERENT order — which is what a stop that fired is —
  // and it is ONE fill of 3 that closes all three entry pieces.
  //
  // THE SHARED FILL IS WHAT MAKES THIS ONE TRADE, and the first version of this
  // fixture got it wrong in an instructive way: three entry pieces each paired
  // with their OWN exit fill share nothing, so union-find yields THREE trades
  // from one entry order. Grouping is by shared FILL and never by shared order
  // (see {@link Trade}), so a single order can legitimately span several
  // BrokerTrades. §B of REF-113 therefore cannot assume "one order, one trade"
  // in either direction.
  const STOP_ORDER = orderIdFor(2);
  const stopFill = handFill({ id: 511, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 3, price: 4990, orderId: STOP_ORDER });

  const scaleInPairs = [
    handPair({ id: 1301, buy: partialA, sell: stopFill, qty: 1 }),
    handPair({ id: 1302, buy: partialB, sell: stopFill, qty: 1 }),
    handPair({ id: 1303, buy: partialC, sell: stopFill, qty: 1 }),
  ];
  const scaleInRow = (
    await pullRows(handScene([partialA, partialB, partialC, stopFill], scaleInPairs))
  )[0];

  // A fill whose orderId is absent or zero. `0` is what an absent numeric field
  // coerces to and is not an id this API issues, so it must be dropped rather
  // than carried — a 0 in the list is an order id that joins to nothing.
  const noOrder = {
    ...handFill({ id: 521, at: '2026-10-14T05:00:00Z', action: 'Buy', qty: 1, price: 5000 }),
    orderId: 0,
  };
  const goodOrder = handFill({ id: 522, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 1, price: 5010, orderId: orderIdFor(3) });
  const unusableRow = (
    await pullRows(handScene([noOrder, goodOrder], [handPair({ id: 1401, buy: noOrder, sell: goodOrder, qty: 1 })]))
  )[0];

  // And the plain case, off the counter-based helper: two orders, neither of
  // them equal to a fill id.
  const plainRow = (await pullRows(withTrips([ONE_LONG])))[0];

  group('every order behind a trade is carried, and only the orders (REF-113 §B)', [
    c('(1) one entry order filled in three pieces is ONE order id', [
      scaleInRow.qty,
      scaleInRow.entryOrderIds.includes(ENTRY_ORDER),
      scaleInRow.entryOrderIds.filter((id) => id === ENTRY_ORDER).length,
    ], [3, true, 1]),
    // The stop IS the exit here, which §B.3 calls the highest-confidence case in
    // the whole feature: no window, no tolerance, no inference — the order is
    // simply in the set.
    c('(2) the order that closed it is there too, so a stop-exit needs no inference', [
      scaleInRow.entryOrderIds.includes(STOP_ORDER),
      scaleInRow.entryOrderIds,
    ], [true, [ENTRY_ORDER, STOP_ORDER]]),
    c('(3) ascending, deduplicated, and shorter than the fills it came from', [
      scaleInRow.fillIds.length,
      scaleInRow.entryOrderIds.length,
      scaleInRow.entryOrderIds[0] < scaleInRow.entryOrderIds[1],
    ], [4, 2, true]),
    // THE ASSERTION THE OLD FIXTURES COULD NOT MAKE. Read `fill.id` where the
    // code means `fill.orderId` and this is the line that fails.
    c('(4) an order id is NOT a fill id', [
      scaleInRow.entryOrderIds.some((id) => scaleInRow.fillIds.includes(id)),
      plainRow.entryOrderIds.some((id) => plainRow.fillIds.includes(id)),
    ], [false, false]),
    c('(5) the ordinary two-order trade carries two', [
      plainRow.entryOrderIds.length,
      plainRow.entryOrderIds.every((id) => id > ORDER_ID_OFFSET),
    ], [2, true]),
    // FAIL CLOSED, like every other number this module reads off the wire: an
    // unusable id is omitted, never carried as a plausible-looking 0.
    c('(6) an unusable orderId is dropped, not carried as 0', [
      unusableRow.entryOrderIds,
      unusableRow.fillIds.length,
    ], [[orderIdFor(3)], 2]),
    // The list is derived, so it must not depend on an order /fillPair/list
    // never promised — the same property assertion (5) of the key group makes.
    c('(7) the pairs arriving in another order change nothing', (
      await pullRows(
        handScene([stopFill, partialC, partialB, partialA], [...scaleInPairs].reverse())
      )
    )[0].entryOrderIds, scaleInRow.entryOrderIds),
    // Zero new requests is the whole point of Stage 1: `fill.orderId` was
    // already on a response the chain reads. If this ever grows an /order/list,
    // that is REF-113 Stage 2 and it does not belong in this pull.
    c('(8) and it cost no new request — no order endpoint was asked for', [
      allCalls.some((path) => path.startsWith('/order')),
      allCalls.some((path) => path.startsWith('/command')),
    ], [false, false]),
  ]);

  // ── The flip ──────────────────────────────────────────────────────────────
  //
  // §A4'S TRIPWIRE, TRIPPED ON PURPOSE (REF-117 Stage 2).
  //
  // This group used to be titled "a position flip is KNOWN-MERGED into one
  // trade" and its first assertion read "two decisions, one row — this is the
  // behaviour, not the ideal". A sell of two closing a long of one and opening a
  // short of one is ONE fill in two pairs, so union-find welded them: the
  // journal showed a single row of qty 2 and $0, which §A4 called "a row the
  // trader will not recognise". The group's own comment said: "these assertions
  // are a tripwire. If the grouping is ever changed to split a flip, this group
  // fails and whoever changed it has to say so on purpose."
  //
  // SAYING SO ON PURPOSE. The flip is now two logical positions, and the first
  // reason alone decides it: `direction` is a required field on `BrokerTrade`
  // and on `trade_plans`, and a row that is both long and short is not
  // representable — merging forces a lie. The matcher reads `direction` too, so
  // a merged flip could only ever link to one of the two plans behind it, and
  // possibly the wrong one.
  //
  // The split is by QUANTITY at the zero crossing, at ONE price, so nothing is
  // averaged and assertion (6) holds: the two P&Ls sum to the figure the merged
  // row showed. The day's `net` does not move — only its `closedCount`,
  // `losingCount` and `lossStreak` do, and in each case towards what happened.
  const flipBuy = handFill({ id: 401, at: '2026-10-14T05:00:00Z', action: 'Buy', qty: 1, price: 5000 });
  const flipOrder = handFill({ id: 402, at: '2026-10-14T06:00:00Z', action: 'Sell', qty: 2, price: 5010 });
  const flipClose = handFill({ id: 403, at: '2026-10-14T07:00:00Z', action: 'Buy', qty: 1, price: 5020 });
  const flipPull = await pullFull(
    handScene(
      [flipBuy, flipOrder, flipClose],
      [
        // The long, closed by the flip order: +$500.
        handPair({ id: 1201, buy: flipBuy, sell: flipOrder, qty: 1 }),
        // The short the same order opened, closed later: −$500.
        handPair({ id: 1202, buy: flipClose, sell: flipOrder, qty: 1 }),
      ]
    )
  );
  // Newest close first, so the SHORT — closed at 07:00 — is trades[0].
  const [shortHalf, longHalf] = flipPull.trades;

  group('a position flip is TWO logical positions, split at the zero crossing (§A4 decided)', [
    c('(1) two decisions, two rows — the tripwire, tripped deliberately', flipPull.trades.length, 2),
    c('(2) a long and a short, because a row that is both cannot be written',
      [longHalf.direction, shortHalf.direction], ['long', 'short']),
    c('(3) one contract each, and each keyed on its own lowest fill', [
      [longHalf.qty, shortHalf.qty],
      [longHalf.brokerTradeKey, shortHalf.brokerTradeKey],
    ], [[1, 1], ['live:401', 'live:402']]),
    // The reversing fill belongs to both halves: an exit of the long and the
    // entry of the short. The keys are still distinct, because the long holds a
    // fill older than the reversal by construction.
    c('(4) the reversing fill is in both rows, and the keys are still distinct', [
      longHalf.fillIds,
      shortHalf.fillIds,
    ], [[401, 402], [402, 403]]),
    c('(5) each half spans only its own decision', [
      [longHalf.entryPrice, longHalf.exitPrice],
      [shortHalf.entryPrice, shortHalf.exitPrice],
    ], [[5000, 5010], [5010, 5020]]),
    // THE PROPERTY THAT MAKES THE SPLIT SAFE TO SHIP: the money is unchanged.
    // The old merged row was qty 2 at $0; these two are +$500 and −$500.
    c('(6) the two P&Ls sum to exactly what the merged row showed', [
      longHalf.pnlUsd,
      shortHalf.pnlUsd,
      longHalf.pnlUsd + shortHalf.pnlUsd,
    ], [500, -500, 0]),
    // And the rules now see what happened. Merged, the flip netted to zero and
    // so was not a loss at all — §A4 called that "conservative-but-distorted for
    // a rule and simply wrong for a journal". Split, the losing half is a loss.
    c('(7) the day counts two closes, one of them a loss, and a streak of one', [
      flipPull.day.closedCount,
      flipPull.day.losingCount,
      flipPull.day.lossStreak,
      flipPull.day.net,
    ], [2, 1, 1, 0]),
    c('(8) and nothing is held — both halves are fully priced by their own pair',
      flipPull.held.length, 0),
  ]);

  // ── The scalars are the reduction of the rows ─────────────────────────────

  // REF-107's one structural requirement: REF-90's figures cannot drift from
  // REF-107's rows, because there is one list and it is reduced once. Asserted
  // twice over — against a reduction written here, which is what "derived from
  // the same list" means, and against hand-computed literals, so that the pair
  // of them cannot be jointly wrong.
  const mixedDay = withTrips([
    // Yesterday evening, so it is in the LIST (the streak reaches back) but not
    // in the day's figures. The one case that proves the two are different cuts.
    roundTrip({ side: 'long', openAt: '2026-10-13T16:00:00Z', closeAt: '2026-10-13T18:00:00Z', entry: 5000, exit: 4990 }),
    roundTrip({ side: 'long', openAt: '2026-10-14T02:00:00Z', closeAt: '2026-10-14T03:00:00Z', entry: 5000, exit: 5020 }),
    roundTrip({ side: 'short', openAt: '2026-10-14T03:30:00Z', closeAt: '2026-10-14T04:00:00Z', entry: 5000, exit: 5010 }),
    roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 4980 }),
  ]);
  const mixed = await pullFull(mixedDay);

  /** The reduction, written out here, over the rows the pull returned. */
  function reduceRows(rows: BrokerTrade[]): BrokerDayContext {
    const todays = rows.filter((r) => r.closedAtMs >= DAY_START);
    const streak: BrokerTrade[] = [];
    for (const row of [...rows].sort((a, b) => b.closedAtMs - a.closedAtMs).slice(0, 10)) {
      if (row.pnlUsd >= 0) break;
      streak.push(row);
    }
    return {
      closedCount: todays.length,
      losingCount: todays.filter((r) => r.pnlUsd < 0).length,
      net: todays.reduce((t, r) => t + r.pnlUsd, 0),
      lost: todays.filter((r) => r.pnlUsd < 0).reduce((t, r) => t + Math.abs(r.pnlUsd), 0),
      lossStreak: streak.length,
      minutesSinceLastClose: streak.length === 0 ? null : (NOW - streak[0].closedAtMs) / 60_000,
      asOf: mixed.day.asOf,
    };
  }

  group('the day figures ARE the reduction of the rows', [
    c('(1) every scalar, against the reduction of the returned list', mixed.day, reduceRows(mixed.trades)),
    c('(2) and against the figures worked out by hand', mixed.day, {
      closedCount: 3,
      losingCount: 2,
      net: -500,
      lost: 1500,
      lossStreak: 2,
      minutesSinceLastClose: 60,
      asOf: new Date(NOW).toISOString(),
    }),
    c('(3) the list reaches back past the day, which is why the route must filter', [
      mixed.trades.length,
      mixed.trades.filter((r) => r.closedAtMs >= DAY_START).length,
    ], [4, 3]),
    c(
      '(4) newest close first, so a journal can render it as it arrives',
      mixed.trades.map((r) => r.closedAtMs),
      [...mixed.trades.map((r) => r.closedAtMs)].sort((a, b) => b - a)
    ),
    c('(5) every row opened before it closed', mixed.trades.every((r) => r.openedAtMs < r.closedAtMs), true),
    c('(6) the day pull still answers the seven scalars and nothing more', Object.keys(mixed.day).sort(), [
      'asOf',
      'closedCount',
      'losingCount',
      'lossStreak',
      'lost',
      'minutesSinceLastClose',
      'net',
    ]),
  ]);

  // ── The window ────────────────────────────────────────────────────────────

  const DAY_START_ISO = new Date(DAY_START).toISOString();
  const windowOf = (query: Record<string, string>) =>
    parseTradesWindow(new URLSearchParams(query), NOW);

  const twoDaysBack = Date.parse('2026-10-12T00:00:00.000Z');

  group('the trade window: today by default, a week at most', [
    c('(1) no `since` is today, and says so', windowOf({ dayStart: DAY_START_ISO }), {
      ok: true,
      dayStartMs: DAY_START,
      windowStartMs: DAY_START,
      clamped: false,
    }),
    c('(2) an empty `since` is the same as none', windowOf({ dayStart: DAY_START_ISO, since: '' }).ok, true),
    c('(3) `since` inside the week reaches back to it', windowOf({ dayStart: DAY_START_ISO, since: '2026-10-12T00:00:00.000Z' }), {
      ok: true,
      dayStartMs: DAY_START,
      windowStartMs: twoDaysBack,
      clamped: false,
    }),
    c('(4) an instant, not a midnight: `since` carrying seconds is fine', windowOf({ dayStart: DAY_START_ISO, since: '2026-10-12T09:14:37.000Z' }), {
      ok: true,
      dayStartMs: DAY_START,
      windowStartMs: Date.parse('2026-10-12T09:14:37.000Z'),
      clamped: false,
    }),
    c('(5) A MONTH BACK IS CLAMPED TO THE WEEK, AND REPORTED', windowOf({ dayStart: DAY_START_ISO, since: '2026-09-01T00:00:00.000Z' }), {
      ok: true,
      dayStartMs: DAY_START,
      windowStartMs: NOW - MAX_SINCE_AGE_MS,
      clamped: true,
    }),
    c('(6) `since` later than midnight does not narrow the day', windowOf({ dayStart: DAY_START_ISO, since: '2026-10-14T05:00:00.000Z' }), {
      ok: true,
      dayStartMs: DAY_START,
      windowStartMs: DAY_START,
      clamped: false,
    }),
    c('(7) a `since` in the future is a fault in the request', windowOf({ dayStart: DAY_START_ISO, since: '2026-10-15T00:00:00.000Z' }), {
      ok: false,
      param: 'since',
      reason: 'in_future',
    }),
    c('(8) an unreadable `since` likewise', windowOf({ dayStart: DAY_START_ISO, since: 'last tuesday' }), {
      ok: false,
      param: 'since',
      reason: 'unparseable',
    }),
    c('(9) `dayStart` is still mandatory, and still never defaulted', windowOf({ since: '2026-10-12T00:00:00.000Z' }), {
      ok: false,
      param: 'dayStart',
      reason: 'missing',
    }),
    c('(10) and still validated by parseDayStart', windowOf({ dayStart: '2026-10-14T06:59:30.000Z' }), {
      ok: false,
      param: 'dayStart',
      reason: 'not_midnight',
    }),
    c('(11) the bound is seven days', MAX_SINCE_AGE_MS, 7 * 24 * 60 * 60_000),
  ]);

  // A window wider than today has to PRICE more, which is the only cost §A2
  // found. Twelve trades, eleven of them two days old: without a window the pull
  // prices today's plus the ten-trade streak window, and with one it prices the
  // lot. The day's figures are identical either way — a journal query cannot
  // restate a discipline figure.
  // One trade today and eleven two days ago. The eleven each get their own
  // entry instant for the reason the `manyLosses` fixture above now spells out:
  // eleven trips sharing one `openAt` is one position scaled out eleven times,
  // not eleven trades, and under logical positions the walk says so.
  const twelveTrades = withTrips([
    roundTrip({ side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z', entry: 5000, exit: 5010 }),
    ...Array.from({ length: 11 }, (_, i) =>
      roundTrip({
        side: 'long',
        openAt: `2026-10-12T${String(i).padStart(2, '0')}:00:00Z`,
        closeAt: `2026-10-12T${String(i).padStart(2, '0')}:30:00Z`,
        entry: 5000,
        exit: 5010,
      })
    ),
  ]);
  const narrow = await pullFull(twelveTrades);
  const wide = await pullFull(twelveTrades, DAY_START, Date.parse('2026-10-12T00:00:00Z'));

  group('a window reaches back without touching the day', [
    c('(1) no window: today plus the streak window, and no more', narrow.trades.length, 10),
    c('(2) a window two days back: every trade in it', wide.trades.length, 12),
    c('(3) THE DAY IS THE SAME FIGURE EITHER WAY', wide.day, narrow.day),
    c('(4) and it is today alone', [narrow.day.closedCount, narrow.day.net], [1, 500]),
  ]);

  // ── cycleClosed: WHOSE position has to be flat, REWRITTEN (REF-117 Stage 2) ─
  //
  // THIS GROUP ASSERTED THE OPPOSITE UNTIL REF-117, AND IT WAS RIGHT TO. Under
  // `positionFlat`, case (5) below pinned the documented limit: a trader who
  // closed a trade in the morning and was holding the SAME contract again in
  // the afternoon had one position row with a non-zero `netPos`, so the morning
  // trade — genuinely finished — waited for the afternoon one before it reached
  // the journal. §A3 chose that direction on purpose and the group's own comment
  // said a later change to it should be "a decision rather than an accident".
  //
  // This is that decision. `cycleClosed` is a property of the TRADE, so the
  // morning trade is importable the moment the trader is out of it. Case (3) is
  // the same fixture as before and now asserts the opposite outcome.
  //
  // AND TWO FIXTURES HAD TO BE REPAIRED TO SAY IT, WHICH IS ITSELF THE FINDING.
  // The old (3) and (5) set `netPos: 2` while supplying no fills for those two
  // contracts — a broker state that cannot exist. Nothing noticed, because the
  // old code never compared the two. The reconciliation in ./cycles.ts does, so
  // those fixtures now describe what they always meant: the open position has
  // its own entry fill.
  const OTHER_CONTRACT = 778899;
  const flatOwn: TradovatePosition = { ...POSITION, netPos: 0 };
  const openOwn: TradovatePosition = { ...POSITION, netPos: 2 };
  /** A second contract on the same account, still being held. */
  const openOther: TradovatePosition = {
    ...POSITION, id: 9002, contractId: OTHER_CONTRACT, netPos: -3,
  };

  const closedTrip = () =>
    roundTrip({
      side: 'long', openAt: '2026-10-14T05:00:00Z', closeAt: '2026-10-14T06:00:00Z',
      entry: 5000, exit: 5010,
    });

  /** The entry of a position still open: two contracts, no exit, so no pair. */
  const stillHolding = handFill({
    id: 990_001, at: '2026-10-14T09:00:00Z', action: 'Buy', qty: 2, price: 5020,
  });

  const aloneRows = await pullRows(withTrips([closedTrip()], { positions: [flatOwn] }));
  const besideOtherRows = await pullRows(withTrips([closedTrip()], { positions: [flatOwn, openOther] }));

  // The repaired (3): the contract is genuinely held, with the fill that holds it.
  const ownOpenTrip = closedTrip();
  const ownOpen = await pullFull(
    withTrips([ownOpenTrip], {
      positions: [openOwn],
      fills: [...ownOpenTrip.fills, stillHolding],
    })
  );

  const missingNetPos = await pullFull(
    withTrips([closedTrip()], {
      positions: [{ ...POSITION, netPos: undefined as unknown as number }],
    })
  );

  // The repaired (5) — the afternoon re-entry, which is REF-117's second case:
  // two finished round trips plus a third position still open, all on one
  // contract, all on one position row.
  const morning = closedTrip();
  const afternoon = roundTrip({
    side: 'long', openAt: '2026-10-14T07:00:00Z', closeAt: '2026-10-14T08:00:00Z',
    entry: 5020, exit: 5030,
  });
  const sameContractAgain = await pullRows(
    withTrips([morning, afternoon], {
      positions: [openOwn],
      fills: [...morning.fills, ...afternoon.fills, stillHolding],
    })
  );

  group('a trade is closed when ITS OWN CYCLE closed, not when the contract is flat (REF-117)', [
    c('(1) a finished trade on a flat position is closed',
      [aloneRows.length, aloneRows[0]?.cycleClosed], [1, true]),
    // Unchanged from the old group, and still the case it was added for: an open
    // position on another contract of the same account must not keep a finished
    // trade out of the journal.
    c('(2) an open position on ANOTHER contract does not touch it',
      [besideOtherRows.length, besideOtherRows[0]?.cycleClosed], [1, true]),
    // THE REVERSAL. Same fixture as the old (3), opposite answer: the contract
    // is still being held and the finished trade on it is importable anyway.
    c('(3) its own contract still being held no longer holds the finished trade back',
      [ownOpen.trades.length, ownOpen.trades[0]?.cycleClosed], [1, true]),
    // The still-open cycle contributes no row at all: nothing has been matched,
    // so there is no round trip to state. Same silence as "no pair, no trade".
    c('(4) and the open cycle beside it is not a row, nor an absence to explain',
      [ownOpen.held.length, ownOpen.trades.filter((t) => !t.cycleClosed).length], [0, 0]),
    // FAIL CLOSED, in the direction REF-107 named and ./cycles.ts strengthened:
    // a `netPos` we cannot read is not "flat", and it is not a trade either —
    // the group is HELD and the absence is reported rather than a row being
    // emitted with a boolean nobody can trust.
    c('(5) a netPos that is not a finite number HOLDS the group',
      [missingNetPos.trades.length, missingNetPos.held.length, missingNetPos.held[0]?.reason],
      [0, 1, 'netpos_mismatch']),
    // THE 19.10 CASE, as an assertion. Two finished trades and one position
    // still open on the same contract: both finished trades reach the journal.
    c('(6) two finished trades on a contract that is still held are BOTH closed',
      sameContractAgain.map((trade) => trade.cycleClosed), [true, true]),
    c('(7) and they are two trades with two keys, not one netted row', [
      sameContractAgain.length,
      new Set(sameContractAgain.map((trade) => trade.brokerTradeKey)).size,
    ], [2, 2]),
  ]);

  // ── The route ─────────────────────────────────────────────────────────────

  const ROW_TODAY: BrokerTrade = {
    brokerTradeKey: 'live:901',
    host: 'live',
    accountId: ACCOUNT.id,
    symbol: 'ESZ6',
    direction: 'long',
    qty: 1,
    entryPrice: 5000,
    exitPrice: 5010,
    openedAtMs: Date.parse('2026-10-14T05:00:00Z'),
    closedAtMs: Date.parse('2026-10-14T06:00:00Z'),
    pnlUsd: 500,
    fillIds: [901, 902],
    // REF-113 Stage 1. Values chosen so that they are NOT the fill ids and NOT
    // a substring of anything else in the body — the leak group below asserts
    // that neither reaches the browser, and an id that happened to appear
    // inside a price or a timestamp would make that assertion pass for the
    // wrong reason.
    entryOrderIds: [770901, 770902],
    // The route neither reads this nor filters on it; it is the IMPORT's gate
    // (REF-107 Stage 2, §A3). True here so the fixture is an ordinary finished
    // trade. scripts/broker-import-check.ts is where both values are exercised.
    cycleClosed: true,
  };
  /** Yesterday evening: in the pull because the streak reaches back, not in today. */
  const ROW_YESTERDAY: BrokerTrade = {
    ...ROW_TODAY,
    brokerTradeKey: 'live:801',
    openedAtMs: Date.parse('2026-10-13T16:00:00Z'),
    closedAtMs: Date.parse('2026-10-13T18:00:00Z'),
    fillIds: [801, 802],
  };
  const ROUTE_ASOF = new Date(NOW).toISOString();

  /** What the route was asked to load, so a case can assert it was not. */
  let loaded: { userId: string; dayStartMs: number; windowStartMs: number } | null = null;

  async function callRoute(
    query: Record<string, string>,
    overrides: Partial<TradesRouteDeps> = {}
  ) {
    loaded = null;
    const url = new URL('https://reflect.test/api/tradovate/trades');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const res = await respondToTradesRequest(new Request(url), {
      currentUserId: async () => 'user-1',
      isAllowed: () => true,
      now: () => NOW,
      loadTrades: async (userId, window) => {
        loaded = { userId, ...window };
        return { trades: [ROW_TODAY, ROW_YESTERDAY], asOf: ROUTE_ASOF };
      },
      ...overrides,
    });

    return {
      status: res.status,
      cache: res.headers.get('cache-control'),
      body: (await res.json()) as Record<string, unknown>,
    };
  }

  /** Run a case whose route logs a warning, and hand back the line it logged. */
  async function warnedBy(run: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (line: unknown) => void lines.push(String(line));
    try {
      await run();
    } finally {
      console.warn = real;
    }
    return lines.join('\n');
  }

  const today = { dayStart: DAY_START_ISO };

  const signedOut = await callRoute(today, { currentUserId: async () => null });
  const notAllowed = await callRoute(today, { isAllowed: () => false });
  const notAllowedLoad = loaded;
  // The allowlist is answered BEFORE the window is parsed, so a user with no
  // broker view never receives a 400 about a parameter that would not have been
  // used. Same order as /today.
  const notAllowedBadDay = await callRoute({ dayStart: 'yesterday' }, { isAllowed: () => false });
  const noDayStart = await callRoute({});
  const badSince = await callRoute({ ...today, since: 'last tuesday' });
  const ok = await callRoute(today);
  const okLoad = loaded;
  const sinceOk = await callRoute({ ...today, since: '2026-10-12T00:00:00.000Z' });
  const sinceClamped = await callRoute({ ...today, since: '2026-09-01T00:00:00.000Z' });

  const throwing = (error: Error) => ({ loadTrades: async () => Promise.reject(error) });
  const leakyError = new TradovateUnpriceableError(
    'No value per point for contract 2606306.',
    'no_value_per_point'
  );
  const refused: Record<string, Awaited<ReturnType<typeof callRoute>>> = {};
  const logged = await warnedBy(async () => {
    refused.expired = await callRoute(today, throwing(new TradovateNotConnectedError('user-1', 'revoked')));
    refused.missing = await callRoute(today, throwing(new TradovateNotConnectedError('user-1', 'missing')));
    refused.transient = await callRoute(today, throwing(new TradovateTransientError('upstream', { reason: 'server' })));
    refused.unpriceable = await callRoute(today, throwing(leakyError));
  });

  group('GET /api/tradovate/trades answers only its own trader', [
    c('(1) no session is a 401, and it is the only error shape', [signedOut.status, signedOut.body], [401, { error: 'Unauthorized' }]),
    c('(2) outside the allowlist is `reflect_only` at 200, not a 403', [notAllowed.status, notAllowed.body], [200, { source: 'reflect_only' }]),
    c('(3) and no broker read is attempted for them', notAllowedLoad, null),
    c('(4) the allowlist is answered before the window is even parsed', [notAllowedBadDay.status, notAllowedBadDay.body], [200, { source: 'reflect_only' }]),
    c('(5) a missing dayStart is a 400 that names the parameter', [noDayStart.status, noDayStart.body], [400, { error: 'Invalid dayStart: missing' }]),
    c('(6) a bad `since` is a 400 that names the bound a caller must respect', [badSince.status, badSince.body], [
      400,
      { error: 'Invalid since: unparseable (an instant, no older than 7 days)' },
    ]),
    c('(7) the happy answer carries the rows, the window and the instant', [ok.status, ok.body], [
      200,
      {
        source: 'broker_verified',
        trades: [ROW_TODAY],
        windowStart: DAY_START_ISO,
        asOf: ROUTE_ASOF,
      },
    ]),
    // The pull hands back the streak window too, so the route cutting the list
    // to the window it was asked for is what stops yesterday's loss appearing
    // in today's journal.
    c("(8) yesterday's row is in the pull and NOT in the answer", okLoad, {
      userId: 'user-1',
      dayStartMs: DAY_START,
      windowStartMs: DAY_START,
    }),
    c('(9) `since` widens the window, and both rows come back', [
      (sinceOk.body.trades as BrokerTrade[]).map((t) => t.brokerTradeKey),
      sinceOk.body.windowStart,
    ], [['live:901', 'live:801'], '2026-10-12T00:00:00.000Z']),
    c('(10) a clamped `since` is visible in `windowStart`, never silent', sinceClamped.body.windowStart, new Date(NOW - MAX_SINCE_AGE_MS).toISOString()),
    c('(11) a refused credential is `broker_expired`', [refused.expired.status, refused.expired.body], [200, { source: 'broker_expired' }]),
    c('(12) a connection that never existed is `reflect_only`, not a reconnect prompt', refused.missing.body, { source: 'reflect_only' }),
    c('(13) anything else degrades to `broker_unavailable`', [refused.transient.body, refused.unpriceable.body], [
      { source: 'broker_unavailable' },
      { source: 'broker_unavailable' },
    ]),
    c('(14) no-store, private on every answer', [ok.cache, signedOut.cache, noDayStart.cache, notAllowed.cache], [
      'no-store, private',
      'no-store, private',
      'no-store, private',
      'no-store, private',
    ]),
    // THE LOG RULE FOR THIS ROUTE: the kind of failure, and nothing that
    // identifies a trade. The error carries a contract id in its message and
    // /today would print it; here it must not appear.
    c('(15) the log names the failure and nothing else', [
      logged.includes('TradovateUnpriceableError(no_value_per_point)'),
      logged.includes('2606306'),
      logged.includes('user-1'),
      logged.includes('ESZ6'),
      logged.includes('5000'),
    ], [true, false, false, false, false]),
    c('(16) which is a different describer from /today\'s, and deliberately', [
      describeDayPullFailure(leakyError).includes('2606306'),
      describeDayPullFailureKind(leakyError).includes('2606306'),
    ], [true, false]),
  ]);

  // ── /today is unchanged ───────────────────────────────────────────────────

  // The privacy split REF-107 rests on: the rule engine's route sends scalars,
  // the journal's route sends rows, and a trader who only ever opens the trade
  // form has had no position leave our server. This group asserts the half that
  // can regress silently — a later change returning `trades` from /today has to
  // delete these lines on purpose.
  const todayBody = JSON.stringify({ source: 'broker_verified', day: mixed.day });
  const tradeFields = [
    'brokerTradeKey',
    'host',
    'accountId',
    'symbol',
    'direction',
    'qty',
    'entryPrice',
    'exitPrice',
    'openedAtMs',
    'closedAtMs',
    'pnlUsd',
    'fillIds',
    // REF-113 Stage 1. An order id is an id, and this route's whole claim is
    // that no id of a trader's position leaves the server through it. Added to
    // this list in the same change that created the field, because a field added
    // to BrokerTrade and NOT added here is a leak nothing would catch.
    'entryOrderIds',
    'cycleClosed',
    'trades',
  ];

  group('/api/tradovate/today still carries no trade', [
    c('(1) the response body is the source and the seven scalars', Object.keys(JSON.parse(todayBody)).sort(), ['day', 'source']),
    c('(2) not one trade field appears anywhere in it', tradeFields.filter((field) => todayBody.includes(field)), []),
    c('(3) nor a symbol, a price, an account id, a fill id or an ORDER id as a VALUE', [
      todayBody.includes('ESZ6'),
      todayBody.includes('5000'),
      todayBody.includes(String(ACCOUNT.id)),
      todayBody.includes(String(POSITION.id)),
      todayBody.includes(String(ROW_TODAY.entryOrderIds[0])),
      todayBody.includes(String(ROW_TODAY.entryOrderIds[1])),
    ], [false, false, false, false, false, false]),
    // The rows exist on the pull. They are dropped by the route, which is the
    // only reason the assertions above hold — so this one states where the line
    // actually is.
    c('(4) the rows were there to be sent, and this route is what drops them', [
      Array.isArray(mixed.trades),
      mixed.trades.length > 0,
      'trades' in mixed.day,
    ], [true, true, false]),
  ]);

  // ── REF-110 Stage 1: the accounts a pull CLAIMS ───────────────────────────
  //
  // The pull's half of REF-110. What `BrokerDay.accounts` carries is asserted
  // here; what the database does with it is asserted in
  // scripts/broker-import-check.ts, which has the Supabase stub. The split is
  // where the two properties actually live — one is a filter over a list, the
  // other is a sequence of statements — and both halves of the §A.5 fail-safe
  // appear on both sides deliberately, because it is the assertion that would
  // otherwise be found in production.

  /** The trader's own account, breached and closed. The row REF-110 is for. */
  const MY_CLOSED: TradovateAccount = { ...ACCOUNT, id: 7101, name: 'MYEVAL', closed: true };
  /** Another trader's, visible because a prop admin's scope is wide. */
  const THEIRS: TradovateAccount = { ...ACCOUNT, id: 7102, name: 'THEIRS', userId: 4242 };
  /** The firm's own House account. Not a portfolio, closed or open. */
  const HOUSE: TradovateAccount = { ...ACCOUNT, id: 7103, name: 'HOUSE', accountType: 'House' };

  const mixedScene = scene({ accounts: [ACCOUNT, MY_CLOSED, THEIRS, HOUSE] });
  // Driven through an explicit reader so the CALLS can be asserted: "zero new
  // upstream requests" is the claim this whole stage rests on, and it is only
  // checkable against a recorded list.
  const claimedReader = reader(mixedScene);
  const claimedPull = await coldPull({
    readers: { live: claimedReader },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });
  const claimedHere = claimedPull.accounts[0]?.claimed ?? [];

  // The §A.5 fail-safe, at the layer that decides it: the demo host's
  // discovery throws, so demo must be ABSENT from `accounts` entirely. An
  // empty `claimed` array for demo would be the bug — indistinguishable, from
  // the sync's side, from a trader who closed every demo account.
  const demoDown = await coldPull({
    readers: {
      live: reader(scene({ accounts: [ACCOUNT] })),
      demo: failingReader(
        scene({ accounts: [MY_CLOSED] }),
        '/account/list',
        () => new TradovateRequestError('/account/list', 500, '{"errorText":"boom"}')
      ),
    },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  // The other direction: a host that answered with an EMPTY list is present
  // with no claims, which is what lets the sync close that host's accounts.
  const demoEmpty = await coldPull({
    readers: {
      live: reader(scene({ accounts: [ACCOUNT] })),
      demo: reader(scene({ accounts: [] })),
    },
    environment: 'live',
    dayStartMs: DAY_START,
    tradovateUserId: ACCOUNT.userId,
    now: NOW,
  });

  const errorBodies: string[] = [];
  const leakyAccountList = await (async () => {
    try {
      await coldPull({
        readers: {
          live: failingReader(
            mixedScene,
            '/account/list',
            // A 403 whose body is what /account/list bodies are: the trader's
            // account names. This is the fixture the reduction exists for.
            () =>
              new TradovateRequestError(
                '/account/list',
                403,
                '[{"id":7101,"name":"MYEVAL","userId":555},{"id":7103,"name":"HOUSE"}]'
              )
          ),
        },
        environment: 'live',
        dayStartMs: DAY_START,
        tradovateUserId: ACCOUNT.userId,
        now: NOW,
      });
      return 'no throw';
    } catch (error) {
      if (error instanceof TradovateRequestError) {
        errorBodies.push(error.message, error.body);
        return `${error.name}:${error.status}`;
      }
      return error instanceof Error ? error.name : 'non-error';
    }
  })();

  group('REF-110 §A.3: the accounts a pull claims', [
    // THE FINDING, AS AN ASSERTION. `accepted` would have thrown the closed one
    // away and kept nothing else; the raw list would have kept all four.
    c('(1) the claimed set is the trader\'s own — the closed one included',
      claimedHere.map((entry) => entry.account.id).sort((a, b) => a - b),
      [ACCOUNT.id, MY_CLOSED.id]),
    c('(2) and it excludes another trader\'s account and a House account', [
      claimedHere.some((entry) => entry.account.id === THEIRS.id),
      claimedHere.some((entry) => entry.account.id === HOUSE.id),
    ], [false, false]),
    // A name is the thing that must not leak, so the exclusion is asserted
    // against the NAME and not only against the id.
    c('(3) so no stranger\'s account NAME is anywhere in what leaves the pull',
      [JSON.stringify(claimedPull.accounts).includes(THEIRS.name),
       JSON.stringify(claimedPull.accounts).includes(HOUSE.name)],
      [false, false]),

    // The flag the status is derived from. Carried, never used as a filter.
    c('(4) tradeability is reported, not applied',
      claimedHere.map((entry) => [entry.account.id, entry.tradeable]),
      [[ACCOUNT.id, true], [MY_CLOSED.id, false]]),
    c('(5) every state flag reads as untradeable, and the type is not a state',
      [
        claimedAccounts([{ ...ACCOUNT, restricted: true }], ACCOUNT.userId)[0]?.tradeable,
        claimedAccounts([{ ...ACCOUNT, readonly: true }], ACCOUNT.userId)[0]?.tradeable,
        claimedAccounts([{ ...ACCOUNT, futuresDisabled: true }], ACCOUNT.userId)[0]?.tradeable,
        claimedAccounts([{ ...ACCOUNT, active: false }], ACCOUNT.userId)[0]?.tradeable,
        claimedAccounts([{ ...ACCOUNT, accountType: 'Omnibus' }], ACCOUNT.userId).length,
      ],
      [false, false, false, false, 0]),
    c('(6) how the claim was made is carried too, for the owned and the permitted',
      [
        claimedAccounts([ACCOUNT], ACCOUNT.userId)[0]?.claim,
        claimedAccounts([THEIRS], ACCOUNT.userId, new Set([THEIRS.id]))[0]?.claim,
        // No permission evidence: a stranger is not claimed at all, which is
        // the leak this filter exists to prevent.
        claimedAccounts([THEIRS], ACCOUNT.userId).length,
      ],
      ['owned', 'permitted', 0]),

    // ACCEPTED IS UNCHANGED BY ALL OF IT. Every REF-90 assertion in this file
    // still holds because this is true, so it is stated once, directly.
    c('(7) the day\'s accepted set and its figures are untouched',
      [claimedPull.day.closedCount, claimedPull.day.net, claimedPull.trades.length],
      [0, 0, 0]),
    // ZERO NEW UPSTREAM REQUESTS, as a list rather than as a promise. The two
    // paths below are exactly what this scene cost before REF-110: the
    // permission read is provoked by a stranger that is Customer AND tradeable,
    // which the OLD gate fired on too, so even the widening is invisible here.
    c('(8) and the pull asks for nothing it did not ask for before',
      claimedReader.calls,
      ['/account/list', '/tradingPermission/list', '/position/list', '/fillPair/list']),

    // ── The §A.5 fail-safe, where it is decided ────────────────────────────
    c('(9) a host whose discovery FAILED is absent from accounts entirely',
      demoDown.accounts.map((entry) => entry.host), ['live']),
    c('(10) and a host that answered with nothing is PRESENT, holding nothing',
      demoEmpty.accounts.map((entry) => [entry.host, entry.claimed.length]),
      [['live', 1], ['demo', 0]]),

    // ── §F: the error path that needs code rather than discipline ──────────
    c('(11) a failed /account/list still fails the pull, with its status intact',
      leakyAccountList, 'TradovateRequestError:403'),
    c('(12) and the account names in its body do not survive into the error', [
      errorBodies.some((text) => text.includes('MYEVAL')),
      errorBodies.some((text) => text.includes('HOUSE')),
      errorBodies.some((text) => text.includes('7101')),
      // The path survives, because that is what makes a 403 diagnosable.
      errorBodies.some((text) => text.includes('/account/list')),
    ], [false, false, false, true]),
  ]);
}

// ── REF-108: what the trader is holding right now ──────────────────────────
//
// Three groups, and the first assertion in two of them is about something
// ABSENT. That is the shape this feature needs: the route must carry no price
// — we are not entitled to one, and a fabricated figure is worse than none —
// and one poll must not become three.

/** An open position on the shared fixture account. `netPos` is signed. */
function openPosition(netPos: number, over: Partial<TradovatePosition> = {}): TradovatePosition {
  return {
    id: 9500 + Math.abs(netPos),
    accountId: ACCOUNT.id,
    contractId: CONTRACT_ID,
    timestamp: '2026-10-14T05:30:00.000Z',
    tradeDate: { year: 2026, month: 10, day: 14 },
    netPos,
    ...over,
  };
}

/** Both hosts answering: `live` from the scene, `demo` holding nothing. */
function liveReaders(data: Scene) {
  const live = reader(data);
  const demo = reader(scene({ accounts: [], positions: [] }));
  return { readers: { live, demo }, live, demo };
}

const LIVE_UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** The contract id the loader carries from Stage 4b. Never on the wire. */
const LIVE_CONTRACT = 2_765_111;

function liveDeps(over: Partial<LiveRouteDeps> = {}): LiveRouteDeps {
  return {
    currentUserId: async () => 'user-1',
    isAllowed: () => true,
    portfoliosEnabled: () => true,
    now: () => NOW,
    loadPositions: async () => ({
      accounts: [
        {
          brokerAccountId: ACCOUNT.id,
          host: 'live',
          positions: [{ contractId: LIVE_CONTRACT, contractName: 'ESZ6', netPos: 2 }],
        },
      ],
      asOf: new Date(NOW).toISOString(),
    }),
    resolveAccounts: async () =>
      new Map([[`live:${ACCOUNT.id}`, { accountId: LIVE_UUID, displayName: 'My Eval' }]]),
    ...over,
  };
}

async function liveBody(deps: LiveRouteDeps): Promise<Record<string, unknown>> {
  forgetLivePull();
  const response = await respondToLiveRequest(deps);
  return (await response.json()) as Record<string, unknown>;
}

/** Every key anywhere in a nested body. The leak assertion reads this. */
function allKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) allKeys(entry, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      allKeys(child, out);
    }
  }
  return out;
}

/** Run something whose route logs, and hand back the lines. */
async function liveLogsOf(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (line: unknown) => void lines.push(String(line));
  try {
    await run();
  } finally {
    console.warn = real;
  }
  return lines;
}

async function liveLoaderGroup() {
  forgetContractNames();
  const flat = liveReaders(scene({ positions: [POSITION] }));
  const flatPull = await loadOpenPositions({
    readers: flat.readers, environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });

  forgetContractNames();
  const held = liveReaders(scene({ positions: [openPosition(2)] }));
  const heldPull = await loadOpenPositions({
    readers: held.readers, environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });

  // The SECOND pull, warm. Deliberately not preceded by forgetContractNames().
  const again = liveReaders(scene({ positions: [openPosition(2)] }));
  await loadOpenPositions({
    readers: again.readers, environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });

  forgetContractNames();
  const short = liveReaders(scene({ positions: [openPosition(-3)] }));
  const shortPull = await loadOpenPositions({
    readers: short.readers, environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });

  // A stranger's account holding a position, on a host they share.
  forgetContractNames();
  const stranger = liveReaders(
    scene({
      accounts: [ACCOUNT, { id: 7101, name: 'NOTYOURS', userId: 999, accountType: 'Customer' }],
      positions: [openPosition(1), openPosition(4, { id: 9999, accountId: 7101 })],
    })
  );
  const strangerPull = await loadOpenPositions({
    readers: stranger.readers, environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });

  // Failure rule 1: the non-mint host is forgiven, the mint host is not.
  const broken: TradovateReader = {
    get: () => Promise.reject(new TradovateRequestError('/account/list', 403, 'nope')),
  };
  forgetContractNames();
  const demoDown = await loadOpenPositions({
    readers: { live: reader(scene({ positions: [openPosition(1)] })), demo: broken },
    environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
  });
  forgetContractNames();
  const mintDown = await thrown(() =>
    loadOpenPositions({
      readers: { live: broken, demo: reader(scene({ positions: [openPosition(1)] })) },
      environment: 'live', tradovateUserId: ACCOUNT.userId, nowMs: NOW,
    })
  );

  group('REF-108: what is open, and nothing about what it is worth', [
    // A FLAT POSITION IS NOT A POSITION. The row survives the whole trading
    // day with netPos 0, and telling a trader who has gone flat that they are
    // still holding something is the one wrong statement here that would
    // change what they do next.
    c('(1) netPos 0 is excluded', flatPull.accounts, []),
    c('(2) an open position is reported, with its account', heldPull.accounts.length, 1),
    c('(3) signed: a long stays positive', heldPull.accounts[0].positions[0].netPos, 2),
    c('(4) signed: a short stays negative', shortPull.accounts[0].positions[0].netPos, -3),
    c('(5) the contract is named', heldPull.accounts[0].positions[0].contractName, 'ESZ6'),
    c('(6) the broker account rides along, host-qualified',
      [heldPull.accounts[0].brokerAccountId, heldPull.accounts[0].host], [ACCOUNT.id, 'live']),
    c('(7) asOf is the instant of the pull', heldPull.asOf, new Date(NOW).toISOString()),

    // THE ABSENCE. No price reaches this shape, because there is none to have.
    c('(8) a position carries no price-shaped key',
      [...allKeys(heldPull.accounts)].filter((k) => /price|pnl|value|avg|mark/i.test(k)),
      []),

    c('(9) a stranger\'s position is not reported', strangerPull.accounts.length, 1),
    c('(10) and what is reported is the trader\'s own account',
      strangerPull.accounts[0].brokerAccountId, ACCOUNT.id),

    // THE PRICING CHAIN IS NOT WALKED. A name costs /contract/item; a
    // valuePerPoint would cost two more reads for a number nothing multiplies.
    c('(11) the reads are the three a name needs — no maturity, no product',
      held.live.calls, ['/account/list', '/position/list', '/contract/item']),
    c('(12) a second pull reuses the cached name',
      again.live.calls, ['/account/list', '/position/list']),

    c('(13) the non-mint host failing is forgiven', demoDown.accounts.length, 1),
    c('(14) the mint host failing is fatal', mintDown, 'TradovateRequestError'),
  ]);
}

async function liveRouteGroup() {
  const verified = await liveBody(liveDeps());

  forgetLivePull();
  const noSession = await respondToLiveRequest(liveDeps({ currentUserId: async () => null }));

  const notAllowed = await liveBody(liveDeps({ isAllowed: () => false }));
  const noMigration = await liveBody(liveDeps({ portfoliosEnabled: () => false }));

  // Two accounts, two names — REF-108's 16.10 requirement that a figure is
  // useless without the portfolio beside it.
  const twoAccounts = await liveBody(
    liveDeps({
      loadPositions: async () => ({
        accounts: [
          {
            brokerAccountId: 7001,
            host: 'live',
            positions: [{ contractId: 1, contractName: 'ESZ6', netPos: 1 }],
          },
          {
            brokerAccountId: 7002,
            host: 'demo',
            positions: [{ contractId: 2, contractName: 'MNQZ6', netPos: -2 }],
          },
        ],
        asOf: new Date(NOW).toISOString(),
      }),
      resolveAccounts: async () =>
        new Map([
          ['live:7001', { accountId: 'uuid-a', displayName: 'Eval One' }],
          ['demo:7002', { accountId: 'uuid-b', displayName: 'Eval Two' }],
        ]),
    })
  );

  // Both of these log on purpose, so both run inside the capture — otherwise
  // the suite's own output carries two warnings that look like failures.
  let unrecorded: Record<string, unknown> = {};
  let failed: Record<string, unknown> = {};
  const logs = await liveLogsOf(async () => {
    unrecorded = await liveBody(liveDeps({ resolveAccounts: async () => new Map() }));
    failed = await liveBody(
      liveDeps({
        loadPositions: async () => {
          throw new TradovateNotConnectedError('user-1', 'expired');
        },
      })
    );
  });
  const verifiedKeys = [...allKeys(verified)].sort();

  group('REF-108: the route answers with positions and never with a figure', [
    c('(1) a signed-out caller gets 401', noSession.status, 401),
    c('(2) outside the allowlist is reflect_only, not a 403', notAllowed, { source: 'reflect_only' }),
    c('(3) without migration 037 it is reflect_only too', noMigration, { source: 'reflect_only' }),
    c('(4) a verified pull carries the account and the position',
      [verified.source, (verified.accounts as unknown[]).length], ['broker_verified', 1]),
    c('(5) the id is OURS, not the broker\'s',
      (verified.accounts as { accountId: string }[])[0].accountId, LIVE_UUID),
    c('(6) and the name is the one the trader sees',
      (verified.accounts as { displayName: string }[])[0].displayName, 'My Eval'),

    // THE LEAK ASSERTION, over the EXACT key set rather than a spot check. A
    // later change that adds a price has to edit this line on purpose — the
    // same device /today uses to keep trade rows out of the rule engine.
    c('(7) the body has exactly these keys and no others', verifiedKeys,
      ['accountId', 'accounts', 'asOf', 'contractName', 'displayName', 'netPos', 'positions', 'source']),
    c('(8) no broker host reaches the browser', verifiedKeys.includes('host'), false),
    c('(9) no broker account id reaches the browser', verifiedKeys.includes('brokerAccountId'), false),

    c('(10) two accounts resolve to two names',
      (twoAccounts.accounts as { displayName: string }[]).map((a) => a.displayName),
      ['Eval One', 'Eval Two']),
    // Dropped rather than rendered nameless: "you are holding something,
    // somewhere" is worse than silence, and the next sync records the account.
    c('(11) a position on an unrecorded account is dropped',
      (unrecorded.accounts as unknown[]).length, 0),
    c('(12) and the pull is still verified rather than failed', unrecorded.source, 'broker_verified'),
    c('(13) a lapsed connection is a state, not an error', failed, { source: 'broker_expired' }),

    // Counts only. This is the highest-frequency log line in the product, so
    // a leak here repeats 240 times an hour per trader.
    c('(14) the log carries a count', logs.some((l) => l.includes('unresolved=1')), true),
    c('(15) and no account name, id or user id', [
      logs.some((l) => l.includes('My Eval')),
      logs.some((l) => l.includes(String(ACCOUNT.id))),
      logs.some((l) => l.includes('user-1')),
    ], [false, false, false]),
  ]);
}

async function liveCacheGroup() {
  let pulls = 0;
  const counting = liveDeps({
    loadPositions: async () => {
      pulls += 1;
      return { accounts: [], asOf: new Date(NOW).toISOString() };
    },
  });

  forgetLivePull();
  pulls = 0;
  await respondToLiveRequest(counting);
  await respondToLiveRequest(counting);
  await respondToLiveRequest(counting);
  const sequential = pulls;

  // Three consumers arriving together. Without the shared in-flight promise
  // this is three upstream pulls, which is the whole reason the hold exists.
  forgetLivePull();
  pulls = 0;
  await Promise.all([
    respondToLiveRequest(counting),
    respondToLiveRequest(counting),
    respondToLiveRequest(counting),
  ]);
  const concurrent = pulls;

  let clock = NOW;
  const moving = liveDeps({
    now: () => clock,
    loadPositions: async () => {
      pulls += 1;
      return { accounts: [], asOf: new Date(clock).toISOString() };
    },
  });
  forgetLivePull();
  pulls = 0;
  await respondToLiveRequest(moving);
  clock = NOW + FRESH_MS + 1;
  await respondToLiveRequest(moving);
  const afterExpiry = pulls;

  forgetLivePull();
  pulls = 0;
  await respondToLiveRequest(counting);
  await respondToLiveRequest(
    liveDeps({ currentUserId: async () => 'user-2', loadPositions: counting.loadPositions })
  );
  const otherUser = pulls;

  group('REF-108: one poll, however many consumers are watching', [
    c('(1) three sequential calls inside the window are one pull', sequential, 1),
    c('(2) three concurrent calls share one in-flight pull', concurrent, 1),
    c('(3) past the window it pulls again', afterExpiry, 2),
    c('(4) another trader is never served this one\'s answer', otherUser, 2),
    c('(5) the window is ten seconds', FRESH_MS, 10_000),
  ]);

  forgetLivePull();
}

// ── REF-113 Stage 4b: a position going flat fires the stop read ────────────
//
// The gate on recording a stop history is `BrokerTrade.cycleClosed` (REF-117
// Stage 2, formerly `positionFlat`). The re-entry half of this problem is gone
// with the rename — a closed cycle is a candidate immediately, whatever the
// contract does next — but the DEADLINE is not: `/order/list` is
// `depthDays = 0`, so a position still open when the day rolls takes those
// orders with it. A trader who rolls positions all day is still invisible to
// the 21:30 cron for the cycle they are IN, and this poll is the only
// thing in the product watching the instant that fixes it.
//
// What is asserted here is the TRIGGER and not the capture: `captureStops` is
// a stub that records the user id, because what it does in production is the
// import, which has its own suite.

/** One held contract, as the loader reports it. The id is what keys the watch. */
function heldPosition(contractId: number, netPos: number, contractName: string | null = 'ESZ6') {
  return { contractId, contractName, netPos };
}

async function liveFlatTransitionGroup() {
  let nowMs = NOW;
  let held: ReturnType<typeof heldPosition>[] = [];
  let broken = false;
  let captured: string[] = [];
  const scheduled: (() => Promise<void>)[] = [];
  let lastBody: Record<string, unknown> = {};

  const deps = liveDeps({
    now: () => nowMs,
    loadPositions: async () => {
      if (broken) throw new TradovateNotConnectedError('user-1', 'expired');
      return {
        // An account with no positions is not an account, which is what the
        // real loader does — so an empty list is an empty `accounts`.
        accounts:
          held.length === 0
            ? []
            : [{ brokerAccountId: ACCOUNT.id, host: 'live' as const, positions: [...held] }],
        asOf: new Date(nowMs).toISOString(),
      };
    },
    captureStops: async (userId) => {
      captured.push(userId);
    },
    // Collected rather than run, which is the structural proof that the
    // response does not wait for it: `captured` is still empty when
    // respondToLiveRequest resolves.
    schedule: (work) => void scheduled.push(work),
  });

  /**
   * One poll past the route's hold, then run whatever it scheduled.
   *
   * The clock has to move by more than {@link FRESH_MS} or the route serves its
   * held answer and never pulls — which would make every assertion below pass
   * for the wrong reason.
   */
  const poll = async (extraMs = 0): Promise<number> => {
    nowMs += FRESH_MS + 1 + extraMs;
    const response = await respondToLiveRequest(deps);
    lastBody = (await response.json()) as Record<string, unknown>;
    const pending = scheduled.splice(0);
    // Deliberately not awaited inside the response — see `schedule`.
    const waitingBefore = captured.length;
    for (const work of pending) await work();
    return captured.length - waitingBefore;
  };

  // ── The sequence ──────────────────────────────────────────────────────────
  forgetLivePull();
  captured = [];

  held = [heldPosition(1, 2)];
  const firstPoll = await poll();
  const bodyKeys = [...allKeys(lastBody)].sort();

  held = [];
  const afterFlat = await poll();

  held = [heldPosition(2, -1)];
  const afterOpening = await poll();

  // Flat again, 20 seconds after the capture that answered the first one. The
  // gap is a minute, so this must be REMEMBERED rather than fired.
  held = [];
  const insideGap = await poll();

  // And now past it. Nothing new went flat on this poll — the `pending` flag is
  // the only reason it fires, which is the whole point of having one.
  const pastGap = await poll(CAPTURE_MIN_GAP_MS);

  // ── Scaling out is not going flat ─────────────────────────────────────────
  forgetLivePull();
  captured = [];
  held = [heldPosition(1, 3)];
  await poll();
  held = [heldPosition(1, 1)];
  const afterScaling = await poll();

  // ── A broker that refused us knows nothing about what is held ────────────
  forgetLivePull();
  captured = [];
  held = [heldPosition(1, 2)];
  await poll();
  broken = true;
  const whileBroken = await liveLogsOf(() => poll());
  const firedWhileBroken = captured.length;
  broken = false;
  // The contract is gone NOW. If the failed poll had written an empty holding
  // set, this transition would be invisible.
  held = [];
  const afterRecovery = await poll();

  // ── Two unnamed contracts in one account are two keys ────────────────────
  //
  // THE REASON `contractId` IS CARRIED AT ALL. `/contract/item` can refuse, and
  // a key built from `contractName` would collapse these two into one — so
  // closing the first would leave the key present and the transition unseen.
  forgetLivePull();
  captured = [];
  held = [heldPosition(11, 1, null), heldPosition(12, 1, null)];
  await poll();
  held = [heldPosition(12, 1, null)];
  const afterOneOfTwoUnnamed = await poll();

  // ── No trigger supplied: the route behaves exactly as it did before ──────
  forgetLivePull();
  const noTrigger = liveDeps({ now: () => nowMs, captureStops: undefined, schedule: (w) => void scheduled.push(w) });
  held = [heldPosition(1, 1)];
  nowMs += FRESH_MS + 1;
  await respondToLiveRequest(noTrigger);
  held = [];
  nowMs += FRESH_MS + 1;
  const quiet = await respondToLiveRequest(noTrigger);
  const quietBody = (await quiet.json()) as Record<string, unknown>;
  const scheduledWithNoTrigger = scheduled.length;
  scheduled.length = 0;

  group('REF-113: a position going flat is what fires the stop read', [
    // No previous holdings means no transition. A trader who closed a position
    // and THEN opened the app is the Sync button's auto-trigger's job.
    c('(1) the first poll of a session never fires', firstPoll, 0),
    c('(2) a contract leaving the list fires exactly one capture', afterFlat, 1),
    c('(3) for the signed-in user and nobody else', captured, ['user-1']),
    // The set GROWING is not a transition. This is the common case on a polled
    // route and it must cost nothing.
    c('(4) opening a position fires nothing', afterOpening, 0),
    c('(5) a second transition inside the gap does not fire a second capture', insideGap, 0),
    // AND IS NOT DROPPED. Without the pending flag, contract B's trades would
    // wait for 21:30 and lose their annotation if anything is held by then.
    c('(6) but it is remembered, and fires past the gap', pastGap, 1),
    c('(7) the gap is one minute', CAPTURE_MIN_GAP_MS, 60_000),
    // Still held, so still not a candidate. netPos moving is not netPos zero.
    c('(8) scaling out of a position fires nothing', afterScaling, 0),
    // "We could not ask" is not "nothing is held".
    c('(9) a failed poll fires nothing', firedWhileBroken, 0),
    c('(10) and does not forget what was held — the transition survives it',
      afterRecovery, 1),
    c('(11) closing one of two UNNAMED contracts is still a transition',
      afterOneOfTwoUnnamed, 1),

    // THE WIRE IS UNCHANGED. `contractId` exists for the watch above and the
    // route projects it away; liveRouteGroup's exact-key-set assertion is the
    // other half of this.
    c('(12) the contract id never reaches the browser', bodyKeys.includes('contractId'), false),
    c('(13) and the body is the three-field position line it always was',
      bodyKeys,
      ['accountId', 'accounts', 'asOf', 'contractName', 'displayName', 'netPos', 'positions', 'source']),

    // With no `captureStops` the route is read-only again, which is what every
    // other group in this file drives.
    c('(14) with no trigger supplied nothing is scheduled', scheduledWithNoTrigger, 0),
    c('(15) and the answer is still a verified pull', quietBody.source, 'broker_verified'),

    // The failed poll logs its own kind, counts-only, as it did before.
    c('(16) the failed poll still logs a kind and no identifier', [
      whileBroken.some((line) => line.includes('did not answer')),
      whileBroken.some((line) => line.includes('user-1')),
    ], [true, false]),
  ]);

  forgetLivePull();
}

// ── REF-108 Stage 2: the client clock ──────────────────────────────────────
//
// The policy is in ./liveClock.ts as pure functions precisely so it can be
// asserted here, without a browser and without a timer. What is left in the
// hook is a setTimeout and a visibility listener; the decisions are these.

function verifiedPull(positions: number[]): BrokerLivePull {
  return {
    source: 'broker_verified',
    asOf: new Date(NOW).toISOString(),
    accounts: positions.map((netPos, i) => ({
      accountId: `uuid-${i}`,
      displayName: `Portfolio ${i}`,
      positions: netPos === 0 ? [] : [{ contractName: 'ESZ6', netPos }],
    })),
  };
}

async function liveClockGroup() {
  forgetLivePoll();

  // One poll, however many callers. The property the three consumers rest on.
  let calls = 0;
  const slow = () =>
    new Promise<BrokerLivePull>((resolve) => {
      calls += 1;
      setTimeout(() => resolve(verifiedPull([2])), 0);
    });

  const [a, b, c3] = await Promise.all([
    shareLivePull('user-1', () => NOW, slow),
    shareLivePull('user-1', () => NOW, slow),
    shareLivePull('user-1', () => NOW, slow),
  ]);
  const shared = calls;
  // The SAME OBJECT, not merely equal — the strongest form of "three
  // components cannot disagree about what is open".
  const sameObject = a === b && b === c3;

  // A second user in the same tab. Never served the first one's positions.
  forgetLivePoll();
  await shareLivePull('user-1', () => NOW, async () => verifiedPull([2]));
  const minePersists = lastLivePull('user-1') !== null;
  const theirs = lastLivePull('user-2');

  // A failed poll still stamps the clock, so one lapsed connection does not
  // become a stream of requests.
  forgetLivePoll();
  await shareLivePull('user-1', () => NOW, async () => ({ source: 'broker_unavailable' }) as BrokerLivePull);
  const failureRecorded = lastLivePull('user-1');

  forgetLivePoll();

  group('REF-108: one poll, one answer, whoever is asking', [
    c('(1) three concurrent callers make one request', shared, 1),
    c('(2) and all three receive the same object', sameObject, true),
    c('(3) the answer is remembered for this user', minePersists, true),
    c('(4) and is never handed to another one', theirs, null),
    c('(5) a failure is recorded too, not retried on every timer',
      failureRecorded, { source: 'broker_unavailable' }),
  ]);

  group('REF-108: how often, and when not at all', [
    // 15 s holding / 60 s flat. The slow end of the ticket's range, and the
    // reason is the penalty rather than the quota: p-captcha cannot be
    // cleared by a third-party app, and it takes the rule engine's day pull
    // down with it for an hour.
    c('(1) holding a position polls at 15 s', nextPollMs(verifiedPull([2])), HOLDING_MS),
    c('(2) a short counts as holding', nextPollMs(verifiedPull([-3])), HOLDING_MS),
    c('(3) flat drops to 60 s', nextPollMs(verifiedPull([0])), FLAT_MS),
    c('(4) no accounts at all is flat', nextPollMs(verifiedPull([])), FLAT_MS),
    // An unknown state is not a held position, and guessing fast would make
    // a failed first poll the most expensive one.
    c('(5) no answer yet takes the slow interval', nextPollMs(null), FLAT_MS),
    c('(6) and so does a failure', nextPollMs({ source: 'broker_unavailable' }), FLAT_MS),
    c('(7) one account holding and one flat still polls fast',
      nextPollMs(verifiedPull([0, 2])), HOLDING_MS),

    // reflect_only cannot change within a session, and the three consumers
    // mount on every page — polling it forever is a request a minute for an
    // answer that is already final.
    c('(8) reflect_only stops the loop', shouldKeepPolling({ source: 'reflect_only' }), false),
    c('(9) an unavailable broker keeps polling',
      shouldKeepPolling({ source: 'broker_unavailable' }), true),
    // Resolves the moment the trader reconnects in another tab, which is
    // exactly when they would be looking at this.
    c('(10) an expired connection keeps polling',
      shouldKeepPolling({ source: 'broker_expired' }), true),
    c('(11) and so does a verified one', shouldKeepPolling(verifiedPull([2])), true),
    c('(12) no answer yet keeps polling', shouldKeepPolling(null), true),

    c('(13) the two intervals are 15 s and 60 s', [HOLDING_MS, FLAT_MS], [15_000, 60_000]),
  ]);

  group('REF-108: the line a trader reads', [
    // Hebrew has a dual. "2 חוזים" reads as a translation; "שני חוזים" reads
    // as a sentence.
    c('(1) one contract', contractsLabel(1), 'חוזה אחד'),
    c('(2) two take the dual', contractsLabel(2), 'שני חוזים'),
    c('(3) three take the numeral', contractsLabel(3), '3 חוזים'),
    // The MAGNITUDE. `netPos` is signed and direction is deliberately not
    // rendered (the copy REF-108 specified); a short must not read as "-3".
    c('(4) a short reads by magnitude', contractsLabel(-3), '3 חוזים'),
    c('(5) and a short of one is still one', contractsLabel(-1), 'חוזה אחד'),

    // One portfolio: no name on the line, because it would be noise on every
    // one of them.
    c('(6) a single portfolio is not named',
      positionLines(openAccounts(verifiedPull([2]))), ['פוזיציה פתוחה · שני חוזים ESZ6']),
    // Several: the name IS the point (REF-108, 16.10) — a trader with two
    // evaluations needs to know which one they are in.
    c('(7) two portfolios are both named',
      positionLines([
        { accountId: 'a', displayName: 'Eval One', positions: [{ contractName: 'ESZ6', netPos: 1 }] },
        { accountId: 'b', displayName: 'Eval Two', positions: [{ contractName: 'MNQZ6', netPos: -2 }] },
      ]),
      ['פוזיציה פתוחה · חוזה אחד ESZ6 · Eval One', 'פוזיציה פתוחה · שני חוזים MNQZ6 · Eval Two']),
    c('(8) several positions are one line each',
      positionLines([
        {
          accountId: 'a', displayName: 'Solo', positions: [
            { contractName: 'ESZ6', netPos: 1 },
            { contractName: 'MNQZ6', netPos: 4 },
          ],
        },
      ]).length, 2),
    // A contract we could not name still says how much is held.
    c('(9) an unnamed contract still reports the size',
      positionLines([{ accountId: 'a', displayName: 'Solo', positions: [{ contractName: null, netPos: 1 }] }]),
      ['פוזיציה פתוחה · חוזה אחד']),
    c('(10) flat renders no line', positionLines(openAccounts(verifiedPull([0]))), []),

    // The sentence that stops a missing number reading as a broken one.
    // Pinned verbatim, because a reword is a product decision taken again.
    c('(11) the no-price note, verbatim', NO_PRICE_NOTE,
      'המחיר החי אינו זמין דרך הברוקר; הרווח/הפסד ייספר עם הסגירה.'),
    // §8: it describes, it does not instruct.
    c('(12) and it instructs nobody to do anything',
      /כדאי|תעצור|מומלץ|עליך|שים לב/.test(NO_PRICE_NOTE), false),
  ]);

  group('REF-108: what the consumers render from', [
    c('(1) an account with a position is listed', openAccounts(verifiedPull([2])).length, 1),
    c('(2) a flat account is not', openAccounts(verifiedPull([0])).length, 0),
    c('(3) mixed: only the holding one', openAccounts(verifiedPull([0, 2])).length, 1),
    c('(4) nothing verified renders nothing',
      openAccounts({ source: 'broker_unavailable' }).length, 0),
    c('(5) and nor does no answer', openAccounts(null).length, 0),
  ]);
}

// ── REF-108 §E: the live figure never reaches a rule ───────────────────────
//
// ASSERTED OVER THE SOURCE, because an absence cannot be asserted by running
// code that never runs. "The rule engine does not read live positions" is not
// a function call that can be checked — it is the lack of one.
//
// The same device REF-110 Stage 5 used for the account filter, and it matters
// more here. A live figure is true for one second; a discipline rule that
// fired on one would lift itself on the next poll, and a block that
// un-blocks is worse than no block. REF-90 option A's whole premise is that
// the rules act on CLOSED money.

function sourceUnder(dir: string): string {
  const root = path.join(process.cwd(), dir);
  if (!fs.existsSync(root)) return '';
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
}

function liveNeverReachesRulesGroup() {
  const rules = sourceUnder('src/lib/rules');
  const validators = sourceUnder('src/lib/validators');
  const ai = [
    'src/app/api/ai-chat', 'src/app/api/ai-coach', 'src/app/api/ai-debrief',
    'src/app/api/ai-patterns', 'src/app/api/ai-trade-review',
    'src/app/api/cron/send-alerts', 'src/lib/weekly',
  ].map(sourceUnder).join('\n');

  const reachesLive = (src: string) =>
    src.includes('tradovate/positions') ||
    src.includes('tradovate/liveClock') ||
    src.includes('tradovate/useLivePositions') ||
    src.includes('tradovate/live/route') ||
    src.includes('/api/tradovate/live');

  group('REF-108 §E: a live position cannot reach a rule', [
    c('(1) lib/rules imports none of the live modules', reachesLive(rules), false),
    c('(2) nor does the validator', reachesLive(validators), false),
    c('(3) nor do the AI routes and the weekly summary', reachesLive(ai), false),
    // The structural half, stronger than the import check: there is nowhere
    // for the figure to go. BrokerDayContext's seven scalars are all about
    // finished trades, and `netPos` is not among them.
    c('(4) the rule engine never names netPos', rules.includes('netPos'), false),
    c('(5) and never names an open or unrealised figure',
      /openPnl|openPnL|unrealis|unrealiz/i.test(rules), false),
    // The positive control: the grep can fire, so a clean result means
    // something. The route itself obviously reaches the loader.
    c('(6) and the needle is a real one',
      reachesLive(fs.readFileSync(path.join(process.cwd(), 'src/app/api/tradovate/live/route.ts'), 'utf8')),
      true),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
