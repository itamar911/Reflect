/**
 * Portfolios regression suite — REF-110 Stages 3, 4 and 5.
 *
 * There is no unit-test runner in this repository (see the header on
 * scripts/broker-import-check.ts, which explains why and sets the shape). This
 * is a plain `tsx` script of assertions: one line per group, non-zero exit on
 * any failure.
 *
 * NOTHING HERE TOUCHES THE NETWORK, SUPABASE, OR A CREDENTIAL. The Supabase
 * client is a hand-built recording stub over an in-memory array, the feature
 * gate is a boolean parameter rather than a read of `process.env`, and no
 * module holding a token is exercised. Safe to run anywhere, with no
 * `.env.local`.
 *
 *
 * WHY THIS IS A SECOND FILE AND NOT A GROUP IN broker-import-check
 * -----------------------------------------------------------------
 *
 * That suite is about the IMPORT: what the broker is allowed to write, and
 * what it must leave alone. Stages 1-2 belong there and are there. Stages 3-5
 * are about what the TRADER does — naming a portfolio, hiding a card,
 * assigning a backlog, filtering a page — and share none of that file's
 * fixtures. The one place they meet is the boundary assertion below, that a
 * nickname survives a resync, and it is here rather than there because it is
 * the trader's half of the promise.
 *
 *
 * WHAT IT COVERS, AND WHY EACH GROUP IS HERE
 *
 *   - **A manual portfolio is created lazily ONCE.** Two submits under the
 *     same name must not leave two cards called the same thing, because a
 *     portfolio list with two "Interactive" rows is a list the trader cannot
 *     use and cannot merge.
 *   - **A trader-set nickname survives a resync.** Driven through the real
 *     `syncBrokerAccounts`, not asserted against a constant: the regression
 *     this guards against is somebody adding `nickname` to `BROKER_OWNED`,
 *     and a test that read the same constant would agree with the mistake.
 *   - **Hiding is not deleting.** The sum over the trader's rows is bit-for-bit
 *     identical before and after a hide, and the hide sends no statement
 *     against `trade_plans` at all.
 *   - **The assign flow moves the chosen rows and only those** — scoped by
 *     user, by id, and by still being unassigned.
 *   - **The filter.** A trade in A is absent under `?account=B`, present with
 *     no parameter, and — the one that matters — a 1,001st trade in B is
 *     RETURNED when filtering to B, which is REF-110 §D.3's `limit(1000)`
 *     finding as an assertion rather than as a paragraph.
 *   - **A card's figures equal lib/pnl.ts** over the same rows. The card must
 *     not become the fourth definition of a win rate.
 *   - **The six Hebrew lines**, pinned verbatim. Imri's 17.10 requirement is a
 *     product decision, so a reword is a decision to take again rather than a
 *     diff to approve.
 *
 * Usage: npm run test:accounts
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  NEW_PORTFOLIO_VALUE,
  PORTFOLIO_COPY,
  UNASSIGNED_VALUE,
  hiddenPortfolios,
  portfolioLabel,
  shownPortfolios,
  sortPortfolios,
  statusLabel,
  type Portfolio,
} from '../src/lib/portfolios/portfolio';
import {
  PORTFOLIO_SELECT,
  UNASSIGNED_SAMPLE_LIMIT,
  assignAllUnassigned,
  assignTradesToPortfolio,
  ensureManualPortfolio,
  readLastUsedPortfolioId,
  readPortfolios,
  renamePortfolio,
  setPortfolioHidden,
} from '../src/lib/portfolios/read';
import {
  UNASSIGNED_KEY,
  figuresByPortfolio,
  figuresFor,
  type PortfolioTradeRow,
} from '../src/lib/portfolios/figures';
import {
  ACCOUNT_PARAM,
  accountHref,
  resolveAccountParam,
  tradesInAccount,
} from '../src/lib/portfolios/filter';
import { withAccount } from '../src/lib/trades/visible';
import { syncBrokerAccounts } from '../src/lib/tradovate/account-sync';
import type { HostAccounts } from '../src/lib/tradovate/fills';
import type { TradovateAccount } from '../src/lib/tradovate/types';
import { isWinningTrade, tradeMoneyPnl } from '../src/lib/pnl';

// ── Harness ─────────────────────────────────────────────────────────────────
//
// Deliberately identical in shape to broker-import-check's, down to the `c()`
// helper, so somebody reading both files is reading one convention.

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

const PORTFOLIO_A = 'c1111111-0000-4000-8000-000000000001';
const PORTFOLIO_B = 'c2222222-0000-4000-8000-000000000002';

/** The flag, as these functions take it: a parameter, never a process read. */
const ON = true;
const OFF = false;

// ── The Supabase stub ───────────────────────────────────────────────────────

type Row = Record<string, unknown> & { __table?: string };

interface Statement {
  kind: 'select' | 'insert' | 'update';
  table: string;
  columns?: string;
  filters: [string, string, unknown][];
  values?: Row;
}

function tableOf(row: Row): string {
  return row.__table ?? 'trade_plans';
}

/**
 * Just enough PostgREST to drive `lib/portfolios/`, over an array of rows.
 *
 * IT RECORDS EVERY STATEMENT, which is the point. The strongest assertions
 * here are about statements NOT sent: the gate-off group measures zero, the
 * hide group measures zero against `trade_plans`, and the idempotence group
 * measures exactly one insert across two calls.
 *
 * Filters are applied for real, for broker-import-check's reason: a stub that
 * ignored `.eq('user_id', …)` would make the cross-user assertions pass
 * vacuously, which is the one kind of green that is worse than red.
 *
 * `.in()` is modelled because the assign flow is one statement over a list,
 * and an assertion that it touches only the chosen rows needs the stub to be
 * able to disagree.
 */
class FakeDb {
  readonly statements: Statement[] = [];
  private seq = 0;

  constructor(public rows: Row[] = []) {}

  get writes(): Statement[] {
    return this.statements.filter((s) => s.kind !== 'select');
  }

  statementsOn(table: string): Statement[] {
    return this.statements.filter((s) => s.table === table);
  }

  client(): SupabaseClient {
    return {
      from: (table: string) => ({
        select: (columns: string) =>
          new FakeQuery(this, { kind: 'select', table, columns, filters: [] }),
        insert: (values: Row) => {
          this.statements.push({ kind: 'insert', table, filters: [], values });
          this.seq += 1;
          const stored: Row = { id: `${table}-row-${this.seq}`, ...values, __table: table };
          this.rows.push(stored);
          return new FakeInsert(stored);
        },
        update: (values: Row) =>
          new FakeQuery(this, { kind: 'update', table, filters: [], values }),
      }),
    } as unknown as SupabaseClient;
  }
}

/** What `insert()` answers with, so `.select('id').maybeSingle()` chains. */
class FakeInsert implements PromiseLike<{ data: unknown; error: unknown }> {
  private columns: string | null = null;

  constructor(private readonly stored: Row) {}

  select(columns: string) {
    this.columns = columns;
    return this;
  }
  maybeSingle() {
    return this;
  }

  private resolve() {
    if (this.columns === null) return { data: null, error: null };
    const projected: Row = {};
    for (const column of this.columns.split(',').map((n) => n.trim())) {
      projected[column] = this.stored[column] ?? null;
    }
    return { data: projected, error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private recorded = false;
  private descending = false;
  private cap: number | null = null;

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
  is(column: string, value: unknown) {
    this.statement.filters.push(['is', column, value]);
    return this;
  }
  /** Only `.not(col, 'is', null)`, for FakeQuery-in-broker-import-check's
   *  reason: a stub that accepted every operator and implemented one would let
   *  a typo in a production query pass here and fail in Postgres. */
  not(column: string, operator: string, value: unknown) {
    if (operator !== 'is' || value !== null) {
      throw new Error(`FakeQuery.not: only .not(col, 'is', null) is modelled, got ${operator}`);
    }
    this.statement.filters.push(['notnull', column, null]);
    return this;
  }
  order(column: string, options?: { ascending?: boolean }) {
    this.statement.filters.push(['order', column, options?.ascending !== false]);
    this.descending = options?.ascending === false;
    return this;
  }
  limit(n: number) {
    this.statement.filters.push(['limit', '', n]);
    this.cap = n;
    return this;
  }
  maybeSingle() {
    this.statement.filters.push(['single', '', true]);
    return this;
  }

  private matched(): Row[] {
    const hits = this.db.rows.filter((row) =>
      tableOf(row) === this.statement.table &&
      this.statement.filters.every(([op, column, value]) => {
        if (op === 'eq') return row[column] === value;
        if (op === 'in') return (value as unknown[]).includes(row[column]);
        if (op === 'neq') return row[column] !== value;
        if (op === 'is') return value === null && (row[column] ?? null) === null;
        if (op === 'notnull') return (row[column] ?? null) !== null;
        return true;
      }),
    );

    const ordered = this.descending ? [...hits].reverse() : hits;
    return this.cap === null ? ordered : ordered.slice(0, this.cap);
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
    const single = this.statement.filters.some(([op]) => op === 'single');
    return { data: single ? (hits[0] ?? null) : hits, error: null };
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

/** A stored `accounts` row. */
function accountRow(over: Row = {}): Row {
  return {
    id: PORTFOLIO_A,
    user_id: USER,
    broker: 'manual',
    broker_account_id: null,
    broker_host: null,
    display_name: 'Portfolio One',
    nickname: null,
    status: 'active',
    hidden: false,
    last_seen_at: '2026-10-17T00:00:00.000Z',
    __table: 'accounts',
    ...over,
  };
}

/** The in-memory shape the figures and the filter read. */
function trade(over: Partial<PortfolioTradeRow> = {}): PortfolioTradeRow {
  return {
    account_id: null,
    status: 'closed',
    submitted_at: '2026-10-15T09:00:00.000Z',
    entry_price: 100,
    exit_price: 110,
    direction: 'long',
    pnl_amount: 250,
    actual_pnl: null,
    hidden: false,
    ...over,
  };
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
    return { result: await run(), lines };
  } finally {
    sinks.forEach((name, i) => {
      console[name] = originals[i];
    });
  }
}

// ── Group: the gate ─────────────────────────────────────────────────────────

async function gateGroup() {
  const db = new FakeDb([accountRow()]);
  const client = db.client();

  const portfolios = await readPortfolios(client, USER, OFF);
  const lastUsed = await readLastUsedPortfolioId(client, USER, OFF);
  const created = await ensureManualPortfolio(client, USER, 'Anything', OFF);

  group('REF-110 §G: migration 037 not run means not one statement', [
    c('readPortfolios answers empty', portfolios, []),
    c('readLastUsedPortfolioId answers null', lastUsed, null),
    c('ensureManualPortfolio answers null', created, null),
    // The whole argument for the gate. A select naming `accounts` on a
    // database without 037 is a PostgREST 42P01 and a 500 on the trade form.
    c('nothing was sent at all', db.statements.length, 0),
  ]);
}

// ── Group: lazy creation, once ──────────────────────────────────────────────

async function lazyCreationGroup() {
  const db = new FakeDb();
  const client = db.client();

  const first = await ensureManualPortfolio(client, USER, 'Interactive, personal', ON);
  const second = await ensureManualPortfolio(client, USER, 'Interactive, personal', ON);
  const differentCase = await ensureManualPortfolio(client, USER, 'INTERACTIVE, PERSONAL', ON);
  const padded = await ensureManualPortfolio(client, USER, '  Interactive, personal  ', ON);
  const other = await ensureManualPortfolio(client, USER, 'Second book', ON);

  const inserts = db.writes.filter((s) => s.kind === 'insert');
  const firstInsert = inserts[0]?.values ?? {};

  const blankDb = new FakeDb();
  const blank = await ensureManualPortfolio(blankDb.client(), USER, '   ', ON);

  group('Stage 3: a manual portfolio is created lazily, once', [
    c('the first submit creates it', typeof first, 'string'),
    // THE ASSERTION THE GROUP EXISTS FOR. Two cards called "Interactive" is a
    // list the trader can neither use nor merge.
    c('the second submit reuses it', second, first),
    c('and so does a different case', differentCase, first),
    c('and so does a padded name', padded, first),
    c('a different name is a different portfolio', other === first, false),
    c('two names, two inserts', inserts.length, 2),

    // 037's accounts_broker_identity_check: a manual row must carry NEITHER
    // broker column. Naming them as NULL would satisfy the CHECK while
    // stating something the row does not mean.
    c('the insert says manual', firstInsert.broker, 'manual'),
    c('the insert carries the typed name', firstInsert.display_name, 'Interactive, personal'),
    c('the insert carries the user', firstInsert.user_id, USER),
    c('broker_account_id is not named', 'broker_account_id' in firstInsert, false),
    c('broker_host is not named', 'broker_host' in firstInsert, false),
    // The trader's two columns are not named either, not even to their
    // defaults — the same boundary account-sync.ts holds on the broker side.
    c('nickname is not named', 'nickname' in firstInsert, false),
    c('hidden is not named', 'hidden' in firstInsert, false),
    c('status is not named', 'status' in firstInsert, false),

    c('a blank name creates nothing', blank, null),
    c('and sends nothing', blankDb.statements.length, 0),
  ]);
}

// ── Group: the trader owns the nickname, the broker owns the name ───────────

async function nicknameSurvivesGroup() {
  // A Tradovate row the sync already recorded, which the trader has since
  // renamed and hidden.
  const db = new FakeDb([
    accountRow({
      id: PORTFOLIO_A,
      broker: 'tradovate',
      broker_account_id: 1,
      broker_host: 'live',
      display_name: 'OLD BROKER NAME',
      nickname: 'הקרן שלי',
      hidden: true,
      status: 'active',
      last_seen_at: '2026-10-16T00:00:00.000Z',
    }),
  ]);

  const account: TradovateAccount = {
    id: 1,
    name: 'NEW BROKER NAME',
    userId: 99,
    accountType: 'Customer',
  } as TradovateAccount;

  const hosts: HostAccounts[] = [
    { host: 'live', claimed: [{ account, claim: 'owned', tradeable: true }] },
  ];

  // The real sync, not a stand-in. A test that compared against
  // BROKER_OWNED_FOR_TEST would agree with the mistake it is meant to catch.
  const { result, lines } = await captureLogs(() =>
    syncBrokerAccounts({
      client: db.client(),
      userId: USER,
      hosts,
      env: { TRADOVATE_IMPORT_ENABLED: '1' } as unknown as NodeJS.ProcessEnv,
      nowMs: Date.parse('2026-10-18T00:00:00.000Z'),
    }),
  );

  const stored = db.rows.find((r) => r.id === PORTFOLIO_A) ?? {};
  const updates = db.writes.filter((s) => s.kind === 'update');
  const updateValues = updates.map((s) => Object.keys(s.values ?? {})).flat().sort();

  group('Stage 3: a resync restates the broker name and nothing of the trader\'s', [
    c('the sync ran', result.counts.ran, true),
    c('the broker name moved', stored.display_name, 'NEW BROKER NAME'),
    // THE REGRESSION. Adding `nickname` to BROKER_OWNED fails here.
    c('the nickname survived', stored.nickname, 'הקרן שלי'),
    c('so did the hide', stored.hidden, true),
    c('no statement named nickname', updateValues.includes('nickname'), false),
    c('no statement named hidden', updateValues.includes('hidden'), false),
    // And the trader's name is still the one the card renders.
    c('the card still shows the nickname', portfolioLabel(stored as unknown as Portfolio), 'הקרן שלי'),
    // Privacy: counts, never names. Both names are in this fixture on purpose.
    c('no log line carries the broker name', lines.some((l) => l.includes('NEW BROKER NAME')), false),
    c('no log line carries the nickname', lines.some((l) => l.includes('הקרן שלי')), false),
  ]);
}

// ── Group: rename and hide ──────────────────────────────────────────────────

async function renameAndHideGroup() {
  const db = new FakeDb([
    accountRow({ id: PORTFOLIO_A, display_name: 'Broker Name', nickname: null }),
    accountRow({ id: PORTFOLIO_B, user_id: OTHER_USER, display_name: 'Not Yours' }),
  ]);
  const client = db.client();

  // Snapshotted, not referenced. `db.rows` holds live objects that the next
  // statement mutates in place, so reading one at the end of the group would
  // assert the final state three times over.
  const snapshot = (id: string): Row => ({ ...(db.rows.find((r) => r.id === id) ?? {}) });

  await renamePortfolio(client, USER, PORTFOLIO_A, '  התיק הראשי  ');
  const renamed = snapshot(PORTFOLIO_A);
  const renameValues = db.writes[0]?.values ?? {};

  await renamePortfolio(client, USER, PORTFOLIO_A, '   ');
  const cleared = snapshot(PORTFOLIO_A);

  // Somebody else's row, reached by id. RLS would refuse it; the explicit
  // user filter is the second line of defence and is what this asserts.
  await renamePortfolio(client, USER, PORTFOLIO_B, 'mine now');
  const foreign = snapshot(PORTFOLIO_B);

  group('Stage 3: rename writes the nickname and only the nickname', [
    c('the nickname is set, trimmed', renamed.nickname, 'התיק הראשי'),
    // display_name is the broker's. A rename written there would last until
    // the next sync and then vanish.
    c('display_name is untouched', renamed.display_name, 'Broker Name'),
    c('the statement names one column', Object.keys(renameValues), ['nickname']),
    c('a blank name clears the rename', cleared.nickname, null),
    c('and the broker name comes back', portfolioLabel(cleared as unknown as Portfolio), 'Broker Name'),
    c('another trader\'s row is not reached', foreign.nickname, null),
  ]);

  // ── Hiding is a screen preference, not a delete (Imri, 17.10) ─────────────
  const rows: PortfolioTradeRow[] = [
    trade({ account_id: PORTFOLIO_A, pnl_amount: 300 }),
    trade({ account_id: PORTFOLIO_A, pnl_amount: -120 }),
    trade({ account_id: PORTFOLIO_B, pnl_amount: 55 }),
    trade({ account_id: null, pnl_amount: 10 }),
  ];
  const totalBefore = rows.reduce((s, r) => s + tradeMoneyPnl(r), 0);

  const hideDb = new FakeDb([accountRow({ id: PORTFOLIO_A })]);
  await setPortfolioHidden(hideDb.client(), USER, PORTFOLIO_A, true);
  const hidden = { ...(hideDb.rows.find((r) => r.id === PORTFOLIO_A) ?? {}) };
  const hideValues = hideDb.writes[0]?.values ?? {};

  const totalAfter = rows.reduce((s, r) => s + tradeMoneyPnl(r), 0);

  await setPortfolioHidden(hideDb.client(), USER, PORTFOLIO_A, false);
  const unhidden = { ...(hideDb.rows.find((r) => r.id === PORTFOLIO_A) ?? {}) };

  group('Stage 3: hiding a portfolio keeps every one of its trades in the totals', [
    c('the flag is set', hidden.hidden, true),
    c('the statement names one column', Object.keys(hideValues), ['hidden']),
    // THE ASSERTION THE GROUP EXISTS FOR. A hide that moved this number would
    // be a destructive button wearing the word "הסתר".
    c('the total is unchanged', totalAfter, totalBefore),
    c('the total is the real one', totalBefore, 245),
    // Structural, and stronger than the arithmetic above: the hide cannot
    // reach a trade because it never addresses the table they live in.
    c('no statement touched trade_plans', hideDb.statementsOn('trade_plans').length, 0),
    c('unhide puts the card back', unhidden.hidden, false),
  ]);
}

// ── Group: reading, sorting and labelling ───────────────────────────────────

async function readGroup() {
  const db = new FakeDb([
    accountRow({ id: PORTFOLIO_A, display_name: 'Live', status: 'active', last_seen_at: '2026-10-10T00:00:00.000Z' }),
    accountRow({ id: PORTFOLIO_B, display_name: 'Breached eval', status: 'closed', hidden: true }),
    accountRow({ id: 'c3', user_id: OTHER_USER, display_name: 'Not Yours' }),
    // A row written before some later migration, carrying no `hidden` at all.
    // `undefined` means visible, exactly as `false` does.
    accountRow({ id: 'c4', display_name: 'No flag', hidden: null, status: 'active', last_seen_at: '2026-10-20T00:00:00.000Z' }),
  ]);

  const portfolios = await readPortfolios(db.client(), USER, ON);
  const select = db.statements[0];

  const sorted = sortPortfolios(portfolios);

  group('Stage 3: reading this trader\'s portfolios', [
    c('three rows, and not the stranger\'s', portfolios.map((p) => p.display_name).sort(), ['Breached eval', 'Live', 'No flag']),
    c('the read is filtered by user', select.filters, [['eq', 'user_id', USER]]),
    // Named columns, not select('*'): what travels is reviewable.
    c('the read names its columns', select.columns, PORTFOLIO_SELECT),
    c('a null hidden reads as visible', portfolios.find((p) => p.display_name === 'No flag')?.hidden, false),
    c('a true hidden reads as hidden', portfolios.find((p) => p.display_name === 'Breached eval')?.hidden, true),

    // Active first, then closed; inside a group, the trader's own recency.
    c('active before closed', sorted.map((p) => p.status), ['active', 'active', 'closed']),
    c('newest active first', sorted[0].display_name, 'No flag'),

    c('hidden is excluded from the choosable set', shownPortfolios(portfolios).map((p) => p.display_name).sort(), ['Live', 'No flag']),
    c('and counted in the folded one', hiddenPortfolios(portfolios).length, 1),

    c('a nickname wins', portfolioLabel({ display_name: 'Broker', nickname: 'Mine' }), 'Mine'),
    c('a blank nickname is not a rename', portfolioLabel({ display_name: 'Broker', nickname: '   ' }), 'Broker'),
    c('no nickname falls back', portfolioLabel({ display_name: 'Broker', nickname: null }), 'Broker'),

    c('the closed chip reads נסגר', statusLabel('closed'), 'נסגר'),
    c('the active chip reads פעיל', statusLabel('active'), 'פעיל'),
    c('the archived chip reads בארכיון', statusLabel('archived'), 'בארכיון'),
  ]);

  // ── The form's default: the portfolio of the most recent plan ─────────────
  const lastDb = new FakeDb([
    { id: 't1', user_id: USER, account_id: PORTFOLIO_A, submitted_at: '2026-10-01T00:00:00.000Z' },
    { id: 't2', user_id: USER, account_id: PORTFOLIO_B, submitted_at: '2026-10-09T00:00:00.000Z' },
    // Newer, but unassigned. "No default" would be a worse answer than "the
    // last portfolio you actually used".
    { id: 't3', user_id: USER, account_id: null, submitted_at: '2026-10-17T00:00:00.000Z' },
    { id: 't4', user_id: OTHER_USER, account_id: 'someone-else', submitted_at: '2026-10-18T00:00:00.000Z' },
  ]);
  const lastUsed = await readLastUsedPortfolioId(lastDb.client(), USER, ON);
  const lastSelect = lastDb.statements[0];

  const emptyDb = new FakeDb([]);
  const noDefault = await readLastUsedPortfolioId(emptyDb.client(), USER, ON);

  group('Stage 3: the form defaults to the last portfolio actually used', [
    c('the newest assigned plan wins', lastUsed, PORTFOLIO_B),
    c('the unassigned newer one is skipped', lastSelect.filters.some(([op, col]) => op === 'notnull' && col === 'account_id'), true),
    c('scoped to this trader', lastSelect.filters.some(([op, col, v]) => op === 'eq' && col === 'user_id' && v === USER), true),
    c('one row is read', lastSelect.filters.some(([op, , v]) => op === 'limit' && v === 1), true),
    c('a first-time trader gets no default', noDefault, null),
  ]);
}

// ── Group: the assign flow ──────────────────────────────────────────────────

async function assignGroup() {
  const db = new FakeDb([
    { id: 't1', user_id: USER, account_id: null, status: 'closed' },
    { id: 't2', user_id: USER, account_id: null, status: 'closed' },
    { id: 't3', user_id: USER, account_id: null, status: 'closed' },
    // Already filed. The flow is "assign the unassigned", so a row that
    // acquired a portfolio since the page rendered is left where it is.
    { id: 't4', user_id: USER, account_id: PORTFOLIO_B, status: 'closed' },
    { id: 't5', user_id: OTHER_USER, account_id: null, status: 'closed' },
  ]);

  const ok = await assignTradesToPortfolio(db.client(), USER, ['t1', 't3', 't4', 't5'], PORTFOLIO_A);
  const after = Object.fromEntries(db.rows.map((r) => [r.id as string, r.account_id ?? null]));
  const statement = db.writes[0];

  const emptyDb = new FakeDb([]);
  const emptyOk = await assignTradesToPortfolio(emptyDb.client(), USER, [], PORTFOLIO_A);

  group('Stage 4: the assign flow moves the chosen rows and only those', [
    c('it succeeds', ok, true),
    c('the chosen unassigned rows move', [after.t1, after.t3], [PORTFOLIO_A, PORTFOLIO_A]),
    c('an unchosen row stays unassigned', after.t2, null),
    c('an already-filed row is not moved', after.t4, PORTFOLIO_B),
    c('another trader\'s row is not reached', after.t5, null),
    // ONE statement for the whole selection. Four hundred pre-REF-110 rows
    // must not be four hundred round trips.
    c('one statement for the whole selection', db.writes.length, 1),
    c('it names one column', Object.keys(statement.values ?? {}), ['account_id']),
    c('scoped by user', statement.filters.some(([op, col, v]) => op === 'eq' && col === 'user_id' && v === USER), true),
    c('scoped to the unassigned', statement.filters.some(([op, col]) => op === 'is' && col === 'account_id'), true),
    c('scoped to the chosen ids', statement.filters.some(([op, col]) => op === 'in' && col === 'id'), true),
    c('an empty selection sends nothing', emptyDb.statements.length, 0),
    c('and still succeeds', emptyOk, true),
  ]);

  // ── "שייך את כל N העסקאות" — the backlog longer than the rendered list ───
  const allDb = new FakeDb([
    { id: 'u1', user_id: USER, account_id: null },
    { id: 'u2', user_id: USER, account_id: null },
    { id: 'u3', user_id: USER, account_id: PORTFOLIO_B },
    { id: 'u4', user_id: OTHER_USER, account_id: null },
  ]);
  await assignAllUnassigned(allDb.client(), USER, PORTFOLIO_A);
  const allAfter = Object.fromEntries(allDb.rows.map((r) => [r.id as string, r.account_id ?? null]));
  const allStatement = allDb.writes[0];

  group('Stage 4: "assign all" reaches rows the list never rendered', [
    // THE REASON THIS IS A SEPARATE FUNCTION. The card lists at most
    // UNASSIGNED_SAMPLE_LIMIT rows; ticking every box on that list would file
    // 200 of 800 and look finished.
    c('every unassigned row of this trader moves', [allAfter.u1, allAfter.u2], [PORTFOLIO_A, PORTFOLIO_A]),
    c('an already-filed row is untouched', allAfter.u3, PORTFOLIO_B),
    c('another trader\'s backlog is untouched', allAfter.u4, null),
    c('still one statement', allDb.writes.length, 1),
    c('and it carries no id list', allStatement.filters.some(([op]) => op === 'in'), false),
    c('scoped by user', allStatement.filters.some(([op, col, v]) => op === 'eq' && col === 'user_id' && v === USER), true),
    c('scoped to the unassigned', allStatement.filters.some(([op, col]) => op === 'is' && col === 'account_id'), true),
    c('the rendered list is bounded', UNASSIGNED_SAMPLE_LIMIT > 0, true),
  ]);
}

// ── Group: the card's figures are lib/pnl.ts's ──────────────────────────────

function figuresGroup() {
  const rows: PortfolioTradeRow[] = [
    trade({ account_id: PORTFOLIO_A, pnl_amount: 300, submitted_at: '2026-10-10T09:00:00.000Z' }),
    trade({ account_id: PORTFOLIO_A, pnl_amount: -120, submitted_at: '2026-10-12T09:00:00.000Z' }),
    // actual_pnl wins over pnl_amount — pnl.ts's precedence, not a second one.
    trade({ account_id: PORTFOLIO_A, pnl_amount: 999, actual_pnl: -40, submitted_at: '2026-10-14T09:00:00.000Z' }),
    // Open: in the trade count, out of the win-rate denominator.
    trade({ account_id: PORTFOLIO_A, status: 'open', exit_price: null, pnl_amount: null, submitted_at: '2026-10-16T09:00:00.000Z' }),
    // A plan never entered is not a trade (REF-82 §5.2).
    trade({ account_id: PORTFOLIO_A, status: 'not_entered', exit_price: null, pnl_amount: null, submitted_at: '2026-10-18T09:00:00.000Z' }),
    // E12: a row the trader deleted is in no total anywhere.
    trade({ account_id: PORTFOLIO_A, pnl_amount: 10_000, hidden: true, submitted_at: '2026-10-19T09:00:00.000Z' }),
    trade({ account_id: PORTFOLIO_B, pnl_amount: 55 }),
    trade({ account_id: null, pnl_amount: 10 }),
  ];

  const figures = figuresByPortfolio(rows);
  const a = figures.get(PORTFOLIO_A)!;

  // The same numbers, derived the way the stats page derives them, straight
  // out of lib/pnl.ts. If these two ever disagree the card has become the
  // fourth definition of a win rate.
  const ownRows = rows.filter((r) => r.account_id === PORTFOLIO_A && r.status !== 'not_entered' && r.hidden !== true);
  const ownClosed = ownRows.filter((r) => r.status === 'closed' && r.exit_price != null);
  const pnlFromHelpers = ownClosed.reduce((s, r) => s + tradeMoneyPnl(r), 0);
  const winsFromHelpers = ownClosed.filter((r) => isWinningTrade(r) === true).length;

  const emptyFigures = figuresFor([]);

  group('Stage 4: a card\'s figures are lib/pnl.ts\'s, over the same rows', [
    c('net P&L matches tradeMoneyPnl', a.netPnl, pnlFromHelpers),
    c('and is the real figure', a.netPnl, 140),
    c('win rate matches isWinningTrade', a.winRate, Math.round((winsFromHelpers / ownClosed.length) * 100)),
    c('and is the real figure', a.winRate, 33),
    c('the open trade is counted', a.trades, 4),
    c('but not in the win-rate denominator', a.closed, 3),
    c('not_entered is not a trade', ownRows.some((r) => r.status === 'not_entered'), false),
    c('a hidden row is in no total', a.netPnl < 10_000, true),
    c('last trade is the newest counted row', a.lastTradeAt, '2026-10-16T09:00:00.000Z'),

    c('the unassigned bucket is in the same map', figures.get(UNASSIGNED_KEY)?.trades, 1),
    c('and totals the same way', figures.get(UNASSIGNED_KEY)?.netPnl, 10),
    c('a portfolio with nothing has no win rate', emptyFigures.winRate, null),
    c('and no last trade', emptyFigures.lastTradeAt, null),

    // The sum of the cards equals the page's total — the check a trader can
    // make themselves in two clicks.
    c(
      'the cards sum to the trader\'s own total',
      [...figures.values()].reduce((s, f) => s + f.netPnl, 0),
      rows.filter((r) => r.status !== 'not_entered' && r.hidden !== true).reduce((s, r) => s + tradeMoneyPnl(r), 0),
    ),
  ]);
}

// ── Group: the filter ───────────────────────────────────────────────────────

function filterParamGroup() {
  group('Stage 5: what ?account= is allowed to mean', [
    c('a uuid is a filter', resolveAccountParam(PORTFOLIO_A, ON), PORTFOLIO_A),
    c('absent means all accounts', resolveAccountParam(undefined, ON), null),
    c('empty means all accounts', resolveAccountParam('', ON), null),
    // NOT a filter that matches nothing: `account_id` is a UUID column, and a
    // malformed value reaching .eq() is Postgres 22P02 — a 400 from PostgREST
    // and a 500 on the page. A broken link must degrade to "all accounts".
    c('junk is not a filter', resolveAccountParam('not-a-uuid', ON), null),
    c('an injection attempt is not a filter', resolveAccountParam("' OR 1=1--", ON), null),
    // Two portfolios is not a view this product offers, and quietly picking
    // the first would show a filtered page nobody asked for.
    c('a repeated parameter is not a filter', resolveAccountParam([PORTFOLIO_A, PORTFOLIO_B], ON), null),
    // 037 not run: no filter, so the page issues exactly the statements it
    // issued before REF-110 even when somebody follows a link into it.
    c('the gate shut means no filter', resolveAccountParam(PORTFOLIO_A, OFF), null),

    c('a href carries the id', accountHref('/trades', PORTFOLIO_A), `/trades?account=${PORTFOLIO_A}`),
    c('and the bare path means all', accountHref('/trades', null), '/trades'),
    c('the key is stable', ACCOUNT_PARAM, 'account'),
  ]);
}

async function filterReaderGroup() {
  // ── The in-memory half, for /stats ────────────────────────────────────────
  const rows: PortfolioTradeRow[] = [
    trade({ account_id: PORTFOLIO_A, pnl_amount: 100 }),
    trade({ account_id: PORTFOLIO_B, pnl_amount: 200 }),
    trade({ account_id: null, pnl_amount: 300 }),
  ];

  const inB = tradesInAccount(rows, PORTFOLIO_B);
  const unfiltered = tradesInAccount(rows, null);

  group('Stage 5: a trade in A is absent under ?account=B, present with no param', [
    // The three assertions REF-110's test plan names, in order.
    c('a trade in A is absent under ?account=B', inB.some((r) => r.account_id === PORTFOLIO_A), false),
    c('the B trade is there', inB.map((r) => r.pnl_amount), [200]),
    c('every trade is there with no param', unfiltered.length, 3),
    c('including the unassigned one', unfiltered.some((r) => r.account_id === null), true),
    // An unassigned row is not in ANY portfolio's view. It belongs to the
    // "ללא תיק" bucket on /accounts and to no filtered page.
    c('an unassigned trade is in no portfolio', tradesInAccount(rows, PORTFOLIO_A).length, 1),
    // Identity when unfiltered, matching visibleTrades, so the overwhelmingly
    // common page view allocates nothing.
    c('no filter returns the same array', unfiltered === rows, true),
  ]);

  // ── The server-side half, and the finding it exists for ──────────────────
  //
  // THE ASSERTION THAT MATTERS. /trades and /journal cap at 1,000 rows BEFORE
  // anything filters, so a trader with 1,400 trades who filtered to one
  // portfolio would be shown whatever subset of it fell inside the newest
  // thousand — fewer trades than the portfolio holds, with nothing saying so.
  // Here, a trade that is the 1,001st row overall is returned when filtering
  // to its portfolio, because the WHERE clause runs first.
  const many: Row[] = [];
  for (let i = 0; i < 1000; i += 1) {
    many.push({ id: `a-${i}`, user_id: USER, account_id: PORTFOLIO_A, status: 'closed' });
  }
  // Oldest row in the table, so it is the one a .limit(1000) would drop.
  many.push({ id: 'the-1001st', user_id: USER, account_id: PORTFOLIO_B, status: 'closed' });

  const db = new FakeDb(many);
  const filtered = await withAccount(
    db.client().from('trade_plans').select('*').eq('user_id', USER),
    PORTFOLIO_B,
  ).limit(1000);

  const unfilteredDb = new FakeDb(many);
  const everything = await withAccount(
    unfilteredDb.client().from('trade_plans').select('*').eq('user_id', USER),
    null,
  ).limit(1000);

  const rowsIn = (res: { data: unknown }) => (res.data as Row[]).map((r) => r.id as string);
  const statement = db.statements[0];

  group('Stage 5: the 1,001st trade is returned when the filter is in the WHERE clause', [
    c('the filtered read finds it', rowsIn(filtered), ['the-1001st']),
    // The same row, through the same cap, with no filter: dropped. This is
    // the finding stated as the difference between two reads.
    c('the unfiltered read drops it', rowsIn(everything).includes('the-1001st'), false),
    c('and returns the cap', rowsIn(everything).length, 1000),
    c('the filter is a WHERE clause', statement.filters.some(([op, col, v]) => op === 'eq' && col === 'account_id' && v === PORTFOLIO_B), true),
    c('and the user filter is still there', statement.filters.some(([op, col, v]) => op === 'eq' && col === 'user_id' && v === USER), true),

    // withAccount's withHidden-shaped property: unfiltered, the caller's own
    // query comes back untouched, so a page with no ?account= issues the
    // statement it issued before REF-110.
    c('no filter adds no clause', unfilteredDb.statements[0].filters.filter(([op]) => op === 'eq').length, 1),
  ]);
}

// ── Group: where the filter and the names must never reach ─────────────────

/**
 * Read every .ts/.tsx under a directory. Source-level assertions need the
 * source; there is no other way to assert that something is ABSENT from code
 * that, by definition, is never executed by this suite.
 */
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

/**
 * The six places the filter is never applied, and the one thing that must
 * never leave the product.
 *
 * ASSERTED OVER THE SOURCE, not over behaviour, and deliberately: these are
 * statements about code paths this suite does not execute and should not have
 * to. "The rule engine never filters by account" is not a function call that
 * can be checked — it is the absence of one, and the honest way to assert an
 * absence is to look.
 */
function neverReachesGroup() {
  const rules = sourceUnder('src/lib/rules');
  const ai = [
    'src/app/api/ai-chat', 'src/app/api/ai-coach', 'src/app/api/ai-debrief',
    'src/app/api/ai-patterns', 'src/app/api/ai-trade-review',
    'src/app/api/cron/send-alerts', 'src/lib/weekly', 'src/lib/ai',
  ].map(sourceUnder).join('\n');

  // THE TABLE, not the column names. `profiles.display_name` is the trader's
  // OWN name and `send-alerts` reads it to address an email — a grep for the
  // bare column would fail on that and be telling the truth about nothing.
  // What must never happen is an AI payload joining `accounts`, so that is
  // what is asserted: the table, and the module that is the only sanctioned
  // way to reach it.
  const readsAccountsTable = (src: string) =>
    src.includes("from('accounts')") || src.includes('from("accounts")');

  group('REF-110 §E/§F: where the filter and the account names never go', [
    // Imri, 17.10: one trader, many portfolios, ONE discipline record. A
    // per-account rule scope would let someone stay inside every limit while
    // breaking all of them together (REF-90 §3ב).
    c('the rule engine does not import the filter', rules.includes('portfolios/filter'), false),
    c('the rule engine does not read ?account=', rules.includes("'account'") && rules.includes('searchParams'), false),
    c('the rule engine never names account_id', rules.includes('account_id'), false),
    c('the AI routes do not import the filter', ai.includes('portfolios/filter'), false),

    // §F's one genuinely new hazard. `account_id` reaching ai-chat is a UUID
    // of ours and harmless; a NAME is a prop firm's identity leaving the
    // product. The join site does not exist, and this is what keeps it that
    // way.
    c('no AI route imports the accounts read', ai.includes('portfolios/read'), false),
    c('no AI route reads the accounts table', readsAccountsTable(ai), false),
    c('nor does the rule engine', readsAccountsTable(rules), false),
    // The grep is only worth anything if it could fire. The module that DOES
    // read the table proves the needle is findable.
    c('and the needle is a real one',
      readsAccountsTable(fs.readFileSync(path.join(process.cwd(), 'src/lib/portfolios/read.ts'), 'utf8')),
      true),
  ]);
}

// ── Group: the six Hebrew lines ─────────────────────────────────────────────

function copyGroup() {
  // PINNED VERBATIM, and that is the point. Imri's 17.10 requirement — "every
  // screen and state must explain itself to the trader in plain Hebrew" — is
  // a product decision, and these six sentences are the decision. A reword is
  // a decision to take again, not a diff to wave through; a deletion is a
  // screen that stopped explaining itself and would otherwise be invisible in
  // review.
  group('REF-110: every element explains itself, in these six lines', [
    c('the screen header',
      PORTFOLIO_COPY.screenHeader,
      'כל תיק שאתה סוחר בו — מהברוקר או ידני. הסטטיסטיקות והחוקים שלך תמיד על כל התיקים ביחד.'),
    c('the "ללא תיק" bucket',
      PORTFOLIO_COPY.unassigned,
      'עסקאות מלפני שהיו תיקים. בחר לאיזה תיק הן שייכות.'),
    c('the "נסגר" chip',
      PORTFOLIO_COPY.closedStatus,
      'הברוקר כבר לא מציג את החשבון הזה. העסקאות נשארות.'),
    c('the hide action',
      PORTFOLIO_COPY.hide,
      'מוריד את הכרטיס מהמסך בלבד. העסקאות נשארות בסטטיסטיקות.'),
    c('the form field',
      PORTFOLIO_COPY.formField,
      'לאיזה חשבון העסקה שייכת. עסקאות מהברוקר משויכות לבד.'),
    c('create a manual portfolio',
      PORTFOLIO_COPY.createManual,
      'לסוחרים בלי ברוקר מחובר, או לחשבון נוסף שאתה מנהל ידנית.'),
    c('all six are present', Object.keys(PORTFOLIO_COPY).length, 6),
    // No emoji anywhere in the UI (CLAUDE.md). Cheap to assert, and this is
    // the one place in the feature where new prose gets written.
    c('no emoji', Object.values(PORTFOLIO_COPY).some((line) => /\p{Extended_Pictographic}/u.test(line)), false),

    // The two sentinel values the "תיק" select uses. '' is unassigned because
    // that is what an unselected <option> carries; the other must never be
    // mistakable for a UUID.
    c('unassigned is the empty value', UNASSIGNED_VALUE, ''),
    c('the "new" sentinel is not a uuid', /^[0-9a-f-]{36}$/i.test(NEW_PORTFOLIO_VALUE), false),
  ]);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  await gateGroup();
  await lazyCreationGroup();
  await nicknameSurvivesGroup();
  await renameAndHideGroup();
  await readGroup();
  await assignGroup();
  figuresGroup();
  filterParamGroup();
  await filterReaderGroup();
  neverReachesGroup();
  copyGroup();

  console.log('');
  if (failures.length > 0) {
    console.log(`${failures.length} assertion(s) failed:`);
    for (const line of failures) console.log(`  - ${line}`);
    process.exit(1);
  }
  console.log('All portfolio assertions passed.');
}

void main();
