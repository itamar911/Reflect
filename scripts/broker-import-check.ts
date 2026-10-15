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
  kind: 'select' | 'insert' | 'update' | 'delete';
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
    } as unknown as SupabaseClient;
  }
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
    c('(4) and the counts are in it',
      /offered=3 imported=2 updated=0 unchanged=0 skippedOpen=1/.test(joined), true),
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
    // Four rows, two trades. The sum would block a trader at half their limit.
    c('(1) two plans + two imported rows for the same two trades = 2', paired.todayTradeCount, 2),
    c('(2) NEVER THE SUM', paired.todayTradeCount === 4, false),
    c('(3) without the declaration, the old count stands', declined.todayTradeCount, 4),
    c('(4) three unplanned broker trades and no plans = 3', unplannedOnly.todayTradeCount, 3),
    c('(5) two plans the broker has not seen close = 2', openPlans.todayTradeCount, 2),
    c('(6) in the fallback state the stored broker closes are the count', fallback.todayTradeCount, 2),
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
    c('(1) exactly these twelve keys', keys, [
      'asOf',
      'failed',
      // Sorts before 'imported': capital E. Default Array#sort is by code unit.
      'importEnabled',
      'imported',
      'offered',
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
