/**
 * A closed broker trade becomes a row in the journal (REF-107 Stage 2).
 *
 * This is the module that reverses the oldest decision in the integration.
 * REF-90 wrote "return the answer, not the data" into ./fills.ts and meant it;
 * Stage 1 returned the rows but persisted nothing. Here they land in
 * `trade_plans`, which is the first time a trader's positions are stored by us,
 * and from there every feature reads them — journal, calendar, stats,
 * dashboard, setups, rules — because they are ordinary rows in the one table.
 *
 * SERVER ONLY. It is reached from three places, and the list is the whole of
 * E9: after the day pull in /api/tradovate/today (free — the rows are already
 * built), from POST /api/tradovate/sync on demand, and from the daily cron
 * /api/cron/tradovate-import.
 *
 *
 * THE FLAG, AND WHY THE DEPLOY ORDER IS FREE
 * ------------------------------------------
 *
 * Migration 034 is run BY HAND by the owner, and the repo cannot know when.
 * So {@link isImportEnabled} gates every line of this module that names a
 * column 034 adds, and it reads one environment variable:
 *
 *     TRADOVATE_IMPORT_ENABLED=1
 *
 * Unset — which is every deployment until the owner sets it — and the import is
 * a NO-OP: no insert, no update, not even a select, and the rule engine issues
 * exactly the queries it issued before. So the order is: deploy, run 034, then
 * set the flag. Setting it first is the one ordering that breaks, and it breaks
 * loudly on an undefined column rather than silently.
 *
 * '1' and not any truthy string, deliberately. `TRADOVATE_IMPORT_ENABLED=0`
 * and `=false` are the two things somebody types when they mean OFF, and both
 * are truthy.
 *
 *
 * WHOSE ROWS THESE ARE — THE RLS DECISION (§C12)
 * ---------------------------------------------
 *
 * Every write to `trade_plans` that exists today comes from the BROWSER, under
 * the user's own RLS: the policy is `FOR ALL USING (auth.uid() = user_id)`, so
 * the database itself enforces that a user writes only their own rows. A
 * server-side import with the service-role key bypasses that entirely, and one
 * bug in a `user_id` puts one trader's trades in another's journal with no
 * safety net left.
 *
 * So {@link importBrokerTrades} TAKES THE CLIENT RATHER THAN MAKING ONE, and on
 * the two request paths the client it is given is the user's own session client
 * — /api/tradovate/today already authenticates the user before it reads
 * anything, and that session is the identity. RLS is still the enforcer there.
 *
 * The cron is the exception and it cannot be otherwise: a background job has no
 * session. It uses the service-role client, and the service role is used for
 * ONE thing — listing which users have a connection — after which each user's
 * import runs through this same function with that user's id. Three properties
 * hold on both paths and are what stands in for RLS on the third:
 *
 *   1. `userId` is a parameter and is never read from a request body, a query
 *      string or a header. On the request paths it comes from the session
 *      cookie; in the cron it comes from the connection row being processed.
 *   2. EVERY statement below carries the user. Inserts set `user_id` explicitly;
 *      the select and every update filter `.eq('user_id', userId)`. There is no
 *      statement that could touch a row belonging to anyone else even with RLS
 *      switched off, because the predicate is in the statement.
 *   3. An empty or non-string `userId` throws before any statement runs.
 *
 *
 * WHAT IT WRITES, AND WHAT IT REFUSES TO TOUCH
 * --------------------------------------------
 *
 * EXECUTION FACTS ONLY — {@link EXECUTION_FACTS}. Prices, quantity, direction,
 * symbol, money, the two instants, the status, and the provenance columns. Those
 * are the broker's to state and it restates them on every pull.
 *
 * NEVER the intent columns, and never on an existing row: `strategy`,
 * `stop_loss`, `take_profit`, `rr_ratio`, `trade_reason`, `emotional_state`,
 * the self-reported discipline flags, `setup_id`, `post_trade_notes`,
 * `plan_score`. A trader who opens an imported row and writes down why they
 * took it has done the most valuable thing this product asks of them, and a
 * sync that overwrote it an hour later would be unforgivable. On an INSERT they
 * are simply not named — 034 made them nullable precisely so that no
 * placeholder has to be invented (E4) — and on an UPDATE they are not in the
 * fact list.
 *
 * `unplanned` and `rule_context_source` are written ON INSERT ONLY, for the same
 * reason. Stage 3 links a plan to an imported trade and will clear `unplanned`;
 * a re-import that set it back to true would undo that link on the next pull.
 *
 *
 * THE THREE RULES THAT DECIDE WHETHER A TRADE IS IMPORTED
 * ------------------------------------------------------
 *
 * 1. **The position must be flat.** `BrokerTrade.positionFlat`, and the reason
 *    is §A3: the key is the group's lowest fill id, and a group can still GROW
 *    while the trader holds contracts. Write a key mid-position and the next
 *    sync writes a SECOND row under a different key — a duplicate the partial
 *    UNIQUE cannot catch, because both keys are genuinely distinct. This is the
 *    one rule that costs a visible absence: a trade scaled out of in pieces
 *    does not appear until the last piece is gone. That is the right trade — an
 *    absence corrects itself on the next pull, a duplicate does not.
 * 2. **A hidden row is left alone.** E12 made "delete" a flag rather than a
 *    DELETE, because a DELETE comes back on the next sync. So a key whose row is
 *    hidden is skipped entirely — not updated, not unhidden.
 * 3. **The connection must declare itself a trade source.** E7, and
 *    {@link readIsTradeSource} is the declaration. A trader who has said
 *    Tradovate is NOT the source of trades for their account gets no imported
 *    rows at all, which is the only coherent reading of that declaration: the
 *    alternative — importing rows the rules then ignore — is a journal that
 *    disagrees with the figures beside it.
 *
 *
 * IDEMPOTENCE IS MEASURED, NOT ASSERTED
 * -------------------------------------
 *
 * A second import of the same trades issues ZERO writes. Not "writes the same
 * values again" — zero. Every fact is compared against what is already stored
 * before an update is sent, which is what makes "run the sync as often as you
 * like" a safe thing to say, and what makes the test for it a real test rather
 * than a tautology. The partial UNIQUE index in 034 is the backstop underneath
 * that, not the mechanism: application logic alone is a race, and an index is
 * not.
 *
 *
 * NOT AN UPSERT, AND THAT IS NOT A STYLE CHOICE
 * ---------------------------------------------
 *
 * PostgREST's `upsert(..., { onConflict })` compiles to `ON CONFLICT (cols) DO
 * UPDATE`, and Postgres cannot INFER A PARTIAL INDEX from a bare column list —
 * a partial index is only inferable when the statement repeats its predicate,
 * which PostgREST has no way to express. Against 034's
 * `UNIQUE (user_id, broker_trade_key) WHERE broker_trade_key IS NOT NULL` an
 * upsert would fail with "no unique or exclusion constraint matching the ON
 * CONFLICT specification". So this reads, then inserts the new and updates the
 * changed. The 23505 that a concurrent insert produces is caught and retried as
 * an update — see {@link UNIQUE_VIOLATION}.
 *
 * It is also the only shape in which the two column sets can DIFFER, which
 * rules 2 and 3 of the previous section require.
 *
 *
 * LOGS
 * ----
 *
 * Counts only, through redactSecrets like every diagnostic here. No symbol, no
 * price, no fill id, no account id, no user id. A daily job over every connected
 * trader is the last place to start writing a trader's positions into Vercel's
 * logs, and a count is what tells an operator the mechanism is alive.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { TradovateEnvironment } from './hosts';
import type { BrokerTrade } from './fills';
import { redactSecrets } from './redact';
import { TRADING_CURRENCY } from '@/lib/money';
import type { TradovateHost } from '@/lib/types';

/**
 * `TradovateHost` (lib/types.ts, browser-safe) and `TradovateEnvironment`
 * (./hosts.ts, server-only) must stay the same two values.
 *
 * The duplication is deliberate — ./hosts.ts is server-only by construction and
 * `broker_host` travels to the browser on every journal row — so this is the
 * compile-time check that they have not drifted. Assignable both ways means
 * identical; a third value added to either union breaks the build here, which
 * is where somebody will be reading about why there are two.
 */
const _hostToType: TradovateHost = 'live' as TradovateEnvironment;
const _typeToHost: TradovateEnvironment = 'live' as TradovateHost;
void _hostToType;
void _typeToHost;

/** The environment variable that turns the import on. See the header. */
export const IMPORT_FLAG = 'TRADOVATE_IMPORT_ENABLED';

/**
 * Whether anything in this module may name a column migration 034 adds.
 *
 * Exactly `'1'`. See the header on why not any truthy value.
 *
 * `env` is a parameter for the same reason ./allowlist.ts takes one: the test
 * suite has to be able to drive both states, and reading `process.env` inside
 * would make "the flag is off" untestable without mutating the process.
 */
export function isImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IMPORT_FLAG] === '1';
}

/** What one import did. Counts only — see the header. */
export interface BrokerImportCounts {
  /**
   * Whether the import actually ran. False means the flag is off or the
   * connection does not declare itself a trade source, and every count below is
   * zero for a reason that is not "nothing happened".
   */
  ran: boolean;
  /** Trades handed in, before any rule was applied. */
  offered: number;
  /** Rows inserted. */
  imported: number;
  /** Existing rows whose execution facts had moved and were restated. */
  updated: number;
  /** Existing rows already correct. Nothing was written for these. */
  unchanged: number;
  /** Skipped: the position is not known to be flat (§A3, rule 1). */
  skippedOpen: number;
  /** Skipped: the row is hidden, which is what delete means here (E12). */
  skippedHidden: number;
  /** Rows the database refused. Nothing is concluded; the next run retries. */
  failed: number;
}

const NOTHING: BrokerImportCounts = Object.freeze({
  ran: false,
  offered: 0,
  imported: 0,
  updated: 0,
  unchanged: 0,
  skippedOpen: 0,
  skippedHidden: 0,
  failed: 0,
});

/** Postgres unique-violation SQLSTATE. A concurrent insert of the same key. */
const UNIQUE_VIOLATION = '23505';

/**
 * The columns the broker owns, and the only ones an existing row has restated.
 *
 * ORDER AND MEMBERSHIP ARE THE POLICY. Adding a column here hands it to the
 * broker forever: every sync will overwrite whatever the trader put in it. The
 * test suite asserts that a trader-edited `strategy` survives a re-import, which
 * is the regression that catches an accidental addition.
 *
 * `kind` is how each value is compared against what is stored, and it is needed
 * because PostgREST does not round-trip these types: a `NUMERIC` comes back as
 * a STRING often enough that the journal's CSV export once silently dropped
 * every R:R by testing `typeof === 'number'` (REF-107 Stage 4), and a
 * `TIMESTAMPTZ` comes back as `+00:00` where we sent `Z`. Comparing the wire
 * forms would report every row as changed on every pull, which is idempotence
 * lost to a formatting difference.
 */
const EXECUTION_FACTS = [
  { column: 'source', kind: 'exact' },
  { column: 'broker_account_id', kind: 'number' },
  { column: 'broker_host', kind: 'exact' },
  { column: 'symbol', kind: 'exact' },
  { column: 'direction', kind: 'exact' },
  { column: 'entry_price', kind: 'number' },
  { column: 'exit_price', kind: 'number' },
  { column: 'quantity', kind: 'number' },
  { column: 'actual_pnl', kind: 'number' },
  { column: 'pnl_currency', kind: 'exact' },
  { column: 'submitted_at', kind: 'instant' },
  { column: 'closed_at', kind: 'instant' },
  { column: 'status', kind: 'exact' },
] as const satisfies readonly { column: string; kind: 'exact' | 'number' | 'instant' }[];

/**
 * {@link EXECUTION_FACTS}, for the regression suite.
 *
 * Exported under a name nothing in `src/` would reach for by accident, because
 * the list is a POLICY and the suite's job is to assert its membership: adding
 * an intent column to it hands that column to the broker forever, and
 * scripts/broker-import-check.ts is what says so out loud.
 */
export const EXECUTION_FACTS_FOR_TEST: readonly { column: string }[] = EXECUTION_FACTS;

/** Every column the select has to bring back so a comparison is possible. */
const EXISTING_COLUMNS = [
  'id',
  'broker_trade_key',
  'hidden',
  ...EXECUTION_FACTS.map((fact) => fact.column),
].join(', ');

type FactValues = Record<string, string | number | null>;

/**
 * The broker's facts about one trade, as column values.
 *
 * `submitted_at` IS THE ENTRY TIME AND `closed_at` IS THE EXIT TIME, and that
 * is §C10.6 rather than a detail. The two columns have two different
 * semantics in this product: `submitted_at` is the axis the journal, the
 * calendar, the P&L charts and the identity card are grouped by, and `closed_at`
 * is the axis the rules measure. Putting the close instant in both would file a
 * trade entered at 23:50 under the following day in the calendar.
 *
 * `pnl_amount` is deliberately not written. `tradeMoneyPnl` prefers
 * `actual_pnl`, which is the broker's own figure and the better of the two, and
 * `pnl_amount` is points × units × point_value — a number this row has no
 * honest inputs for.
 */
function facts(trade: BrokerTrade): FactValues {
  return {
    source: 'tradovate',
    broker_account_id: trade.accountId,
    broker_host: trade.host,
    symbol: trade.symbol,
    direction: trade.direction,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    quantity: trade.qty,
    actual_pnl: trade.pnlUsd,
    pnl_currency: TRADING_CURRENCY,
    submitted_at: new Date(trade.openedAtMs).toISOString(),
    closed_at: new Date(trade.closedAtMs).toISOString(),
    status: 'closed',
  };
}

/** Whether a stored value already says what the broker is saying. */
function alreadyStated(kind: 'exact' | 'number' | 'instant', stored: unknown, wanted: string | number | null): boolean {
  if (wanted === null) return stored === null || stored === undefined;
  if (stored === null || stored === undefined) return false;

  if (kind === 'number') {
    const a = Number(stored);
    const b = Number(wanted);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (kind === 'instant') {
    const a = Date.parse(String(stored));
    const b = Date.parse(String(wanted));
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return String(stored) === String(wanted);
}

/** The subset of facts this row does not already state. Empty means no write. */
function changedFacts(stored: Record<string, unknown>, wanted: FactValues): FactValues {
  const changes: FactValues = {};
  for (const { column, kind } of EXECUTION_FACTS) {
    if (!alreadyStated(kind, stored[column], wanted[column])) changes[column] = wanted[column];
  }
  return changes;
}

/**
 * One row for a trade the journal has never seen.
 *
 * NOT ONE INTENT COLUMN IS NAMED. 034 made all six nullable for exactly this
 * insert, and naming them with a placeholder is the thing E4 refused.
 *
 * `unplanned: true` is 032's column doing the job it was added for — its own
 * migration says so: "a trade that reaches the journal with no plan behind it…
 * REF-90 (the broker pull layer) is what produces such a row, and it is not
 * built." It is built now. The row counts toward the rules, which 032 also
 * argues for: otherwise a trader who loses twice without filling the form gets
 * a clean verdict from the form afterwards.
 *
 * `rule_context_source: 'broker_verified'` means something slightly different
 * here than it does on a plan. On a plan it records what the rule check had in
 * hand. On an imported row there was no rule check — the trade had already
 * happened — and the honest reading of the column is the stronger one: this
 * row's facts came from the broker, not from somebody typing.
 */
function newRow(userId: string, trade: BrokerTrade): Record<string, unknown> {
  return {
    user_id: userId,
    broker_trade_key: trade.brokerTradeKey,
    unplanned: true,
    rule_context_source: 'broker_verified',
    ...facts(trade),
  };
}

export interface ImportRequest {
  /**
   * The client the write goes through, and therefore the identity it runs as.
   *
   * The user's own session client on the two request paths, so RLS enforces
   * ownership. The service-role client in the cron, where there is no session —
   * see the header for the three properties that stand in for RLS there.
   */
  client: SupabaseClient;
  /** Whose trades these are. From the session or the connection row, never a request. */
  userId: string;
  /** The pull's rows. Already closed round trips by construction (./fills.ts). */
  trades: readonly BrokerTrade[];
  /**
   * Whether the connection declares the broker a source of trades (E7).
   *
   * MANDATORY AND NOT DEFAULTED, like `broker` on loadTradeRuleContext and for
   * the same reason: there are three call sites, each gets this from a different
   * place, and a default would let one of them silently import for a trader who
   * said not to. Read it with {@link readIsTradeSource}.
   */
  isTradeSource: boolean;
  /** Test seam for the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Write the closed broker trades that are not in the journal yet.
 *
 * Never throws for a reason the caller can do nothing about: a refused row is
 * counted as `failed` and the run continues, because one bad row must not cost
 * the other nine. It DOES throw on a bad `userId`, which is a programming error
 * and the one thing that must not be tolerated here.
 */
export async function importBrokerTrades(request: ImportRequest): Promise<BrokerImportCounts> {
  const { client, userId, trades, isTradeSource, env = process.env } = request;

  // Before anything else, and not an assertion about data: a falsy or
  // non-string user id reaching the cron's service-role client is the one bug
  // in this module that could write into somebody else's journal. Fail loudly
  // at the top rather than build a statement around it.
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('importBrokerTrades: userId must be a non-empty string.');
  }

  if (!isImportEnabled(env) || !isTradeSource) return NOTHING;

  const counts: BrokerImportCounts = { ...NOTHING, ran: true, offered: trades.length };

  // Every refusal the run met, as SQLSTATE codes and nothing else — one line at
  // the end rather than a line per row, so a bad batch is one log entry and a
  // good one is one log entry.
  const refusals: string[] = [];

  // Rule 1 (§A3). Done first and counted, so a pull that imported nothing can
  // be told apart from a pull that found nothing.
  const flat = trades.filter((trade) => trade.positionFlat);
  counts.skippedOpen = trades.length - flat.length;
  if (flat.length === 0) {
    report(counts, refusals);
    return counts;
  }

  // One read for the whole batch. `.in()` on the key plus the user filter, so
  // the statement carries ownership whatever the client's privileges are.
  const keys = [...new Set(flat.map((trade) => trade.brokerTradeKey))];
  const { data: existingRows, error: readError } = await client
    .from('trade_plans')
    .select(EXISTING_COLUMNS)
    .eq('user_id', userId)
    .in('broker_trade_key', keys);

  if (readError) {
    // Nothing is known about what is already there, so nothing may be written:
    // inserting blind would duplicate every row the read failed to see. Same
    // rule as everywhere in this integration — a failure to ask is not an
    // answer.
    counts.failed = flat.length;
    report(counts, [`read:${readError.code ?? 'none'}`]);
    return counts;
  }

  const existing = new Map<string, Record<string, unknown>>();
  // Through `unknown`: EXISTING_COLUMNS is assembled from EXECUTION_FACTS at
  // runtime, and supabase-js infers a row shape by parsing the select string at
  // the TYPE level — which it cannot do for a joined array. The alternative is
  // writing the column list twice, once for Postgres and once for TypeScript,
  // and a drift between those two lists is a fact silently never compared.
  for (const row of (existingRows ?? []) as unknown as Record<string, unknown>[]) {
    const key = row.broker_trade_key;
    if (typeof key === 'string') existing.set(key, row);
  }

  // Sequential. The batch is a handful of trades, there is no deadline on any
  // of the three call sites, and a parallel write would multiply the unique-
  // violation race below for nothing.
  for (const trade of flat) {
    const stored = existing.get(trade.brokerTradeKey);

    if (stored) {
      // Rule 2 (E12). A hidden row is the trader's deletion and is not touched.
      if (stored.hidden === true) {
        counts.skippedHidden += 1;
        continue;
      }
      await restate(client, userId, String(stored.id), stored, trade, counts, refusals);
      continue;
    }

    const { error } = await client.from('trade_plans').insert(newRow(userId, trade));

    if (!error) {
      counts.imported += 1;
      continue;
    }

    // Somebody inserted this key between the read and now — the other two
    // triggers can overlap, and the cron can overlap a form opening. The index
    // did its job; the row exists, so this becomes the update it would have
    // been had the read seen it. Re-read rather than trust the row we did not
    // see.
    if (error.code === UNIQUE_VIOLATION) {
      await restateByKey(client, userId, trade, counts, refusals);
      continue;
    }

    counts.failed += 1;
    // The CODE, never the message: a PostgREST message can echo the row back,
    // and the row is this trader's position.
    refusals.push(`insert:${error.code ?? 'none'}`);
  }

  report(counts, refusals);
  return counts;
}

/** Restate the facts on a row we have already read. Zero writes when correct. */
async function restate(
  client: SupabaseClient,
  userId: string,
  id: string,
  stored: Record<string, unknown>,
  trade: BrokerTrade,
  counts: BrokerImportCounts,
  refusals: string[]
): Promise<void> {
  const changes = changedFacts(stored, facts(trade));

  // THE WHOLE OF IDEMPOTENCE, IN ONE BRANCH. A re-import of an unchanged trade
  // reaches here and returns without sending a statement.
  if (Object.keys(changes).length === 0) {
    counts.unchanged += 1;
    return;
  }

  // Both predicates, not just the id: the id came from a read filtered by
  // user, so this is belt and braces — but it is the statement that would be
  // wrong if the id ever came from somewhere else.
  const { error } = await client
    .from('trade_plans')
    .update(changes)
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    counts.failed += 1;
    refusals.push(`update:${error.code ?? 'none'}`);
    return;
  }
  counts.updated += 1;
}

/**
 * Re-read one key and restate it. The concurrent-insert path only.
 *
 * A second read rather than an unconditional update, because the row that won
 * the race may be HIDDEN — a trader deleting a broker row while a cron is
 * mid-run is unlikely and is exactly the kind of unlikely that resurrects a
 * deleted trade once a month and is never diagnosed.
 */
async function restateByKey(
  client: SupabaseClient,
  userId: string,
  trade: BrokerTrade,
  counts: BrokerImportCounts,
  refusals: string[]
): Promise<void> {
  const { data, error } = await client
    .from('trade_plans')
    .select(EXISTING_COLUMNS)
    .eq('user_id', userId)
    .eq('broker_trade_key', trade.brokerTradeKey)
    .maybeSingle();

  if (error || !data) {
    counts.failed += 1;
    refusals.push(`conflict:${error?.code ?? 'norow'}`);
    return;
  }

  const stored = data as unknown as Record<string, unknown>;
  if (stored.hidden === true) {
    counts.skippedHidden += 1;
    return;
  }
  await restate(client, userId, String(stored.id), stored, trade, counts, refusals);
}

/**
 * One line per run, counts only, through redactSecrets. See the header.
 *
 * Refusals are deduplicated SQLSTATE codes. Ten rows refused for the same
 * reason is one reason, and the count beside it already says ten.
 */
function report(counts: BrokerImportCounts, refusals: readonly string[]): void {
  const line =
    `[tradovate][import] offered=${counts.offered} imported=${counts.imported} ` +
    `updated=${counts.updated} unchanged=${counts.unchanged} ` +
    `skippedOpen=${counts.skippedOpen} skippedHidden=${counts.skippedHidden} ` +
    `failed=${counts.failed}` +
    (refusals.length > 0 ? ` refusals=${[...new Set(refusals)].join(',')}` : '');

  if (counts.failed > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));
}
