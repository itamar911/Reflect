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
 *
 * Usage: npm run test:broker-import
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EXECUTION_FACTS_FOR_TEST,
  IMPORT_FLAG,
  importBrokerTrades,
  isImportEnabled,
} from '../src/lib/tradovate/import';
import { runBrokerImport } from '../src/lib/tradovate/import-cron';
import type { BrokerTrade } from '../src/lib/tradovate/fills';
import { isHiddenTrade, visibleTrades, withHidden } from '../src/lib/trades/visible';
import { loadTradeRuleContext } from '../src/lib/rules/tradeRuleContext';
import type { BrokerDayPull } from '../src/lib/rules/brokerDayContext';
import { readBrokerDayResponse } from '../src/lib/rules/brokerDayContext';
import { GET as cronImport } from '../src/app/api/cron/tradovate-import/route';
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
  type CandidatePlan,
} from '../src/lib/tradovate/match';
import {
  confirmLink,
  declineLink,
  deleteWarningText,
  isQueuedBrokerRow,
  LINK_STATE_COPY,
  linkState,
  proposeFlags,
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
  positionFlat: true,
};

/** The same trade while the trader still holds one of the two contracts. */
const STILL_OPEN: BrokerTrade = { ...TRADE, positionFlat: false };

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

type Row = Record<string, unknown>;

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
          const stored = { id: `row-${this.rows.length + 1}`, ...values };
          if (this.failNextInsertAsConflict) {
            this.failNextInsertAsConflict = false;
            // The row the race's winner left behind, so the re-read finds it.
            this.rows.push(stored);
            return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
          }
          this.rows.push(stored);
          return Promise.resolve({ data: null, error: null });
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
      this.statement.filters.every(([op, column, value]) => {
        if (op === 'eq') return row[column] === value;
        if (op === 'in') return (value as unknown[]).includes(row[column]);
        if (op === 'neq') return row[column] !== value;
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
    c('(4) the thirteen execution facts moved',
      EXECUTION_FACTS_FOR_TEST.filter(({ column }) => linked[column] === undefined), []),
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
  await respondToDebriefRequest(debriefRequest(), declinedDeps);
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

async function alertSummaryGroup() {
  // A SHORT THAT MADE MONEY. entry above exit, `actual_pnl` positive — the
  // test that used to read `exit_price > entry_price` called this a loss.
  const winningShort = {
    status: 'closed', direction: 'short',
    entry_price: 110, exit_price: 100, actual_pnl: 500, rr_ratio: 2,
  };
  const losingLong = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 90, actual_pnl: -500, rr_ratio: 2,
  };
  // An imported row: no plan behind it, so no R:R by design.
  const brokerRow = {
    status: 'closed', direction: 'long',
    entry_price: 100, exit_price: 105, actual_pnl: 250, rr_ratio: null,
  };

  const shortOnly = summarise([winningShort]);
  const mixed = summarise([winningShort, losingLong]);
  const withBroker = summarise([winningShort, brokerRow]);
  const openPlan = summarise([{ status: 'open', entry_price: 100, exit_price: null, rr_ratio: 4 }]);
  const empty = summarise([]);

  group('the alert emails count a short the way a trader does', [
    // THE §0ד BUG, in the one file Stage 4 did not reach.
    c('(1) a profitable short is a win', shortOnly.winRate, 100),
    c('(2) and its P&L is positive in points', shortOnly.totalPL, 10),
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
  await linkWriteGroup();
  await linkCountGroup();
  await debriefGateGroup();
  await confirmScreenGroup();
  await unlinkGroup();
  await todayPanelGroup();

  console.log('');
  if (failures.length > 0) {
    console.log(`${failures.length} failing assertion(s):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log('All groups passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
