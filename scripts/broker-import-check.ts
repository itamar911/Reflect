/**
 * Broker import regression suite (REF-107 Stage 2).
 *
 * There is no unit-test runner in this repository — `package.json` has `dev`,
 * `build`, `start`, `lint`, three `tradovate:*` diagnostics and four check
 * scripts, and no `*.test.*` file exists. So this follows the precedent set by
 * scripts/tradovate-today-check.ts: a plain `tsx` script of assertions that
 * prints one line per group and exits non-zero on any failure.
 *
 * NOTHING HERE TOUCHES THE NETWORK, SUPABASE, OR A CREDENTIAL. The Supabase
 * client is a hand-built recording stub over an in-memory array of rows, the
 * feature flag and the allowlist are passed in as `env` objects rather than
 * read from the process, and no module that holds a token is exercised. Safe to
 * run anywhere, with no .env.local.
 *
 *
 * WHAT IT COVERS, AND WHY EACH GROUP IS HERE
 *
 *   - **The flag is off by default**, and off means ZERO STATEMENTS — not zero
 *     rows written. That is the property the deploy order rests on: the code
 *     ships before migration 034, so a single `select` naming a new column
 *     would be a 500 on the trade form.
 *   - **A second import writes nothing.** Not "writes the same values" — zero
 *     update statements. "Sync as often as you like" is only true if this holds,
 *     and three triggers can overlap.
 *   - **A trader's own edit survives a re-import.** The worst thing this feature
 *     could do is overwrite the reason somebody wrote down for their own trade.
 *     The group asserts the whole intent half is untouched, so adding a column
 *     to EXECUTION_FACTS by accident fails here.
 *   - **An open position is not imported** (§A3). The key is only stable once
 *     the position is flat, and a key written early is a duplicate the UNIQUE
 *     cannot catch.
 *   - **A hidden row stays hidden** (E12), including on the concurrent-insert
 *     path, which is the one that re-reads.
 *   - **The count rule** (§0ה, E8): max, never the sum, in both the verified and
 *     the fallback states.
 *   - **The cron rejects an unauthorized caller**, and does so before it builds
 *     a service-role client.
 *   - **Nothing identifying reaches a log.** The import logs counts; this
 *     asserts that a symbol, a price, a fill id, an account id and a user id are
 *     absent from every line it emits.
 *   - **A run that could not read the broker's orders never erases one that
 *     could** (REF-113 Stage 3). The nightly cron ALWAYS has an empty stop
 *     history to offer — it runs hours after Tradovate cleared the orders of the
 *     day it imports — so the three columns are present-or-absent and the
 *     absence is asserted as a property of the STATEMENTS, not of the rows.
 *   - **`kind: 'json'` is a real comparison.** A JSONB column compared with
 *     `String()` is `'[object Object]'` against `'[object Object]'`, which is
 *     always equal, so the column would never be updated once written. The group
 *     fails if the kind is reverted to `exact`.
 *   - **Two columns are filled when empty and never restated.** A trader who
 *     disagrees with "you moved your stop" and unticks the box must not find it
 *     ticked again an hour later.
 *   - **AN UNPLANNED BROKER ROW SCORES EXACTLY 0/60 ON PLANNING.** The broker's
 *     stop goes to `broker_stop_loss` and NEVER to `stop_loss`, because the
 *     trader's column is SCORED: filling it paid 30 points for a plan that does
 *     not exist, under a J1 line reading "לא הוגשה תוכנית", and one journal edit
 *     then minted an `rr_ratio` from it and took the row to 100/100. Both
 *     counterfactuals are computed in the group, so it says what it prevents
 *     rather than only that it does not happen.
 *   - **No broker figure reaches `proposeFlags` or `reachedStop`.** The one of
 *     the three concerns that was already safe, pinned so that it stays safe: a
 *     broker row is `closed` and not `manual`, so it can never arrive as the
 *     `plan` argument.
 *   - **Only the two triggers that can see the orders ask for them.** A
 *     source-level group, because the claim is about a call that is NOT made.
 *
 * Usage: npm run test:broker-import
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import fs from 'node:fs';
import path from 'node:path';

import {
  EXECUTION_FACTS_FOR_TEST,
  IMPORT_FLAG,
  importBrokerTrades,
  isImportEnabled,
  tradesNeedingStopHistory,
} from '../src/lib/tradovate/import';
import type { StopHistory } from '../src/lib/tradovate/orders';
import {
  BROKER_OWNED_FOR_TEST,
  syncBrokerAccounts,
} from '../src/lib/tradovate/account-sync';
import { accountIdentity, claimedAccounts } from '../src/lib/tradovate/accounts';
import { runBrokerImport } from '../src/lib/tradovate/import-cron';
import { computeTradeScore, type TradeScoreInput } from '../src/lib/scoring/tradeScore';
import type { BrokerTrade, HostAccounts } from '../src/lib/tradovate/fills';
import type { TradovateEnvironment } from '../src/lib/tradovate/hosts';
import type { TradovateAccount } from '../src/lib/tradovate/types';
import { isHiddenTrade, visibleTrades, withHidden } from '../src/lib/trades/visible';
import { loadTradeRuleContext } from '../src/lib/rules/tradeRuleContext';
import type { BrokerDayPull } from '../src/lib/rules/brokerDayContext';
import { readBrokerDayResponse } from '../src/lib/rules/brokerDayContext';
import { GET as cronImport } from '../src/app/api/cron/tradovate-import/route';
import { GET as cronOrders } from '../src/app/api/cron/tradovate-orders/route';
import { ORDERS_LOOKBACK_MS, runStopCapture } from '../src/lib/tradovate/orders-cron';
import {
  brokerStopToShow,
  readStopHistory,
  stopDirectionOf,
  stopMoveSentence,
  stopWasWidened,
} from '../src/lib/journal/stopHistory';
import {
  CONDITION_LABELS,
  conditionNeedsThreshold,
  describeCustomRule,
  evaluateCustomRuleCondition,
  type CustomRuleCheckContext,
} from '../src/lib/validators/RulesetValidator';
import type { ConditionType, CustomRule } from '../src/lib/types';
import { respondToSyncRequest, type SyncRouteDeps } from '../src/app/api/tradovate/sync/route';
import { syncUserTrades } from '../src/lib/tradovate/sync';
import {
  TradovateNotConnectedError,
  TradovateTransientError,
  TradovateUnpriceableError,
} from '../src/lib/tradovate/errors';
import {
  AUTO_SYNC_THROTTLE_MS,
  forgetBrokerSync,
  markBrokerPull,
  shareBrokerSync,
  shouldAutoSync,
} from '../src/lib/tradovate/syncClock';
import {
  describeSyncOutcome,
  readSyncResponse,
  SYNC_UNAVAILABLE,
  type BrokerSyncOutcome,
} from '../src/lib/tradovate/sync-response';
import {
  hasStoredDebrief,
  readStoredDebrief,
} from '../src/lib/journal/debrief';
import {
  MATCH_WINDOW_MS,
  matchBrokerTrade,
  planCandidates,
  rootsConflict,
  type CandidatePlan,
} from '../src/lib/tradovate/match';
import {
  brokerSymbolRoot,
  canonicalRoot,
  planSymbolRoot,
} from '../src/lib/symbols';
import {
  confirmLink,
  declineLink,
  deleteWarningText,
  isQueuedBrokerRow,
  LINK_STATE_CHIP,
  LINK_STATE_COPY,
  linkState,
  proposeFlags,
  proposeStopMoveFlag,
  queueBannerText,
  resetLinkGuard,
  UNLINK_WARNING,
  unlinkPlan,
} from '../src/lib/journal/link';
import {
  respondToDebriefRequest,
  type DebriefRouteDeps,
} from '../src/app/api/ai-debrief/route';
import {
  chooseAlertJobs,
  importBeforeSummary,
  summarise,
} from '../src/app/api/cron/send-alerts/route';
import { alertRangeStart, zonedDayStart } from '../src/lib/email/alertWindow';
import { dailySummaryEmail } from '../src/lib/email/alerts';
import { EMAIL_COLORS } from '../src/lib/email/template';
import {
  LOSS_LIMIT_LABEL,
  LOSS_LIMIT_NOTE,
  moreLinesText,
  NET_LABEL,
  readTodayTradeLines,
  showsLineList,
  TODAY_LINE_CAP,
  visibleLines,
} from '../src/lib/rules/todayLines';
import { formatMoney } from '../src/lib/money';
import { calcRR } from '../src/lib/utils';

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
  console.log(`${bad.length ? 'FAIL  ' : 'ok    '}${name}  (${cases.length - bad.length}/${cases.length})`);
  for (const entry of bad) {
    console.log(`         ${entry.label}: got ${show(entry.got)} want ${show(entry.want)}`);
    failures.push(`${name} / ${entry.label}`);
  }
}

const c = (label: string, got: unknown, want: unknown): Case => ({ label, got, want });

// ── Fixtures ────────────────────────────────────────────────────────────────

const USER = 'a7f3c1d2-0000-4000-8000-000000000001';
const OTHER_USER = 'b8e4d2e3-0000-4000-8000-000000000002';

/** The flag ON. Every group that expects a write passes this. */
const ON: NodeJS.ProcessEnv = { [IMPORT_FLAG]: '1' } as unknown as NodeJS.ProcessEnv;
/** The flag OFF, as every deployment is until the owner sets it. */
const OFF: NodeJS.ProcessEnv = {} as unknown as NodeJS.ProcessEnv;

/**
 * A `syncUserTrades` result with nothing in it, for the groups that stub the
 * pull and assert on what the LOOP asked for rather than on what came back.
 *
 * Spelled out rather than imported: `NOTHING` in both modules is private, and a
 * local literal is what makes a group fail to compile when a count is added —
 * which is the moment to decide whether the new one should be totalled.
 */
const EMPTY_COUNTS = Object.freeze({
  ran: false,
  offered: 0,
  imported: 0,
  linkedAuto: 0,
  queued: 0,
  updated: 0,
  unchanged: 0,
  skippedOpen: 0,
  skippedHidden: 0,
  failed: 0,
});

const EMPTY_ACCOUNT_COUNTS = Object.freeze({
  ran: false,
  accountsSeen: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  accountsClosed: 0,
  backfilled: 0,
  failed: 0,
});

const SYMBOL = 'MNQZ6';
const ENTRY = 29834.75;
const EXIT = 29767.25;
const ACCOUNT_ID = 1_805_221;
const OPENED = Date.parse('2026-10-15T09:12:00.000Z');
const CLOSED = Date.parse('2026-10-15T09:41:00.000Z');

/**
 * The 15.10 trade off the real account, as Stage 1 reported it: a short on
 * MNQZ6, two contracts, +$270 gross.
 *
 * Written from the figures in the REF-107 Stage 1 comment rather than invented,
 * so the assertions below are about a shape the pipe has actually produced.
 */
const TRADE: BrokerTrade = {
  brokerTradeKey: 'demo:88412',
  host: 'demo',
  accountId: ACCOUNT_ID,
  symbol: SYMBOL,
  direction: 'short',
  qty: 2,
  entryPrice: ENTRY,
  exitPrice: EXIT,
  openedAtMs: OPENED,
  closedAtMs: CLOSED,
  pnlUsd: 270,
  fillIds: [88412, 88431],
  // REF-113 Stage 1. Deliberately NOT the fill ids: an order id and a fill id
  // are different id spaces, and a fixture that conflated them would hide the
  // join. The import does not read this yet — REF-113 Stage 3 is what writes
  // anything derived from it, and `EXECUTION_FACTS` is unchanged here.
  entryOrderIds: [77412, 77431],
  cycleClosed: true,
};

/** The same trade while the trader still holds one of the two contracts. */
const STILL_OPEN: BrokerTrade = { ...TRADE, cycleClosed: false };

/**
 * The facts that are named ONLY WHEN THE PULL RESOLVED THEM.
 *
 * Every other entry in `EXECUTION_FACTS` is on every statement. These four are
 * present-or-absent, and the absence is load-bearing in both cases: `account_id`
 * because `/api/tradovate/today` has no identity map (REF-110 Stage 2), and the
 * three stop columns because neither `/today` nor the nightly cron can read the
 * orders at all (REF-113 Stage 3). A pull that named them with NULL instead
 * would erase, on every run, what a run that COULD resolve them had written.
 */
const CONDITIONAL_FACTS = ['account_id', 'broker_stop_loss', 'broker_take_profit', 'stop_history'];

/** A second, unrelated trade. Different key, so a different row. */
const SECOND: BrokerTrade = {
  ...TRADE,
  brokerTradeKey: 'demo:88500',
  symbol: 'ESZ6',
  direction: 'long',
  entryPrice: 5000,
  exitPrice: 4990,
  pnlUsd: -500,
  fillIds: [88500, 88511],
  openedAtMs: Date.parse('2026-10-15T13:00:00.000Z'),
  closedAtMs: Date.parse('2026-10-15T13:30:00.000Z'),
};

// ── The Supabase stub ───────────────────────────────────────────────────────

type Row = Record<string, unknown> & { [TABLE]?: string };

/**
 * Which table a stubbed row belongs to.
 *
 * REF-110 is what forced this: until Stages 1-2 every statement in this file
 * was against `trade_plans`, so one flat array of rows was a faithful enough
 * model. It stopped being one the moment a second table existed — the
 * backfill's `from('trade_plans')` read matched the `accounts` rows sitting
 * beside it, and an assertion about statements NOT sent passed or failed on a
 * property of the stub rather than of the code.
 *
 * Defaulted rather than required, so every fixture written before this keeps
 * meaning what it meant. Stamped onto the STORED copy only — the recorded
 * `values` are what the code actually sent, and a marker in them would make
 * the privacy and column-membership assertions read a field that does not
 * exist.
 */
const TABLE = Symbol('table');

/** A pre-seeded row in a table other than `trade_plans`. */
function rowIn(table: string, row: Row): Row {
  return { ...row, [TABLE]: table };
}

function tableOf(row: Row): string {
  return row[TABLE] ?? 'trade_plans';
}

interface Statement {
  kind: 'select' | 'insert' | 'update' | 'delete' | 'rpc';
  table: string;
  columns?: string;
  filters: [string, string, unknown][];
  values?: Row;
}

/** Postgres error shapes the import branches on. */
const UNIQUE_VIOLATION = { code: '23505', message: 'duplicate key value', details: '', hint: '' };

/**
 * Just enough PostgREST to drive the import, over an array of rows.
 *
 * It RECORDS EVERY STATEMENT, which is the point: the strongest assertions in
 * this file are about statements NOT sent — the flag-off group and the
 * idempotence group both measure writes rather than rows.
 *
 * Filters are applied for real (`eq` and `in`), because the import's safety
 * argument is that every statement carries the user: a stub that ignored
 * `.eq('user_id', …)` would make the cross-user group pass vacuously.
 */
class FakeDb {
  readonly statements: Statement[] = [];
  /** Set to make the NEXT insert fail with 23505, as a concurrent one would. */
  failNextInsertAsConflict = false;

  constructor(public rows: Row[] = []) {}

  get writes(): Statement[] {
    return this.statements.filter((s) => s.kind !== 'select');
  }

  /** Arrow properties throughout, so `this` is the FakeDb without an alias. */
  client(): SupabaseClient {
    return {
      from: (table: string) => ({
        select: (columns: string) =>
          new FakeQuery(this, { kind: 'select', table, columns, filters: [] }),

        insert: (values: Row) => {
          this.statements.push({ kind: 'insert', table, filters: [], values });
          const stored = { id: `row-${this.rows.length + 1}`, ...values, [TABLE]: table };
          if (this.failNextInsertAsConflict) {
            this.failNextInsertAsConflict = false;
            // The row the race's winner left behind, so the re-read finds it.
            this.rows.push(stored);
            return new FakeInsert(null, UNIQUE_VIOLATION);
          }
          this.rows.push(stored);
          return new FakeInsert(stored, null);
        },

        update: (values: Row) =>
          new FakeQuery(this, { kind: 'update', table, filters: [], values }),

        delete: () => new FakeQuery(this, { kind: 'delete', table, filters: [] }),
      }),

      /**
       * `link_broker_trade`, migration 035's merge, as the browser reaches it
       * (REF-107 Stage 3b).
       *
       * A HAND-WRITTEN MIRROR OF THE SQL, AND ITS FIDELITY IS THE THING TO
       * WATCH. What this stub makes testable is the CLIENT's half: that the
       * right function is called with the right three arguments, that a double
       * confirm sends one call and not two, and that the flags the trader
       * agreed to are written to the plan afterwards. The function's own body —
       * the `FOR UPDATE`, the two ownership checks, the fixed statement order
       * the partial UNIQUE forces — is asserted by supabase/queries/
       * security_assertions.sql and by running it, not here. A test cannot
       * prove a transaction it does not have.
       *
       * The merge is mirrored anyway, rather than stubbed as a no-op, because
       * the row it leaves behind is what the NEXT import reads: the assertion
       * that a linked plan costs zero statements needs a linked plan to exist.
       */
      rpc: (fn: string, args: Row) => {
        this.statements.push({ kind: 'rpc', table: fn, filters: [], values: args });

        const broker = this.rows.find((row) => row.id === args.broker_row_id);
        const plan = this.rows.find((row) => row.id === args.plan_id);
        if (!broker || !plan) {
          return Promise.resolve({ data: null, error: { code: 'P0002', message: 'not found' } });
        }

        for (const { column } of EXECUTION_FACTS_FOR_TEST) plan[column] = broker[column];
        plan.broker_trade_key = broker.broker_trade_key;
        plan.unplanned = false;
        plan.link_confirmed_at = '2026-10-16T10:00:00.000Z';
        plan.link_method = args.method;
        this.rows = this.rows.filter((row) => row !== broker);

        return Promise.resolve({ data: null, error: null });
      },
    } as unknown as SupabaseClient;
  }
}

/**
 * What `insert()` answers with, so `.select(…).maybeSingle()` can be chained.
 *
 * `importBrokerTrades` awaits an insert directly and reads only `error`;
 * `syncBrokerAccounts` asks for the new row's `id` back, because the identity
 * map it hands to the import has to name a row that did not exist a moment
 * ago. Both shapes are real supabase-js and both have to work, so this is
 * awaitable on its own AND chainable.
 *
 * It projects the requested columns rather than returning the whole row: an
 * assertion that the sync reads `id` and nothing else is only worth making if
 * the stub could have returned more.
 */
class FakeInsert implements PromiseLike<{ data: unknown; error: unknown }> {
  private columns: string | null = null;
  private single = false;

  constructor(private readonly stored: Row | null, private readonly error: unknown) {}

  select(columns: string) {
    this.columns = columns;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private resolve(): { data: unknown; error: unknown } {
    if (this.error !== null) return { data: null, error: this.error };
    if (this.columns === null || this.stored === null) return { data: null, error: null };

    const projected: Row = {};
    for (const column of this.columns.split(',').map((name) => name.trim())) {
      projected[column] = this.stored[column] ?? null;
    }
    return { data: this.single ? projected : [projected], error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

/**
 * `gte`/`lte`/`lt` over whatever PostgREST would have compared.
 *
 * ISO 8601 UTC strings compare correctly as strings — same length, same
 * format, fixed-width fields — which is the only kind of range this suite
 * asks for. A missing value matches nothing rather than everything: a row
 * without the column cannot be said to be inside a range.
 */
function withinRange(stored: unknown, bound: unknown, op: 'gte' | 'lte' | 'lt'): boolean {
  if (stored == null || bound == null) return false;
  const a = typeof stored === 'number' ? stored : String(stored);
  const b = typeof bound === 'number' ? bound : String(bound);
  if (op === 'gte') return a >= b;
  if (op === 'lte') return a <= b;
  return a < b;
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private recorded = false;

  constructor(private readonly db: FakeDb, private readonly statement: Statement) {}

  eq(column: string, value: unknown) {
    this.statement.filters.push(['eq', column, value]);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.statement.filters.push(['in', column, values]);
    return this;
  }
  neq(column: string, value: unknown) {
    this.statement.filters.push(['neq', column, value]);
    return this;
  }
  gte(column: string, value: unknown) {
    this.statement.filters.push(['gte', column, value]);
    return this;
  }
  lte(column: string, value: unknown) {
    this.statement.filters.push(['lte', column, value]);
    return this;
  }
  lt(column: string, value: unknown) {
    this.statement.filters.push(['lt', column, value]);
    return this;
  }
  /** `IS NULL`, which PostgREST spells `.is(col, null)`. The backfill's filter. */
  is(column: string, value: unknown) {
    this.statement.filters.push(['is', column, value]);
    return this;
  }
  /**
   * `.not(col, 'is', null)`. Only the one operator, because only one is used —
   * a stub that accepted every operator and implemented one would make a typo
   * in the production query pass here and fail in Postgres.
   */
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) {
      throw new Error(`FakeQuery.not: only .not(col, 'is', null) is modelled, got ${operator}`);
    }
    this.statement.filters.push(['notnull', column, null]);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.statement.filters.push(['single', '', true]);
    return this;
  }

  private matched(): Row[] {
    return this.db.rows.filter((row) =>
      // The table first. `accounts` and `trade_plans` share this array and a
      // query against one must not see the other — see TABLE.
      tableOf(row) === this.statement.table &&
      this.statement.filters.every(([op, column, value]) => {
        if (op === 'eq') return row[column] === value;
        if (op === 'in') return (value as unknown[]).includes(row[column]);
        if (op === 'neq') return row[column] !== value;
        // `IS NULL` is true for a column the row does not carry at all, which
        // is what Postgres says about a row written before the column existed
        // and is exactly the state the backfill looks for.
        if (op === 'is') return value === null && (row[column] ?? null) === null;
        if (op === 'notnull') return (row[column] ?? null) !== null;
        if (op === 'gte' || op === 'lte' || op === 'lt') {
          return withinRange(row[column], value, op);
        }
        return true;
      })
    );
  }

  private resolve(): { data: unknown; error: unknown } {
    if (!this.recorded) {
      this.db.statements.push(this.statement);
      this.recorded = true;
    }
    const hits = this.matched();

    if (this.statement.kind === 'update') {
      for (const row of hits) Object.assign(row, this.statement.values);
      return { data: null, error: null };
    }
    if (this.statement.kind === 'delete') {
      this.db.rows = this.db.rows.filter((row) => !hits.includes(row));
      return { data: null, error: null };
    }

    const single = this.statement.filters.some(([op]) => op === 'single');
    return { data: single ? (hits[0] ?? null) : hits, error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

/** Run something while capturing every console line it writes. */
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

/** Import, with the logs swallowed. Most groups do not assert on them. */
async function quietImport(params: Parameters<typeof importBrokerTrades>[0]) {
  const { result } = await captureLogs(() => importBrokerTrades(params));
  return result;
}

// ── Groups ──────────────────────────────────────────────────────────────────

async function flagGroup() {
  const db = new FakeDb();
  const off = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE, SECOND],
    isTradeSource: true,
    env: OFF,
  });

  const declined = new FakeDb();
  const notSource = await quietImport({
    client: declined.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: false,
    env: ON,
  });

  group('the import is a no-op until the owner turns it on', [
    c('(1) the flag is off by default', isImportEnabled(OFF), false),
    c('(2) and only the string "1" turns it on', [
      isImportEnabled({ [IMPORT_FLAG]: '1' } as unknown as NodeJS.ProcessEnv),
      isImportEnabled({ [IMPORT_FLAG]: '0' } as unknown as NodeJS.ProcessEnv),
      isImportEnabled({ [IMPORT_FLAG]: 'true' } as unknown as NodeJS.ProcessEnv),
      isImportEnabled({ [IMPORT_FLAG]: 'yes' } as unknown as NodeJS.ProcessEnv),
    ], [true, false, false, false]),
    // NOT ZERO ROWS — ZERO STATEMENTS. The code ships before migration 034, so a
    // select naming `source` or `hidden` would be a 500 on the trade form.
    c('(3) flag off: not one statement of any kind', db.statements.length, 0),
    c('(4) flag off: ran=false, so nobody reads the zeroes as a clean run', off.ran, false),
    c('(5) a connection that is not a trade source: no statements either', declined.statements.length, 0),
    c('(6) and it also reports ran=false', notSource.ran, false),
  ]);
}

async function firstImportGroup() {
  const db = new FakeDb();
  const counts = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  const row = db.rows[0] ?? {};
  const intent = ['strategy', 'stop_loss', 'take_profit', 'rr_ratio', 'trade_reason', 'emotional_state'];

  group('a closed broker trade becomes a journal row', [
    c('(1) one row, counted as imported', [db.rows.length, counts.imported, counts.ran], [1, 1, true]),
    c('(2) provenance', [row.source, row.broker_trade_key, row.broker_host, row.broker_account_id],
      ['tradovate', 'demo:88412', 'demo', ACCOUNT_ID]),
    c('(3) the facts, as the broker stated them', [row.symbol, row.direction, row.entry_price, row.exit_price, row.quantity],
      [SYMBOL, 'short', ENTRY, EXIT, 2]),
    c('(4) money is actual_pnl in dollars, and pnl_amount is NOT invented',
      [row.actual_pnl, row.pnl_currency, row.pnl_amount ?? null], [270, '$', null]),
    // §C10.6: two columns, two semantics. submitted_at is the axis the journal,
    // the calendar and the charts group by; closed_at is the axis the rules
    // measure. The close instant in both would file a 23:50 entry under tomorrow.
    c('(5) submitted_at is the ENTRY and closed_at is the EXIT',
      [row.submitted_at, row.closed_at],
      [new Date(OPENED).toISOString(), new Date(CLOSED).toISOString()]),
    c('(6) closed, unplanned, and provenance-stamped',
      [row.status, row.unplanned, row.rule_context_source], ['closed', true, 'broker_verified']),
    // E4: 034 made these nullable so that no placeholder has to be invented.
    c('(7) NOT ONE intent column is named on the insert',
      intent.filter((column) => column in row), []),
    c('(8) the row carries the user the caller named, and the statement did too',
      [row.user_id, db.writes[0]?.values?.user_id], [USER, USER]),
  ]);
}

async function idempotenceGroup() {
  const db = new FakeDb();
  await quietImport({ client: db.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON });
  const writesAfterFirst = db.writes.length;

  const second = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });
  const writesAfterSecond = db.writes.length;

  // A row whose stored values came back in the shapes PostgREST actually uses:
  // NUMERIC as a string, TIMESTAMPTZ with a +00:00 offset. Comparing the wire
  // forms would report this row as changed on every single pull, which is
  // idempotence lost to a formatting difference (REF-107 Stage 4 found the same
  // string-NUMERIC trap in the CSV export).
  const wireShapes = new FakeDb([
    {
      id: 'row-1',
      user_id: USER,
      broker_trade_key: TRADE.brokerTradeKey,
      hidden: false,
      source: 'tradovate',
      broker_account_id: String(ACCOUNT_ID),
      broker_host: 'demo',
      symbol: SYMBOL,
      direction: 'short',
      entry_price: '29834.75',
      exit_price: '29767.25',
      quantity: '2',
      actual_pnl: '270',
      pnl_currency: '$',
      submitted_at: '2026-10-15T09:12:00+00:00',
      closed_at: '2026-10-15T09:41:00+00:00',
      status: 'closed',
    },
  ]);
  const onWire = await quietImport({
    client: wireShapes.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  // A trade the broker has restated — a corrected exit price.
  const moved = new FakeDb();
  await quietImport({ client: moved.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON });
  const movedWrites = moved.writes.length;
  const corrected = await quietImport({
    client: moved.client(),
    userId: USER,
    trades: [{ ...TRADE, exitPrice: 29760, pnlUsd: 300 }],
    isTradeSource: true,
    env: ON,
  });

  group('a second import writes nothing at all', [
    c('(1) the first import wrote once', writesAfterFirst, 1),
    c('(2) THE SECOND SENDS NO WRITE STATEMENT', writesAfterSecond - writesAfterFirst, 0),
    c('(3) and says so: unchanged, not updated', [second.unchanged, second.updated, second.imported], [1, 0, 0]),
    c('(4) still one row', db.rows.length, 1),
    c('(5) a NUMERIC-as-string, +00:00 row is also unchanged',
      [onWire.unchanged, onWire.updated, wireShapes.writes.length], [1, 0, 0]),
    // The other half of the same property: a fact that genuinely moved IS
    // restated, so "no writes" is not just a function that never writes.
    c('(6) a corrected exit price IS written', [corrected.updated, moved.writes.length - movedWrites], [1, 1]),
    c('(7) and only the two columns that moved', Object.keys(moved.writes[1]?.values ?? {}).sort(),
      ['actual_pnl', 'exit_price']),
  ]);
}

async function intentSurvivesGroup() {
  const db = new FakeDb();
  await quietImport({ client: db.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON });

  // The trader opens the imported row and records what they were thinking —
  // the most valuable thing this product asks of them.
  Object.assign(db.rows[0], {
    strategy: 'ORB',
    stop_loss: 29900,
    take_profit: 29700,
    rr_ratio: 2.4,
    trade_reason: 'שבירת טווח הפתיחה',
    emotional_state: 4,
    post_trade_notes: 'יצאתי מוקדם מדי',
    setup_id: 'setup-1',
    followed_plan: true,
    unplanned: false,
  });
  const before = { ...db.rows[0] };

  const again = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  const after = db.rows[0];
  const intentKeys = [
    'strategy', 'stop_loss', 'take_profit', 'rr_ratio', 'trade_reason', 'emotional_state',
    'post_trade_notes', 'setup_id', 'followed_plan', 'unplanned',
  ];

  group("a trader's own edit survives every later sync", [
    c('(1) the re-import wrote nothing', [again.unchanged, db.writes.length], [1, 1]),
    c('(2) every intent column is byte-identical',
      intentKeys.filter((key) => !same(after[key], before[key])), []),
    // Stage 3 links a plan to an imported trade and clears `unplanned`. A
    // re-import that set it back to true would undo that link overnight, which
    // is why it is written on INSERT only.
    c('(3) `unplanned` is NOT reset to true', after.unplanned, false),
    c('(4) and the broker still owns the facts', [after.entry_price, after.actual_pnl], [ENTRY, 270]),
    // The membership of EXECUTION_FACTS is the policy. If a later change adds an
    // intent column to it, (2) fails — and so does this, which names the reason.
    c('(5) no intent column is in the fact list',
      EXECUTION_FACTS_FOR_TEST.map((fact) => fact.column).filter((column) => intentKeys.includes(column)), []),
  ]);
}

async function openPositionGroup() {
  const db = new FakeDb();
  const counts = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [STILL_OPEN, SECOND],
    isTradeSource: true,
    env: ON,
  });

  // Snapshotted BEFORE the second import below, which adds a row: an assertion
  // read off `db.rows` afterwards would be describing both runs at once.
  const afterFirst = db.rows.map((row) => row.broker_trade_key);

  // The same trade once the last contract is out. The key did not move here,
  // but it COULD have (§A3) — which is the whole reason for the gate.
  const later = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE, SECOND],
    isTradeSource: true,
    env: ON,
  });

  group('a position that is not flat is not imported (§A3)', [
    c('(1) only the flat trade landed', [counts.imported, counts.skippedOpen], [1, 1]),
    c('(2) and it is the right one', afterFirst, [SECOND.brokerTradeKey]),
    c('(3) once it is flat, it is imported', [later.imported, later.skippedOpen], [1, 0]),
    c('(4) and the already-stored one is still not rewritten', later.unchanged, 1),
    c('(5) two rows, no duplicate', db.rows.length, 2),
    // An absence corrects itself on the next pull. A duplicate does not — which
    // is the asymmetry the gate is chosen on.
    c('(6) a trade offered but skipped is still reported as offered', counts.offered, 2),
  ]);
}

async function hiddenGroup() {
  const db = new FakeDb();
  await quietImport({ client: db.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON });

  // The trader deletes it, which on a broker row sets the flag (E12).
  db.rows[0].hidden = true;
  db.rows[0].actual_pnl = '999';
  const writesBefore = db.writes.length;

  const after = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  // The concurrent-insert path. The read ran before the row existed, so an
  // insert is attempted; the partial UNIQUE refuses it with 23505; the import
  // re-reads the key and restates it as the update it would have been. Three
  // triggers can overlap — a cron mid-run while the trader opens the form — so
  // this is a real path and not a theoretical one.
  const racedDb = new FakeDb([]);
  racedDb.failNextInsertAsConflict = true;
  const beforeRace = racedDb.rows.length;
  const racedCounts = await quietImport({
    client: racedDb.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  group('a row the trader deleted stays deleted (E12)', [
    c('(1) the hidden row is skipped, not updated', [after.skippedHidden, after.updated, after.imported], [1, 0, 0]),
    c('(2) NO WRITE was sent for it', db.writes.length - writesBefore, 0),
    c('(3) it is still hidden, and still holds the value it was left with',
      [db.rows[0].hidden, db.rows[0].actual_pnl], [true, '999']),
    c('(4) it is not re-inserted under the same key either', db.rows.length, 1),
    // The flag is the only thing that makes "delete" mean anything on an
    // imported row: a DELETE is a key the next sync does not find.
    c('(5) the shared filter agrees it is hidden', isHiddenTrade(db.rows[0]), true),
    c('(6) and a visible row is left alone by it', visibleTrades([{ hidden: false }, { a: 1 }]).length, 2),
    // The conflict path: the insert is refused, the re-read happens, and the row
    // the race left behind was NOT hidden here — so it is restated normally.
    c('(7) a unique violation becomes an update, not a failure',
      [racedCounts.failed, racedCounts.imported + racedCounts.updated + racedCounts.unchanged], [0, 1]),
    c('(8) and the conflict path left exactly one row', racedDb.rows.length - beforeRace, 1),
  ]);
}

async function ownershipGroup() {
  const db = new FakeDb([
    // Another trader's row, with the SAME broker key. Host-local ids make this
    // possible, and nothing about it may be read or written here.
    { id: 'row-1', user_id: OTHER_USER, broker_trade_key: TRADE.brokerTradeKey, hidden: false, actual_pnl: '1' },
  ]);

  const counts = await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
  });

  let threw = 'no throw';
  try {
    await importBrokerTrades({
      client: db.client(),
      userId: '',
      trades: [TRADE],
      isTradeSource: true,
      env: ON,
    });
  } catch (error) {
    threw = error instanceof Error ? 'Error' : 'non-error';
  }

  const everyStatementCarriesTheUser = db.statements.every((statement) =>
    statement.kind === 'insert'
      ? statement.values?.user_id === USER
      : statement.filters.some(([op, column, value]) => op === 'eq' && column === 'user_id' && value === USER)
  );

  group('every statement carries the user, with or without RLS', [
    // The cron writes with the service-role client, which bypasses RLS. The
    // predicate being IN THE STATEMENT is what stands in for it (§C12).
    c('(1) EVERY statement filters or sets user_id', everyStatementCarriesTheUser, true),
    c('(2) the other trader\'s identical key was not seen', counts.imported, 1),
    c('(3) and their row is untouched',
      [db.rows[0].user_id, db.rows[0].actual_pnl], [OTHER_USER, '1']),
    c('(4) the new row belongs to the caller', db.rows[1]?.user_id, USER),
    // A falsy user id reaching a service-role client is the one bug here that
    // could write into somebody else's journal. It is not tolerated.
    c('(5) an empty userId throws rather than building a statement', threw, 'Error'),
  ]);
}

async function privacyGroup() {
  const db = new FakeDb();
  const { lines } = await captureLogs(() =>
    importBrokerTrades({
      client: db.client(),
      userId: USER,
      trades: [TRADE, STILL_OPEN, SECOND],
      isTradeSource: true,
      env: ON,
    })
  );
  const joined = lines.join('\n');

  const leaked = [
    ['symbol', SYMBOL],
    ['other symbol', 'ESZ6'],
    ['entry price', String(ENTRY)],
    ['exit price', String(EXIT)],
    ['account id', String(ACCOUNT_ID)],
    ['fill id', '88412'],
    ['broker key', TRADE.brokerTradeKey],
    ['user id', USER],
  ].filter(([, value]) => joined.includes(value));

  group('the import logs counts and nothing else', [
    c('(1) it did log — an empty capture would pass everything below', lines.length > 0, true),
    // A nightly job over every connected trader is the last place to start
    // writing a trader's positions into Vercel's logs.
    c('(2) NOT ONE identifying value appears', leaked.map(([what]) => what), []),
    c('(3) one line per run, not one per row', lines.length, 1),
    // The two Stage 3b counts are in the same line and in the same style: an
    // operator reading this wants "the matcher linked none of them and queued
    // two" from the same glance that tells them two rows were written.
    c('(4) and the counts are in it',
      /offered=3 imported=2 linkedAuto=0 queued=2 updated=0 unchanged=0 skippedOpen=1/.test(joined), true),
  ]);
}

// ── The count rule (§0ה, E8) ────────────────────────────────────────────────

interface StubRow {
  status: string;
  exit_price: number | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  closed_at?: string | null;
  source?: string;
  hidden?: boolean;
  id?: string;
}

/**
 * The three queries loadTradeRuleContext makes, told apart by their column
 * list — the same trick scripts/tradovate-today-check.ts uses, extended because
 * the lists are now conditional on the trade-source declaration.
 */
function ruleDb(data: { taken: StubRow[]; closedToday: StubRow[]; recent: StubRow[] }): SupabaseClient {
  class Q implements PromiseLike<{ data: unknown[] }> {
    constructor(private readonly rows: unknown[]) {}
    eq() { return this; }
    neq() { return this; }
    gte() { return this; }
    order() { return this; }
    limit() { return this; }
    then<R1 = { data: unknown[] }, R2 = never>(
      onfulfilled?: ((value: { data: unknown[] }) => R1 | PromiseLike<R1>) | null,
      onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
    ): PromiseLike<R1 | R2> {
      return Promise.resolve({ data: this.rows }).then(onfulfilled, onrejected);
    }
  }
  return {
    from: () => ({
      select: (columns: string) => {
        if (columns.startsWith('id')) return new Q(data.taken);
        if (columns.includes('closed_at')) return new Q(data.recent);
        return new Q(data.closedToday);
      },
    }),
  } as unknown as SupabaseClient;
}

const closedRow = (pnl: number, source: string, closedAt = '2026-10-15T09:41:00.000Z'): StubRow => ({
  status: 'closed',
  exit_price: 1,
  pnl_amount: null,
  actual_pnl: pnl,
  closed_at: closedAt,
  source,
});

/** The seven scalars, as the broker reports them. */
const brokerDay = (closedCount: number, lost: number, lossStreak = 0) => ({
  closedCount,
  losingCount: lossStreak,
  net: -lost,
  lost,
  lossStreak,
  minutesSinceLastClose: lossStreak > 0 ? 5 : null,
  asOf: '2026-10-15T10:00:00.000Z',
});

/** A verified pull from a connection that DOES declare the broker a source. */
const verified = (closedCount: number, lost: number, lossStreak = 0): BrokerDayPull => ({
  source: 'broker_verified',
  isTradeSource: true,
  day: brokerDay(closedCount, lost, lossStreak),
});

async function countRuleGroup() {
  // The trader planned two trades and both closed. Three rows in the table for
  // two trades, and the sum would be four.
  const bothSides = {
    taken: [
      { ...closedRow(100, 'manual'), id: '1' },
      { ...closedRow(-50, 'manual'), id: '2' },
      { ...closedRow(100, 'tradovate'), id: '3' },
      { ...closedRow(-50, 'tradovate'), id: '4' },
    ],
    closedToday: [closedRow(100, 'tradovate'), closedRow(-50, 'tradovate'), closedRow(100, 'manual'), closedRow(-50, 'manual')],
    recent: [closedRow(-50, 'tradovate'), closedRow(100, 'tradovate'), closedRow(-50, 'manual')],
  };

  const paired = await loadTradeRuleContext(USER, verified(2, 50), ruleDb(bothSides));

  // The declaration off: today's behaviour, byte for byte.
  const declined = await loadTradeRuleContext(
    USER,
    { source: 'broker_verified', day: brokerDay(2, 50) },
    ruleDb(bothSides)
  );

  // An unplanned broker trade and no plan at all.
  const unplannedOnly = await loadTradeRuleContext(
    USER,
    verified(3, 0),
    ruleDb({
      taken: [{ ...closedRow(10, 'tradovate'), id: '1' }, { ...closedRow(10, 'tradovate'), id: '2' }, { ...closedRow(10, 'tradovate'), id: '3' }],
      closedToday: [closedRow(10, 'tradovate'), closedRow(10, 'tradovate'), closedRow(10, 'tradovate')],
      recent: [],
    })
  );

  // Plans with no close yet: the broker reports CLOSES, so it sees none of them.
  const openPlans = await loadTradeRuleContext(
    USER,
    verified(0, 0),
    ruleDb({
      taken: [{ ...closedRow(0, 'manual'), id: '1', status: 'open' }, { ...closedRow(0, 'manual'), id: '2', status: 'open' }],
      closedToday: [],
      recent: [],
    })
  );

  // The pull failed. The stored broker rows are the answer, and the manual
  // duplicates must not be added to them.
  const fallback = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb(bothSides)
  );

  // A hidden broker row must not count toward anything.
  const withHiddenRow = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb({
      taken: [{ ...closedRow(-200, 'tradovate'), id: '1', hidden: true }],
      closedToday: [{ ...closedRow(-200, 'tradovate'), hidden: true }],
      recent: [{ ...closedRow(-200, 'tradovate'), hidden: true }],
    })
  );

  group('one trade counts once (§0ה, E8)', [
    // THESE TWO CASES CHANGED ANSWER IN STAGE 3b, ON PURPOSE, and the reason
    // is that the fixture changed meaning. Four rows for two trades used to be
    // the NORMAL state — the import wrote a row beside every plan — and
    // `max()` was what kept the counter honest through it. Stage 3b writes a
    // matched trade ONTO its plan, so four rows for two trades now means
    // something narrower: two trades the matcher refused to guess about, each
    // sitting beside its plan until the trader confirms. There are four rows
    // in the trader's journal and the counter says four.
    //
    // The old expectation is not relaxed, it is relocated: `linkCountGroup`
    // below is where the counter's policy now lives, including the price of
    // this window.
    c('(1) four rows for two unconfirmed pairs = 4', paired.todayTradeCount, 4),
    c('(2) and the live close count does not override it', paired.todayTradeCount === 2, false),
    c('(3) without the declaration, the same figure', declined.todayTradeCount, 4),
    c('(4) three unplanned broker trades and no plans = 3', unplannedOnly.todayTradeCount, 3),
    c('(5) two plans the broker has not seen close = 2', openPlans.todayTradeCount, 2),
    // The same figure in every source state, which is new and is the point:
    // how many trades the trader TOOK is a question about their own rows, and
    // a broker we could not reach cannot change the answer.
    c('(6) and the same figure when the pull failed', fallback.todayTradeCount, 4),
    c('(7) a hidden row counts toward nothing',
      [withHiddenRow.todayTradeCount, withHiddenRow.todayLossAmount], [0, 0]),
  ]);

  group('closed money counts broker rows only (E7)', [
    // Option A unchanged: on broker_verified the live figures replace the query.
    c('(1) verified: the broker\'s own figure', paired.todayLossAmount, 50),
    // The fallback is where the filter does the work: the manual −50 is the same
    // trade as the imported −50, and adding them reads double.
    c('(2) fallback: the imported row alone, not doubled', fallback.todayLossAmount, 50),
    c('(3) without the declaration, the fallback adds both', (await loadTradeRuleContext(
      USER,
      { source: 'broker_unavailable' },
      ruleDb(bothSides)
    )).todayLossAmount, 100),
    c('(4) the streak measures broker closes', fallback.lossStreak, 1),
    c('(5) and the panel reports the same set it measured',
      [fallback.todayClosed.count, fallback.todayClosed.losingCount], [2, 1]),
  ]);

  // The flags are deliberately NOT filtered: `false` is the permissive answer
  // for a `*_last_trade` custom rule, and a flag the trader self-reported on a
  // row they closed by hand is still the most recent thing they told us.
  const flagged = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb({
      taken: [],
      closedToday: [],
      recent: [{ ...closedRow(-10, 'manual'), ...({ fomo_entry: true } as object) } as StubRow],
    })
  );

  group('the self-reported flags are read from any source', [
    c('(1) a manual close still reports its own FOMO flag', flagged.lastTradeFomo, true),
    c('(2) and the streak still ignores it', flagged.lossStreak, 0),
  ]);
}

async function wireGroup() {
  group('the declaration crosses the wire intact', [
    c('(1) absent means false, and the singleton is reused',
      readBrokerDayResponse({ source: 'reflect_only' }).isTradeSource ?? false, false),
    c('(2) true is carried',
      readBrokerDayResponse({ source: 'broker_unavailable', isTradeSource: true }).isTradeSource, true),
    // Only the literal `true`. A string "true" from a hand-rolled client is not
    // a declaration.
    c('(3) a truthy non-boolean is not a declaration',
      readBrokerDayResponse({ source: 'broker_expired', isTradeSource: 'true' }).isTradeSource ?? false, false),
    c('(4) it rides a verified day too', readBrokerDayResponse({
      source: 'broker_verified',
      isTradeSource: true,
      day: { closedCount: 0, losingCount: 0, net: 0, lost: 0, lossStreak: 0, minutesSinceLastClose: null, asOf: 'x' },
    }).isTradeSource, true),
    // A reader that names a column before migration 034 has run is a 42703.
    c('(5) withHidden adds the column only when it exists',
      [withHidden('a,b', false), withHidden('a,b', true)], ['a,b', 'a,b,hidden']),
  ]);
}

async function cronGroup() {
  const SECRET = 'cron-secret-for-the-test';
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  const previousFlag = process.env[IMPORT_FLAG];
  delete process.env[IMPORT_FLAG];

  const noAuth = await cronImport(new Request('https://example.test/api/cron/tradovate-import'));
  const wrongAuth = await cronImport(
    new Request('https://example.test/api/cron/tradovate-import', {
      headers: { authorization: 'Bearer not-the-secret' },
    })
  );
  const authed = await cronImport(
    new Request('https://example.test/api/cron/tradovate-import', {
      headers: { authorization: `Bearer ${SECRET}` },
    })
  );
  const authedBody = await authed.json();

  // With no secret configured at all, fail-closed: a correct-looking header
  // must not be accepted.
  delete process.env.CRON_SECRET;
  const unconfigured = await cronImport(
    new Request('https://example.test/api/cron/tradovate-import', {
      headers: { authorization: 'Bearer ' },
    })
  );

  process.env.CRON_SECRET = previous;
  if (previousFlag === undefined) delete process.env[IMPORT_FLAG];
  else process.env[IMPORT_FLAG] = previousFlag;

  // The loop itself, with the flag off: it must not even LIST, because
  // `is_trade_source` is a column migration 034 adds. The admin client is a
  // throwing stub, so a read would surface as an exception.
  const throwingAdmin = {
    from() {
      throw new Error('the import cron must not read anything with the flag off');
    },
  } as unknown as SupabaseClient;
  const { result: offRun } = await captureLogs(() =>
    runBrokerImport({ admin: throwingAdmin, env: OFF })
  );

  group('the import cron refuses an unauthorized caller', [
    c('(1) no Authorization header: 401', noAuth.status, 401),
    c('(2) wrong secret: 401', wrongAuth.status, 401),
    // The body is empty so an unauthenticated caller does not learn it found a
    // cron endpoint rather than a path that does not exist.
    c('(3) and the 401 body is empty', await noAuth.text(), ''),
    c('(4) an unset CRON_SECRET rejects even a well-formed header', unconfigured.status, 401),
    c('(5) the right secret gets in', authed.status, 200),
    // Flag off: honest about having done nothing, rather than ten zeroes that
    // read as a healthy run.
    c('(6) and with the flag off it reports ran=false',
      [authedBody.ok, authedBody.ran, authedBody.reason], [true, false, 'import_disabled']),
    c('(7) the loop reads NOTHING with the flag off',
      [offRun.found, offRun.attempted, offRun.imported], [0, 0, 0]),
  ]);
}

async function cronSkipGroup() {
  // Two connections: one not on the allowlist, one that declined to be a trade
  // source. Neither may reach a pull — so a stub that throws on any token read
  // is enough to prove it.
  const admin = {
    from: (table: string) => {
      if (table !== 'tradovate_connections') throw new Error(`unexpected table ${table}`);
      const rows = [
        { user_id: USER, is_trade_source: true },
        { user_id: OTHER_USER, is_trade_source: false },
      ];
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        returns: () => q,
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;

  // An allowlist containing NEITHER user, so both are skipped before any
  // upstream call. If either reached syncUserTrades it would try to decrypt a
  // token and throw, and `failedUsers` would be non-zero.
  const { result: run } = await captureLogs(() =>
    runBrokerImport({
      admin,
      env: {
        [IMPORT_FLAG]: '1',
        TRADOVATE_OAUTH_ALLOWED_USER_IDS: 'c9f5e3f4-0000-4000-8000-000000000003',
      } as unknown as NodeJS.ProcessEnv,
    })
  );

  group('the nightly loop skips before it spends anything', [
    c('(1) both connections were found', run.found, 2),
    c('(2) neither was attempted', run.attempted, 0),
    c('(3) both counted as skipped users', run.skippedUsers, 2),
    // A pull that was attempted and threw would land here instead, which is how
    // this group proves nothing upstream was touched.
    c('(4) and nothing failed, because nothing was tried', [run.failedUsers, run.failed], [0, 0]),
    c('(5) no rows moved', [run.imported, run.updated, run.unchanged], [0, 0, 0]),
  ]);
}

// ── Stage 2.5: the sync button's half ───────────────────────────────────────
//
// Five groups over the route a trader triggers on purpose and the two pure
// modules the button is built from. Until this stage /api/tradovate/sync had
// no assertion on it at all — it was the only route in the integration in that
// position — which is why step 4 of the build plan gave it the same deps seam
// app/api/tradovate/trades/route.ts has. Nothing here touches the network: the
// seams are parameters and the pull is a function that returns or throws.

/** A fixed now, so the 25-hour window is measured from something stable. */
const SYNC_NOW = Date.parse('2026-10-15T14:00:00.000Z');
/** A plausible local midnight: Israel is UTC+3, so 21:00 the day before. */
const SYNC_DAY_START = '2026-10-14T21:00:00.000Z';

const syncUrl = (query: string) => `https://example.test/api/tradovate/sync${query}`;

/** The counts a run that imported one trade and left one open would report. */
const RAN_COUNTS = {
  ran: true,
  offered: 3,
  imported: 1,
  linkedAuto: 0,
  queued: 1,
  updated: 0,
  unchanged: 1,
  skippedOpen: 1,
  skippedHidden: 0,
  failed: 0,
};

/**
 * The account pass's counts for a run that recorded nothing new (REF-110).
 *
 * All zeros but `ran`, because the sync ROUTE is what these cases are about
 * and it does not read this field at all — see the assertion in
 * syncPrivacyGroup that the response carries counts and no account. It is here
 * so `runSync`'s stub matches `SyncResult`, and a zero that the route ignores
 * is the honest stub for that.
 */
const NO_ACCOUNT_WORK = {
  ran: true,
  accountsSeen: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  accountsClosed: 0,
  backfilled: 0,
  failed: 0,
};

/**
 * The route's four seams, with the three uninteresting ones defaulted.
 *
 * `runSync` is the only one most cases care about, and giving it a default
 * that THROWS would be wrong — several cases assert the route answers before
 * it is ever called, and a throw would make those pass for the wrong reason.
 * It returns a benign run instead, so "the route stopped early" shows up as a
 * different `source` rather than as an exception.
 */
function syncDeps(over: Partial<SyncRouteDeps> = {}): SyncRouteDeps {
  return {
    currentUserId: async () => USER,
    isAllowed: () => true,
    now: () => SYNC_NOW,
    runSync: async () => ({
      counts: RAN_COUNTS,
      accounts: NO_ACCOUNT_WORK,
      asOf: '2026-10-15T13:59:00.000Z',
      isTradeSource: true,
      importEnabled: true,
    }),
    ...over,
  };
}

async function syncRouteGroup() {
  const call = async (query: string, over: Partial<SyncRouteDeps> = {}) => {
    const res = await respondToSyncRequest(new Request(syncUrl(query)), syncDeps(over));
    return { status: res.status, body: await res.json() };
  };

  const good = `?dayStart=${encodeURIComponent(SYNC_DAY_START)}`;

  const noSession = await call(good, { currentUserId: async () => null });
  const noDayStart = await call('');
  const withSeconds = await call('?dayStart=2026-10-14T21:00:30.000Z');
  const tooOld = await call('?dayStart=2026-10-14T08:00:00.000Z');
  const sinceAhead = await call(`${good}&since=2026-10-16T00:00:00.000Z`);

  // The allowlist is answered BEFORE the window is parsed, and this is how
  // that is proved: a refused user sending an unparseable dayStart gets
  // `reflect_only` and not the 400. A route that parsed first would leak a
  // complaint about a parameter it was never going to read.
  const refusedWithBadWindow = await call('?dayStart=not-a-date', { isAllowed: () => false });

  const ran = await call(good);

  // The three thrown failures, mapped by classifyDayPullFailure. 'missing' is
  // reflect_only and not broker_expired on purpose: a reconnect button in
  // front of a connection the trader never made is an instruction they cannot
  // follow (brokerDayContext.ts).
  const thrown = async (error: unknown) =>
    (await call(good, {
      runSync: async () => {
        throw error;
      },
    })).body.source;

  const { result: expired } = await captureLogs(() =>
    thrown(new TradovateNotConnectedError(USER, 'expired'))
  );
  const { result: missing } = await captureLogs(() =>
    thrown(new TradovateNotConnectedError(USER, 'missing'))
  );
  const { result: transient } = await captureLogs(() =>
    thrown(new TradovateTransientError('upstream said no', { reason: 'network' }))
  );
  const { result: unpriceable } = await captureLogs(() =>
    thrown(new TradovateUnpriceableError('no value per point', 'no_value_per_point'))
  );

  group('the sync route answers before it works', [
    c('(1) no session: 401', [noSession.status, noSession.body.error], [401, 'Unauthorized']),
    c('(2) a missing dayStart is a 400',
      [noDayStart.status, noDayStart.body.error], [400, 'Invalid dayStart: missing']),
    c('(3) a dayStart carrying seconds is not a midnight',
      [withSeconds.status, withSeconds.body.error], [400, 'Invalid dayStart: not_midnight']),
    c('(4) a dayStart 30 hours old is out of range',
      [tooOld.status, tooOld.body.error], [400, 'Invalid dayStart: out_of_range']),
    c('(5) a `since` in the future is a 400', sinceAhead.status, 400),
    c('(6) a refused user gets reflect_only, and the window is never parsed',
      [refusedWithBadWindow.status, refusedWithBadWindow.body.source], [200, 'reflect_only']),
    c('(7) a real run answers broker_verified with its counts',
      [ran.status, ran.body.source, ran.body.ran, ran.body.imported, ran.body.skippedOpen],
      [200, 'broker_verified', true, 1, 1]),
    c('(8) the window it served is stated back', ran.body.windowStart, SYNC_DAY_START),
    c('(9) a refused credential is broker_expired', expired, 'broker_expired'),
    c('(10) a connection that never existed is reflect_only', missing, 'reflect_only'),
    c('(11) a transient failure is broker_unavailable', transient, 'broker_unavailable'),
    c('(12) an unpriceable product is broker_unavailable too', unpriceable, 'broker_unavailable'),
  ]);
}

/**
 * The two states that reach the client as `broker_verified` with ten zeroes.
 *
 * Driven through the REAL {@link syncUserTrades} rather than a fake `runSync`,
 * because the claim being made is about upstream calls that did not happen and
 * a fake cannot make that claim. The proof is structural: `getUserTradingApi`
 * is the first thing on the pull path and it would throw against these stub
 * clients, so a run that RETURNS proves the gate stopped it first.
 *
 * THIS GROUP IS WHY THE RESPONSE CARRIES `importEnabled` AND NOT
 * `isTradeSource`. The Stage 2.5 investigation proposed the latter; this group
 * was written to its spec, failed, and the failure was correct — sync.ts
 * forces `isTradeSource` to false whenever the flag is off, because the column
 * belongs to migration 034 and reading it early is a 42703 for every user. The
 * field therefore arrives exactly equal to `ran` and splits nothing.
 * Assertion (2) below is the one that caught it and the one that keeps it
 * caught.
 */
async function syncDisabledGroup() {
  const connected = () =>
    new FakeDb([{ user_id: USER, is_trade_source: true }]).client();
  const declaredNotSource = () =>
    new FakeDb([{ user_id: USER, is_trade_source: false }]).client();

  const write = new FakeDb();

  const flagOff = await syncUserTrades({
    userId: USER,
    client: write.client(),
    admin: connected(),
    dayStartMs: Date.parse(SYNC_DAY_START),
    windowStartMs: Date.parse(SYNC_DAY_START),
    env: OFF,
  });

  const notSource = await syncUserTrades({
    userId: USER,
    client: write.client(),
    admin: declaredNotSource(),
    dayStartMs: Date.parse(SYNC_DAY_START),
    windowStartMs: Date.parse(SYNC_DAY_START),
    env: ON,
  });

  // And through the route, which is where the distinction has to survive.
  const answerFor = async (result: Awaited<ReturnType<typeof syncUserTrades>>) => {
    const res = await respondToSyncRequest(
      new Request(syncUrl(`?dayStart=${encodeURIComponent(SYNC_DAY_START)}`)),
      syncDeps({ runSync: async () => result })
    );
    return res.json();
  };

  const flagOffBody = await answerFor(flagOff);
  const notSourceBody = await answerFor(notSource);

  group('a sync that did not run says which kind of not-run it was', [
    c('(1) flag off: ran=false', flagOff.counts.ran, false),
    // THE ASSERTION THAT KILLED §D's PROPOSAL. With the flag off the
    // declaration is never read, so `isTradeSource` is false even though this
    // connection declares itself a trade source — equal to `ran`, and useless
    // as a discriminator. `importEnabled` is what carries the distinction.
    c('(2) flag off: isTradeSource is NOT the discriminator',
      [flagOff.isTradeSource, flagOff.counts.ran], [false, false]),
    c('(3) flag off: importEnabled is', flagOffBody.importEnabled, false),
    c('(4) declaration off: ran=false, but the flag was on',
      [notSource.counts.ran, notSourceBody.importEnabled], [false, true]),
    // THE WHOLE POINT OF THE FIELD: identical in every other respect.
    c('(5) the two are otherwise the same answer',
      [flagOffBody.source, notSourceBody.source, flagOffBody.ran, notSourceBody.ran],
      ['broker_verified', 'broker_verified', false, false]),
    c('(6) and they produce two DIFFERENT sentences',
      describeSyncOutcome(readSyncResponse(flagOffBody)).text ===
        describeSyncOutcome(readSyncResponse(notSourceBody)).text,
      false),
    // Zero upstream calls: a pull would have gone through getUserTradingApi,
    // which throws against a stub with no token columns.
    c('(7) neither spent an upstream call',
      [flagOff.counts.offered, notSource.counts.offered], [0, 0]),
    c('(8) and neither wrote a row', write.writes.length, 0),
  ]);
}

async function syncResponseGroup() {
  const verified = {
    source: 'broker_verified',
    windowStart: SYNC_DAY_START,
    asOf: '2026-10-15T13:59:00.000Z',
    importEnabled: true,
    ...RAN_COUNTS,
  };

  const src = (body: unknown) => readSyncResponse(body).source;

  group('the sync reader trusts nothing it is handed', [
    c('(1) a string body is broker_unavailable', src('broker_verified'), 'broker_unavailable'),
    c('(2) null is broker_unavailable', src(null), 'broker_unavailable'),
    c('(3) a body with no source is broker_unavailable', src({ ran: true }), 'broker_unavailable'),
    c('(4) an unknown source is broker_unavailable', src({ source: 'maybe' }), 'broker_unavailable'),
    // The dangerous one: every missing count reads as zero, and ten zeroes is
    // exactly the shape of "הכל מעודכן". A partial body must not get there.
    c('(5) broker_verified with no counts is broker_unavailable',
      src({ source: 'broker_verified', windowStart: SYNC_DAY_START, asOf: 'x', ran: true }),
      'broker_unavailable'),
    c('(6) one missing count is enough',
      src({ ...verified, failed: undefined }), 'broker_unavailable'),
    // `ran` is the field the entire display branches on. A truthy string would
    // render a switched-off import as a successful sync.
    c('(7) ran as the string "true" is rejected',
      src({ ...verified, ran: 'true' }), 'broker_unavailable'),
    c('(8) a well-formed body survives', src(verified), 'broker_verified'),
    c('(9) the three stateless sources pass through',
      [src({ source: 'broker_expired' }), src({ source: 'reflect_only' })],
      ['broker_expired', 'reflect_only']),
    // Absence means false — the same rule readBrokerDayResponse applies to its
    // own optional flag. Against a deployment from before Stage 2.5 the field
    // is missing and `ran:false` really is ambiguous, so it resolves to the
    // sentence that blames nobody rather than to one that tells a trader they
    // set something they may never have touched.
    c('(10) a missing importEnabled reads as false',
      (readSyncResponse({ ...verified, importEnabled: undefined }) as { importEnabled: boolean })
        .importEnabled,
      false),
  ]);
}

async function syncCopyGroup() {
  const verified = (over: Partial<typeof RAN_COUNTS> & { importEnabled?: boolean } = {}) =>
    describeSyncOutcome({
      source: 'broker_verified',
      windowStart: SYNC_DAY_START,
      asOf: '2026-10-15T13:59:00.000Z',
      importEnabled: true,
      ran: true,
      offered: 0,
      imported: 0,
      updated: 0,
      unchanged: 0,
      skippedOpen: 0,
      skippedHidden: 0,
      failed: 0,
      ...over,
    } as BrokerSyncOutcome);

  const three = verified({ imported: 3 });
  const one = verified({ imported: 1 });
  const nothing = verified({});
  const openLeft = verified({ skippedOpen: 2 });
  const refused = verified({ failed: 1 });
  const restated = verified({ updated: 4 });
  const restatedOne = verified({ updated: 1 });
  const flagOff = verified({ ran: false, importEnabled: false });
  const notSource = verified({ ran: false, importEnabled: true });
  const lapsed = describeSyncOutcome({ source: 'broker_expired' });

  group('the sync copy says what happened, in Hebrew that counts', [
    c('(1) three imported', three.text, 'נוספו 3 עסקאות'),
    // Hebrew counts one and then everything else. "נוספו 1 עסקאות" is the
    // kind of thing that makes a product look unfinished.
    c('(2) one imported takes the singular', one.text, 'נוספה עסקה אחת'),
    c('(3) a quiet run', nothing.text, 'הכל מעודכן'),
    c('(4) and a quiet run says nothing else', nothing.detail, null),
    // "הכל מעודכן" on its own would be a small lie here: there IS a trade the
    // trader took that is not in the journal, and this is why.
    c('(5) an open position is explained, not swallowed',
      [openLeft.text, openLeft.detail],
      ['הכל מעודכן', 'פוזיציה פתוחה נכנסת ליומן רק לאחר סגירתה.']),
    c('(6) refused rows are NOT "הכל מעודכן"',
      refused.text, 'חלק מהעסקאות לא נשמרו. נסה שוב בעוד רגע.'),
    c('(7) restated rows get their own sentence', restated.text, 'עודכנו 4 עסקאות'),
    c('(8) and the singular of that one too', restatedOne.text, 'עודכנה עסקה אחת'),
    c('(9) the flag being off is an operator fact',
      flagOff.text, 'ייבוא עסקאות אינו פעיל בחשבון הזה'),
    c('(10) the declaration is the trader\'s own setting',
      notSource.text, 'הגדרת שהברוקר אינו מקור העסקאות שלך'),
    // The pair §D could not tell apart before this stage.
    c('(11) and the two did not collapse into one sentence',
      flagOff.text === notSource.text, false),
    c('(12) only a lapsed connection offers the reconnect link',
      [lapsed.reconnect, nothing.reconnect, flagOff.reconnect], [true, false, false]),
  ]);
}

async function syncThrottleGroup() {
  const T = 1_700_000_000_000;

  // ── The window ───────────────────────────────────────────────────────────
  forgetBrokerSync();
  const freshTab = shouldAutoSync(USER, T);

  markBrokerPull(USER, T);
  const insideWindow = shouldAutoSync(USER, T + AUTO_SYNC_THROTTLE_MS - 1);
  const atTheEdge = shouldAutoSync(USER, T + AUTO_SYNC_THROTTLE_MS);
  // A pull for somebody else must never silence this trader's first page.
  const otherTrader = shouldAutoSync(OTHER_USER, T + 1_000);

  // ── The shared promise ───────────────────────────────────────────────────
  forgetBrokerSync();
  let starts = 0;
  let release: ((outcome: BrokerSyncOutcome) => void) | null = null;
  const pending = new Promise<BrokerSyncOutcome>((resolve) => {
    release = resolve;
  });
  const start = () => {
    starts += 1;
    return pending;
  };

  // Two mounts at the same instant — StrictMode, or /trades and the dashboard
  // both on screen. They must be one request and one answer.
  const first = shareBrokerSync(USER, () => T, start);
  const second = shareBrokerSync(USER, () => T, start);

  // An explicit click lands while that is still in the air. It BYPASSES the
  // window — shareBrokerSync never consults it — but not the in-flight pull.
  markBrokerPull(USER, T);
  const clickedMidFlight = shareBrokerSync(USER, () => T, start);

  release!(SYNC_UNAVAILABLE);
  await Promise.all([first, second, clickedMidFlight]);

  // Settling stamps the clock, so the next page entry is inside the window.
  const stampedBySettle = shouldAutoSync(USER, T + 1_000);
  // ...and releases the slot, so a later sync is a new request.
  let laterStarts = 0;
  await shareBrokerSync(USER, () => T, async () => {
    laterStarts += 1;
    return SYNC_UNAVAILABLE;
  });

  forgetBrokerSync();

  group('one clock, so three triggers cannot disagree', [
    c('(1) a fresh tab syncs', freshTab, true),
    c('(2) one millisecond before the window closes, it does not',
      insideWindow, false),
    c('(3) exactly at the window it does again', atTheEdge, true),
    c('(4) another trader is never served from this one\'s window', otherTrader, true),
    c('(5) two mounts at once are ONE request', starts, 1),
    c('(6) and they hold the same promise', first === second, true),
    // The property that makes the button and the page-entry trigger safe to
    // run at the same time: they cannot report different things, because they
    // are awaiting the same object.
    c('(7) a click mid-flight joins it rather than starting a second',
      [starts, clickedMidFlight === first], [1, true]),
    c('(8) settling stamps the window', stampedBySettle, false),
    c('(9) and releases the slot for the next one', laterStarts, 1),
  ]);
}

async function syncPrivacyGroup() {
  const res = await respondToSyncRequest(
    new Request(syncUrl(`?dayStart=${encodeURIComponent(SYNC_DAY_START)}`)),
    syncDeps()
  );
  const body = await res.json();
  const serialized = JSON.stringify(body);

  // Sorted, so the assertion is about the SET of keys and not the order the
  // spread happens to produce.
  const keys = Object.keys(body).sort();

  group('the sync response carries counts and a provenance, and not one trade', [
    // Spelled out in full and deliberately brittle. A later change that adds a
    // row, a symbol or an account id to this response has to come here and
    // delete this line ON PURPOSE — which is the only review step this
    // repository can enforce on a route that answers with a trader's activity.
    c('(1) exactly these fourteen keys', keys, [
      'asOf',
      'failed',
      // Sorts before 'imported': capital E. Default Array#sort is by code unit.
      'importEnabled',
      'imported',
      // Stage 3b. Both are counts, which is the only kind of thing this
      // response is allowed to carry — a link count says how many trades
      // found a plan and names neither the trade nor the plan.
      'linkedAuto',
      'offered',
      'queued',
      'ran',
      'skippedHidden',
      'skippedOpen',
      'source',
      'unchanged',
      'updated',
      'windowStart',
    ]),
    c('(2) no symbol', serialized.includes(SYMBOL), false),
    c('(3) no price', [serialized.includes(String(ENTRY)), serialized.includes(String(EXIT))],
      [false, false]),
    c('(4) no account id', serialized.includes(String(ACCOUNT_ID)), false),
    c('(5) no host and no user id',
      [serialized.includes('tradovate.com'), serialized.includes(USER)], [false, false]),
    c('(6) and it is not cached anywhere',
      res.headers.get('cache-control'), 'no-store, private'),
  ]);
}

// ── Stage 3a: the debrief's storage, and the alert emails ───────────────────
//
// Four groups over the two halves of Stage 3a. Neither half touches the
// broker's wire: the debrief groups drive `respondToDebriefRequest` through
// the deps seam step 3 gave it, and the alert groups drive two pure
// functions. No model is called, by construction — `callModel` is a counter.

/** A row as the debrief route reads it, with the Stage 3a columns present. */
function debriefRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'trade-1',
    user_id: USER,
    status: 'closed',
    entry_price: 100,
    exit_price: 110,
    stop_loss: 95,
    take_profit: 115,
    rr_ratio: 3,
    direction: 'long',
    strategy: 'breakout',
    ...over,
  };
}

/** The four paragraphs, as the model would return them. */
const MODEL_REPLY = {
  summary: 'סיכום',
  worked: 'מה עבד',
  improve: 'מה לשפר',
  lesson: 'לקח',
};

/**
 * Deps over an in-memory row, counting model calls and recording writes.
 *
 * `persist` writes back into the same object the next request reads, which is
 * what makes the dedupe assertion a real round trip rather than two
 * independent calls that happen to agree.
 */
function debriefDeps(row: Record<string, unknown>) {
  const state = { modelCalls: 0, persisted: 0 };

  const deps: DebriefRouteDeps = {
    currentUserId: async () => USER,
    loadTrade: async (_userId, tradeId) => (tradeId === row.id ? row : null),
    loadRequiredMinRR: async () => null,
    callModel: async () => {
      state.modelCalls += 1;
      return { ...MODEL_REPLY };
    },
    persist: async (_tradeId, _userId, feedback, score) => {
      state.persisted += 1;
      row.plan_score = score;
      const stored: Record<string, string> = {};
      for (const key of ['summary', 'worked', 'improve', 'lesson']) {
        if (typeof feedback[key] === 'string') stored[key] = feedback[key];
      }
      if (Object.keys(stored).length === 0) return null;
      row.debrief_ai = stored;
      row.debrief_generated_at = '2026-10-16T09:00:00.000Z';
      return row.debrief_generated_at as string;
    },
  };

  return { deps, state };
}

function debriefRequest(query = ''): Request {
  const body = new FormData();
  body.append('trade', JSON.stringify({ id: 'trade-1' }));
  return new Request(`https://example.test/api/ai-debrief${query}`, { method: 'POST', body });
}

async function debriefReaderGroup() {
  const full = { summary: 'a', worked: 'b', improve: 'c', lesson: 'd' };

  group('a stored debrief is read no further than it can be trusted', [
    c('(1) a well-formed blob survives', readStoredDebrief(full), full),
    c('(2) a string body is not a debrief', readStoredDebrief('summary'), null),
    c('(3) null is not a debrief', readStoredDebrief(null), null),
    // An array has string keys too, and `{...[]}` would read as `{}` rather
    // than failing — worth its own branch.
    c('(4) an array is not a debrief', readStoredDebrief(['a']), null),
    c('(5) an empty object is not a debrief', readStoredDebrief({}), null),
    // Whitespace renders as an empty block and tells the trader nothing, so
    // it must not keep the model from running.
    c('(6) whitespace-only fields are not a debrief',
      readStoredDebrief({ summary: '   ', lesson: '\n' }), null),
    c('(7) a non-string field is dropped, the rest survive',
      readStoredDebrief({ summary: 'a', worked: 42, lesson: 'd' }), { summary: 'a', lesson: 'd' }),
    // BOTH HALVES, and this is the dedupe rule: a stamp without a blob would
    // serve nothing, a blob without a stamp was written by code that did not
    // record when.
    c('(8) a blob with no timestamp is not servable',
      hasStoredDebrief({ debrief_ai: full }), false),
    c('(9) a timestamp with no blob is not servable',
      hasStoredDebrief({ debrief_generated_at: '2026-10-16T09:00:00.000Z' }), false),
    c('(10) both together are',
      hasStoredDebrief({ debrief_ai: full, debrief_generated_at: '2026-10-16T09:00:00.000Z' }),
      true),
    // The pre-036 database: `select('*')` returns neither key.
    c('(11) a row from before migration 036 is not servable', hasStoredDebrief({}), false),
  ]);
}

async function debriefDedupeGroup() {
  const row = debriefRow();
  const { deps, state } = debriefDeps(row);

  const first = await respondToDebriefRequest(debriefRequest(), deps);
  const firstBody = await first.json();
  const callsAfterFirst = state.modelCalls;
  // Captured here, not read at assertion time: the forced request below
  // stores a second time, correctly, and would make this read 2.
  const persistedAfterFirst = state.persisted;

  // The same row object, now carrying what the first call stored.
  const second = await respondToDebriefRequest(debriefRequest(), deps);
  const secondBody = await second.json();
  const callsAfterSecond = state.modelCalls;

  // `?force=1` is the way past the gate.
  const forced = await respondToDebriefRequest(debriefRequest('?force=1'), deps);
  const forcedBody = await forced.json();
  const callsAfterForce = state.modelCalls;

  // A row that was never stored — the pre-036 state — must call every time.
  const bare = debriefRow({ id: 'trade-1' });
  const { deps: bareDeps, state: bareState } = debriefDeps(bare);
  bareDeps.persist = async () => null; // the flag is off; nothing is written
  await respondToDebriefRequest(debriefRequest(), bareDeps);
  await respondToDebriefRequest(debriefRequest(), bareDeps);

  group('a second debrief of the same trade costs nothing', [
    c('(1) the first request calls the model once', callsAfterFirst, 1),
    c('(2) and stores what it got', persistedAfterFirst, 1),
    c('(2b) the served request stores nothing', state.persisted, 2),
    // THE ASSERTION THIS GROUP EXISTS FOR.
    c('(3) the second request calls the model ZERO more times', callsAfterSecond, 1),
    c('(4) and is served from the row', secondBody.stored, true),
    c('(5) with the same prose', secondBody.summary, MODEL_REPLY.summary),
    c('(6) the first answer was not marked stored', firstBody.stored, false),
    c('(7) ?force=1 calls the model again', callsAfterForce, 2),
    c('(8) and the forced answer is not marked stored', forcedBody.stored, false),
    // The derived half is recomputed every time, never stored — so a later
    // fix to the scoring formula reaches debriefs written before it.
    c('(9) a served debrief still carries a freshly computed score',
      typeof secondBody.score === 'number' && secondBody.breakdown != null, true),
    c('(10) a row that was never stored calls the model every time',
      bareState.modelCalls, 2),
  ]);
}

async function debriefRouteGroup() {
  const row = debriefRow();
  const { deps } = debriefDeps(row);

  const noSession = await respondToDebriefRequest(debriefRequest(), {
    ...deps,
    currentUserId: async () => null,
  });

  const missing = await respondToDebriefRequest(debriefRequest(), {
    ...deps,
    loadTrade: async () => null,
  });

  const noId = await respondToDebriefRequest(
    (() => {
      const body = new FormData();
      body.append('trade', JSON.stringify({}));
      return new Request('https://example.test/api/ai-debrief', { method: 'POST', body });
    })(),
    deps
  );

  // A model that answers with nothing usable must not stamp the row: the
  // next request would then serve four empty paragraphs the trader cannot
  // refresh.
  const emptyRow = debriefRow();
  const { deps: emptyDeps, state: emptyState } = debriefDeps(emptyRow);
  emptyDeps.callModel = async () => {
    emptyState.modelCalls += 1;
    return {};
  };
  await respondToDebriefRequest(debriefRequest(), emptyDeps);
  await respondToDebriefRequest(debriefRequest(), emptyDeps);

  group('the debrief route answers before it spends', [
    c('(1) no session: 401', noSession.status, 401),
    c('(2) a trade that is not this user\'s: 404', missing.status, 404),
    c('(3) no trade id: 400', noId.status, 400),
    c('(4) an empty model answer is not stored', emptyRow.debrief_generated_at, undefined),
    c('(5) so the next request tries again', emptyState.modelCalls, 2),
  ]);
}

// ── Stage 3b — the matcher, the merge, the counter and the debrief gate ─────

/** Noon on the day of {@link TRADE}, which opened at 09:12. */
const MATCH_NOW = Date.parse('2026-10-15T12:00:00.000Z');

/** A plan the trader submitted before the trade, matching it on every rule. */
function planRow(over: Partial<CandidatePlan> = {}): CandidatePlan {
  return {
    id: 'plan-1',
    status: 'open',
    source: 'manual',
    hidden: false,
    submitted_at: '2026-10-15T08:30:00.000Z',
    direction: 'short',
    symbol: SYMBOL,
    ...over,
  };
}

/** The match for {@link TRADE} against these plans, at {@link MATCH_NOW}. */
function matchAgainst(plans: CandidatePlan[], trade: BrokerTrade = TRADE) {
  return matchBrokerTrade({ trade, plans, nowMs: MATCH_NOW });
}

async function matchRuleGroup() {
  const EIGHT_HOURS_BEFORE = new Date(OPENED - MATCH_WINDOW_MS).toISOString();
  const JUST_OUTSIDE = new Date(OPENED - MATCH_WINDOW_MS - 1).toISOString();

  const two = [
    planRow({ id: 'plan-a', submitted_at: '2026-10-15T08:30:00.000Z' }),
    planRow({ id: 'plan-b', submitted_at: '2026-10-15T09:00:00.000Z' }),
  ];

  group('a broker trade finds the plan behind it, or nobody (§B)', [
    c('(1) one plan in the window, on the right side: a unique match',
      matchAgainst([planRow()]), { kind: 'unique', planId: 'plan-1' }),

    // THE HEART OF THE RULE, AND THE SABOTAGE CHECK'S TARGET. A plan written
    // after the entry is a note, not a plan; linking backwards would award a
    // planning score to somebody who planned nothing.
    c('(2) a plan submitted AFTER the entry is not a plan at all',
      matchAgainst([planRow({ submitted_at: '2026-10-15T09:13:00.000Z' })]), { kind: 'none' }),

    c('(3) the window is inclusive at exactly eight hours',
      matchAgainst([planRow({ submitted_at: EIGHT_HOURS_BEFORE })]),
      { kind: 'unique', planId: 'plan-1' }),
    c('(4) and one millisecond past it is outside',
      matchAgainst([planRow({ submitted_at: JUST_OUTSIDE })]), { kind: 'none' }),

    // Two is not "pick the closer one". §F1 names a wrong automatic link as
    // the central risk of this stage, and it is silent.
    c('(5) two plans: ambiguous, and NEVER a tie-break',
      matchAgainst(two), { kind: 'ambiguous', candidateIds: ['plan-b', 'plan-a'] }),
    c('(6) the candidates are ordered nearest-in-time first, which is the order the screen lists',
      planCandidates({ trade: TRADE, plans: two, nowMs: MATCH_NOW }).map((plan) => plan.id),
      ['plan-b', 'plan-a']),

    c('(7) a plan on the other side is not a candidate',
      matchAgainst([planRow({ direction: 'long' })]), { kind: 'none' }),
    // Nullable column. An absent direction is not a disagreement.
    c('(8) a plan with no direction still matches',
      matchAgainst([planRow({ direction: null })]), { kind: 'unique', planId: 'plan-1' }),

    c('(9) a contradicting symbol root disqualifies',
      matchAgainst([planRow({ symbol: 'ESZ6' })]), { kind: 'none' }),
    c('(10) a root that cannot be read sits the decision out entirely',
      matchAgainst([planRow({ symbol: 'NQ/ES SPREAD' })]), { kind: 'unique', planId: 'plan-1' }),
    // §B's own example: the trader typed the root, the broker named the micro.
    c('(11) a bare root the trader typed matches the contract it is the tail of',
      matchAgainst([planRow({ symbol: 'NQ' })]), { kind: 'unique', planId: 'plan-1' }),
    c('(12) and a bare root of a different instrument does not',
      matchAgainst([planRow({ symbol: 'ES' })]), { kind: 'none' }),
    c('(13) an empty symbol on either side sits out',
      [matchAgainst([planRow({ symbol: null })]).kind,
       matchAgainst([planRow()], { ...TRADE, symbol: null }).kind],
      ['unique', 'unique']),

    c('(14) a plan that is closed, never entered or deleted is not a candidate',
      [matchAgainst([planRow({ status: 'closed' })]).kind,
       matchAgainst([planRow({ status: 'not_entered' })]).kind,
       matchAgainst([planRow({ hidden: true })]).kind],
      ['none', 'none', 'none']),

    // Never broker-to-broker: that would merge two real trades into one.
    c('(15) an imported row is not a link target',
      matchAgainst([planRow({ source: 'tradovate' })]), { kind: 'none' }),
    // Before migration 034 `select('*')` returns no `source` key, and every
    // row in such a database is a hand-written plan.
    c('(16) a plan with no source column at all reads as manual',
      matchAgainst([planRow({ source: undefined })]), { kind: 'unique', planId: 'plan-1' }),

    // Condition 8, and it is the whole reason the unlink button works. An
    // unlinked plan keeps the broker's submitted_at, direction and symbol, so
    // it is a PERFECT candidate for the trade it was just released from —
    // equal instants pass the ordering rule and the window is zero. Without
    // this the next sync re-links it and the button does nothing.
    c('(16a) the AUTOMATIC matcher will not touch a plan that carries one',
      matchAgainst([planRow({ link_confirmed_at: '2026-10-16T11:00:00.000Z' })]), { kind: 'none' }),
    c('(16b) a plan that never had one is matched as usual',
      matchAgainst([planRow({ link_confirmed_at: null })]), { kind: 'unique', planId: 'plan-1' }),
    // THE ASYMMETRY IS THE POINT, and getting it wrong is the bug this case
    // was added for: the first version put condition 8 in `planCandidates`,
    // which ALSO hid the unlinked plan from the trader's own candidate list.
    // The cron may not overrule a decision the trader made; the trader may.
    c('(16c) but the confirmation screen still OFFERS it, because the trader is choosing',
      planCandidates({
        trade: TRADE,
        plans: [planRow({ link_confirmed_at: '2026-10-16T11:00:00.000Z' })],
        nowMs: MATCH_NOW,
      }).map((plan) => plan.id), ['plan-1']),
    c('(16d) a decided plan does not make an undecided one ambiguous either',
      matchAgainst([
        planRow({ id: 'decided', link_confirmed_at: '2026-10-16T11:00:00.000Z' }),
        planRow({ id: 'fresh' }),
      ]), { kind: 'unique', planId: 'fresh' }),

    // The clock's one job. A future anchor makes rule 4 vacuous and turns the
    // window around, so nothing matches rather than everything.
    c('(17) a trade whose entry instant is in the future matches nothing',
      matchBrokerTrade({
        trade: { ...TRADE, openedAtMs: MATCH_NOW + 60_000 },
        plans: [planRow()],
        nowMs: MATCH_NOW,
      }), { kind: 'none' }),
    c('(18) an unparseable submitted_at is not a candidate',
      matchAgainst([planRow({ submitted_at: 'not a date' })]), { kind: 'none' }),
    c('(19) no plans at all', matchAgainst([]), { kind: 'none' }),
  ]);
}

// ── REF-107 — the two sides of a symbol ────────────────────────────────────
//
// The matcher's symbol rule used ONE parser for both sides, and a trader's
// free text is not the language Tradovate speaks. `NQ1` — the continuous
// contract every TradingView user reads off their chart — parsed as root `N`
// + month `Q` (August) + year `1`, so a plan written `NQ1` was judged a
// different instrument from `MNQZ6`: the trade went to the confirmation queue,
// the queue computes its candidates with the same function, and the only
// action the screen could offer was "not planned". Seven other roots misparse
// identically, and `SIL`/`SI` was a second live false conflict of the same
// silent kind — the accidental `endsWith` test could not see micro silver.
//
// So these three groups pin, in order: what each side reads, the micro table
// that replaced the tail test, and the production trade end to end.

/** The micro→mini pairs the table owns, with a contract name for each side. */
const MICRO_PAIRS: { micro: string; mini: string; microContract: string; miniContract: string }[] = [
  { micro: 'MNQ', mini: 'NQ', microContract: 'MNQZ6', miniContract: 'NQZ6' },
  { micro: 'MES', mini: 'ES', microContract: 'MESZ6', miniContract: 'ESZ6' },
  { micro: 'MYM', mini: 'YM', microContract: 'MYMZ6', miniContract: 'YMZ6' },
  { micro: 'M2K', mini: 'RTY', microContract: 'M2KZ6', miniContract: 'RTYZ6' },
  { micro: 'MGC', mini: 'GC', microContract: 'MGCZ6', miniContract: 'GCZ6' },
  { micro: 'MCL', mini: 'CL', microContract: 'MCLZ6', miniContract: 'CLZ6' },
  { micro: 'SIL', mini: 'SI', microContract: 'SILZ6', miniContract: 'SIZ6' },
  // The three the tail test covered by accident or not at all (finding 4 of
  // 19.10). They are table lines and nothing else, which is what the table was
  // for: the stage's own trade was "a missing pair is one line here".
  { micro: 'MHG', mini: 'HG', microContract: 'MHGZ6', miniContract: 'HGZ6' },
  { micro: 'MBT', mini: 'BTC', microContract: 'MBTZ6', miniContract: 'BTCZ6' },
  { micro: 'MET', mini: 'ETH', microContract: 'METZ6', miniContract: 'ETHZ6' },
];

async function symbolRootGroup() {
  /**
   * The eight roots whose second letter is a CME month code, which is the
   * whole of the misparse: `NQ1` reads as a well-formed contract name and no
   * later check could tell it from one. The other eighteen common roots
   * returned null and therefore worked BY ACCIDENT — an unreadable root sits
   * the decision out — which is why `ES1` was fine and `NQ1` was not, for a
   * reason invisible to the trader.
   */
  const misparsed: [string, string][] = [
    ['NQ1', 'NQ'],
    ['YM1', 'YM'],
    ['NG1', 'NG'],
    ['ZN1', 'ZN'],
    ['HG1', 'HG'],
    ['ZF1', 'ZF'],
    ['MNQ1', 'MNQ'],
    ['MYM1', 'MYM'],
  ];

  group('a plan symbol is read in the language a trader writes (REF-107)', [
    ...misparsed.map(([typed, root]) =>
      c(`(1) ${typed} is the ${root} continuous contract, not a 2021 expiry`,
        planSymbolRoot(typed), root)),

    c('(2) the TradingView spelling of the same thing', planSymbolRoot('NQ1!'), 'NQ'),
    c('(3) a bare bang', planSymbolRoot('NQ!'), 'NQ'),
    c('(4) the second month', planSymbolRoot('NQ2'), 'NQ'),
    c('(5) the thinkorswim spelling', planSymbolRoot('/NQ'), 'NQ'),
    c('(6) a bare root is itself', planSymbolRoot('NQ'), 'NQ'),
    c('(7) lower case is the same symbol', planSymbolRoot('nq1'), 'NQ'),
    c('(8) and so is a symbol with spaces around it', planSymbolRoot('  NQ1  '), 'NQ'),

    // NON-REGRESSION. A real contract name must still read as one from the
    // plan side too — a trader may paste exactly what the broker shows them.
    c('(9) a contract name still reads as a contract', planSymbolRoot('NQZ6'), 'NQ'),
    c('(10) including a micro contract', planSymbolRoot('MNQZ6'), 'MNQ'),
    // The ordering inside planSymbolRoot earns this one: `ESH2` ends in a `2`,
    // but `ESH` is not a root we know, so the contract reading wins and the
    // March-2022 name resolves to `ES` rather than to `ESH`.
    c('(11) a dated contract whose year digit looks like a continuous marker',
      planSymbolRoot('ESH2'), 'ES'),

    // A root carrying a digit is admitted by name, never by shape.
    c('(12) a root with a digit in it', planSymbolRoot('M2K'), 'M2K'),
    // Not in the known-roots list, so it falls through every reading above and
    // is still resolved — the list makes the ambiguous cases certain, it does
    // not decide what may match.
    c('(13) a root the list has never heard of still resolves', planSymbolRoot('ZQ1'), 'ZQ'),

    // Null is the answer that makes the symbol sit the decision out, and
    // ./fills.ts's warning about name parsing is why it is the failure mode.
    c('(14) a spread leg is unreadable, as before', planSymbolRoot('NQ/ES SPREAD'), null),
    c('(15) an empty symbol', [planSymbolRoot(''), planSymbolRoot('   ')], [null, null]),
    c('(16) a null column', [planSymbolRoot(null), planSymbolRoot(undefined)], [null, null]),
    // Still out, exactly as today: admitting `6E` by shape would also admit
    // `M6E` as a root of its own, and the micro table does not carry that pair.
    c('(17) a currency root remains out of the decision',
      [planSymbolRoot('6E'), planSymbolRoot('6J')], [null, null]),
  ]);

  group('a broker symbol is read in the language Tradovate sends (REF-107)', [
    c('(1) the production contract', brokerSymbolRoot('MNQZ6'), 'MNQ'),
    c('(2) its mini', brokerSymbolRoot('NQZ6'), 'NQ'),
    c('(3) a two-digit year', brokerSymbolRoot('ESH27'), 'ES'),
    c('(4) a root with a digit', brokerSymbolRoot('M2KZ6'), 'M2K'),
    // The narrow reading stays narrow. A single-letter root is a real contract
    // from this side — the two-character floor is a PLAN-SIDE rule only.
    c('(5) a single-letter root is a contract here', brokerSymbolRoot('CZ6'), 'C'),
    // And the decorations a human types are not Tradovate's to send, so this
    // side does not invent a reading for them.
    c('(6) a continuous marker is not broker notation', brokerSymbolRoot('NQ1'), 'N'),
    c('(7) a spread leg is unreadable', brokerSymbolRoot('NQ/ES SPREAD'), null),
    c('(8) an absent symbol', brokerSymbolRoot(null), null),
  ]);
}

async function microMiniGroup() {
  group('a micro and its mini are one instrument, from a table (REF-107)', [
    ...MICRO_PAIRS.map((pair) =>
      c(`(1) ${pair.micro} is ${pair.mini}`, canonicalRoot(pair.micro), pair.mini)),

    // BOTH DIRECTIONS FOR EVERY PAIR THE TABLE CARRIES, and the list is the
    // only place a new one has to be named — adding a line above adds three
    // assertions here. The old rule was "one root is a tail of the other",
    // which got five of the original seven right by coincidence of spelling:
    // `SIL` does not end in `SI`, and `M2K` shares no letter with `RTY`.
    ...MICRO_PAIRS.map((pair) =>
      c(`(2) a plan written ${pair.mini} matches a ${pair.microContract} trade`,
        rootsConflict(pair.mini, pair.microContract), false)),
    ...MICRO_PAIRS.map((pair) =>
      c(`(3) a plan written ${pair.micro} matches a ${pair.miniContract} trade`,
        rootsConflict(pair.micro, pair.miniContract), false)),

    // The two the tail test got wrong, called out so a failure names them.
    c('(4) micro silver against its mini, which the tail test refused',
      rootsConflict('SIL', 'SIZ6'), false),
    c('(5) micro Russell against its mini, which shares no letters',
      rootsConflict('M2K', 'RTYZ6'), false),

    // NON-REGRESSION. The table widens nothing beyond itself: two different
    // instruments still contradict, and that is the wrong link worth refusing.
    c('(6) two different instruments still conflict',
      [rootsConflict('ES', 'MNQZ6'), rootsConflict('NQ', 'ESZ6'), rootsConflict('GC', 'CLZ6')],
      [true, true, true]),
    c('(7) a micro against ANOTHER instrument\'s micro conflicts',
      rootsConflict('MES', 'MNQZ6'), true),
    c('(8) an unreadable side never conflicts',
      [rootsConflict('NQ/ES SPREAD', 'MNQZ6'), rootsConflict('NQ1', 'NQ/ES SPREAD'),
       rootsConflict(null, 'MNQZ6'), rootsConflict('NQ1', null)],
      [false, false, false, false]),
    // And the bug itself, at the level of the rule rather than the match.
    c('(9) the production pair does not conflict', rootsConflict('NQ1', 'MNQZ6'), false),
    // It failed against the MINI too. This was never a micro problem.
    c('(10) nor does it against the mini', rootsConflict('NQ1', 'NQZ6'), false),

    // ── The three added after 19.10, named one at a time ──────────────────
    //
    // The parametrised assertions above already cover all three in both
    // directions. These are here because the first report said out loud that
    // `MHG`/`HG` had REGRESSED when the tail test went, and that `MBT`/`BTC`
    // and `MET`/`ETH` had never worked at all — so a failure should name the
    // product rather than a row index.
    c('(11) micro copper, which the tail test used to cover by accident',
      [rootsConflict('MHG', 'HGZ6'), rootsConflict('HG', 'MHGZ6')], [false, false]),
    c('(12) micro bitcoin, which never matched its mini before',
      [rootsConflict('MBT', 'BTCZ6'), rootsConflict('BTC', 'MBTZ6')], [false, false]),
    c('(13) micro ether, which never matched its mini before',
      [rootsConflict('MET', 'ETHZ6'), rootsConflict('ETH', 'METZ6')], [false, false]),

    // A CONTINUOUS MICRO COPPER PLAN, which is the spelling a trader on a
    // TradingView chart actually types and the one that used to misparse: the
    // table makes `MHG` a known root, so the trailing `1` is read as a marker
    // instead of `MHG1` resolving to `MH` through the contract reading.
    c('(14) the continuous spelling of a new micro',
      [planSymbolRoot('MHG1'), planSymbolRoot('MBT1'), planSymbolRoot('MET1')],
      ['MHG', 'MBT', 'MET']),

    // NON-REGRESSION FOR THE NEW LINES, the same shape as (7): three pairs
    // were added, not one crypto bucket. Micro bitcoin is not micro ether, and
    // micro copper is not micro gold.
    c('(15) the new micros do not match each other',
      [rootsConflict('MBT', 'METZ6'), rootsConflict('MET', 'BTCZ6'),
       rootsConflict('MHG', 'MGCZ6'), rootsConflict('MHG', 'GCZ6')],
      [true, true, true, true]),
    // And `6E` is STILL unreadable, so `M6E` folds into nothing and sits every
    // decision out exactly as it did before these three lines were added. It is
    // pinned here as well as in the plan-symbol group because this table is
    // where somebody would try to add the pair.
    c('(16) micro euro remains out of the decision',
      [planSymbolRoot('M6E'), planSymbolRoot('6E'), canonicalRoot(planSymbolRoot('M6E'))],
      [null, null, null]),
  ]);
}

/** Noon on 19.10, the day of the trade that opened this investigation. */
const QUEUED_NOW = Date.parse('2026-10-19T12:00:00.000Z');

async function continuousContractGroup() {
  // The trade from production, to the minute: a long on the micro Nasdaq
  // entered at 11:16, against a plan submitted at 11:12 that said "NQ1".
  const trade: BrokerTrade = {
    ...TRADE,
    brokerTradeKey: 'demo:91007',
    symbol: 'MNQZ6',
    direction: 'long',
    openedAtMs: Date.parse('2026-10-19T11:16:00.000Z'),
    closedAtMs: Date.parse('2026-10-19T11:20:00.000Z'),
  };
  const plan = (over: Partial<CandidatePlan> = {}): CandidatePlan => ({
    id: 'plan-nq1',
    status: 'open',
    source: 'manual',
    hidden: false,
    submitted_at: '2026-10-19T11:12:00.000Z',
    direction: 'long',
    symbol: 'NQ1',
    ...over,
  });
  const against = (plans: CandidatePlan[]) =>
    matchBrokerTrade({ trade, plans, nowMs: QUEUED_NOW });

  // Both sizes open at once, which is the one user-visible cost of widening:
  // more queue, never a wrong automatic link.
  const bothSizes = [
    plan({ id: 'plan-mnq', symbol: 'MNQ', submitted_at: '2026-10-19T11:00:00.000Z' }),
    plan({ id: 'plan-nq', symbol: 'NQ', submitted_at: '2026-10-19T11:12:00.000Z' }),
  ];

  group('the 19.10 trade finds the plan behind it (REF-107)', [
    // THE WHOLE POINT. Seven of the eight conditions always passed for this
    // trade; condition 7 alone refused it.
    c('(1) plan "NQ1" long 11:12 + MNQZ6 long 11:16 is a unique match',
      against([plan()]), { kind: 'unique', planId: 'plan-nq1' }),
    c('(2) and the confirmation screen offers it too, which is what the trader sees',
      planCandidates({ trade, plans: [plan()], nowMs: QUEUED_NOW }).map((row) => row.id),
      ['plan-nq1']),

    // Every spelling of the same intent, all of which a chart may show.
    c('(3) every spelling of the same plan matches',
      ['NQ1', 'NQ1!', 'NQ', '/NQ', 'MNQ', 'NQZ6', 'MNQZ6', 'nq1']
        .map((symbol) => against([plan({ symbol })]).kind),
      ['unique', 'unique', 'unique', 'unique', 'unique', 'unique', 'unique', 'unique']),

    // §7's safety property. Widening can only ADD candidates, and the matcher
    // auto-links on exactly one, so the worst it can do is send a row to the
    // queue with both plans offered — nearest in time first.
    c('(4) an NQ plan and an MNQ plan open together are ambiguous, never unique',
      against(bothSizes), { kind: 'ambiguous', candidateIds: ['plan-nq', 'plan-mnq'] }),

    // NON-REGRESSION, AND THE SABOTAGE CHECK. A symbol fix must not reach
    // condition 4: a plan written after the entry is a note, not a plan.
    c('(5) a plan written AFTER the entry is still refused, whatever its symbol',
      ['NQ1', 'NQ', 'MNQ'].map((symbol) =>
        against([plan({ symbol, submitted_at: '2026-10-19T11:17:00.000Z' })]).kind),
      ['none', 'none', 'none']),
    c('(6) the other instrument is still refused',
      against([plan({ symbol: 'ES' })]), { kind: 'none' }),
    c('(7) an unreadable symbol still sits out rather than refusing',
      against([plan({ symbol: 'NQ/ES SPREAD' })]), { kind: 'unique', planId: 'plan-nq1' }),
    c('(8) a plan on the other side is still refused',
      against([plan({ direction: 'short' })]), { kind: 'none' }),
  ]);
}

/** A manual plan as the database holds it, with intent columns filled in. */
function storedPlan(over: Row = {}): Row {
  return {
    id: 'plan-1',
    user_id: USER,
    status: 'open',
    source: 'manual',
    hidden: false,
    submitted_at: '2026-10-15T08:30:00.000Z',
    direction: 'short',
    symbol: SYMBOL,
    // The intent half. Not one of these may move, ever.
    strategy: 'פריצת טווח',
    stop_loss: 29900,
    take_profit: 29700,
    rr_ratio: 2,
    trade_reason: 'פריצה של הטווח הלילי',
    emotional_state: 4,
    setup_id: 'setup-7',
    entry_price: 29830,
    units: 2,
    rule_context_source: 'reflect_only',
    ...over,
  };
}

async function linkWriteGroup() {
  // ── The auto-link: a unique match never produces a broker row at all ──────
  const auto = new FakeDb([storedPlan()]);
  const autoCounts = await quietImport({
    client: auto.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON,
  });
  const linked = auto.rows.find((row) => row.id === 'plan-1') ?? {};

  // The re-import. THE MOST IMPORTANT ASSERTION IN THIS GROUP: the key now
  // sits on the plan, so the existing read finds it, `restate()` compares the
  // thirteen facts, finds them identical, and sends nothing.
  const writesBeforeReimport = auto.writes.length;
  const reimport = await quietImport({
    client: auto.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON,
  });

  // ── Two plans: the row is queued and neither plan is touched ──────────────
  const ambiguous = new FakeDb([
    storedPlan({ id: 'plan-a' }),
    storedPlan({ id: 'plan-b', submitted_at: '2026-10-15T09:00:00.000Z' }),
  ]);
  const ambiguousCounts = await quietImport({
    client: ambiguous.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON,
  });
  const queuedRow = ambiguous.rows.find((row) => row.source === 'tradovate') ?? {};

  // ── Unlinking is the absence of an action (§F1) ───────────────────────────
  // Clearing the key is the whole of it: the next import does not find it in
  // the table and inserts an identical broker row, because the key is
  // deterministic. Nothing was lost in the link.
  const unlinked = new FakeDb(auto.rows.map((row) => ({ ...row, broker_trade_key: null })));
  await quietImport({
    client: unlinked.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON,
  });

  // ── The confirm button, and the guard against pressing it twice ───────────
  resetLinkGuard();
  const confirm = new FakeDb([
    storedPlan(),
    { id: 'broker-1', user_id: USER, source: 'tradovate', status: 'closed', unplanned: true,
      broker_trade_key: TRADE.brokerTradeKey, symbol: SYMBOL, direction: 'short',
      entry_price: ENTRY, exit_price: EXIT, quantity: 2, actual_pnl: 270 },
  ]);
  const confirmOutcome = await confirmLink({
    client: confirm.client(),
    brokerRowId: 'broker-1',
    planId: 'plan-1',
    flags: { proper_size: true, followed_plan: false },
  });
  const confirmed = confirm.rows.find((row) => row.id === 'plan-1') ?? {};
  const rpcCalls = confirm.statements.filter((s) => s.kind === 'rpc');

  // Two presses of the same button, overlapping. THE SABOTAGE CHECK'S SECOND
  // TARGET: without the guard both reach the function and the loser raises.
  resetLinkGuard();
  const doubled = new FakeDb([
    storedPlan(),
    { id: 'broker-1', user_id: USER, source: 'tradovate', status: 'closed', unplanned: true,
      broker_trade_key: TRADE.brokerTradeKey },
  ]);
  const client = doubled.client();
  const both = await Promise.all([
    confirmLink({ client, brokerRowId: 'broker-1', planId: 'plan-1' }),
    confirmLink({ client, brokerRowId: 'broker-1', planId: 'plan-1' }),
  ]);
  const doubledRpc = doubled.statements.filter((s) => s.kind === 'rpc').length;

  // ── "לא תוכננה": the row stays, and only the bookkeeping moves ────────────
  resetLinkGuard();
  const declined = new FakeDb([
    { id: 'broker-1', user_id: USER, source: 'tradovate', status: 'closed', unplanned: true,
      broker_trade_key: TRADE.brokerTradeKey, ...Object.fromEntries(
        EXECUTION_FACTS_FOR_TEST.map(({ column }) => [column, (storedPlan() as Row)[column] ?? null])
      ) },
  ]);
  const declineOutcome = await declineLink({ client: declined.client(), brokerRowId: 'broker-1' });
  const declinedRow = declined.rows[0] ?? {};

  group('a unique match becomes one row, and the link survives every later sync', [
    c('(1) no broker row was inserted — the plan IS the trade',
      [auto.rows.length, autoCounts.imported, autoCounts.linkedAuto], [1, 0, 1]),
    c('(2) the plan carries the key, so the next import finds it',
      linked.broker_trade_key, TRADE.brokerTradeKey),
    c('(3) and the bookkeeping says who linked it and when',
      [linked.unplanned, linked.link_method, typeof linked.link_confirmed_at],
      [false, 'auto', 'string']),
    // FOUR OF THE FACTS ARE CONDITIONAL, and that is the property rather than a
    // gap. `account_id` (REF-110 Stage 2) is named when the pull could resolve
    // an account; the three stop columns (REF-113 Stage 3) are named when it
    // read the orders. This call passed neither map — which is exactly what
    // /api/tradovate/today and the nightly cron do — so all four are absent.
    // accountStampGroup() and stopHistoryGroup() assert the resolved cases,
    // including the one that matters most: a later run WITHOUT a map does not
    // clear what an earlier one wrote.
    c('(4) every unconditional execution fact moved',
      EXECUTION_FACTS_FOR_TEST
        .filter(({ column }) => !CONDITIONAL_FACTS.includes(column))
        .filter(({ column }) => linked[column] === undefined), []),
    c('(4b) and not one conditional fact was named, because this pull resolved none',
      CONDITIONAL_FACTS.filter((column) => column in linked), []),
    c('(5) the broker\'s own figures, on the trader\'s row',
      [linked.source, linked.entry_price, linked.exit_price, linked.quantity, linked.actual_pnl, linked.status],
      ['tradovate', ENTRY, EXIT, 2, 270, 'closed']),
    // The whole reason one row is the right shape.
    c('(6) NOT ONE intent column moved',
      [linked.strategy, linked.stop_loss, linked.take_profit, linked.rr_ratio,
       linked.trade_reason, linked.emotional_state],
      ['פריצת טווח', 29900, 29700, 2, 'פריצה של הטווח הלילי', 4]),
    c('(7) setup_id survived, so the strategy comparison keeps the trade', linked.setup_id, 'setup-7'),
    // Written on insert only, and an auto-link is not an insert.
    c('(8) rule_context_source is left exactly as the trader\'s own check left it',
      linked.rule_context_source, 'reflect_only'),

    // THE ASSERTION THIS GROUP EXISTS FOR.
    c('(9) the next import of a linked trade sends ZERO statements',
      auto.writes.length - writesBeforeReimport, 0),
    c('(10) and reports it as unchanged rather than as a new link',
      [reimport.unchanged, reimport.linkedAuto, reimport.imported], [1, 0, 0]),

    c('(11) two candidates: the row is queued, not linked',
      [ambiguous.rows.length, ambiguousCounts.queued, ambiguousCounts.linkedAuto,
       ambiguousCounts.imported], [3, 1, 0, 1]),
    c('(12) the queued row is the shape the confirm screen looks for',
      [queuedRow.unplanned, queuedRow.link_confirmed_at ?? null], [true, null]),
    c('(13) and neither plan was touched',
      ambiguous.rows.filter((row) => row.source === 'manual')
        .every((row) => row.broker_trade_key == null && row.status === 'open'), true),

    c('(14) unlinking is the absence of an action: the next import re-inserts an identical row',
      unlinked.rows.filter((row) => row.broker_trade_key === TRADE.brokerTradeKey).length, 1),

    c('(15) זו העסקה הזו calls the one function that has a transaction',
      [rpcCalls.length, rpcCalls[0]?.table, rpcCalls[0]?.values?.method],
      [1, 'link_broker_trade', 'confirmed']),
    c('(16) with the two ids it was given',
      [rpcCalls[0]?.values?.plan_id, rpcCalls[0]?.values?.broker_row_id], ['plan-1', 'broker-1']),
    c('(17) the merged row is one row, carrying the key and the trader\'s strategy',
      [confirm.rows.length, confirmed.broker_trade_key, confirmed.strategy, confirmed.unplanned],
      [1, TRADE.brokerTradeKey, 'פריצת טווח', false]),
    c('(18) the flags the trader agreed to were written to the plan, not to a row that is gone',
      [confirmOutcome.ok, confirmed.proper_size, confirmed.followed_plan], [true, true, false]),

    // THE DOUBLE-CONFIRM GUARD.
    c('(19) two overlapping confirms send ONE call', doubledRpc, 1),
    c('(20) and the second one says why it did nothing',
      both.filter((outcome) => outcome.ok === false).map((outcome) => outcome.ok === false && outcome.reason),
      ['busy']),

    c('(21) לא תוכננה leaves the row where it is, with its key',
      [declined.rows.length, declinedRow.broker_trade_key, declinedRow.unplanned],
      [1, TRADE.brokerTradeKey, true]),
    c('(22) and records that we asked and were answered',
      [declineOutcome.ok, declinedRow.link_method, typeof declinedRow.link_confirmed_at],
      [true, 'declined', 'string']),
  ]);
}

async function linkCountGroup() {
  // Two linked trades, one broker trade with no plan, one plan still open.
  // FOUR trades, and the trader can see all four in their journal.
  const fourTrades = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb({
      taken: [
        { ...closedRow(100, 'tradovate'), id: '1' },
        { ...closedRow(-50, 'tradovate'), id: '2' },
        { ...closedRow(20, 'tradovate'), id: '3' },
        { ...closedRow(0, 'manual'), id: '4', status: 'open' },
      ],
      closedToday: [closedRow(100, 'tradovate'), closedRow(-50, 'tradovate'), closedRow(20, 'tradovate')],
      recent: [],
    })
  );

  // THE WAITING WINDOW, and this is the case step 8 changes the answer to.
  // An ambiguous import leaves two rows for one trade — the plan, still open,
  // and the queued broker row — until the trader confirms. `max()` used to
  // read that as one; a plain row count reads it as two.
  const waiting = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb({
      taken: [
        { ...closedRow(0, 'manual'), id: '1', status: 'open' },
        { ...closedRow(-50, 'tradovate'), id: '2' },
      ],
      closedToday: [closedRow(-50, 'tradovate')],
      recent: [],
    })
  );

  const hiddenOnly = await loadTradeRuleContext(
    USER,
    { source: 'broker_unavailable', isTradeSource: true },
    ruleDb({
      taken: [{ ...closedRow(-200, 'tradovate'), id: '1', hidden: true }],
      closedToday: [{ ...closedRow(-200, 'tradovate'), hidden: true }],
      recent: [],
    })
  );

  // The live count no longer enters the figure at all: the broker reports
  // CLOSES, and a plan the trader took and has not closed is a trade they took.
  const verifiedPull = await loadTradeRuleContext(
    USER,
    verified(9, 0),
    ruleDb({
      taken: [{ ...closedRow(10, 'tradovate'), id: '1' }, { ...closedRow(0, 'manual'), id: '2', status: 'open' }],
      closedToday: [closedRow(10, 'tradovate')],
      recent: [],
    })
  );

  group('one row is one trade, and the counter just counts rows (§E)', [
    // The formula §E asked for — linked pairs + unlinked plans + unlinked
    // broker rows — collapses to this, because a linked pair IS one row.
    c('(1) 2 linked + 1 broker-only + 1 open plan = 4', fourTrades.todayTradeCount, 4),
    c('(2) and never max(3,1) = 3', fourTrades.todayTradeCount === 3, false),

    // THE PRICE OF DELETING THE CRUTCH, STATED RATHER THAN HIDDEN. During the
    // window between an ambiguous import and the trader's confirmation the
    // same trade does occupy two rows, and this now counts two. It is why
    // step 8 had to be last — before the queue existed, EVERY imported trade
    // sat in that window — and it is bounded now: only an ambiguous or
    // unplanned row ever queues, and confirming it collapses the pair.
    c('(3) an unconfirmed pair counts twice until the trader resolves it',
      waiting.todayTradeCount, 2),

    c('(4) a row the trader deleted counts toward nothing',
      [hiddenOnly.todayTradeCount, hiddenOnly.todayLossAmount], [0, 0]),

    c('(5) the broker\'s live close count no longer moves the trades-taken figure',
      verifiedPull.todayTradeCount, 2),
    // Unchanged by step 8, and asserted so that the two halves cannot drift:
    // the money and the streak still come off the broker's own figures.
    c('(6) while the money and the streak still do',
      [verifiedPull.todayLossAmount, verifiedPull.todayClosed.count], [0, 9]),
  ]);
}

/** A trade row in each of the four link states, for the debrief gate. */
function linkStateRow(state: 'manual' | 'linked' | 'queued' | 'declined'): Record<string, unknown> {
  const broker = {
    source: 'tradovate',
    broker_trade_key: TRADE.brokerTradeKey,
    symbol: SYMBOL,
    quantity: 2,
  };
  if (state === 'manual') return debriefRow({ trade_reason: 'פריצה של הטווח הלילי' });
  if (state === 'linked') {
    // The intent the broker row could never have carried, which is the whole
    // argument for running the debrief on a linked pair and not before.
    return debriefRow({
      ...broker,
      trade_reason: 'פריצה של הטווח הלילי',
      unplanned: false,
      link_confirmed_at: '2026-10-16T10:00:00.000Z',
      link_method: 'auto',
    });
  }
  if (state === 'queued') return debriefRow({ ...broker, unplanned: true, link_confirmed_at: null });
  return debriefRow({
    ...broker,
    unplanned: true,
    link_confirmed_at: '2026-10-16T10:00:00.000Z',
    link_method: 'declined',
    // A trade with no plan behind it carries no intent, which is the whole
    // reason its prompt has to be a different one.
    strategy: null, stop_loss: null, take_profit: null, rr_ratio: null, trade_reason: null,
  });
}

/** Deps that keep the prompt the model was sent, so the branch is assertable. */
function promptCapturingDeps(row: Record<string, unknown>) {
  const { deps, state } = debriefDeps(row);
  const prompts: string[] = [];
  deps.callModel = async (content) => {
    state.modelCalls += 1;
    for (const block of content as { type: string; text?: string }[]) {
      if (block.type === 'text' && typeof block.text === 'string') prompts.push(block.text);
    }
    return { ...MODEL_REPLY };
  };
  return { deps, state, prompts };
}

async function debriefGateGroup() {
  // (ג) A row nobody has decided about yet. It may be linked in a minute, and
  // a debrief of "unplanned" that becomes a linked trade is work thrown away.
  const queued = linkStateRow('queued');
  const { deps: queuedDeps, state: queuedState } = promptCapturingDeps(queued);
  const queuedRes = await respondToDebriefRequest(debriefRequest(), queuedDeps);
  const queuedBody = await queuedRes.json();

  // (א) The linked pair. The trade the debrief was built for — and the first
  // time it gets a real stop, a real R:R and a real reason beside real fills.
  const linked = linkStateRow('linked');
  const { deps: linkedDeps, state: linkedState, prompts: linkedPrompts } =
    promptCapturingDeps(linked);
  await respondToDebriefRequest(debriefRequest(), linkedDeps);
  const linkedPrompt = linkedPrompts[0] ?? '';
  // The second request is the dedupe gate, which the link path must respect.
  await respondToDebriefRequest(debriefRequest(), linkedDeps);

  // (ב) Confirmed unplanned. It runs, with a prompt that does not score a
  // form the trader never claimed to have filled in.
  const declined = linkStateRow('declined');
  const { deps: declinedDeps, state: declinedState, prompts: declinedPrompts } =
    promptCapturingDeps(declined);
  const declinedRes = await respondToDebriefRequest(debriefRequest(), declinedDeps);
  const declinedBody = await declinedRes.json();
  const declinedPrompt = declinedPrompts[0] ?? '';

  // A hand-entered trade, which is every trade this route has ever been
  // asked about. Nothing here may change for it.
  const manual = linkStateRow('manual');
  const { deps: manualDeps, state: manualState, prompts: manualPrompts } =
    promptCapturingDeps(manual);
  await respondToDebriefRequest(debriefRequest(), manualDeps);

  group('the debrief runs on a decided trade and never on a waiting one (§D)', [
    // THE ASSERTION THIS GROUP EXISTS FOR: not "returns an error" — spends
    // nothing.
    c('(1) a queued row calls the model ZERO times', queuedState.modelCalls, 0),
    c('(2) and says why, so the UI does not show it as a failure',
      [queuedRes.status, queuedBody.awaitingLink], [409, true]),
    c('(3) nothing was written to it either',
      [queued.debrief_generated_at ?? null, queued.plan_score ?? null], [null, null]),

    c('(4) a linked pair runs', linkedState.modelCalls, 1),
    c('(5) and the prompt carries the intent the broker row never had',
      [linkedPrompt.includes('Stop Loss: 95'), linkedPrompt.includes('R:R ratio: 3'),
       linkedPrompt.includes('Entry reason (the plan): —')],
      [true, true, false]),
    c('(6) the planning breakdown is in it', linkedPrompt.includes('תכנון (planning)'), true),
    c('(7) and a second request after the link still spends nothing', linkedState.modelCalls, 1),

    c('(8) a confirmed-unplanned row runs too', declinedState.modelCalls, 1),
    // The whole of the branch: no planning score, and the model is told why.
    c('(9) with NO planning section in the prompt',
      declinedPrompt.includes('תכנון (planning)'), false),
    c('(10) and told that there was no plan to measure',
      declinedPrompt.includes('NO PLAN'), true),
    c('(11) a manual trade is unaffected',
      [manualState.modelCalls, (manualPrompts[0] ?? '').includes('תכנון (planning)')], [1, true]),

    // J1, from the ROUTE rather than from the pure function. The decision
    // was reversed on 18.10: the row is scored on the full scale and the
    // missing plan costs what it costs.
    c('(12) the response says the trade was unplanned', declinedBody.unplanned, true),
    c('(13) planning is zero out of sixty',
      [declinedBody.breakdown.planning.score, declinedBody.breakdown.planning.max], [0, 60]),
    c('(14) and the score is 40 on the full scale', declinedBody.score, 40),
  ]);
}

async function unlinkGroup() {
  // A linked pair, built by the real auto-link so the row under test is the
  // row production produces — not one assembled by hand to be convenient.
  const db = new FakeDb([storedPlan()]);
  await quietImport({
    client: db.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON, nowMs: MATCH_NOW,
  });
  const linked = db.rows.find((row) => row.id === 'plan-1') ?? {};
  const wasLinked = [linked.source, linked.broker_trade_key, linked.status];

  resetLinkGuard();
  const outcome = await unlinkPlan({ client: db.client(), rowId: 'plan-1' });
  const plan = db.rows.find((row) => row.id === 'plan-1') ?? {};

  // The next sync. The key is not in the table any more, so the trade is new
  // to the journal again — and the plan must NOT be matched to it a second
  // time, or the button undoes itself.
  const reimport = await quietImport({
    client: db.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON, nowMs: MATCH_NOW,
  });
  const queued = db.rows.find((row) => row.source === 'tradovate') ?? {};
  const planAfter = db.rows.find((row) => row.id === 'plan-1') ?? {};

  // Two presses, overlapping — the same guard as the other two writes.
  resetLinkGuard();
  const twice = new FakeDb([{ ...storedPlan(), source: 'tradovate', unplanned: false,
    broker_trade_key: TRADE.brokerTradeKey, link_confirmed_at: '2026-10-16T10:00:00.000Z' }]);
  const client = twice.client();
  const both = await Promise.all([
    unlinkPlan({ client, rowId: 'plan-1' }),
    unlinkPlan({ client, rowId: 'plan-1' }),
  ]);

  group('an unlink gives the plan back and lets the trade return', [
    c('(0) the fixture really was linked first',
      wasLinked, ['tradovate', TRADE.brokerTradeKey, 'closed']),

    c('(1) the plan is a plan again', [outcome.ok, plan.source, plan.status], [true, 'manual', 'open']),
    c('(2) the provenance is gone, so the next sync does not find this trade',
      [plan.broker_trade_key, plan.broker_account_id, plan.broker_host], [null, null, null]),
    // The broker's statement about a trade this row no longer claims to be.
    c('(3) the exit half is dropped',
      [plan.closed_at, plan.exit_price, plan.actual_pnl, plan.pnl_currency], [null, null, null, null]),
    c('(4) it is not an unplanned trade — it is a plan, and always was',
      plan.unplanned, false),
    c('(5) link_method is cleared: none of its three values is true any more',
      plan.link_method, null),
    // THE LINE THAT MAKES THE BUTTON WORK. Clearing this hands the plan
    // straight back to the matcher — see (9).
    c('(6) but the decision itself is on record', typeof plan.link_confirmed_at, 'string'),

    // Never the broker's, never touched by the link, and not touched here.
    c('(7) NOT ONE intent column moved',
      [plan.strategy, plan.stop_loss, plan.take_profit, plan.rr_ratio,
       plan.trade_reason, plan.emotional_state, plan.setup_id],
      ['פריצת טווח', 29900, 29700, 2, 'פריצה של הטווח הלילי', 4, 'setup-7']),
    // NOT RECOVERABLE, and the dialog says so. EXECUTION_FACTS owns all five
    // and nothing kept what the trader originally typed.
    c('(8) the entry half stays as the broker reported it',
      [plan.symbol, plan.direction, plan.entry_price, plan.quantity], [SYMBOL, 'short', ENTRY, 2]),

    // THE ASSERTION THIS GROUP EXISTS FOR.
    c('(9) the next import brings the trade back AS A QUEUED ROW, not a re-link',
      [reimport.imported, reimport.queued, reimport.linkedAuto], [1, 1, 0]),
    c('(10) with the same key, because the key is deterministic',
      [queued.broker_trade_key, queued.unplanned, queued.link_confirmed_at ?? null],
      [TRADE.brokerTradeKey, true, null]),
    c('(11) and the plan was left alone by that import',
      [planAfter.source, planAfter.status, planAfter.broker_trade_key],
      ['manual', 'open', null]),
    c('(12) so the trader is back to two rows and one decision to make',
      db.rows.length, 2),

    c('(13) two overlapping unlinks: the second says why it did nothing',
      both.filter((o) => o.ok === false).map((o) => o.ok === false && o.reason), ['busy']),
    c('(14) and the dialog states the one thing that cannot be undone',
      UNLINK_WARNING.includes('פרטי הכניסה נשארים כפי שהברוקר דיווח'), true),
  ]);
}

async function todayPanelGroup() {
  // Three closes, AS THE TRADES ROUTE ACTUALLY ANSWERS THEM: newest first,
  // because `loadBrokerDay` sorts `b.closedAtMs - a.closedAtMs`. The fixture
  // is in that order deliberately — one already in chronological order would
  // let a reader that does not sort at all pass this whole group.
  const body = {
    source: 'broker_verified',
    windowStart: '2026-10-15T00:00:00.000Z',
    asOf: '2026-10-15T14:00:00.000Z',
    trades: [
      { direction: 'short', symbol: null, pnlUsd: 40, closedAtMs: Date.parse('2026-10-15T13:30:00Z') },
      { direction: 'long', symbol: 'ESZ6', pnlUsd: -125, closedAtMs: Date.parse('2026-10-15T11:00:00Z') },
      { direction: 'short', symbol: SYMBOL, pnlUsd: 270, closedAtMs: Date.parse('2026-10-15T09:41:00Z'),
        brokerTradeKey: 'x', accountId: 1 },
    ],
  };
  const lines = readTodayTradeLines(body);

  // Twelve closes, to drive the cap. Newest first here too, and the P&L is
  // the row's CHRONOLOGICAL index: array position 0 is the newest close and
  // carries 11, position 11 is the oldest and carries 0. So a correctly
  // sorted list reads 0,1,2… and a list left in route order reads 11,10,9…
  const many = readTodayTradeLines({
    ...body,
    trades: Array.from({ length: 12 }, (_, i) => ({
      direction: 'long', symbol: 'ESZ6', pnlUsd: 11 - i,
      closedAtMs: Date.parse('2026-10-15T09:00:00Z') + (11 - i) * 60_000,
    })),
  });

  group('the day panel itemises the broker\'s closes, and says what the net is', [
    // CHRONOLOGICAL, OLDEST CLOSE FIRST — the reverse of the order the route
    // sent them in. The panel NUMBERS these rows, so "1" against the most
    // recent trade would tell the trader their last trade was their first,
    // which is the one thing the numbering exists to say.
    c('(1) three rows, oldest close first, three fields each and nothing else',
      lines, [
        { direction: 'short', symbol: SYMBOL, pnl: 270 },
        { direction: 'long', symbol: 'ESZ6', pnl: -125 },
        { direction: 'short', symbol: null, pnl: 40 },
      ]),
    c('(1b) which is NOT the order the route sent, and that is the point',
      lines?.map((line) => line.pnl), [270, -125, 40]),
    // Twelve rows whose P&L ascends with the chronology: in route order this
    // would read 11, 10, 9…
    c('(1c) twelve rows come back in chronological order too',
      many?.map((line) => line.pnl), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    // Position 1 is a claim — "this closed before the others" — and an
    // unreadable instant is not evidence for it.
    c('(1d) a row with no readable close instant sorts last, never first',
      readTodayTradeLines({ ...body, trades: [
        { direction: 'long', symbol: 'A', pnlUsd: 1 },
        { direction: 'long', symbol: 'B', pnlUsd: 2, closedAtMs: Date.parse('2026-10-15T10:00:00Z') },
      ] })?.map((line) => line.symbol), ['B', 'A']),
    // The reader takes three fields and drops the rest on the floor: the key,
    // the account id and the fill ids are not this panel's business even
    // though the route sends them.
    c('(2) the key and the account id are not carried into the view',
      Object.keys(lines?.[0] ?? {}).sort(), ['direction', 'pnl', 'symbol']),

    // Every non-verified state is "no list", which is a different thing from
    // "no trades" — and the panel keeps its sentences for it.
    c('(3) a state that is not a successful pull is no list at all', [
      readTodayTradeLines({ source: 'broker_unavailable' }),
      readTodayTradeLines({ source: 'broker_expired' }),
      readTodayTradeLines({ source: 'reflect_only' }),
      readTodayTradeLines(null),
      readTodayTradeLines('trades'),
    ], [null, null, null, null, null]),
    c('(4) a verified pull with no trades is an EMPTY list, not a missing one',
      readTodayTradeLines({ ...body, trades: [] }), []),
    c('(5) a row with no usable direction or money is dropped',
      readTodayTradeLines({ ...body, trades: [
        { direction: 'sideways', symbol: 'ESZ6', pnlUsd: 10 },
        { direction: 'long', symbol: 'ESZ6', pnlUsd: 'x' },
        { direction: 'long', symbol: 'ESZ6', pnlUsd: 10 },
      ] })?.length, 1),

    // THE CONSISTENCY GATE, and it is the whole reason the net is not
    // re-summed from the lines: two reads, a moment apart, can see different
    // days, and three rows above a net that accounts for two is a panel
    // contradicting itself in the trader's own money.
    c('(6) the list is drawn only when it has as many lines as the day counted',
      [showsLineList(lines, 3), showsLineList(lines, 2), showsLineList(lines, 4)],
      [true, false, false]),
    c('(7) and never when there is no list, or an empty one',
      [showsLineList(null, 3), showsLineList([], 0)], [false, false]),

    c('(8) ten rows at most, and the rest are counted',
      [visibleLines(many ?? []).shown.length, visibleLines(many ?? []).more], [TODAY_LINE_CAP, 2]),
    c('(9) and nothing is held back when there is nothing to hold back',
      [visibleLines(lines ?? []).shown.length, visibleLines(lines ?? []).more], [3, 0]),
    c('(10) the overflow says how many', moreLinesText(2), 'ועוד 2'),

    // The net is the DAY PULL's figure. The sum of the lines is asserted to
    // agree with it here so that a fixture which drifts from the arithmetic
    // fails rather than passing quietly.
    c('(11) the net label, and the amount the lines add up to',
      [NET_LABEL, formatMoney((lines ?? []).reduce((sum, line) => sum + line.pnl, 0))],
      ['נטו היום', '+$185.00']),
    c('(12) a losing day carries its own sign', formatMoney(-185), '-$185.00'),

    // THE REWORDED LIMIT LINE. A trader who closed +$270 and −$125 read "סך
    // ההפסדים היום: $125 מתוך $500" beneath a net of +$145 and reasonably
    // concluded one of the two was wrong. Neither was.
    c('(13) the loss limit says that only losses count',
      [LOSS_LIMIT_LABEL, LOSS_LIMIT_NOTE],
      ['מגבלת הפסד', 'רק הפסדים נספרים, רווחים לא מקזזים']),
    // The rule the sentence describes, measured rather than asserted: the
    // winner does not buy the loss back.
    c('(14) and that is what the engine actually does', (await loadTradeRuleContext(
      USER,
      { source: 'broker_unavailable', isTradeSource: true },
      ruleDb({
        taken: [{ ...closedRow(270, 'tradovate'), id: '1' }, { ...closedRow(-125, 'tradovate'), id: '2' }],
        closedToday: [closedRow(270, 'tradovate'), closedRow(-125, 'tradovate')],
        recent: [],
      })
    )).todayLossAmount, 125),
  ]);
}

async function confirmScreenGroup() {
  // A short that went to target: planned at 29830 with a 70-point stop and an
  // 80-point target, entered 4 points away from the plan, exited past the
  // target. Every proposal below is one comparison against these two rows.
  const brokerFacts = { direction: 'short' as const, entry_price: 29834, exit_price: 29767, quantity: 2 };
  const plan = { entry_price: 29830, stop_loss: 29900, take_profit: 29780, units: 2, quantity: null };

  const flags = proposeFlags(plan, brokerFacts);
  const byColumn = Object.fromEntries(flags.map((flag) => [flag.column, flag]));

  // A fill of three against a plan for two.
  const oversized = proposeFlags(plan, { ...brokerFacts, quantity: 3 });
  // An exit short of the target, in profit: the exited_early proposal.
  const early = proposeFlags(plan, { ...brokerFacts, exit_price: 29800 });
  // Stopped out. A loss is not an early exit.
  const stopped = proposeFlags(plan, { ...brokerFacts, exit_price: 29905 });
  // No target on the plan: nothing to say about either judgement flag.
  const noTarget = proposeFlags({ ...plan, take_profit: null }, brokerFacts);

  group('the confirm screen reads one state and proposes what it can justify', [
    c('(1) the four states, off three columns', [
      linkState({ source: 'manual' }),
      linkState({ source: 'tradovate', unplanned: false, link_confirmed_at: '2026-10-16T10:00:00.000Z' }),
      linkState({ source: 'tradovate', unplanned: true, link_confirmed_at: null }),
      linkState({ source: 'tradovate', unplanned: true, link_confirmed_at: '2026-10-16T10:00:00.000Z' }),
    ], [null, 'linked', 'queued', 'declined']),
    // Every row the import has written since 15.10 looks like this, and the
    // queue is where they genuinely belong.
    c('(2) a row written before migration 035 reads as queued',
      linkState({ source: 'tradovate', unplanned: true }), 'queued'),
    c('(3) the מקור row needs three sentences, not two',
      [LINK_STATE_COPY.linked, LINK_STATE_COPY.queued, LINK_STATE_COPY.declined],
      ['Tradovate · מקושרת לתוכנית', 'Tradovate · ממתינה לשיוך', 'Tradovate · לא תוכננה']),
    // THE CHIP IN THE LIST, AND THE ONE WORD IT MUST NOT SAY (finding 2 of
    // 19.10). It used to be rendered off `unplanned`, which is true the moment
    // the import writes the row — so "לא תוכננה" was printed over a trade in
    // the queue, under a banner offering to assign it to a plan. The state is
    // the only thing allowed to decide it, and `linkState` is the state.
    c('(3a) a queued row is waiting, not unplanned',
      LINK_STATE_CHIP[linkState({ source: 'tradovate', unplanned: true, link_confirmed_at: null })!],
      'ממתינה לשיוך'),
    c('(3b) and only the trader\'s own answer says otherwise',
      LINK_STATE_CHIP[linkState({
        source: 'tradovate', unplanned: true, link_confirmed_at: '2026-10-16T10:00:00.000Z',
      })!],
      'לא תוכננה'),
    // A linked row carries the broker's name and nothing else: the trade has a
    // plan behind it, which is the normal case and not a thing to label.
    c('(3c) a linked row carries no state chip',
      LINK_STATE_CHIP[linkState({
        source: 'tradovate', unplanned: false, link_confirmed_at: '2026-10-16T10:00:00.000Z',
      })!],
      null),
    // The word nobody may reach from the column alone. If `unplanned` is ever
    // read directly again, one of these three is the assertion that says so.
    c('(3d) the two chips are never the same word',
      LINK_STATE_CHIP.queued === LINK_STATE_CHIP.declined, false),
    c('(4) a deleted row is not in the queue',
      [isQueuedBrokerRow({ source: 'tradovate', unplanned: true, link_confirmed_at: null }),
       isQueuedBrokerRow({ source: 'tradovate', unplanned: true, link_confirmed_at: null, hidden: true })],
      [true, false]),
    c('(5) the banner counts in Hebrew that reads',
      [queueBannerText(1), queueBannerText(3)],
      ['עסקה אחת מ-Tradovate ממתינה לשיוך', '3 עסקאות מ-Tradovate ממתינות לשיוך']),
    // §F4: after the link they are one row, so hiding it hides the plan.
    c('(6) deleting a linked row warns that the plan goes with it',
      deleteWarningText({ source: 'tradovate', unplanned: false, link_confirmed_at: 'x' })
        .includes('מקושרת לתוכנית שכתבת'), true),
    c('(7) and an ordinary row keeps the ordinary sentence',
      deleteWarningText({ source: 'manual' }), 'האם אתה בטוח שברצונך למחוק עסקה זו?'),

    c('(8) proper_size is the one unambiguous flag: two numbers, one comparison',
      [byColumn.proper_size?.value, byColumn.proper_size?.reason], [true, 'כמות תואמת: 2 מול 2']),
    c('(9) and it says so when they differ',
      oversized.find((flag) => flag.column === 'proper_size')?.reason, 'כמות שונה מהמתוכנן: 2 מול 3'),

    c('(10) an exit at or beyond the target is not an early exit',
      byColumn.exited_early?.value, false),
    c('(11) an exit in profit, short of the target, is',
      early.find((flag) => flag.column === 'exited_early')?.value, true),
    c('(12) and a loss is neither', [
      stopped.find((flag) => flag.column === 'exited_early')?.value,
      stopped.find((flag) => flag.column === 'exited_early')?.reason,
    ], [false, 'העסקה נסגרה בהפסד — לא יציאה מוקדמת מרווח']),

    c('(13) followed_plan: entry near the planned price and an exit at the target',
      byColumn.followed_plan?.value, true),
    c('(14) and not when the entry is far from it',
      proposeFlags(plan, { ...brokerFacts, entry_price: 29870 })
        .find((flag) => flag.column === 'followed_plan')?.value, false),

    // NO "UNKNOWN" CHECKBOX. A flag that cannot be computed is not offered,
    // because an unchecked box with "we could not tell" invites the trader to
    // confirm a `false` that means nothing.
    c('(15) a plan with no target offers only the flag it can justify',
      noTarget.map((flag) => flag.column), ['proper_size']),
    c('(16) and a trade with no size on either side offers nothing at all',
      proposeFlags({}, { direction: 'short' }).map((flag) => flag.column), []),
    c('(17) every proposal carries its own rationale',
      flags.filter((flag) => flag.reason.trim() === '').length, 0),
  ]);
}

/**
 * The hero stat's colour and printed value, read back out of the rendered
 * email.
 *
 * `plColorFor` and `readout` are module-private in lib/email/alerts.ts and
 * worth keeping that way, so REF-114's sign cases assert on what the trader
 * actually receives. The hero is the only 36px tile in the mail (template.ts
 * `tile`), which is what makes this unambiguous.
 */
function heroStat(html: string): { color: string; value: string } {
  const m = html.match(/font-size:36px;font-weight:700;line-height:1\.15;color:([^;]+);">([^<]*)</);
  return { color: m?.[1] ?? 'no hero', value: m?.[2] ?? 'no hero' };
}

async function alertSummaryGroup() {
  // A SHORT THAT MADE MONEY. entry above exit, `actual_pnl` positive — the
  // test that used to read `exit_price > entry_price` called this a loss.
  // Points 10, money 500: the two units are far enough apart to tell which
  // one `totalPL` is reporting.
  const winningShort = {
    status: 'closed', direction: 'short',
    entry_price: 110, exit_price: 100, actual_pnl: 500, rr_ratio: 2,
  };
  const losingLong = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 90, actual_pnl: -500, rr_ratio: 2,
  };
  // An imported row AS THE IMPORT WRITES IT: no plan behind it, so no R:R by
  // design, and `pnl_amount` NULL — import.ts:362 does not write it, and the
  // prices are index points. `actual_pnl` is the broker's own figure and the
  // only money on the row.
  const brokerRow = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 105, actual_pnl: 250, pnl_amount: null, rr_ratio: null,
  };
  // A MANUAL CLOSE: no broker figure, so `pnl_amount` — points × units ×
  // point_value, written by CloseTrade — is the money. 5 points × 2 × $2.
  const manualRow = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 105, actual_pnl: null, pnl_amount: 20, rr_ratio: null,
  };
  // Both columns set and disagreeing. `actual_pnl` is the trader's real or
  // overridden figure; `pnl_amount` can be inflated by a misconfigured point
  // value (lib/pnl.ts header).
  const overridden = { ...manualRow, actual_pnl: 300 };
  // Closed, priced, and no money figure anywhere: a manual close with no
  // `units` (CloseTrade.tsx:144 yields null), or a row from before the
  // `actual_pnl` backfill.
  const noMoney = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 105, actual_pnl: null, pnl_amount: null, rr_ratio: null,
  };

  // THE REF-114 SHAPE: points and money of OPPOSITE SIGN. +2 points on one
  // contract and −1 point on twenty is +1 in points and −$36 in money, so
  // the day the trader had is a loss and the day the points describe is a
  // gain. Reachable with no code change by a trader who scales differently
  // between trades.
  const smallWinner = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 102, actual_pnl: 4, pnl_amount: null, rr_ratio: null,
  };
  const bigLoser = {
    status: 'closed', direction: 'long',
    entry_price: 200, exit_price: 199, actual_pnl: -40, pnl_amount: null, rr_ratio: null,
  };

  const shortOnly = summarise([winningShort]);
  const mixed = summarise([winningShort, losingLong]);
  const withBroker = summarise([winningShort, brokerRow]);
  const openPlan = summarise([{ status: 'open', entry_price: 100, exit_price: null, rr_ratio: 4 }]);
  const empty = summarise([]);

  const scaled = summarise([smallWinner, bigLoser]);
  const scaledMail = dailySummaryEmail('דני', scaled, 'יום שישי, 16 באוקטובר');
  const hero = heroStat(scaledMail.html);

  group('the alert emails count a short the way a trader does', [
    // THE §0ד BUG, in the one file Stage 4 did not reach.
    c('(1) a profitable short is a win', shortOnly.winRate, 100),
    // REF-114. The hero stat is labelled `P&L היום` and prefixed `$`, so the
    // figure under it is the broker's 500 and not the 10 points behind it.
    c('(2) and its P&L is the money, not the points', shortOnly.totalPL, 500),
    c('(3) one win and one loss is 50%', mixed.winRate, 50),
    // THE §0ג BUG. 2 and null must average to 2, not to 1.
    c('(4) a null R:R is excluded from the average, not counted as zero',
      withBroker.avgRR, 2),
    c('(5) and the trade still counts as a trade', withBroker.trades, 2),
    c('(6) a row with no R:R at all leaves the average at zero',
      summarise([brokerRow]).avgRR, 0),
    // An open plan is a trade taken but not a closed one.
    c('(7) an open plan counts in `trades` and not in the win rate',
      [openPlan.trades, openPlan.winRate], [1, 0]),
    c('(8) no rows is all zeroes',
      [empty.trades, empty.winRate, empty.avgRR, empty.totalPL], [0, 0, 0, 0]),

    // ── REF-114: which figure, per row shape ──────────────────────────────
    // The reported bug. 5 index points on an MNQ-style row is not $5.
    c('(9) a broker row reports the broker figure, not its index points',
      summarise([brokerRow]).totalPL, 250),
    c('(10) a manual row still reports points x units x value',
      summarise([manualRow]).totalPL, 20),
    c('(11) actual_pnl wins over pnl_amount',
      summarise([overridden]).totalPL, 300),
    // 0, NOT 5. A trade with no size cannot be stated in dollars, and the
    // alternative is the points-and-dollars sum identity.ts refuses.
    c('(12) a closed row with no money figure contributes 0, not its points',
      summarise([noMoney]).totalPL, 0),
    // AND IT IS STILL A WIN, at 0. `isWinningTrade` falls back to points when
    // there is no money figure (lib/pnl.ts:92-94) and `tradeMoneyPnl` does
    // not, so this row shape is the one place `winRate` and `totalPL` can
    // still disagree: a day of only these reports 100% wins and $0.00. Pinned
    // rather than fixed — the fallback is the shared win test every page
    // reads, and changing it is not REF-114.
    c('(13) and it still counts as a trade, and as a win by points at 0 money',
      [summarise([noMoney]).trades, summarise([noMoney]).winRate], [1, 100]),

    // ── REF-114: the sign, which drives three decisions ───────────────────
    // Points would sum to +1 here. Money sums to -36.
    c('(14) when points and money disagree on the sign, money decides',
      scaled.totalPL, -36),
    c('(15) and the points sum really does disagree',
      Math.sign((102 - 100) + (199 - 200)), 1),
    // Each of the three readers of `totalPL`, on the day that used to arrive
    // green with a profit in its subject about a losing day.
    c('(16) the hero stat is red and prints the loss',
      hero, { color: EMAIL_COLORS.danger, value: '-$36.00' }),
    c('(17) the readout does not call it a positive day',
      scaledMail.text.includes('יום חיובי'), false),
    c('(18) it names the loss, with the win rate that makes it one',
      scaledMail.text.includes('הפסד למרות אחוז הצלחה מעל 50%'), true),
    c('(19) and the subject line carries the loss, not a gain',
      scaledMail.subject.includes('-$36.00'), true),
  ]);
}

async function alertWindowGroup() {
  // Israel is UTC+3 in summer and UTC+2 in winter. Both are asserted, because
  // the bug this replaces was a fixed offset of zero.
  const summerEvening = new Date('2026-07-15T18:00:00.000Z'); // 21:00 Israel, IDT
  const winterEvening = new Date('2026-01-15T19:00:00.000Z'); // 21:00 Israel, IST

  // The hour the bug lived in: 01:00 Israel is still the previous UTC day in
  // winter, and in summer it is 22:00 UTC of the day before.
  const summerSmallHours = new Date('2026-07-15T22:30:00.000Z'); // 01:30 Israel on the 16th

  group('an alert day starts at the trader\'s midnight, not the server\'s', [
    c('(1) summer: the day starts at 21:00 UTC the previous evening',
      zonedDayStart(summerEvening).toISOString(), '2026-07-14T21:00:00.000Z'),
    c('(2) winter: at 22:00 UTC the previous evening',
      zonedDayStart(winterEvening).toISOString(), '2026-01-14T22:00:00.000Z'),
    // THE BUG, STATED AS AN ASSERTION. `setHours(0,0,0,0)` on a UTC server
    // would answer 2026-07-15T00:00:00Z here, which is 03:00 Israel — three
    // hours of the trader's own day missing from their summary.
    c('(3) and it is NOT UTC midnight',
      zonedDayStart(summerEvening).toISOString() === '2026-07-15T00:00:00.000Z', false),
    // 01:30 Israel on the 16th belongs to the 16th, not the 15th.
    c('(4) the small hours belong to the day the trader is in',
      zonedDayStart(summerSmallHours).toISOString(), '2026-07-15T21:00:00.000Z'),
    c('(5) end_of_day uses that boundary',
      alertRangeStart('end_of_day', summerEvening), '2026-07-14T21:00:00.000Z'),
    c('(6) pre_market uses it too',
      alertRangeStart('pre_market', summerEvening), '2026-07-14T21:00:00.000Z'),
    // The weekly summary is a duration and not a calendar week; the product
    // has never promised Sunday-to-Sunday.
    c('(7) weekly_summary reaches back seven days from now',
      alertRangeStart('weekly_summary', summerEvening), '2026-07-08T18:00:00.000Z'),
  ]);
}

async function alertImportGroup() {
  const connected = new Set([USER]);

  const everything = chooseAlertJobs(
    [
      {
        user_id: USER,
        pre_market_enabled: true,
        pre_market_time: '21:00',
        end_of_day_enabled: true,
        end_of_day_time: '21:00',
        weekly_summary_enabled: true,
        weekly_summary_time: '21:00',
      },
    ],
    { ilHour: 21, isSunday: true, importable: connected }
  );

  const importing = everything.filter((job) => job.importFirst);

  // A second trader, at the same hour, with no connection.
  const twoUsers = chooseAlertJobs(
    [
      { user_id: USER, end_of_day_enabled: true, end_of_day_time: '21:00' },
      { user_id: OTHER_USER, end_of_day_enabled: true, end_of_day_time: '21:00' },
    ],
    { ilHour: 21, isSunday: false, importable: connected }
  );

  const wrongHour = chooseAlertJobs(
    [{ user_id: USER, end_of_day_enabled: true, end_of_day_time: '21:00' }],
    { ilHour: 9, isSunday: false, importable: connected }
  );

  const disabled = chooseAlertJobs(
    [{ user_id: USER, end_of_day_enabled: false, end_of_day_time: '21:00' }],
    { ilHour: 21, isSunday: false, importable: connected }
  );

  // THE FAILURE PATH. A pull that throws must not reach the caller — the
  // trader asked for a summary, not for a broker.
  let threw = false;
  const { lines } = await captureLogs(async () => {
    try {
      await importBeforeSummary(
        null as never,
        USER,
        new Date('2026-07-15T18:00:00.000Z'),
        async () => {
          throw new TradovateTransientError('upstream said no', { reason: 'network' });
        }
      );
    } catch {
      threw = true;
    }
  });

  group('the end-of-day summary imports once, and sends even when that fails', [
    // AT MOST ONE IMPORT PER USER PER RUN, however many emails they get.
    c('(1) three emails for one trader, one import', importing.length, 1),
    c('(2) and it is the end-of-day one', importing[0]?.type, 'end_of_day'),
    c('(3) pre_market never imports',
      everything.find((j) => j.type === 'pre_market')?.importFirst, false),
    c('(4) weekly_summary never imports',
      everything.find((j) => j.type === 'weekly_summary')?.importFirst, false),
    // A trader with no active, declaring, allowlisted connection is not in
    // the set, so no pull is attempted for them.
    c('(5) a trader with no connection gets the email and no import',
      twoUsers.map((j) => j.importFirst), [true, false]),
    c('(6) and both still get an email', twoUsers.length, 2),
    c('(7) a different hour owes nothing', wrongHour.length, 0),
    c('(8) a disabled summary owes nothing', disabled.length, 0),
    // The property the §H fix rests on.
    c('(9) a broker that throws does not reach the caller', threw, false),
    c('(10) and it is logged as a kind, with no user id',
      [lines.length, lines.some((l) => l.includes(USER))], [1, false]),
  ]);
}

// ── Main ────────────────────────────────────────────────────────────────────

// ── REF-110 Stages 1-2: accounts become rows, and trades point at them ──────
//
// The WRITE half. What a pull claims is asserted in
// scripts/tradovate-today-check.ts, which has the reader seam; this file has
// the Supabase stub, so it is where "what statements does that produce" lives.
// The §A.5 fail-safe is asserted on BOTH sides on purpose — it is the one
// whose failure mode is a trader's whole portfolio reading as closed after a
// demo outage, which nothing else in the product would make visible.

/** The Tradovate user the fixtures below belong to. */
const TRADOVATE_USER_ID = 555;

/** The trader's funded account, on demo, where TRADE was executed. */
const BROKER_ACCOUNT: TradovateAccount = {
  id: ACCOUNT_ID,
  name: 'EVAL-A',
  userId: TRADOVATE_USER_ID,
  accountType: 'Customer',
};

/** A second account of theirs, on the same host. */
const OTHER_ACCOUNT: TradovateAccount = { ...BROKER_ACCOUNT, id: 1_805_999, name: 'EVAL-B' };

/** The pull's clock, frozen. See `syncTwice` for why that is the whole trick. */
const ACCOUNT_NOW = Date.parse('2026-10-16T08:00:00.000Z');
/** An hour later, for the one assertion that needs the clock to have moved. */
const ACCOUNT_LATER = ACCOUNT_NOW + 3_600_000;

/**
 * One host's discovery result, built through the REAL claim filter.
 *
 * Deliberately not a hand-written `claimed` array: `claimedAccounts` is what
 * production calls, so a fixture that bypassed it could assert a status
 * mapping against a `tradeable` flag the real filter would never have
 * produced. This way the two halves cannot drift.
 */
function answered(host: TradovateEnvironment, accounts: TradovateAccount[]): HostAccounts {
  return { host, claimed: claimedAccounts(accounts, TRADOVATE_USER_ID) };
}

/** The sync, with the log swallowed. */
async function quietAccountSync(params: Parameters<typeof syncBrokerAccounts>[0]) {
  const { result } = await captureLogs(() => syncBrokerAccounts(params));
  return result;
}

/** A sync, then the identical sync again, against one database. */
async function syncTwice(db: FakeDb, hosts: HostAccounts[], nowMs = ACCOUNT_NOW) {
  const client = db.client();
  const first = await quietAccountSync({ client, userId: USER, hosts, env: ON, nowMs });
  const writesAfterFirst = db.writes.length;
  const second = await quietAccountSync({ client, userId: USER, hosts, env: ON, nowMs });
  return { first, second, secondRunWrites: db.writes.length - writesAfterFirst };
}

async function accountRecordGroup() {
  // ── The first sync: two accounts, one of them already closed ─────────────
  const fresh = new FakeDb();
  const hosts = [answered('demo', [BROKER_ACCOUNT, { ...OTHER_ACCOUNT, closed: true }])];
  const { first, secondRunWrites } = await syncTwice(fresh, hosts);

  const rowFor = (db: FakeDb, account: TradovateAccount) =>
    db.rows.find((row) => row.broker_account_id === account.id) ?? {};
  const open = rowFor(fresh, BROKER_ACCOUNT);
  const shut = rowFor(fresh, OTHER_ACCOUNT);

  // ── The four states that are not `closed: true` ──────────────────────────
  const statusOf = async (over: Partial<TradovateAccount>) => {
    const db = new FakeDb();
    await quietAccountSync({
      client: db.client(),
      userId: USER,
      hosts: [answered('demo', [{ ...BROKER_ACCOUNT, ...over }])],
      env: ON,
      nowMs: ACCOUNT_NOW,
    });
    return db.rows[0]?.status ?? 'no row';
  };

  // `archived` is not on TradovateAccount and must not be — ./types.ts forbids
  // widening from guesswork — so the fixture carries it the same way the
  // reader reads it: off the body, undeclared. If the spike shows the field
  // does not exist, this case and the branch it covers go together.
  const archived = await statusOf({ archived: true } as Partial<TradovateAccount>);

  // ── The flag ─────────────────────────────────────────────────────────────
  const offDb = new FakeDb();
  const offRun = await quietAccountSync({
    client: offDb.client(),
    userId: USER,
    hosts,
    env: OFF,
    nowMs: ACCOUNT_NOW,
  });

  // ── A concurrent insert of the same account ──────────────────────────────
  const raced = new FakeDb();
  raced.failNextInsertAsConflict = true;
  const racedRun = await quietAccountSync({
    client: raced.client(),
    userId: USER,
    hosts: [answered('demo', [BROKER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_NOW,
  });

  group('REF-110: a trader\'s accounts become rows', [
    c('(1) one row per claimed account, whatever its state',
      [fresh.rows.length, first.counts.accountsSeen, first.counts.inserted],
      [2, 2, 2]),
    c('(2) the identity the join needs: broker, id and HOST',
      [open.broker, open.broker_account_id, open.broker_host],
      ['tradovate', ACCOUNT_ID, 'demo']),
    c('(3) display_name is the broker\'s own name for it',
      [open.display_name, shut.display_name], ['EVAL-A', 'EVAL-B']),
    c('(4) and a closed account is RECORDED, which is the whole ticket',
      [open.status, shut.status], ['active', 'closed']),

    // §A.5's first branch, one case per flag, because "closed" is a claim
    // about five different booleans.
    c('(5) every state flag reads as closed, and nothing else does', [
      await statusOf({}),
      await statusOf({ closed: true }),
      await statusOf({ restricted: true }),
      await statusOf({ readonly: true }),
      await statusOf({ futuresDisabled: true }),
      await statusOf({ active: false }),
      archived,
    ], ['active', 'closed', 'closed', 'closed', 'closed', 'closed', 'archived']),

    c('(6) both timestamps are the pull\'s, so a row cannot be first seen after it was last seen',
      [open.first_seen_at, open.last_seen_at],
      [new Date(ACCOUNT_NOW).toISOString(), new Date(ACCOUNT_NOW).toISOString()]),

    // THE ASSERTION THIS GROUP EXISTS FOR, and the frozen clock is what makes
    // it meaningful: `last_seen_at` moves on every real pull, so what is being
    // measured is that NO BROKER FACT IS RESTATED NEEDLESSLY — in particular
    // that a TIMESTAMPTZ returning as `+00:00` where we sent `Z` does not
    // report every row as changed, which is how idempotence is usually lost.
    c('(7) a second sync against the same clock writes NOTHING AT ALL',
      secondRunWrites, 0),

    // The flag, which is what makes the deploy order survivable.
    c('(8) with the flag off, not one statement is sent',
      [offRun.counts.ran, offDb.statements.length, offRun.identities.size],
      [false, 0, 0]),

    // §C12's three properties, on a second table.
    c('(9) every statement carries the user',
      fresh.statements.every((s) =>
        s.kind === 'insert'
          ? s.values?.user_id === USER
          : s.filters.some(([op, column, value]) => op === 'eq' && column === 'user_id' && value === USER)
      ), true),
    c('(10) and a blank user id throws before any of them',
      await syncBrokerAccounts({ client: new FakeDb().client(), userId: '', hosts, env: ON })
        .then(() => 'no throw', (error: unknown) => (error as Error).message.includes('non-empty string')),
      true),

    // The race. The index did its job; the row exists, so this becomes the
    // update it would have been — and its id still reaches the map, which is
    // what the import needs.
    c('(11) a 23505 from a concurrent insert is absorbed, not counted as a failure',
      [racedRun.counts.failed, racedRun.counts.inserted, racedRun.counts.unchanged],
      [0, 0, 1]),
    c('(12) and the winner\'s row is the one the identity map names',
      racedRun.identities.get(accountIdentity('demo', ACCOUNT_ID)),
      raced.rows[0]?.id),

    // The log rule, which this module is the reason for restating: a
    // display_name is a prop firm's name.
    c('(13) the log carries counts and not one account name or id', await (async () => {
      const db = new FakeDb();
      const { lines } = await captureLogs(() =>
        syncBrokerAccounts({ client: db.client(), userId: USER, hosts, env: ON, nowMs: ACCOUNT_NOW })
      );
      const text = lines.join('\n');
      return [
        text.includes('accountsSeen=2'),
        text.includes('EVAL-A'),
        text.includes('EVAL-B'),
        text.includes(String(ACCOUNT_ID)),
        text.includes(USER),
      ];
    })(), [true, false, false, false, false]),
  ]);
}

async function accountBoundaryGroup() {
  // The trader has renamed their evaluation and hidden a dead one. Then the
  // broker restates both names.
  const db = new FakeDb([
    rowIn('accounts', {
      id: 'acct-1',
      user_id: USER,
      broker: 'tradovate',
      broker_account_id: ACCOUNT_ID,
      broker_host: 'demo',
      display_name: 'EVAL-A',
      nickname: 'התיק של אפריל',
      hidden: true,
      status: 'active',
      first_seen_at: '2026-09-01T00:00:00.000Z',
      last_seen_at: '2026-10-15T08:00:00.000Z',
    }),
  ]);

  const run = await quietAccountSync({
    client: db.client(),
    userId: USER,
    hosts: [answered('demo', [{ ...BROKER_ACCOUNT, name: 'EVAL-A-RENAMED-BY-FIRM' }])],
    env: ON,
    nowMs: ACCOUNT_LATER,
  });

  const row = db.rows[0] ?? {};
  const updates = db.statements.filter((s) => s.kind === 'update');

  group('REF-110: the broker owns the name, the trader owns the rest', [
    // The E12 regression, in its second home. Same shape as "a trader-edited
    // strategy survives a re-import".
    c('(1) a nickname the trader typed survives a resync that restates the name',
      [row.display_name, row.nickname],
      ['EVAL-A-RENAMED-BY-FIRM', 'התיק של אפריל']),
    c('(2) and so does hidden, which is a screen preference and not a delete',
      row.hidden, true),
    c('(3) neither column is NAMED by any statement — not even to its default',
      updates.every((s) => !('nickname' in (s.values ?? {})) && !('hidden' in (s.values ?? {}))),
      true),

    // first_seen_at is in neither set, and this is the only place that says so.
    c('(4) first_seen_at is never restated; last_seen_at is',
      [row.first_seen_at, row.last_seen_at],
      ['2026-09-01T00:00:00.000Z', new Date(ACCOUNT_LATER).toISOString()]),
    c('(5) and no statement names first_seen_at at all',
      updates.every((s) => !('first_seen_at' in (s.values ?? {}))), true),

    c('(6) the row was restated rather than duplicated',
      [db.rows.length, run.counts.inserted, run.counts.updated], [1, 0, 1]),

    // THE MEMBERSHIP ASSERTION. This list is a POLICY: adding a column to it
    // hands it to the broker forever. The three members below are the three
    // the broker is allowed to restate, and `nickname`/`hidden`/`first_seen_at`
    // being absent is what cases 1-5 above actually depend on.
    c('(7) and the broker-owned list is exactly these three',
      [...BROKER_OWNED_FOR_TEST].sort(),
      ['display_name', 'last_seen_at', 'status']),
  ]);
}

async function accountClosureGroup() {
  /** Two accounts the trader had last week: one on each host. */
  const storedPair = (): Row[] => [
    rowIn('accounts', {
      id: 'acct-live',
      user_id: USER,
      broker: 'tradovate',
      broker_account_id: ACCOUNT_ID,
      broker_host: 'live',
      display_name: 'EVAL-A',
      status: 'active',
      first_seen_at: '2026-09-01T00:00:00.000Z',
      last_seen_at: '2026-10-15T08:00:00.000Z',
    }),
    rowIn('accounts', {
      id: 'acct-demo',
      user_id: USER,
      broker: 'tradovate',
      broker_account_id: OTHER_ACCOUNT.id,
      broker_host: 'demo',
      display_name: 'EVAL-B',
      status: 'active',
      first_seen_at: '2026-09-01T00:00:00.000Z',
      last_seen_at: '2026-10-15T08:00:00.000Z',
    }),
  ];

  // Both hosts answer; live no longer lists its account.
  const gone = new FakeDb(storedPair());
  const goneRun = await quietAccountSync({
    client: gone.client(),
    userId: USER,
    hosts: [answered('live', []), answered('demo', [OTHER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_LATER,
  });
  const goneLive = gone.rows.find((row) => row.id === 'acct-live') ?? {};

  // THE FAIL-SAFE. Live's discovery FAILED, so live has no entry at all — the
  // shape `loadBrokerDay` produces when it drops a host. Nothing about live
  // may be concluded from this pull.
  const outage = new FakeDb(storedPair());
  const outageRun = await quietAccountSync({
    client: outage.client(),
    userId: USER,
    hosts: [answered('demo', [OTHER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_LATER,
  });
  const outageLive = outage.rows.find((row) => row.id === 'acct-live') ?? {};

  // A total outage: no host answered. The pull itself failed, and the sync
  // must be a no-op rather than a mass closure.
  const blackout = new FakeDb(storedPair());
  const blackoutRun = await quietAccountSync({
    client: blackout.client(),
    userId: USER,
    hosts: [],
    env: ON,
    nowMs: ACCOUNT_LATER,
  });

  // An account that is already closed is not re-closed every night.
  const settled = new FakeDb(
    storedPair().map((row) => (row.id === 'acct-live' ? { ...row, status: 'closed' } : row))
  );
  const settledClient = settled.client();
  await quietAccountSync({
    client: settledClient,
    userId: USER,
    hosts: [answered('live', []), answered('demo', [OTHER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_LATER,
  });

  group('REF-110 §A.5: an account that stops being listed, and one that was never asked about', [
    c('(1) a host that ANSWERED and did not list it closes it',
      [goneLive.status, goneRun.counts.accountsClosed], ['closed', 1]),
    // The one date the trader wants, and the pull that notices the account is
    // gone is the last pull that should be allowed to move it.
    c('(2) and last_seen_at is NOT moved by the pull that noticed',
      goneLive.last_seen_at, '2026-10-15T08:00:00.000Z'),

    // THE ASSERTION THAT WOULD OTHERWISE BE FOUND IN PRODUCTION.
    c('(3) a host whose discovery FAILED does not close its accounts',
      [outageLive.status, outageLive.last_seen_at, outageRun.counts.accountsClosed],
      ['active', '2026-10-15T08:00:00.000Z', 0]),
    c('(4) and nothing about that host was written at all',
      outage.writes.filter((s) =>
        s.filters.some(([op, column, value]) => op === 'eq' && column === 'id' && value === 'acct-live')
      ).length, 0),
    c('(5) a pull where NO host answered closes nothing',
      [blackoutRun.counts.accountsClosed, blackout.writes.length,
       blackout.rows.every((row) => row.status === 'active')],
      [0, 0, true]),

    // Scoped to the closed row on purpose: the DEMO account was listed, so
    // its `last_seen_at` moves and that is one legitimate write. What must not
    // happen is a second closure statement against a row that is already
    // closed, every night, forever.
    c('(6) an already-closed account is not closed again every night',
      settled.writes.filter((s) =>
        s.filters.some(([op, column, value]) => op === 'eq' && column === 'id' && value === 'acct-live')
      ).length, 0),

    // The other direction, so (3) cannot pass by the rule simply never firing.
    c('(7) the demo account, which WAS listed, is untouched and current',
      [(gone.rows.find((row) => row.id === 'acct-demo') ?? {}).status,
       (gone.rows.find((row) => row.id === 'acct-demo') ?? {}).last_seen_at],
      ['active', new Date(ACCOUNT_LATER).toISOString()]),
  ]);
}

async function accountStampGroup() {
  /** An already-imported trade, with no account pointed at it yet. */
  const importedRow = (over: Row = {}): Row => ({
    id: 'trade-1',
    user_id: USER,
    source: 'tradovate',
    status: 'closed',
    hidden: false,
    broker_trade_key: TRADE.brokerTradeKey,
    broker_account_id: ACCOUNT_ID,
    broker_host: 'demo',
    account_id: null,
    ...over,
  });

  // ── Stage 2, end to end: record the accounts, then import onto them ──────
  const db = new FakeDb();
  const client = db.client();
  const { identities } = await quietAccountSync({
    client,
    userId: USER,
    hosts: [answered('demo', [BROKER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_NOW,
  });
  await quietImport({ client, userId: USER, trades: [TRADE], isTradeSource: true, env: ON, accountIds: identities });
  const written = db.rows.find((row) => row.broker_trade_key === TRADE.brokerTradeKey) ?? {};
  const accountRow = db.rows.find((row) => row.broker === 'tradovate') ?? {};

  // ── The backfill: rows imported before any account existed ───────────────
  const old = new FakeDb([
    importedRow(),
    importedRow({ id: 'trade-2', broker_trade_key: 'demo:88500' }),
    // A row on a host this pull did not see. Nothing may be concluded about it.
    importedRow({ id: 'trade-3', broker_trade_key: 'live:1', broker_host: 'live' }),
    // A manual plan. It has no broker identity, so the backfill must not
    // invent one for it — NULL means UNASSIGNED, never "manual".
    { id: 'plan-1', user_id: USER, source: 'manual', status: 'open', account_id: null },
  ]);
  const oldClient = old.client();
  const backfill = await quietAccountSync({
    client: oldClient,
    userId: USER,
    hosts: [answered('demo', [BROKER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_NOW,
  });
  const writesAfterBackfill = old.writes.length;
  // The same pass again. The rows are assigned now, so it has nothing to do.
  await quietAccountSync({
    client: oldClient,
    userId: USER,
    hosts: [answered('demo', [BROKER_ACCOUNT])],
    env: ON,
    nowMs: ACCOUNT_NOW,
  });
  const secondBackfillWrites = old.writes.length - writesAfterBackfill;
  const byId = (id: string) => old.rows.find((row) => row.id === id) ?? {};
  const assignedAccount = old.rows.find((row) => row.broker === 'tradovate')?.id;

  // ── /api/tradovate/today's arrangement: an import with NO identity map ───
  const noMap = new FakeDb([importedRow({ account_id: 'acct-already-there' })]);
  await quietImport({
    client: noMap.client(), userId: USER, trades: [TRADE], isTradeSource: true, env: ON,
  });

  // ── The unlink ───────────────────────────────────────────────────────────
  resetLinkGuard();
  const unlinked = new FakeDb([importedRow({ account_id: 'acct-1' })]);
  await unlinkPlan({ client: unlinked.client(), rowId: 'trade-1' });

  group('REF-110 Stage 2: a trade points at the account it was executed on', [
    c('(1) the import stamps account_id from (broker_account_id, broker_host)',
      written.account_id, accountRow.id),
    c('(2) which is the column the migration adds, and it is a real row\'s id',
      typeof written.account_id, 'string'),

    // The pass that makes 037 safe to run before any code ships.
    c('(3) the backfill points existing imported rows at the account',
      [byId('trade-1').account_id, byId('trade-2').account_id],
      [assignedAccount, assignedAccount]),
    c('(4) ONE update per identity, not one per row',
      old.writes.filter((s) => s.kind === 'update' && s.table === 'trade_plans').length, 1),
    c('(5) and it reports the identity it assigned', backfill.counts.backfilled, 1),
    c('(6) a second pass has nothing to do and writes nothing',
      secondBackfillWrites, 0),

    // The two rows it must not touch.
    c('(7) a row on a host this pull never saw is left unassigned',
      byId('trade-3').account_id, null),
    c('(8) and a manual plan is left unassigned — NULL means unassigned, not manual',
      byId('plan-1').account_id, null),

    // THE ONE THAT PROTECTS THE BACKFILL FROM /today. An import with no
    // identity map must not name the column, or every trade-form opening
    // would undo the assignment the last sync made.
    c('(9) an import with no identity map does not clear an assignment',
      (noMap.rows[0] ?? {}).account_id, 'acct-already-there'),
    c('(10) because it does not name the column in any statement',
      noMap.writes.every((s) => !('account_id' in (s.values ?? {}))), true),

    // The provenance goes together or not at all.
    c('(11) an unlink clears account_id with the rest of the provenance',
      [(unlinked.rows[0] ?? {}).account_id,
       (unlinked.rows[0] ?? {}).broker_account_id,
       (unlinked.rows[0] ?? {}).broker_host,
       (unlinked.rows[0] ?? {}).broker_trade_key],
      [null, null, null, null]),

    // The policy list, now fourteen.
    c('(12) account_id is in EXECUTION_FACTS deliberately, so the broker restates it',
      EXECUTION_FACTS_FOR_TEST.some(({ column }) => column === 'account_id'), true),
  ]);
}

// ── REF-113 Stage 3: the broker's stop, written ─────────────────────────────

/**
 * A stop history as ./orders.ts derives one. The measured 19.10 shape: a
 * bracketed stop dragged twice, tightening.
 */
const MOVED_HISTORY: StopHistory = {
  verdict: 'moved',
  reason: null,
  initialStop: 4504,
  // Below the 4510.25 entry, which is the only side a long's stop is submitted
  // on. The 4512 final is above it and is the legitimate drag into profit.
  initialStopSide: 'risk',
  finalStop: 4512,
  initialTarget: 4525,
  movedCount: 2,
  direction: 'tightened',
  movedAtMs: null,
  trailing: false,
  noStopPlaced: false,
  source: 'linked',
  versions: [{ stopPrice: 4504 }, { stopPrice: 4508.5 }, { stopPrice: 4512 }],
  // The entry filled at market, so no revision preceded the stop the position
  // opened under — and the fill anchor still RAN, which is the difference
  // `anchoredAtFill` exists to state (REF-113 fill anchor).
  preFillVersions: 0,
  anchoredAtFill: true,
  otherTargets: [],
};

const KEPT_HISTORY: StopHistory = {
  ...MOVED_HISTORY,
  verdict: 'kept',
  finalStop: 4504,
  movedCount: 0,
  direction: null,
  versions: [{ stopPrice: 4504 }],
};

/** The trader placed no stop at all. A FINDING, not a failure. */
const NONE_HISTORY: StopHistory = {
  ...MOVED_HISTORY,
  verdict: 'none',
  initialStop: null,
  finalStop: null,
  initialTarget: null,
  movedCount: 0,
  direction: null,
  noStopPlaced: true,
  source: 'none',
  versions: [],
};

/** We could not read the orders. NOT the same claim as NONE_HISTORY. */
const UNKNOWN_HISTORY: StopHistory = {
  ...NONE_HISTORY,
  verdict: 'unknown',
  reason: 'interday',
  noStopPlaced: false,
};

/** A trailing stop: it moved, and the moves were the server's. */
const TRAILING_HISTORY: StopHistory = { ...MOVED_HISTORY, trailing: true };

const historyFor = (trade: BrokerTrade, history: StopHistory) =>
  new Map([[trade.brokerTradeKey, history]]);

async function stopHistoryGroup() {
  // ── A fresh broker row, with the orders read ─────────────────────────────
  const fresh = new FakeDb();
  await quietImport({
    client: fresh.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });
  const row = fresh.rows[0] ?? {};

  // ── The same run twice: the JSONB must not look changed every time ───────
  const writesAfterFirst = fresh.writes.length;
  const second = await quietImport({
    client: fresh.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });

  // The same document with its keys in Postgres's order rather than ours, and
  // the two NUMERIC columns as the strings PostgREST sends back. If `kind` were
  // `exact` this row would be reported as changed on every pull — and if the
  // key order were compared, on every pull as well.
  const reordered: StopHistory = JSON.parse(
    JSON.stringify(
      Object.fromEntries(Object.entries(MOVED_HISTORY).sort(([a], [b]) => (a > b ? -1 : 1)))
    )
  ) as StopHistory;
  const wire = new FakeDb([
    {
      ...row,
      broker_stop_loss: '4504',
      broker_take_profit: '4525',
      stop_history: reordered,
    },
  ]);
  const onWire = await quietImport({
    client: wire.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });

  // ── A history that genuinely changed ────────────────────────────────────
  // THE TRAP THIS GROUP EXISTS FOR. `String(obj) === String(obj)` is
  // `'[object Object]' === '[object Object]'`, so with `kind: 'exact'` the
  // column would compare equal to EVERY other object and never be updated once
  // written. The two documents below are different in every field that matters
  // and identical under `String()`.
  const changed = new FakeDb([{ ...row }]);
  const afterChange = await quietImport({
    client: changed.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, { ...MOVED_HISTORY, movedCount: 3, finalStop: 4515 }),
  });

  group('REF-113: the broker\'s stop history becomes three columns', [
    c('(1) the JSONB document is written whole',
      row.stop_history, MOVED_HISTORY),
    c('(2) broker_stop_loss is the INITIAL stop and broker_take_profit the nearest target',
      [row.broker_stop_loss, row.broker_take_profit], [4504, 4525]),
    // THE REVERSAL OF DECISION 4. The broker's prices go to the two columns
    // 038 added for them and NOWHERE ELSE: `stop_loss` and `take_profit` are
    // scored, and paying for them on a row whose whole point is that it has no
    // plan is worth 30 points of a plan that does not exist. See
    // unplannedScoreGroup(), which is where the number is pinned.
    c('(3) the trader\'s own stop_loss and take_profit are NOT filled',
      [row.stop_loss ?? null, row.take_profit ?? null], [null, null]),
    c('(4) and the verdict reaches the self-report columns',
      [row.moved_sl, row.kept_sl], [true, false]),

    c('(5) a second identical run sends NO statement',
      [fresh.writes.length - writesAfterFirst, second.unchanged, second.updated], [0, 1, 0]),
    c('(6) nor does a row whose JSONB came back with Postgres\'s key order',
      [onWire.unchanged, onWire.updated, wire.writes.length], [1, 0, 0]),

    // The silent trap, caught.
    c('(7) a CHANGED history IS written — `kind: json`, not `exact`',
      [afterChange.updated, afterChange.unchanged], [1, 0]),
    c('(8) and only the columns that moved',
      Object.keys(changed.writes[0]?.values ?? {}).sort(), ['stop_history']),
    c('(9) `stop_history` carries `kind: \'json\'` in the fact list',
      EXECUTION_FACTS_FOR_TEST.length > 0 &&
        ['broker_stop_loss', 'broker_take_profit', 'stop_history'].every((column) =>
          EXECUTION_FACTS_FOR_TEST.some((fact) => fact.column === column)
        ),
      true),
  ]);
}

async function stopNotDeletedGroup() {
  // THE MOST DESTRUCTIVE THING THIS STAGE COULD HAVE SHIPPED. The nightly cron
  // runs at 03:30 UTC, hours after Tradovate cleared `/order/list` of the day it
  // imports, so it ALWAYS has an empty stop history to offer. If an absent
  // history resolved to NULL, it would erase every evening what the end-of-day
  // summary captured six hours earlier — silently, for every trader, forever.
  const stored = new FakeDb([
    {
      id: 'trade-1',
      user_id: USER,
      source: 'tradovate',
      status: 'closed',
      hidden: false,
      unplanned: true,
      broker_trade_key: TRADE.brokerTradeKey,
      broker_account_id: ACCOUNT_ID,
      broker_host: 'demo',
      symbol: SYMBOL,
      direction: 'short',
      entry_price: ENTRY,
      exit_price: EXIT,
      quantity: 2,
      actual_pnl: 270,
      pnl_currency: '$',
      submitted_at: new Date(OPENED).toISOString(),
      closed_at: new Date(CLOSED).toISOString(),
      // What an earlier, order-reading run wrote.
      broker_stop_loss: 4504,
      broker_take_profit: 4525,
      stop_history: MOVED_HISTORY,
      stop_loss: 4504,
      take_profit: 4525,
      moved_sl: true,
      kept_sl: false,
    },
  ]);
  const nightly = await quietImport({
    client: stored.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    // No map at all: the cron's state, and /api/tradovate/today's.
  });
  const after = stored.rows[0] ?? {};

  // An `'unknown'` is a real answer and IS stored — but it has no prices, and
  // naming the price columns with NULL would be the same erasure in miniature.
  const unknown = new FakeDb();
  await quietImport({
    client: unknown.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, UNKNOWN_HISTORY),
  });
  const unknownRow = unknown.rows[0] ?? {};

  const none = new FakeDb();
  await quietImport({
    client: none.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, NONE_HISTORY),
  });
  const noneRow = none.rows[0] ?? {};

  group('a run that could not read the orders never erases one that could', [
    c('(1) a pull with no stop history sends ZERO statements', nightly.unchanged, 1),
    c('(2) and the stored history is untouched',
      [after.stop_history, after.broker_stop_loss, after.moved_sl],
      [MOVED_HISTORY, 4504, true]),
    c('(3) because not one statement names any of the three columns',
      stored.writes.every((s) =>
        !('stop_history' in (s.values ?? {})) &&
        !('broker_stop_loss' in (s.values ?? {})) &&
        !('broker_take_profit' in (s.values ?? {}))
      ), true),

    // `'unknown'` vs `'none'`: the distinction the whole ticket exists for.
    c('(4) an `unknown` is stored, so the screen can say "we could not read it"',
      [(unknownRow.stop_history as StopHistory)?.verdict,
       (unknownRow.stop_history as StopHistory)?.reason],
      ['unknown', 'interday']),
    c('(5) but it names no price column and no flag',
      ['broker_stop_loss', 'broker_take_profit', 'stop_loss', 'take_profit', 'moved_sl', 'kept_sl']
        .filter((column) => column in unknownRow), []),
    c('(6) a `none` is stored as the finding it is',
      [(noneRow.stop_history as StopHistory)?.verdict,
       (noneRow.stop_history as StopHistory)?.noStopPlaced],
      ['none', true]),
    // Decision 2: `moved_sl` stays NULL for `'none'` too. "You did not place a
    // stop" is not an answer to "did you move it", and both big consumers
    // already filter `!== null`.
    c('(7) and `none` leaves moved_sl unnamed — NULL, not false',
      ['moved_sl', 'kept_sl'].filter((column) => column in noneRow), []),
  ]);
}

async function stopSelfReportGroup() {
  const brokerRow = (over: Row = {}): Row => ({
    id: 'trade-1',
    user_id: USER,
    source: 'tradovate',
    status: 'closed',
    hidden: false,
    unplanned: true,
    broker_trade_key: TRADE.brokerTradeKey,
    broker_account_id: ACCOUNT_ID,
    broker_host: 'demo',
    symbol: SYMBOL,
    direction: 'short',
    entry_price: ENTRY,
    exit_price: EXIT,
    quantity: 2,
    actual_pnl: 270,
    pnl_currency: '$',
    submitted_at: new Date(OPENED).toISOString(),
    closed_at: new Date(CLOSED).toISOString(),
    moved_sl: null,
    kept_sl: null,
    stop_loss: null,
    take_profit: null,
    stop_history: null,
    ...over,
  });

  // THE INTERACTION THAT WOULD TEACH A TRADER TO DISTRUST THE FIGURES. They
  // disagree with "you moved your stop" and untick the box. A sync must not
  // tick it again.
  const disagreed = new FakeDb([brokerRow({ moved_sl: false, kept_sl: true })]);
  await quietImport({
    client: disagreed.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });
  const disagreedRow = disagreed.rows[0] ?? {};

  // The trader typed their own stop on the imported row. The broker's number
  // does not replace it — and does not reach the column at all.
  const ownStop = new FakeDb([brokerRow({ stop_loss: 29_900, take_profit: 29_700 })]);
  await quietImport({
    client: ownStop.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });
  const ownStopRow = ownStop.rows[0] ?? {};
  const ownStopWrite = ownStop.writes.find((s) => s.kind === 'update')?.values ?? {};

  // A LINKED PLAN — E12's case, and now covered by the same unconditional rule
  // rather than by a branch of its own. A trader who planned WITHOUT a stop
  // planned without one; the broker's number must not make their plan claim
  // something they never typed.
  const linkedPlan = new FakeDb([
    brokerRow({ unplanned: false, link_confirmed_at: '2026-10-19T12:00:00.000Z' }),
  ]);
  await quietImport({
    client: linkedPlan.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });
  const linkedRow = linkedPlan.rows[0] ?? {};
  const linkedWrite = linkedPlan.writes.find((s) => s.kind === 'update')?.values ?? {};

  // A trailing stop moved, and the moves were the server's. The verdict is
  // stored; the attribution is not made.
  const trailing = new FakeDb([brokerRow()]);
  await quietImport({
    client: trailing.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, TRAILING_HISTORY),
  });
  const trailingRow = trailing.rows[0] ?? {};

  // And the empty case: a stop that never moved fills `false`, which is a
  // genuine answer and the one that most needs to be right.
  const kept = new FakeDb([brokerRow()]);
  await quietImport({
    client: kept.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, KEPT_HISTORY),
  });
  const keptRow = kept.rows[0] ?? {};

  group('two columns are filled when empty and NEVER restated', [
    c('(1) a trader who unticked "moved SL" does not find it ticked again',
      [disagreedRow.moved_sl, disagreedRow.kept_sl], [false, true]),
    c('(2) and the broker\'s evidence is still recorded beside their answer',
      (disagreedRow.stop_history as StopHistory)?.verdict, 'moved'),
    c('(3) a stop the trader typed themselves is not replaced',
      [ownStopRow.stop_loss, ownStopRow.take_profit], [29_900, 29_700]),
    c('(3b) and no statement names either column, whatever is in them',
      ['stop_loss', 'take_profit'].filter((column) => column in ownStopWrite), []),

    // E12, now reached by the unconditional rule rather than by a branch.
    c('(4) a LINKED PLAN\'s stop_loss is not filled even though it is NULL',
      [linkedRow.stop_loss, linkedRow.take_profit], [null, null]),
    c('(5) and no statement names either column on it',
      ['stop_loss', 'take_profit'].filter((column) => column in linkedWrite), []),
    c('(6) but the broker columns and the verdict still land on it',
      [(linkedRow.stop_history as StopHistory)?.verdict, linkedRow.broker_stop_loss,
       linkedRow.moved_sl],
      ['moved', 4504, true]),

    // §3's rule, applied to the one case that reaches it in v1.
    c('(7) a TRAILING stop does not claim the trader moved anything',
      ['moved_sl', 'kept_sl'].filter((column) => column in
        (trailing.writes.find((s) => s.kind === 'update')?.values ?? {})), []),
    c('(8) though the history records that it moved, and that it was trailing',
      [(trailingRow.stop_history as StopHistory)?.verdict,
       (trailingRow.stop_history as StopHistory)?.trailing],
      ['moved', true]),

    c('(9) a stop that never moved fills false, not NULL',
      [keptRow.moved_sl, keptRow.kept_sl], [false, true]),
    // The membership rule: none of the four is the broker's to restate, and the
    // two price columns are not the broker's to write at all.
    c('(10) and none of the four is in EXECUTION_FACTS',
      EXECUTION_FACTS_FOR_TEST
        .map(({ column }) => column)
        .filter((column) => ['moved_sl', 'kept_sl', 'stop_loss', 'take_profit'].includes(column)),
      []),
    c('(11) `stop_loss` and `take_profit` are named in NO statement of any run',
      [disagreed, ownStop, linkedPlan, trailing, kept].flatMap((db) =>
        db.writes.flatMap((s) =>
          ['stop_loss', 'take_profit'].filter((column) => column in (s.values ?? {}))
        )
      ), []),
  ]);
}

async function stopCandidateGroup() {
  const flagOff = new FakeDb();
  const offCandidates = await tradesNeedingStopHistory({
    client: flagOff.client(),
    userId: USER,
    trades: [TRADE],
    env: OFF,
  });

  const db = new FakeDb([
    // Already answered on an earlier run of the same day: no request for it.
    { id: 'a', user_id: USER, broker_trade_key: TRADE.brokerTradeKey, stop_history: MOVED_HISTORY, hidden: false },
    // A row the trader deleted. Rule 2 (E12): not touched, not read for.
    { id: 'b', user_id: USER, broker_trade_key: 'demo:hidden', stop_history: null, hidden: true },
    // Imported, never answered. THE candidate.
    { id: 'c', user_id: USER, broker_trade_key: 'demo:88500', stop_history: null, hidden: false },
  ]);
  const hiddenTrade: BrokerTrade = { ...TRADE, brokerTradeKey: 'demo:hidden' };
  const neverSeen: BrokerTrade = { ...TRADE, brokerTradeKey: 'demo:99999' };

  const { result: candidates } = await captureLogs(() =>
    tradesNeedingStopHistory({
      client: db.client(),
      userId: USER,
      // Five trades, and only two of them are worth a request.
      trades: [TRADE, hiddenTrade, SECOND, neverSeen, STILL_OPEN],
      env: ON,
    })
  );

  // A failed read costs the run its annotations and nothing else.
  const broken = {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () =>
            Promise.resolve({ data: null, error: { code: '42703', message: 'undefined column' } }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const { result: afterError, lines: errorLines } = await captureLogs(() =>
    tradesNeedingStopHistory({ client: broken, userId: USER, trades: [TRADE], env: ON })
  );

  group('only the trades that still need an answer cost a request', [
    // Before the select, not after: `stop_history` belongs to migration 038.
    c('(1) the flag off reads NOTHING and asks about nobody',
      [flagOff.statements.length, offCandidates.length], [0, 0]),
    c('(2) a trade that already has a history is not a candidate',
      candidates.some((trade) => trade.brokerTradeKey === TRADE.brokerTradeKey), false),
    c('(3) a hidden row is not a candidate either (E12)',
      candidates.some((trade) => trade.brokerTradeKey === 'demo:hidden'), false),
    c('(4) a row with a NULL history IS one',
      candidates.some((trade) => trade.brokerTradeKey === SECOND.brokerTradeKey), true),
    // The case a `.is('stop_history', null)` predicate would have hidden: a
    // trade with no row yet has no NULL to match, and it is the one that most
    // needs asking about.
    c('(5) and so is a trade the journal has never seen',
      candidates.some((trade) => trade.brokerTradeKey === 'demo:99999'), true),
    c('(6) a position that is not flat is not imported, so it is not asked about',
      candidates.some((trade) => !trade.cycleClosed), false),
    c('(7) two candidates out of five, in one select',
      [candidates.length, db.statements.length], [2, 1]),
    c('(8) a failed read asks about nobody and does not throw', afterError.length, 0),
    c('(9) and logs the SQLSTATE, not the message',
      [errorLines.length, errorLines[0]?.includes('42703'),
       errorLines[0]?.includes('undefined column')],
      [1, true, false]),
  ]);
}

/**
 * THE GROUP THAT KEEPS THE BROKER'S STOP FROM BECOMING A PLAN (REF-113 Stage 3).
 *
 * Decision 4 of 17.10 said to fill `stop_loss`/`take_profit` when they are NULL,
 * and the design report asked for a dedicated test case because the risk was
 * known. This is that test case. It FAILED against the first implementation, in
 * two independent ways, and the decision was reversed rather than labelled
 * around:
 *
 *   1. `tradeScore` paid 30 of 60 planning points for the broker's own
 *      protective order, under a J1 line reading "לא הוגשה תוכנית" — a label
 *      disagreeing with the number beside it — and the total went 40 → 70.
 *   2. The journal's editor recomputes `rr_ratio = calcRR(entry, sl, tp)` on
 *      save from the row's own stop and target, so ONE EDIT on an unplanned row
 *      would mint a ratio the trader never planned and award the remaining 30
 *      points, taking an impulse trade to 100/100.
 *
 * Both are pinned here by their numbers, and both counterfactuals are computed
 * alongside, so the group says what it is preventing rather than only asserting
 * that it does not happen.
 */
async function unplannedScoreGroup() {
  // A real import, with the orders read, of a trade with no plan behind it.
  const db = new FakeDb();
  await quietImport({
    client: db.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, MOVED_HISTORY),
  });
  const row = db.rows[0] ?? {};

  /** The score input exactly as src/app/api/ai-debrief/route.ts builds it. */
  const scoreInputFor = (stored: Row): TradeScoreInput => ({
    stop_loss: stored.stop_loss != null ? (stored.stop_loss as number) : null,
    take_profit: stored.take_profit != null ? (stored.take_profit as number) : null,
    rr_ratio: stored.rr_ratio != null ? (stored.rr_ratio as number) : null,
    required_min_rr: null,
    strategy_conditions_checked: null,
    moved_sl: stored.moved_sl === true,
    exited_early: stored.exited_early === true,
    fomo_entry: stored.fomo_entry === true,
    revenge_trade: stored.revenge_trade === true,
    exit_price: stored.exit_price != null ? (stored.exit_price as number) : null,
    entry_price: stored.entry_price != null ? (stored.entry_price as number) : null,
    direction: (stored.direction as 'long' | 'short' | null) ?? null,
    // J1: the trader confirmed this execution was not planned.
    unplanned: true,
  });

  const scored = computeTradeScore(scoreInputFor(row));

  // The same import, of a trade whose stop never moved. J1's own number, with
  // nothing deducted: the baseline this group is measuring departures from.
  const keptDb = new FakeDb();
  await quietImport({
    client: keptDb.client(),
    userId: USER,
    trades: [TRADE],
    isTradeSource: true,
    env: ON,
    stopHistories: historyFor(TRADE, KEPT_HISTORY),
  });
  const keptScored = computeTradeScore(scoreInputFor(keptDb.rows[0] ?? {}));

  // WHAT THE OLD BEHAVIOUR SCORED, computed here so the regression has a number
  // and not an adjective.
  const asIfFilled = computeTradeScore(
    scoreInputFor({ ...row, stop_loss: 4504, take_profit: 4525 })
  );
  // And what one journal edit then made of it: the editor's own expression, run
  // on a row whose stop and target came from the broker.
  const asIfEdited = computeTradeScore(
    scoreInputFor({
      ...row,
      stop_loss: 4504,
      take_profit: 4525,
      rr_ratio: calcRR(TRADE.entryPrice, 4504, 4525),
    })
  );

  // The editor's recompute, on the row as it is actually stored. `sl` and `tp`
  // are read straight off the row — JournalClient.tsx pre-populates both from it
  // — so with the columns NULL the guard short-circuits and no ratio is minted.
  // This is the expression itself, not a description of it.
  const storedSl = row.stop_loss != null ? (row.stop_loss as number) : null;
  const storedTp = row.take_profit != null ? (row.take_profit as number) : null;
  const mintedOnEdit =
    storedSl !== null && storedTp !== null ? calcRR(TRADE.entryPrice, storedSl, storedTp) : null;

  group('an unplanned broker row scores 0/60 on planning, and keeps scoring it', [
    // THE LOCK.
    c('(1) planning is exactly zero out of sixty',
      [scored.breakdown.planning.score, scored.breakdown.planning.max], [0, 60]),
    c('(2) and the J1 line says so, in one sentence and with no partial credit',
      scored.breakdown.planning.details, ['תכנון 0/60 — לא הוגשה תוכנית']),
    // A stop that never moved scores J1's 40 exactly — planning zero, discipline
    // whole. That is the baseline, and it is unchanged by this stage.
    c('(3) a trade whose stop stayed put scores J1\'s 40, unchanged',
      [keptScored.breakdown.planning.score, keptScored.breakdown.discipline.score,
       keptScored.total],
      [0, 40, 40]),
    // THE ONE DEPARTURE FROM 40, AND IT IS THE POINT OF THE TICKET. This trade's
    // stop WAS moved, the broker saw it, and the discipline block deducts its 12
    // — on evidence, where before REF-113 an absent self-report collected the
    // whole 12 for having nothing against it (tradeScore's own header).
    c('(4) a stop the broker saw move costs 12, and only that 12',
      [scored.breakdown.discipline.score, scored.total], [28, 28]),

    // The regression, by its numbers. Both counterfactuals are computed on THIS
    // row, so they carry the same 12 deduction and the planning delta is the
    // whole of the difference.
    c('(5) filling the trader\'s columns would have paid 30 for a plan that does not exist',
      [asIfFilled.breakdown.planning.score, asIfFilled.total - scored.total], [30, 30]),
    c('(6) and the label would have contradicted its own number',
      asIfFilled.breakdown.planning.details, ['תכנון 30/60 — לא הוגשה תוכנית']),
    c('(7) and one journal edit would then have paid the whole planning block',
      [asIfEdited.breakdown.planning.score, asIfEdited.total - scored.total], [60, 60]),

    // No rr_ratio, and none mintable.
    c('(8) rr_ratio is NULL on the row and is named in no statement',
      [row.rr_ratio ?? null, db.writes.some((s) => 'rr_ratio' in (s.values ?? {}))],
      [null, false]),
    c('(9) the editor\'s own recompute cannot mint one — no legs, no ratio',
      mintedOnEdit, null),
    // The guard is only worth anything if the expression could fire.
    c('(10) and the expression DOES fire when the legs are a trader\'s own',
      calcRR(TRADE.entryPrice, 29_900, 29_700) > 0, true),

    // The broker's numbers are not lost — they are in the columns 038 added for
    // them, which nothing scores. That is the whole reason those columns exist.
    c('(11) the measured prices are still recorded, where nothing scores them',
      [row.broker_stop_loss, row.broker_take_profit], [4504, 4525]),
    c('(12) and the evidence is whole',
      (row.stop_history as StopHistory)?.initialStop, 4504),
    // `moved_sl` is the one column whose score effect is an improvement in both
    // directions: an absent self-report already collected the whole 12 points
    // for having no evidence against it, so this deducts ON EVIDENCE instead.
    c('(13) the stop the broker SAW being moved costs discipline, on evidence',
      [row.moved_sl, scored.breakdown.discipline.details.includes('הוזז Stop Loss (0/12)')],
      [true, true]),
  ]);
}

/**
 * proposeFlags/reachedStop — reported, and pinned where it is already safe.
 *
 * MEASURED RATHER THAN ASSUMED, because this is the one of the three concerns
 * that turned out NOT to be broken, and a group that only said so in prose would
 * not notice the day it became broken. Two independent reasons, the first
 * sufficient on its own:
 *
 *   - `proposeFlags(plan, facts)` reads the STOP OFF THE PLAN, and the plan is
 *     always one of `planCandidates(...)` — which requires `source === 'manual'`
 *     and `status === 'open'`. A broker row is `'tradovate'` and `'closed'`, so
 *     it can never arrive as the `plan` argument.
 *   - `facts` carries direction, entry, exit and quantity. It has never carried
 *     a stop, so nothing the broker writes reaches `reachedStop` through it.
 *
 * So no discipline flag was ever proposed off a broker figure, and `followed_plan`
 * is simply not offered for a plan with no stop. If a later change puts a broker
 * row into the candidate pool, (1) fails.
 */
function proposeFlagsBoundaryGroup() {
  const brokerRow = {
    id: 'broker-1',
    status: 'closed',
    source: 'tradovate',
    hidden: false,
    submitted_at: new Date(OPENED - 60_000).toISOString(),
    direction: 'short' as const,
    symbol: SYMBOL,
    // What the first implementation would have written here.
    stop_loss: 4504,
    take_profit: 4525,
    link_confirmed_at: null,
  };
  const manualPlan = { ...brokerRow, id: 'plan-1', source: 'manual', status: 'open' };

  const candidates = planCandidates({
    trade: { openedAtMs: OPENED, direction: 'short', symbol: SYMBOL },
    plans: [brokerRow, manualPlan] as unknown as CandidatePlan[],
    nowMs: CLOSED + 60_000,
  });

  const facts = {
    direction: 'short' as const,
    entry_price: ENTRY,
    exit_price: EXIT,
    quantity: 2,
  };

  // A plan with no stop and no target: the two flags that need them are not
  // offered at all. There is no "unknown" checkbox, by §E's decision.
  const bare = proposeFlags(
    { entry_price: ENTRY, stop_loss: null, take_profit: null, units: 2 },
    facts
  );
  // A plan the trader DID write a stop on, so the group cannot pass by
  // proposeFlags never proposing anything.
  const planned = proposeFlags(
    { entry_price: ENTRY, stop_loss: 29_900, take_profit: 29_700, units: 2 },
    facts
  );

  group('a broker figure never reaches proposeFlags or reachedStop', [
    c('(1) a broker row is not a candidate plan — closed, and not manual',
      candidates.map((plan) => plan.id), ['plan-1']),
    c('(2) the executed facts carry no stop, so reachedStop cannot see one',
      Object.keys(facts).sort(), ['direction', 'entry_price', 'exit_price', 'quantity']),
    c('(3) a plan with no stop is offered neither exited_early nor followed_plan',
      bare.map((proposal) => proposal.column), ['proper_size']),
    c('(4) and a plan that HAS one is offered both — so (3) is not vacuous',
      planned.map((proposal) => proposal.column).sort(),
      ['exited_early', 'followed_plan', 'proper_size']),
  ]);
}

function stopTriggerGroup() {
  const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

  const sync = source('src/lib/tradovate/sync.ts');
  const syncRoute = source('src/app/api/tradovate/sync/route.ts');
  const alerts = source('src/app/api/cron/send-alerts/route.ts');
  const nightly = source('src/lib/tradovate/import-cron.ts');
  const today = source('src/app/api/tradovate/today/route.ts');
  const ordersCron = source('src/lib/tradovate/orders-cron.ts');
  const live = source('src/app/api/tradovate/live/route.ts');
  const vercel = JSON.parse(source('vercel.json')) as {
    crons: { path: string; schedule: string }[];
  };
  const schedulesFor = (routePath: string) =>
    vercel.crons.filter((entry) => entry.path === routePath).map((entry) => entry.schedule);

  // A source-level group, for a claim about calls that are NOT made. The same
  // shape accounts-check.ts uses for the AI routes, and for the same reason: no
  // stub can prove the nightly cron never asks, because the proof is that the
  // parameter is absent from the call.
  group('only the triggers that can see the orders ask for them', [
    c('(1) the Sync button asks', syncRoute.includes('readStops: true'), true),
    c('(2) the end-of-day summary asks', alerts.includes('readStops: true'), true),
    // The import cron still does not ask, and the reason changed with REF-117
    // Stage 2b. It used to be "03:30 UTC is hours after the roll, so
    // `/order/list` cannot answer"; now the job runs at 20:00 UTC, BEFORE the
    // roll, so it could. It still must not: the stop read is 7-9 requests per
    // trader and /api/cron/tradovate-orders at 21:30 already makes them, closer
    // to the deadline and for exactly that purpose. Two jobs asking would double
    // the most request-hungry work in the product for one answer.
    c('(3) the import cron does NOT', nightly.includes('readStops'), false),
    // E9's free trigger stays free: it is on the critical path of opening the
    // trade form.
    c('(4) /api/tradovate/today does not read orders at all',
      [today.includes('readStopHistories'), today.includes('stopHistories')], [false, false]),
    c('(5) and the default is off, so a new caller cannot opt in by accident',
      sync.includes('readStops = false'), true),
    // The grep is only worth anything if it could fire.
    c('(6) and the needle is a real one', sync.includes('readStops'), true),

    // ── Stage 4 — the two triggers that do not need the trader ──────────────
    c('(7) the dedicated cron asks', ordersCron.includes('readStops: true'), true),
    // THE HOUR IS THE FEATURE. Anything else and the job is either before the
    // American session closes or after Tradovate has cleared `/order/list`.
    c('(8) and it is scheduled at 21:30 UTC, once',
      schedulesFor('/api/cron/tradovate-orders'), ['30 21 * * *']),
    // (9) REWRITTEN ON PURPOSE (REF-117 Stage 2b). This pinned `['30 3 * * *']`
    // and its comment read "which is not the nightly import's slot" — true, and
    // it was asserting the wrong property. 03:30 UTC is 22:30 CT, five and a
    // half hours PAST the 17:00 CT roll, and REF-117 Stage 0 measured
    // /fill/list, /fillPair/list and /position/list all at `depthDays = 0`. So
    // the import cron ran every night against three empty lists and imported
    // nothing, for the same reason this suite already knew it could not read
    // orders. The fills do not survive the roll either; that was an assumption.
    //
    // What matters about the hour is therefore not "a different slot from the
    // stop cron" but BEFORE THE ROLL, so that is what these two assert.
    c('(9) the import cron runs at 20:00 UTC, once',
      schedulesFor('/api/cron/tradovate-import'), ['0 20 * * *']),
    // 20:00 UTC is 15:00 CDT / 14:00 CST and 21:30 UTC is 16:30 / 15:30, so
    // both are before the 17:00 CT roll in both DST regimes, and the cheaper
    // job runs first. A schedule that put either one after the roll would be
    // importing empty responses, which is the bug Stage 2b fixed.
    c('(9b) both broker crons are before the 17:00 CT roll, import first',
      [
        ...schedulesFor('/api/cron/tradovate-import'),
        ...schedulesFor('/api/cron/tradovate-orders'),
      ].map((schedule) => {
        const [minute, hour] = schedule.split(' ');
        const utcMinutes = Number(hour) * 60 + Number(minute);
        // The roll in UTC: 17:00 CT is 22:00 in summer (CDT) and 23:00 in
        // winter (CST), so the summer figure is the binding one.
        return utcMinutes < 22 * 60;
      }),
      [true, true]),
    c('(10) the flat-transition trigger asks too', live.includes('readStops: true'), true),
    // The live route is polled 240 times an hour. If it captured on every poll
    // rather than on a transition, that is the shape it would have.
    c('(11) and it is a transition rather than a poll',
      live.includes('wentFlat'), true),
    // A day whose orders are already gone is not worth a second day of pricing,
    // and a window that cannot cross the roll would say nothing about the hours
    // just after it. See the constant.
    c('(12) the cron reaches one day back and no further',
      ORDERS_LOOKBACK_MS, 24 * 60 * 60_000),
  ]);
}

// ── REF-113 Stage 5: the reading, the score, the rule and the sentence ──────
//
// Four groups over one document. The reader is pure and browser-safe, which is
// what lets the trade card, the link panel, the rule engine and the debrief
// prompt all branch on the same four answers — and what makes every assertion
// below a plain function call.
//
// THE PROPERTY THEY ALL EXIST FOR: `'unknown'` must not read like `'kept'`. A
// trader told "the stop was not moved" on the strength of a read that failed
// has been handed a claim about their own discipline made out of our missing
// data, and that is the failure this ticket was opened for.

/** A stored document, with the measured 19.10 numbers as the default. */
function stopDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'moved',
    reason: null,
    initialStop: 29_671.25,
    initialStopSide: 'risk',
    finalStop: 29_681.5,
    initialTarget: 29_790,
    movedCount: 2,
    direction: 'mixed',
    movedAtMs: null,
    trailing: false,
    noStopPlaced: false,
    source: 'linked',
    versions: [{ stopPrice: 29_671.25 }],
    preFillVersions: 2,
    anchoredAtFill: true,
    otherTargets: [],
    ...over,
  };
}

const sentenceOf = (value: unknown): string | null =>
  stopMoveSentence(readStopHistory(value))?.text ?? null;
const toneOf = (value: unknown): string | null =>
  stopMoveSentence(readStopHistory(value))?.tone ?? null;

function stopSentenceGroup() {
  const tightened = stopDoc({ direction: 'tightened', movedCount: 1, finalStop: 29_690 });
  const widened = stopDoc({ direction: 'widened', movedCount: 1, finalStop: 29_651.25 });

  group('the four answers about a stop are four different sentences', [
    // NULL IS THE ONE THAT MUST SAY NOTHING. A reader that renders a label with
    // a dash for it is announcing a feature on every manual trade ever logged.
    c('(1) no document shows nothing at all', [
      sentenceOf(null),
      sentenceOf(undefined),
      sentenceOf({}),
      sentenceOf('not a document'),
      sentenceOf([]),
    ], [null, null, null, null, null]),

    // THE PAIR THAT MATTERS. Different words, so one cannot be read as the
    // other.
    c('(2) kept and unknown do not say the same thing', [
      sentenceOf(stopDoc({ verdict: 'kept', movedCount: 0, direction: null })),
      sentenceOf(stopDoc({ verdict: 'unknown', reason: 'interday', movedCount: 0, direction: null })),
    ], ['הסטופ לא הוזז', 'לא הצלחנו לקרוא את פקודות הסטופ']),
    c('(3) and "no stop at all" is a third thing, and a warning',
      [sentenceOf(stopDoc({ verdict: 'none', movedCount: 0, direction: null })),
       toneOf(stopDoc({ verdict: 'none', movedCount: 0, direction: null }))],
      ['לא הוצב סטופ בעסקה הזו', 'warning']),

    // TIGHTENING IS NEUTRAL AND WIDENING IS A WARNING (Imri, 19.10).
    c('(4) a tightening is a fact, with the range',
      sentenceOf(tightened), 'הסטופ הודק לכיוון הרווח (מ-29671.25 ל-29690.00)'),
    c('(5) and it is not coloured as a failing', toneOf(tightened), 'neutral'),
    c('(6) a widening says the risk grew, and warns',
      [sentenceOf(widened), toneOf(widened)],
      ['הסטופ הורחק מנקודת הכניסה — הסיכון גדל (מ-29671.25 ל-29651.25)', 'warning']),
    // The measured trade. Two prices cannot describe a stop that went both
    // ways, so this one counts instead.
    c('(7) mixed counts the moves rather than quoting two prices',
      [sentenceOf(stopDoc()), toneOf(stopDoc())],
      ['הסטופ הוזז 2 פעמים — גם הורחק וגם הודק', 'warning']),

    // A trailing stop's steps are the SERVER'S, and `moved_sl` is deliberately
    // not written for one either (lib/tradovate/import.ts).
    c('(8) a trailing stop is not described as the trader moving it',
      sentenceOf(stopDoc({ trailing: true })), 'סטופ נגרר אוטומטית'),

    // THE 19.10 DEFECT, AS A RENDERING RULE. A long stored an initial stop 148
    // ticks ABOVE its entry; this panel is where that number would have been
    // printed beside the stop the trader typed.
    c('(9) a wrong-side stop still gets a sentence, with NO prices in it',
      sentenceOf(stopDoc({ direction: 'widened', movedCount: 1, initialStopSide: 'wrong' })),
      'הסטופ הורחק מנקודת הכניסה — הסיכון גדל'),
    c('(10) and no price is offered for it',
      brokerStopToShow(readStopHistory(stopDoc({ initialStopSide: 'wrong' })), 29_671.25), null),
    c('(11) nor for a trade that had no stop',
      brokerStopToShow(readStopHistory(stopDoc({ verdict: 'none' })), 29_671.25), null),
    c('(12) nor when there is no document',
      brokerStopToShow(null, 29_671.25), null),
    c('(13) but a readable one is offered, from the column',
      brokerStopToShow(readStopHistory(stopDoc()), 29_671.25), 29_671.25),

    // PostgREST returns NUMERIC as a STRING, and these prices came back through
    // it. A `typeof value === 'number'` guard would silently lose the range.
    c('(14) a price that arrives as a string still reads as a number',
      sentenceOf(stopDoc({
        direction: 'tightened', movedCount: 1,
        initialStop: '29671.25', finalStop: '29690',
      })),
      'הסטופ הודק לכיוון הרווח (מ-29671.25 ל-29690.00)'),
    c('(15) and the column arriving as a string is still a price',
      brokerStopToShow(readStopHistory(stopDoc()), '29671.25'), 29_671.25),

    // A document whose verdict cannot be read is one whose other fields we have
    // no reason to trust either.
    c('(16) an unrecognised verdict is no document',
      sentenceOf(stopDoc({ verdict: 'probably' })), null),
    // The two directions a rule and the score both read.
    c('(17) widened and mixed are both "a widening happened"', [
      stopWasWidened(stopDoc({ direction: 'widened' })),
      stopWasWidened(stopDoc({ direction: 'mixed' })),
      stopWasWidened(stopDoc({ direction: 'tightened' })),
      stopWasWidened(null),
    ], [true, true, false, false]),
  ]);
}

function stopScoreGroup() {
  // A closed manual trade with a plan, scoring 100 before any stop moved.
  const BASE: TradeScoreInput = {
    stop_loss: 29_650,
    take_profit: 29_900,
    rr_ratio: 2.5,
    required_min_rr: 2,
    strategy_conditions_checked: null,
    moved_sl: false,
    exited_early: false,
    fomo_entry: false,
    revenge_trade: false,
    exit_price: 29_800,
    entry_price: 29_704,
    direction: 'long',
  };

  const untouched = computeTradeScore(BASE);
  // The behaviour before this stage, which EVERY manual close and every broker
  // row from before Stage 3 still gets: one boolean, twelve points.
  const movedNoDocument = computeTradeScore({ ...BASE, moved_sl: true });
  const tightened = computeTradeScore({ ...BASE, moved_sl: true, stopDirection: 'tightened' });
  const widened = computeTradeScore({ ...BASE, moved_sl: true, stopDirection: 'widened' });
  const mixed = computeTradeScore({ ...BASE, moved_sl: true, stopDirection: 'mixed' });
  // A document saying "tightened" on a row whose column says the stop never
  // moved. The column is checked first, so there is nothing for the document
  // to decide.
  const notMovedButTightened = computeTradeScore({ ...BASE, stopDirection: 'tightened' });

  const disciplineOf = (r: ReturnType<typeof computeTradeScore>) => r.breakdown.discipline.score;
  const stopLine = (r: ReturnType<typeof computeTradeScore>) => r.breakdown.discipline.details[0];

  group('a tightening does not cost twelve points, and a widening does', [
    c('(1) an untouched stop is 40/40 on discipline and 100 overall',
      [disciplineOf(untouched), untouched.total], [40, 100]),
    // THE NUMBERS, SO THE DECISION IS LOCKED AND NOT DESCRIBED.
    c('(2) a tightening keeps the twelve',
      [disciplineOf(tightened), tightened.total], [40, 100]),
    c('(3) a widening loses them', [disciplineOf(widened), widened.total], [28, 88]),
    // Mixed means at least one step widened, and the first step is the one that
    // mattered.
    c('(4) and so does mixed', [disciplineOf(mixed), mixed.total], [28, 88]),
    // UNCHANGED BEHAVIOUR FOR EVERY ROW WITH NO DOCUMENT. There is no backfill
    // and there cannot be one, so this is most of the table forever.
    c('(5) a move with no document still costs twelve, exactly as before',
      [disciplineOf(movedNoDocument), movedNoDocument.total], [28, 88]),
    c('(6) and `moved_sl === false` makes the document irrelevant',
      [disciplineOf(notMovedButTightened), notMovedButTightened.total], [40, 100]),

    // The number is only half of it: a trader reading "+12" beside "הוזז Stop
    // Loss" would be reading a contradiction.
    c('(7) the tightening line says why the points were kept',
      stopLine(tightened), 'הסטופ הודק לכיוון הרווח — לא נחשב הפרת משמעת (+12)'),
    c('(8) the widening line says why they were not',
      stopLine(widened), 'הסטופ הורחק מנקודת הכניסה — הסיכון גדל (0/12)'),
    c('(9) the undocumented move keeps the sentence it always had',
      stopLine(movedNoDocument), 'הוזז Stop Loss (0/12)'),
    c('(10) and an untouched stop keeps its own',
      stopLine(untouched), 'לא הוזז Stop Loss (+12)'),

    // The reader and the score must agree about which directions are a
    // widening, or a trader sees a warning beside a full twelve points.
    c('(11) the score and the sentence agree about the two directions', [
      disciplineOf(computeTradeScore({
        ...BASE, moved_sl: true, stopDirection: stopDirectionOf(stopDoc({ direction: 'tightened' })),
      })),
      disciplineOf(computeTradeScore({
        ...BASE, moved_sl: true, stopDirection: stopDirectionOf(stopDoc({ direction: 'widened' })),
      })),
    ], [40, 28]),
  ]);
}

function stopRuleGroup() {
  const rule = (condition_type: ConditionType): CustomRule => ({
    id: 'r1',
    user_id: USER,
    name: describeCustomRule({ condition_type, threshold_value: null }),
    is_active: true,
    condition_type,
    threshold_value: null,
    action_type: 'block_day',
    cooldown_minutes: null,
    created_at: new Date().toISOString(),
  });

  const ctx = (over: Partial<CustomRuleCheckContext> = {}): CustomRuleCheckContext => ({
    todayLossAmount: 0,
    todayLossPercent: null,
    todayTradeCount: 1,
    lossStreak: 0,
    currentHour: 12,
    lastTradeFomo: false,
    lastTradeExitedEarly: false,
    lastTradeMovedSl: false,
    ...over,
  });

  const broad = rule('moved_sl_last_trade');
  const narrow = rule('moved_sl_widened_last_trade');

  // A tightening: the column says the stop moved, the document says which way.
  const tightening = ctx({ lastTradeMovedSl: true, lastTradeStopWidened: false });
  const widening = ctx({ lastTradeMovedSl: true, lastTradeStopWidened: true });
  // A trader who unticked the box on a trade the broker says widened. The two
  // inputs are independent on purpose — see the field.
  const disputed = ctx({ lastTradeMovedSl: false, lastTradeStopWidened: true });

  group('the widened-only rule is an option, and the default did not move', [
    // THE EXISTING RULE IS UNCHANGED. A trader who created it asked for every
    // move, in those words, and it can be `block_day`.
    c('(1) the broad condition still fires on a tightening',
      evaluateCustomRuleCondition(broad, tightening), true),
    c('(2) and on a widening', evaluateCustomRuleCondition(broad, widening), true),
    c('(3) and not when nothing moved', evaluateCustomRuleCondition(broad, ctx()), false),

    c('(4) the narrow one does NOT fire on a tightening',
      evaluateCustomRuleCondition(narrow, tightening), false),
    c('(5) it fires on a widening', evaluateCustomRuleCondition(narrow, widening), true),
    // Independent inputs: the self-report is the trader's and this is the
    // broker's evidence.
    c('(6) and on a widening the trader unticked',
      evaluateCustomRuleCondition(narrow, disputed), true),

    // ABSENT IS FALSE, which is the permissive direction. A wrong `true` on a
    // `block_day` rule locks a trader out over something they did not do.
    c('(7) absent evidence does not fire — a manual close, or no migration 038',
      evaluateCustomRuleCondition(narrow, ctx({ lastTradeMovedSl: true })), false),

    // The editor builds its dropdown from Object.keys(CONDITION_LABELS), so an
    // entry there is creatable; a threshold box on a yes/no condition is not.
    c('(8) it is offered in the editor and needs no threshold',
      [narrow.condition_type in CONDITION_LABELS, conditionNeedsThreshold('moved_sl_widened_last_trade')],
      [true, false]),
    // RulesEditor SAVES this string into `custom_rules.name`, so the broad
    // one's description must not move — only the dropdown label did.
    c('(9) the two rules describe themselves differently', [
      describeCustomRule({ condition_type: 'moved_sl_last_trade', threshold_value: null }),
      describeCustomRule({ condition_type: 'moved_sl_widened_last_trade', threshold_value: null }),
    ], [
      'הזזתי Stop Loss בעסקה האחרונה',
      'הרחקתי את ה-Stop Loss מנקודת הכניסה בעסקה האחרונה',
    ]),
    // The CHECK is extended by migration 039 step 1 and nothing in the repo
    // runs it. Without that file a rule saved with this condition is a 23514 —
    // loud, and for one person.
    c('(10) and the migration that lets it be stored exists',
      fs.existsSync(path.join(process.cwd(), 'supabase/migrations/039_stop_direction.sql')), true),
  ]);
}

function stopFlagProposalGroup() {
  const offered = (doc: unknown) => proposeStopMoveFlag(doc);

  const mixed = offered(stopDoc());
  const tightened = offered(stopDoc({ direction: 'tightened', movedCount: 1, finalStop: 29_690 }));
  const kept = offered(stopDoc({ verdict: 'kept', movedCount: 0, direction: null }));

  group('the confirmation screen can finally propose moved_sl', [
    // The note at the head of `proposeFlags` said these were absent because
    // "the order history is not in the pull at all, which is REF-113". It is.
    c('(1) a move is proposed, as the fact it is',
      [mixed?.column, mixed?.value], ['moved_sl', true]),
    c('(2) a stop that was never moved is proposed as false',
      [kept?.column, kept?.value], ['moved_sl', false]),

    // THE PRODUCT DECISION: `moved_sl` is a fact and stays true for a
    // tightening. What changes is the sentence and the colour.
    c('(3) a tightening is still a move', tightened?.value, true),
    c('(4) but it is not flagged as a failing', tightened?.tone, 'neutral'),
    c('(5) while a widening is', offered(stopDoc({ direction: 'widened', movedCount: 1 }))?.tone, 'warning'),
    c('(6) and the reason quotes the broker rather than asserting it',
      tightened?.reason, 'לפי פקודות הברוקר: הסטופ הודק לכיוון הרווח (מ-29671.25 ל-29690.00)'),

    // NO "UNKNOWN" CHECKBOX — §E's rule, restated. Offering an unchecked box
    // with "we could not tell" invites the trader to confirm a false that means
    // nothing.
    c('(7) nothing is proposed when we could not tell', [
      offered(null),
      offered(undefined),
      offered(stopDoc({ verdict: 'unknown', reason: 'interday' })),
    ], [null, null, null]),
    // `'none'` would be `moved_sl = false`, which is TRUE and completely
    // misleading: it reads as "I held my stop" about a trade that never had one.
    c('(8) and nothing for a trade with no stop at all',
      offered(stopDoc({ verdict: 'none', movedCount: 0, direction: null })), null),
    // The steps were the server's. The import declines to write `moved_sl` for
    // a trailing stop and so does this.
    c('(9) nor for a trailing stop', offered(stopDoc({ trailing: true })), null),

    // The proposal is written onto the PLAN by `confirmLink`, which is what
    // survives `link_broker_trade` deleting the broker row. Migration 039 step
    // 2 is what carries the rest.
    c('(10) the column it writes is one the link cannot lose',
      mixed?.column, 'moved_sl'),
  ]);
}

async function ordersCronGroup() {
  const SECRET = 'cron-secret-for-the-test';
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  const previousFlag = process.env[IMPORT_FLAG];
  delete process.env[IMPORT_FLAG];

  const url = 'https://example.test/api/cron/tradovate-orders';
  const noAuth = await cronOrders(new Request(url));
  const wrongAuth = await cronOrders(
    new Request(url, { headers: { authorization: 'Bearer not-the-secret' } })
  );
  const authed = await cronOrders(
    new Request(url, { headers: { authorization: `Bearer ${SECRET}` } })
  );
  const authedBody = await authed.json();

  // With no secret configured at all, fail-closed: a correct-looking header
  // must not be accepted. This route holds the service-role client.
  delete process.env.CRON_SECRET;
  const unconfigured = await cronOrders(
    new Request(url, { headers: { authorization: 'Bearer ' } })
  );

  process.env.CRON_SECRET = previous;
  if (previousFlag === undefined) delete process.env[IMPORT_FLAG];
  else process.env[IMPORT_FLAG] = previousFlag;

  // The loop with the flag off: it must not even LIST, because `is_trade_source`
  // is a column 034 adds and `stop_history` one that 038 adds. The admin client
  // throws, so a read would surface as an exception.
  const throwingAdmin = {
    from() {
      throw new Error('the orders cron must not read anything with the flag off');
    },
  } as unknown as SupabaseClient;
  const { result: offRun } = await captureLogs(() =>
    runStopCapture({ admin: throwingAdmin, env: OFF })
  );

  group('the orders cron refuses an unauthorized caller', [
    c('(1) no Authorization header: 401', noAuth.status, 401),
    c('(2) wrong secret: 401', wrongAuth.status, 401),
    c('(3) and the 401 body is empty', await noAuth.text(), ''),
    c('(4) an unset CRON_SECRET rejects even a well-formed header', unconfigured.status, 401),
    c('(5) the right secret gets in', authed.status, 200),
    c('(6) and with the flag off it reports ran=false',
      [authedBody.ok, authedBody.ran, authedBody.reason], [true, false, 'import_disabled']),
    c('(7) the loop reads NOTHING with the flag off',
      [offRun.found, offRun.attempted, offRun.imported], [0, 0, 0]),
  ]);
}

async function ordersCronWindowGroup() {
  // Two connections, both allowlisted, one of which declined to be a trade
  // source. The pull is a stub, so this group is about WHAT THE LOOP ASKS FOR
  // rather than about a broker.
  const admin = {
    from: (table: string) => {
      if (table !== 'tradovate_connections') throw new Error(`unexpected table ${table}`);
      const rows = [
        { user_id: USER, is_trade_source: true },
        { user_id: OTHER_USER, is_trade_source: false },
      ];
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        returns: () => q,
        then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;

  const NOW = Date.parse('2026-10-19T21:30:00.000Z');
  const asked: Parameters<typeof syncUserTrades>[0][] = [];
  const stubSync = (async (request) => {
    asked.push(request);
    return {
      counts: {
        ...EMPTY_COUNTS,
        ran: true,
        offered: 1,
        updated: 1,
        skippedOpen: 2,
      },
      accounts: EMPTY_ACCOUNT_COUNTS,
      asOf: new Date(NOW).toISOString(),
      isTradeSource: true,
      importEnabled: true,
    };
  }) as typeof syncUserTrades;

  const { result: run, lines } = await captureLogs(() =>
    runStopCapture({
      admin,
      now: NOW,
      env: {
        [IMPORT_FLAG]: '1',
        TRADOVATE_OAUTH_ALLOWED_USER_IDS: `${USER},${OTHER_USER}`,
      } as unknown as NodeJS.ProcessEnv,
      sync: stubSync,
    })
  );

  const only = asked[0];
  const windowStart = only ? new Date(only.windowStartMs).toISOString() : null;
  const line = lines.find((entry) => entry.includes('[tradovate][orders-cron]')) ?? '';

  group('the orders cron asks for the trading day that is about to roll', [
    c('(1) both connections found, one attempted', [run.found, run.attempted], [2, 1]),
    // E7 is read off the row already in hand, so the declining user costs no
    // pull at all.
    c('(2) the declining user was skipped before the pull',
      [run.skippedUsers, asked.length], [1, 1]),
    c('(3) and it asked for the orders', only?.readStops, true),
    // 21:30 UTC minus 24h. The trading day began at 22:00 (summer) or 23:00
    // (winter) UTC the previous calendar day, so this covers all of it — and
    // reaches 30-90 minutes past the roll, where the honest answer is
    // 'interday'. See ORDERS_LOOKBACK_MS.
    c('(4) the window is one day, ending now', windowStart, '2026-10-18T21:30:00.000Z'),
    c('(5) and it starts BEFORE the earliest possible roll of this trading day',
      only !== undefined && only.windowStartMs < Date.parse('2026-10-18T22:00:00.000Z'), true),
    c('(6) the day boundary is UTC midnight, like the nightly job',
      only ? new Date(only.dayStartMs).toISOString() : null, '2026-10-19T00:00:00.000Z'),
    c('(7) the counts are totalled', [run.updated, run.skippedOpen], [1, 2]),
    // THE NUMBER TO WATCH. A trader still holding at 21:30 has every earlier
    // trade on that contract dropped before an order is read.
    c('(8) and skippedOpen is in the log line', line.includes('skippedOpen=2'), true),
    // Counts only. A nightly job over every connected trader is the wrong place
    // to start writing identifiers into Vercel's logs.
    c('(9) with no user id in it', line.includes(USER), false),
  ]);
}

async function main() {
  await flagGroup();
  await firstImportGroup();
  await idempotenceGroup();
  await intentSurvivesGroup();
  await openPositionGroup();
  await hiddenGroup();
  await ownershipGroup();
  await privacyGroup();
  await countRuleGroup();
  await wireGroup();
  await cronGroup();
  await cronSkipGroup();

  // Stage 2.5 — the sync button's half.
  await syncRouteGroup();
  await syncDisabledGroup();
  await syncResponseGroup();
  await syncCopyGroup();
  await syncThrottleGroup();
  await syncPrivacyGroup();

  // Stage 3a — the debrief's storage and the alert emails.
  await debriefReaderGroup();
  await debriefDedupeGroup();
  await debriefRouteGroup();
  await alertSummaryGroup();
  await alertWindowGroup();
  await alertImportGroup();

  // Stage 3b — the matcher, the merge, the counter and the debrief gate.
  await matchRuleGroup();
  // REF-107 — the two sides of a symbol, and the micro table between them.
  await symbolRootGroup();
  await microMiniGroup();
  await continuousContractGroup();
  await linkWriteGroup();
  await linkCountGroup();
  await debriefGateGroup();
  await confirmScreenGroup();
  await unlinkGroup();
  await todayPanelGroup();

  // REF-110 Stages 1-2 — the accounts pass and the account a trade carries.
  await accountRecordGroup();
  await accountBoundaryGroup();
  await accountClosureGroup();
  await accountStampGroup();

  // REF-113 Stage 3 — the broker's stop, written.
  await stopHistoryGroup();
  await stopNotDeletedGroup();
  await stopSelfReportGroup();
  await stopCandidateGroup();
  await unplannedScoreGroup();
  proposeFlagsBoundaryGroup();
  stopTriggerGroup();

  // REF-113 Stage 4 — the two triggers that do not need the trader.
  await ordersCronGroup();
  await ordersCronWindowGroup();

  // REF-113 Stage 5 — the reading, the score, the rule and the sentence.
  stopSentenceGroup();
  stopScoreGroup();
  stopRuleGroup();
  stopFlagProposalGroup();

  // J1 — the unplanned row's score (REF-107 Stage 3b follow-up).
  scoringGroup();

  console.log('');
  if (failures.length > 0) {
    console.log(`${failures.length} failing assertion(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('All groups passed.');
}

// ── J1: a trade with no plan scores zero on planning ───────────────────────
//
// REVERSED ON 18.10, and the reversal is the product decision rather than an
// implementation one. The first version skipped the planning block for a
// declined broker row and normalised over what remained, so a cleanly
// executed unplanned trade scored 100. The decision went the other way:
//
//   ENTERING WITHOUT A PLAN IS THE DISCIPLINE FAILURE THIS PRODUCT MEASURES.
//   A scale that normalises it away says an impulse trade executed tidily is
//   a 100, which is the opposite of what Reflect exists to tell a trader.
//
// So the scoring is exactly what it was before J1, and what survives is the
// one part that was right: the trader is told WHY, in one line, instead of
// being shown three itemised zeros for fields that were never going to be
// filled. These groups pin both halves — the numbers, and the sentence.

/** A fully planned manual trade, clean on every discipline flag. */
const PLANNED: TradeScoreInput = {
  stop_loss: 4990,
  take_profit: 5020,
  rr_ratio: 3,
  required_min_rr: null,
  strategy_conditions_checked: null,
  moved_sl: false,
  exited_early: false,
  fomo_entry: false,
  revenge_trade: false,
  exit_price: 5010,
  entry_price: 5000,
  direction: 'long',
};

/** The declined broker row: no intent at all, and the flags all clean. */
const DECLINED: TradeScoreInput = {
  ...PLANNED,
  stop_loss: null,
  take_profit: null,
  rr_ratio: null,
  unplanned: true,
};

function scoringGroup() {
  const planned = computeTradeScore(PLANNED);
  const emptyForm = computeTradeScore({ ...PLANNED, stop_loss: null, take_profit: null, rr_ratio: null });
  const withConditions = computeTradeScore({
    ...PLANNED,
    strategy_conditions_checked: [
      { condition: 'a', checked: true },
      { condition: 'b', checked: true },
      { condition: 'c', checked: false },
      { condition: 'd', checked: false },
    ],
    moved_sl: true,
  });
  const sloppy = computeTradeScore({ ...PLANNED, fomo_entry: true, revenge_trade: true });

  const sumsToBlocks = (r: ReturnType<typeof computeTradeScore>) =>
    r.total === r.breakdown.planning.score + r.breakdown.strategyAdherence.score + r.breakdown.discipline.score;

  group('J1: a manual or linked trade scores exactly as it always has', [
    c('(1) a fully planned clean trade', planned.total, 100),
    c('(2) an empty form loses the planning points', emptyForm.total, 40),
    c('(3) strategy conditions redistribute the maxima', withConditions.total, 73),
    c('(4) and the discipline flags cost what they cost', sloppy.total, 84),
    // The total IS the sum of the blocks — no normalisation anywhere.
    c('(5) every total is the sum of its three blocks',
      [planned, emptyForm, withConditions, sloppy].every(sumsToBlocks), true),
    c('(6) planning is measured out of 60 when there are no entry conditions',
      emptyForm.breakdown.planning.max, 60),
  ]);

  const declined = computeTradeScore(DECLINED);
  const declinedSloppy = computeTradeScore({ ...DECLINED, moved_sl: true, fomo_entry: true });

  group('J1: a trade with no plan is scored on the same 100-point scale', [
    // THE REVERSAL. 100 under the first version; 40 now, and 40 is the point.
    c('(1) planning scores zero out of sixty',
      [declined.breakdown.planning.score, declined.breakdown.planning.max], [0, 60]),
    c('(2) discipline is awarded as computed', declined.breakdown.discipline.score, 40),
    c('(3) so the trade scores 40, not 100', declined.total, 40),
    c('(4) and the total is still the sum of its blocks', sumsToBlocks(declined), true),

    // A badly executed unplanned trade scores lower still — discipline is
    // the only block it can lose further.
    c('(5) moving a stop and a FOMO entry cost on top', declinedSloppy.total, 20),

    // WHAT SURVIVED THE REVERSAL: the reason, in one line, instead of three
    // complaints about fields that were never going to be filled.
    c('(6) the planning details are one line naming the reason',
      declined.breakdown.planning.details, ['תכנון 0/60 — לא הוגשה תוכנית']),
    c('(7) and not the three itemised zeros',
      declined.breakdown.planning.details.some((d) => d.includes('לא הוגדר Stop Loss')), false),
    // A planned row keeps its itemised lines — the one-liner is for the row
    // that could not have had them.
    c('(8) a planned trade still gets its itemised planning lines',
      planned.breakdown.planning.details.length, 3),
    // An EMPTY MANUAL FORM is not the unplanned case: the trader had the
    // form and left it blank, so they are shown which fields they skipped.
    c('(9) an empty manual form is still itemised',
      emptyForm.breakdown.planning.details.some((d) => d.includes('לא הוגדר Stop Loss')), true),
    c('(10) and scores the same 40 by a different route',
      [emptyForm.total, declined.total], [40, 40]),

    // The label cannot disagree with the number beside it: the maxima move
    // when a strategy carries entry conditions, so the line is interpolated.
    c('(11) the line follows the real maximum',
      computeTradeScore({
        ...DECLINED,
        strategy_conditions_checked: [{ condition: 'a', checked: true }],
      }).breakdown.planning.details,
      ['תכנון 0/30 — לא הוגשה תוכנית']),
  ]);

  // A QUEUED row is never scored at all — the debrief route does not reach
  // scoring for one — and neither J1 nor its reversal changes that.
  group('J1: a queued row is still not scored', [
    c('(1) queued is not declined', linkState({
      source: 'tradovate', unplanned: true, link_confirmed_at: null,
    } as Parameters<typeof linkState>[0]), 'queued'),
    c('(2) declined is', linkState({
      source: 'tradovate', unplanned: true, link_confirmed_at: '2026-10-16T10:00:00.000Z',
    } as Parameters<typeof linkState>[0]), 'declined'),
    c('(3) a linked row is neither', linkState({
      source: 'tradovate', unplanned: false, link_confirmed_at: '2026-10-16T10:00:00.000Z',
    } as Parameters<typeof linkState>[0]), 'linked'),
    c('(4) and a manual row has no link state at all', linkState({
      source: 'manual', unplanned: false, link_confirmed_at: null,
    } as Parameters<typeof linkState>[0]), null),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
