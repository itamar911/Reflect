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
 * reason. Stage 3b's auto-link clears `unplanned`, and a re-import that set it
 * back to true would undo that link on the next pull.
 *
 * AND THERE IS NOW A THIRD CATEGORY — TWO COLUMNS THE BROKER FILLS ONLY WHEN
 * THEY ARE EMPTY (REF-113 Stage 3). `moved_sl` and `kept_sl` are the trader's to
 * own and the broker's to measure, and the reconciliation is: written once, into
 * a NULL, and never restated. A trader who disagrees with "you moved your stop"
 * and unticks the box must not find it ticked again an hour later.
 *
 * `stop_loss` AND `take_profit` ARE NOT IN THAT CATEGORY AND ARE NEVER WRITTEN
 * BY THIS MODULE AT ALL. The broker's protective prices live in
 * `broker_stop_loss` and `broker_take_profit`, which is what 038 adds them for:
 * writing the trader's own two columns made an UNPLANNED row score 30/60 on
 * planning under a J1 label reading "לא הוגשה תוכנית", and let one journal edit
 * mint an `rr_ratio` from the broker's numbers. See {@link fillWhenEmpty}, which
 * has both measurements.
 *
 *
 * THE MATCHING PASS, AND WHY A TRADE CAN ARRIVE WITHOUT A ROW OF ITS OWN
 * ---------------------------------------------------------------------
 *
 * Stage 3b (§B) put a question in front of the insert: does this trade belong
 * to a plan the trader submitted before they entered? {@link decideLinks} asks
 * it once per run, in one grouped select, with zero upstream calls — and when
 * the answer is exactly one plan, {@link linkOnto} writes the trade ONTO that
 * plan and no broker row is created at all.
 *
 * SO THE TWO COLUMN SETS NOW HAVE A THIRD CASE, and the counts say which
 * happened: `imported` is a row that was inserted, `linkedAuto` is a plan that
 * became the trade, `queued` is a trade the matcher refused to guess about.
 * `imported + linkedAuto` is how many trades the journal gained.
 *
 * ONE ROW PER TRADE, ALWAYS, is the property all of this protects (§0א). Eleven
 * readers count rows — the journal, the calendar, the dashboard, the stats, the
 * rule engine, the weekly summary — and none of them knows what a link is. A
 * design that left two rows for one trade, even for a moment, would have to
 * teach all eleven; this one does not have to teach any.
 *
 *
 * THE THREE RULES THAT DECIDE WHETHER A TRADE IS IMPORTED
 * ------------------------------------------------------
 *
 * 1. **The logical position must have closed.** `BrokerTrade.cycleClosed`
 *    (REF-117 Stage 2), which replaced `positionFlat` and narrowed what this
 *    rule claims. The old field asked whether the CONTRACT was flat right now,
 *    so re-entering it turned the rule against trades that had already finished
 *    and withheld them from the journal — the 19.10 case where the trader
 *    concluded something had broken. The new one asks whether THIS CYCLE closed,
 *    which no later trade can undo.
 *
 *    The rule survives the rename because the reason changed rather than
 *    disappeared. §A3's hazard was a key that could MOVE: a later pair could
 *    bridge two union-find groups and the merged group's lowest fill id might be
 *    the other group's. Cycles cannot do that — a closed cycle ends at
 *    `netPos = 0` and nothing after it can join. What remains is simpler: an
 *    OPEN cycle's quantity, exit price and P&L all still move, so a row written
 *    mid-cycle would be restated on every pull. The gate is now "is this row
 *    finished" rather than "is this key stable".
 *
 *    It still costs a visible absence — a trade scaled out of in pieces does not
 *    appear until the last piece is gone — and that is still the right trade: an
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

import { accountIdentity } from './accounts';
import type { TradovateEnvironment } from './hosts';
import type { BrokerTrade, TradeStages } from './fills';
import type { StopHistory } from './orders';
import {
  MATCH_WINDOW_MS,
  matchBrokerTrade,
  type CandidatePlan,
  type MatchResult,
} from './match';
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

/**
 * How many plans one grouped read may bring back.
 *
 * The read is already narrowed to `status = 'open'`, `source = 'manual'` and an
 * eight-hour window around the batch, so a trader would have to have submitted
 * two hundred plans inside one trading day to reach this. It is here because an
 * unbounded select in a daily job over every connected trader is the kind of
 * thing that is fine until it is not, and the failure mode if it ever bites is
 * the queue — which is a screen the trader can work, not a lost trade.
 */
const CANDIDATE_LIMIT = 200;

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
  /**
   * Trades that found exactly one plan and were written onto it (Stage 3b).
   *
   * These produced NO broker row at all — the plan is the trade. So they are
   * not in `imported`, and `imported + linkedAuto` is how many trades the
   * journal gained.
   */
  linkedAuto: number;
  /**
   * Trades that found no plan, or more than one, and went to the queue.
   *
   * A count of DECISIONS, where `imported` is a count of ROWS: they differ
   * when an insert is refused or loses the unique race. Both are logged so
   * that "the matcher declined to guess" can be told apart from "the database
   * declined to write".
   */
  queued: number;
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
  linkedAuto: 0,
  queued: 0,
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
type FactKind = 'exact' | 'number' | 'instant' | 'json';

const EXECUTION_FACTS = [
  { column: 'source', kind: 'exact' },
  { column: 'broker_account_id', kind: 'number' },
  { column: 'broker_host', kind: 'exact' },
  // REF-110 Stage 2, and it is in this list DELIBERATELY rather than by
  // analogy. The question the list asks is "may the broker overwrite what the
  // trader put here", and for `account_id` the answer is yes: it is derived
  // from `broker_account_id` and `broker_host`, which are already the broker's
  // two lines above, so a trader who reassigned an IMPORTED row to a different
  // portfolio is asserting something the broker directly contradicts. Manual
  // rows are never in this list's reach — Stage 3's form owns those.
  //
  // THE COLUMN IS ONLY COMPARED WHEN THE PULL CAN RESOLVE IT. See {@link facts}:
  // an unresolvable account leaves the key OUT of the wanted record entirely,
  // and {@link changedFacts} then skips it rather than restating a NULL. That
  // is what stops `/api/tradovate/today` — which has no identity map — from
  // clearing an assignment the sync made an hour earlier.
  { column: 'account_id', kind: 'exact' },
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
  // REF-113 Stage 3, and all three are in this list for `account_id`'s reason
  // rather than by analogy: they are derived from the broker's own orders, so a
  // trader cannot be asserting anything about them that the broker contradicts.
  //
  // AND ALL THREE ARE PRESENT-OR-ABSENT, WHICH IS THE WHOLE SAFETY ARGUMENT.
  // See {@link facts}: a pull that did not read the orders leaves the keys OUT
  // of the wanted record, and {@link changedFacts} skips them rather than
  // restating a NULL. Without that, the nightly 03:30 cron — which CANNOT see
  // the orders of the day it imports, because Tradovate rolled the trading day
  // over four and a half hours earlier — would overwrite with NULL every stop
  // history the end-of-day summary captured six hours before. That is the most
  // destructive thing this stage could have shipped, and the fix was already in
  // the file.
  { column: 'broker_stop_loss', kind: 'number' },
  { column: 'broker_take_profit', kind: 'number' },
  // `json` AND NOT `exact`. A JSONB column comes back from PostgREST as an
  // OBJECT, and `String(obj) === String(obj)` is
  // `'[object Object]' === '[object Object]'` — always true, so the column would
  // be compared equal to everything and NEVER updated. A silent trap, and the
  // reason this kind exists at all.
  { column: 'stop_history', kind: 'json' },
  // REF-117 Stage 6, migration 040. In this list for the reason `account_id`
  // is: it is derived from the broker's own fills, so a trader cannot be
  // asserting anything about it that the broker contradicts.
  //
  // UNLIKE THE FOUR ABOVE IT IS NOT PRESENT-OR-ABSENT, and the asymmetry is
  // worth knowing. The stop columns are absent on two of the four triggers
  // because two of them CANNOT read `/order/list` — so a NULL there would
  // erase what another trigger captured. The stages come off the same
  // `/fill/list` pass that produces the trade itself, so EVERY trigger that
  // can state a trade can state its stages, and there is no trigger whose
  // silence has to be protected. A row that somehow has none gets one honest
  // NULL rather than a reason to keep guessing.
  { column: 'broker_stages', kind: 'json' },
] as const satisfies readonly { column: string; kind: FactKind }[];

/**
 * {@link EXECUTION_FACTS}, for the regression suite.
 *
 * Exported under a name nothing in `src/` would reach for by accident, because
 * the list is a POLICY and the suite's job is to assert its membership: adding
 * an intent column to it hands that column to the broker forever, and
 * scripts/broker-import-check.ts is what says so out loud.
 */
export const EXECUTION_FACTS_FOR_TEST: readonly { column: string }[] = EXECUTION_FACTS;

/**
 * Every column the select has to bring back so a comparison is possible.
 *
 * THE TWO AT THE END ARE NOT FACTS AND ARE NEVER RESTATED. They are read for one
 * question — "has the trader left this empty?" — which is the whole of
 * {@link fillWhenEmpty}. A column in this list is a column the comparison can
 * SEE; only {@link EXECUTION_FACTS} decides what may be written.
 *
 * `stop_loss`, `take_profit` and `unplanned` were in this list and are gone,
 * which is the shape of the Stage 3 correction: nothing reads them here any
 * more, because the broker no longer writes the first two on any row and so has
 * no reason to ask whether they are empty or whose row it is.
 *
 * `stop_history` ARRIVES HERE THROUGH `EXECUTION_FACTS`, which makes this select
 * the reason migration 038 must be run BEFORE this code deploys: the flag it is
 * gated behind is already '1' in production, so without 038 every import answers
 * PostgREST 42703 and nothing is imported at all. 038's header says so at the
 * top, and this is the line it is talking about.
 *
 * `broker_stages` ARRIVES THE SAME WAY AND CARRIES THE SAME DEBT (REF-117
 * Stage 6, migration 040). The sentence above is now true of two migrations,
 * and the failure is identical and total: not "the stages are missing" but "no
 * trade is imported". **Run 040, then deploy.** There is no flag gating it
 * separately, on purpose — a second environment variable per migration is a
 * second thing to get wrong forever, and stating the order is what 038 chose.
 */
const EXISTING_COLUMNS = [
  'id',
  'broker_trade_key',
  'hidden',
  ...EXECUTION_FACTS.map((fact) => fact.column),
  // Read to be checked for emptiness, never to be restated (REF-113 Stage 3).
  'moved_sl',
  'kept_sl',
].join(', ');

/**
 * A value a statement may carry.
 *
 * `StopHistory` is in the union because one column is JSONB. `boolean` is in it
 * for `moved_sl`/`kept_sl`, which are not facts — they travel in the same
 * statement, never through {@link changedFacts}.
 */
type FactValue = string | number | boolean | null | StopHistory | TradeStages;
type FactValues = Record<string, FactValue>;

/**
 * What the pull worked out BESIDE the trades, and what every writer below needs.
 *
 * One object rather than two trailing optional parameters on five functions. Both
 * members are maps the pull built once, both are optional, and the absence of
 * either is a supported state rather than a degraded one — which is exactly why
 * they belong together: the rule for reading them is the same rule.
 */
interface Derived {
  /** `${host}:${brokerAccountId}` → `accounts.id` (REF-110 Stage 2). */
  accountIds?: ReadonlyMap<string, string>;
  /** `brokerTradeKey` → the broker's stop history (REF-113 Stage 3). */
  stopHistories?: ReadonlyMap<string, StopHistory>;
}

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
 *
 *
 * `account_id` IS PRESENT OR ABSENT, AND NEVER NULL (REF-110 Stage 2)
 * -------------------------------------------------------------------
 *
 * Three states, not two, and conflating the last two is the bug this shape
 * exists to prevent:
 *
 *   resolved      → the column is named, and an existing row is restated to it
 *   NOT RESOLVED  → the key is ABSENT from the record, and the column is not
 *                   named in any statement — not on the insert, not in the
 *                   comparison
 *
 * "Not resolved" is the ordinary case on two of the three triggers.
 * `/api/tradovate/today` passes no identity map at all, because it does not run
 * the account sync; and the very first sync on a database where 037 has just
 * run has an empty `accounts` table until the pass that fills it. If an absent
 * account resolved to NULL instead, `/today` would CLEAR the assignment on
 * every imported row, every time a trader opened the trade form — silently
 * undoing the backfill between one sync and the next.
 *
 * So the absence is load-bearing, and it is also what keeps the deploy honest:
 * with no map, every statement this module issues is byte-identical to the one
 * it issued before REF-110.
 *
 *
 * AND THE THREE STOP COLUMNS TAKE EXACTLY THAT SHAPE (REF-113 Stage 3)
 * -------------------------------------------------------------------
 *
 * For a harder reason than `account_id`'s. Two of this module's four triggers
 * CANNOT EVER read the orders:
 *
 *   - the nightly cron runs at 03:30 UTC, four and a half hours after Tradovate
 *     rolled the trading day over, so `/order/list` no longer holds the orders of
 *     the day it is importing — not today, and not on any future run;
 *   - `/api/tradovate/today` does not read them on purpose, because it is free
 *     precisely by not making extra passes.
 *
 * If an unread history resolved to NULL, those two would ERASE, every night and
 * every time a trader opened the trade form, what the Sync button and the
 * end-of-day summary had captured hours earlier. The absence is what makes the
 * four triggers safe to overlap, which is the property the whole module is built
 * on.
 *
 * THE TWO PRICE COLUMNS ARE ABSENT WHENEVER THERE IS NO PRICE, even when the
 * history itself is present. An `'unknown'` or a `'none'` has no stop to state,
 * and naming the column with a NULL would be the same erasure in a smaller form.
 */
function facts(trade: BrokerTrade, derived: Derived = {}): FactValues {
  const accountId = derived.accountIds?.get(accountIdentity(trade.host, trade.accountId));
  const stop = derived.stopHistories?.get(trade.brokerTradeKey);

  return {
    source: 'tradovate',
    broker_account_id: trade.accountId,
    broker_host: trade.host,
    ...(accountId === undefined ? {} : { account_id: accountId }),
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
    // REF-117 Stage 6, and UNCONDITIONALLY rather than present-or-absent: the
    // stages come off the same `/fill/list` pass that produced this row, so
    // every trigger that can state a trade can state them. See the note in
    // {@link EXECUTION_FACTS} on why that makes them unlike the stop columns.
    broker_stages: trade.stages,
    ...(stop === undefined
      ? {}
      : {
          stop_history: stop,
          ...(stop.initialStop === null ? {} : { broker_stop_loss: stop.initialStop }),
          ...(stop.initialTarget === null ? {} : { broker_take_profit: stop.initialTarget }),
        }),
  };
}

/**
 * The two columns the broker fills ONLY WHEN THE TRADER LEFT THEM EMPTY
 * (REF-113 Stage 3).
 *
 * NOT FACTS, AND DELIBERATELY NOT IN {@link EXECUTION_FACTS}. `moved_sl` and
 * `kept_sl` are self-report: `CloseTrade.tsx` is what writes them, from a
 * checkbox. Putting them in the fact list would hand them to the broker forever
 * — a trader who disagrees with the verdict and unticks the box would find it
 * ticked again on the next sync, which is the one interaction that would teach
 * them to stop trusting the figures. So these are written once, into a NULL, and
 * never restated.
 *
 * `restate()` ALREADY HOLDS `stored`, so this is a small special case rather than
 * a new mechanism. On an insert there is nothing stored and both are free.
 *
 *
 * THE THREE RULES, AND WHY EACH ONE FAILS SILENT RATHER THAN LOUD
 * --------------------------------------------------------------
 *
 * 1. `moved_sl` is written for `'moved'` and `'kept'` and FOR NOTHING ELSE.
 *    `'none'` (no stop was placed) and `'unknown'` both leave it NULL, which is
 *    how every consumer already reads "no answer": `stats/page.tsx` and
 *    `DashboardClient.tsx` both filter `!== null` today, so decision 2 needed no
 *    line of code in either of them.
 *
 * 2. A TRAILING STOP DOES NOT SET IT EITHER, even though its verdict is
 *    `'moved'`. The steps of a trail are the server's, not a decision the trader
 *    took mid-trade, and the stored history says so (`trailing: true`) for the
 *    screen that explains it. This is §3's rule applied to the one case that
 *    reaches it in v1: evidence of automation may only ever take attribution
 *    away.
 *
 * 3. `kept_sl = !moved_sl`, for consistency and nothing more. It is a dead
 *    column (§E) kept alive by the AI-debrief score formula, and REF-113 is not
 *    going to become its first real consumer.
 *
 * NOTE THAT `moved_sl` IS THE ONE COLUMN WHOSE SCORE EFFECT IS AN IMPROVEMENT IN
 * BOTH DIRECTIONS. `tradeScore` reads `moved_sl === true`, so an absent
 * self-report already scored as "did not move" and collected the whole 12
 * points for having no evidence against it — which the function's own header
 * calls out and names REF-113 as the fix for. Writing `false` changes no number;
 * writing `true` deducts 12 ON EVIDENCE rather than on silence.
 *
 *
 * `stop_loss` AND `take_profit` ARE NOT HERE, AND THAT REVERSES DECISION 4
 * -----------------------------------------------------------------------
 *
 * Decision 4 of 17.10 said to fill them when NULL, and the design report asked
 * for a dedicated test case because the risk was known: filling `stop_loss` arms
 * `rr_ratio`, the planning block of `tradeScore` and `reachedStop` in
 * `proposeFlags` off a broker figure. THE TEST CASE WAS WRITTEN AND IT FAILED,
 * so the decision goes the other way. Two measured breakages, neither of them
 * recoverable by a label:
 *
 *   1. **`tradeScore` pays for a plan that does not exist.** The planning block
 *      awards `stop_loss !== null` 20 points and `take_profit !== null` 10, so
 *      an unplanned broker row scored 30/60 on planning and totalled 70 instead
 *      of 40 — while the J1 line beside it read "תכנון 30/60 — לא הוגשה
 *      תוכנית", which is a label disagreeing with its own number. J1's whole
 *      argument is that ENTERING WITHOUT A PLAN IS THE DISCIPLINE FAILURE THIS
 *      PRODUCT MEASURES; paying for the broker's own protective order as though
 *      it were a plan measures nothing.
 *
 *   2. **One edit mints an `rr_ratio` the trader never planned.** The journal's
 *      editor pre-populates its stop and target from the row and recomputes
 *      `rr_ratio = calcRR(entry, sl, tp)` on save (JournalClient.tsx). So a
 *      trader adding a note to an unplanned row would silently mint a ratio from
 *      the broker's numbers, which awards the remaining 30 planning points and
 *      takes the row to 100/100. The comment at that line already calls this
 *      "the silent corruption REF-107 §0ג is about" — it was simply unreachable
 *      until the import started filling the two columns it reads.
 *
 * SO THE BROKER'S NUMBERS LIVE IN `broker_stop_loss` AND `broker_take_profit`
 * AND NOWHERE ELSE. Nothing scores those two columns, which is the whole reason
 * 038 adds them rather than reusing the trader's. The number is stored, it is
 * displayable beside the planned one (Stage 5, `LinkConfirm.tsx`), and it no
 * longer impersonates a plan.
 *
 * E12 pointed the same way from the other end — on a LINKED PLAN the two
 * columns were never to be touched, because a trader who planned without a stop
 * planned without one. With the unplanned case ruled out too, there is no row
 * left for which filling them is right, and the branch is gone rather than
 * narrowed. That is the stronger shape: a rule with no exceptions cannot be
 * re-widened by accident.
 */
function fillWhenEmpty(params: {
  stop: StopHistory | undefined;
  /** The row as stored. Absent on an insert, where nothing is filled in. */
  stored?: Record<string, unknown>;
}): FactValues {
  const { stop, stored } = params;
  if (stop === undefined) return {};

  const fills: FactValues = {};
  const empty = (column: string): boolean =>
    stored === undefined || stored[column] === null || stored[column] === undefined;

  const moved =
    stop.verdict === 'moved' && !stop.trailing ? true : stop.verdict === 'kept' ? false : null;
  if (moved !== null) {
    if (empty('moved_sl')) fills.moved_sl = moved;
    if (empty('kept_sl')) fills.kept_sl = !moved;
  }

  return fills;
}

/** JSON text as a value, or the text itself when it is not JSON. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A JSON value as a string whose KEY ORDER CANNOT DISAGREE.
 *
 * Needed because Postgres `jsonb` is stored decomposed and re-serialises its
 * keys in its own order, so the object that comes back from PostgREST is equal
 * to the one we sent and not identically ordered. `JSON.stringify` on both
 * would then report every row as changed on every pull — the same idempotence-
 * lost-to-a-formatting-difference that `kind: 'number'` and `kind: 'instant'`
 * exist for, one level deeper.
 *
 * Recursive, because `stop_history.versions` is an array of objects. Arrays keep
 * their order: an array's order is data, and `versions` is specifically ordered
 * oldest-first.
 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // An absent key and a key set to undefined are the same document. JSON.
    // stringify would drop it too, and the sorted comparison has to agree.
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

/** Whether a stored value already says what the broker is saying. */
function alreadyStated(kind: FactKind, stored: unknown, wanted: FactValue): boolean {
  if (wanted === null) return stored === null || stored === undefined;
  if (stored === null || stored === undefined) return false;

  if (kind === 'json') {
    // Parsed when it arrives as text. supabase-js hands back a decomposed
    // object today; a driver that handed back the document would otherwise make
    // every row look changed forever.
    const left = typeof stored === 'string' ? safeParse(stored) : stored;
    return stableJson(left) === stableJson(wanted);
  }
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

/**
 * The subset of facts this row does not already state. Empty means no write.
 *
 * A COLUMN THE PULL DID NOT STATE IS SKIPPED, not compared against undefined.
 * `account_id` and the three stop columns are the ones that reach it — see
 * {@link facts} on why "the broker did not say" and "the broker says NULL" must
 * not become the same statement, and on why the nightly cron depends on that
 * distinction to avoid erasing what the evening's summary captured. Written as a
 * membership test on `wanted` rather than as a check for `undefined` so that a
 * future fact with a legitimately undefined value cannot slip through it.
 */
function changedFacts(stored: Record<string, unknown>, wanted: FactValues): FactValues {
  const changes: FactValues = {};
  for (const { column, kind } of EXECUTION_FACTS) {
    if (!(column in wanted)) continue;
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
 * REF-113 STAGE 3 DOES NOT CHANGE THAT, AND BRIEFLY DID. The broker's stop and
 * target are real measurements rather than placeholders, so filling the trader's
 * `stop_loss` and `take_profit` with them looked like it was inside E4's rule.
 * It is not: those two columns are SCORED, and paying for them on a row whose
 * whole point is that it carries no plan is worth 30 points of a plan that does
 * not exist. They go to `broker_stop_loss` and `broker_take_profit` instead —
 * which is what {@link facts} names, through the fact list, like any other thing
 * the broker owns. {@link fillWhenEmpty} has the two measurements.
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
function newRow(userId: string, trade: BrokerTrade, derived: Derived): Record<string, unknown> {
  return {
    user_id: userId,
    broker_trade_key: trade.brokerTradeKey,
    unplanned: true,
    rule_context_source: 'broker_verified',
    ...facts(trade, derived),
    // No `stored`, because there is no row yet: every one of the four is free.
    ...fillWhenEmpty({ stop: derived.stopHistories?.get(trade.brokerTradeKey) }),
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
  /**
   * Now, ms since epoch. Test seam; production reads the clock.
   *
   * Used for two things and both are in the matcher's hands: the future-anchor
   * guard ./match.ts documents, and the `link_confirmed_at` an auto-link
   * stamps. One clock for both, so a run cannot disagree with itself.
   */
  nowMs?: number;
  /**
   * `${host}:${brokerAccountId}` → `accounts.id`, from the pass that just
   * recorded them (REF-110 Stage 2).
   *
   * OPTIONAL, AND ITS ABSENCE IS A SUPPORTED STATE RATHER THAN A DEGRADED ONE.
   * `/api/tradovate/today` does not run the account sync — it is free precisely
   * because it has a pull in hand and makes no extra passes — so it passes
   * nothing here, no statement names `account_id`, and the rows it imports are
   * assigned by the backfill on the next sync or nightly run. See
   * {@link facts} for why that is not the same as resolving to NULL.
   *
   * Built by `syncBrokerAccounts` in ./account-sync.ts, which owns the key's
   * shape — the host is in it because Tradovate account ids are host-local.
   */
  accountIds?: ReadonlyMap<string, string>;
  /**
   * `brokerTradeKey` → what the broker's protective orders said (REF-113 Stage 3).
   *
   * OPTIONAL, AND ITS ABSENCE IS THE NORMAL STATE ON TWO OF THE FOUR TRIGGERS —
   * the nightly cron, which cannot read orders at all, and `/api/tradovate/today`,
   * which does not try. A key that is not in this map leaves all three stop
   * columns UNNAMED in every statement, which is what stops those two from
   * erasing what the Sync button and the end-of-day summary captured. See
   * {@link facts}.
   *
   * Built by `readStopHistories` in ./orders.ts, which is also what decides what
   * is worth storing: a trade whose history could not be read for a transient
   * reason is simply not in here, so the row stays a candidate for the next run
   * of the same trading day.
   */
  stopHistories?: ReadonlyMap<string, StopHistory>;
}

/**
 * Which plan, if any, each new trade belongs to (Stage 3b, §B).
 *
 * ONE GROUPED SELECT FOR THE WHOLE BATCH AND ZERO UPSTREAM CALLS, which is
 * what §B measured and is the reason the matcher runs here rather than in a
 * pass of its own. The pull has already happened — `importBrokerTrades`
 * receives rows and never touches the network — so the entire cost of this
 * feature, on all four triggers, is one more `trade_plans` read per run,
 * independent of how many trades are in it.
 *
 * It runs BEFORE any insert, and that is the point rather than an
 * optimisation: a pass afterwards would create the two-rows-for-one-trade
 * window that the single-row data model exists to avoid (§0א). Here, a trade
 * that finds its plan never has a second row, not even for a moment.
 *
 * A PLAN IS CLAIMED ONCE. The loop walks the batch oldest-entry first and
 * drops each matched plan from the pool, which is what makes a scale-in behave
 * the way §B describes: one plan, three round trips, the earliest links and
 * the rest queue. In the database the same thing happens for free — a linked
 * plan is no longer `open` — but inside one batch nothing has been written
 * yet, so the pool is the only thing that knows.
 *
 * A FAILED READ MEANS "NO MATCH", NOT "NO IMPORT". The trades go to the queue,
 * which is a screen the trader can work in one click, and the alternative —
 * skipping the import — is a trade missing from the journal. The cost is that
 * the auto-link is not retried for those trades later: the broker row carries
 * the key from then on, so the next run finds it and restates it rather than
 * matching it again. One transient failure therefore costs a confirmation,
 * never a duplicate and never a loss.
 *
 * IT ALSO RETURNS THE CANDIDATES' OWN SYMBOLS, for migration 041's capture.
 * The symbol is already in the select — condition 7 compares it — so this
 * costs nothing and is the only place the trader's spelling is in hand before
 * `facts()` overwrites it. See {@link linkOnto}.
 */
interface LinkDecisions {
  /** `brokerTradeKey` → what the matcher decided about that trade. */
  decisions: Map<string, MatchResult>;
  /**
   * `planId` → the symbol the trader typed on that plan, as read.
   *
   * Every candidate, not only the matched ones: the map is built from the pool
   * before the loop claims anything, because a caller asking about a plan the
   * matcher rejected should get `undefined` from a lookup rather than from a
   * map that happens not to contain it yet.
   */
  planSymbols: Map<string, string | null>;
}

async function decideLinks(
  client: SupabaseClient,
  userId: string,
  trades: readonly BrokerTrade[],
  nowMs: number
): Promise<LinkDecisions> {
  const decisions = new Map<string, MatchResult>();
  const planSymbols = new Map<string, string | null>();
  if (trades.length === 0) return { decisions, planSymbols };

  const earliest = Math.min(...trades.map((trade) => trade.openedAtMs));
  const latest = Math.max(...trades.map((trade) => trade.openedAtMs));

  // The widest window the batch can need, and the same two bounds the matcher
  // applies per trade. Both predicates are repeated in ./match.ts — the query
  // is here so the batch reads a handful of rows instead of a year of them,
  // and the rule itself lives in one place.
  const { data, error } = await client
    .from('trade_plans')
    // `link_confirmed_at` is selected although no SQL predicate below reads
    // it, and it has to be: it is condition 8 of the matching rule, and a
    // column the matcher cannot see is a condition that silently never
    // applies. An unlinked plan would then be re-linked on this very run.
    .select('id, status, source, hidden, submitted_at, direction, symbol, link_confirmed_at')
    .eq('user_id', userId)
    .eq('status', 'open')
    .eq('source', 'manual')
    .gte('submitted_at', new Date(earliest - MATCH_WINDOW_MS).toISOString())
    .lte('submitted_at', new Date(latest).toISOString())
    .limit(CANDIDATE_LIMIT);

  if (error) {
    // The code, never the message. One line, because every trade in the batch
    // has the same reason.
    console.info(redactSecrets(`[tradovate][import] candidates:${error.code ?? 'none'}`));
    return { decisions, planSymbols };
  }

  const pool = new Map<string, CandidatePlan>();
  for (const plan of (data ?? []) as unknown as CandidatePlan[]) {
    if (typeof plan.id === 'string') {
      pool.set(plan.id, plan);
      planSymbols.set(plan.id, plan.symbol ?? null);
    }
  }

  for (const trade of [...trades].sort((a, b) => a.openedAtMs - b.openedAtMs)) {
    const result = matchBrokerTrade({ trade, plans: [...pool.values()], nowMs });
    decisions.set(trade.brokerTradeKey, result);
    if (result.kind === 'unique') pool.delete(result.planId);
  }

  return { decisions, planSymbols };
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
  const {
    client,
    userId,
    trades,
    isTradeSource,
    env = process.env,
    nowMs = Date.now(),
    accountIds,
    stopHistories,
  } = request;

  // The two maps the pull built, carried as one thing from here down.
  const derived: Derived = { accountIds, stopHistories };

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
  const flat = trades.filter((trade) => trade.cycleClosed);
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

  // The matching pass — one select, for the trades that are not in the journal
  // already. A trade whose key is stored has nothing to match: it is either a
  // queued row the trader will decide about, or a plan that was linked on an
  // earlier run and already carries the key.
  const unseen = flat.filter((trade) => !existing.has(trade.brokerTradeKey));
  const { decisions, planSymbols } = await decideLinks(client, userId, unseen, nowMs);

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
      await restate(client, userId, String(stored.id), stored, trade, counts, refusals, derived);
      continue;
    }

    // One plan, unambiguously: the trade is written ONTO it and no broker row
    // is created. `linkOnto` falls through to the insert below if the database
    // refuses, so the trade reaches the journal either way.
    const decision = decisions.get(trade.brokerTradeKey);
    if (decision?.kind === 'unique') {
      const written = await linkOnto(
        client, userId, decision.planId, planSymbols.get(decision.planId) ?? null,
        trade, nowMs, refusals, derived
      );
      if (written) {
        counts.linkedAuto += 1;
        continue;
      }
    } else {
      counts.queued += 1;
    }

    const { error } = await client.from('trade_plans').insert(newRow(userId, trade, derived));

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
      await restateByKey(client, userId, trade, counts, refusals, derived);
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

/**
 * Write a trade onto the plan it belongs to. The auto-link (Stage 3b, §A).
 *
 * ONE STATEMENT, WHICH IS WHY THIS PATH NEEDS NO FUNCTION AND NO TRANSACTION.
 * The confirmation screen's merge needs `link_broker_trade` because it has two
 * existing rows to reconcile and the partial UNIQUE forces a fixed order over
 * three statements (§0ג). Here there is no second row and never was: the key
 * has not been written to the table yet, so moving it onto the plan is a
 * single UPDATE that either happens or does not.
 *
 * WHAT IT WRITES: the thirteen execution facts, the key, and the three
 * bookkeeping columns. `unplanned` goes to false because the trade WAS planned
 * — leaving it true would print "Tradovate · לא תוכננה" over a trade the trader
 * planned carefully, which is the trap §A found in the existing `מקור` row.
 *
 * WHAT IT DOES NOT TOUCH: every intent column, and `rule_context_source`. The
 * fact list contains no intent column by construction, and the statement names
 * nothing else. `rule_context_source` on this row records what the trader's own
 * rule check had in hand when they submitted the plan, which is still true and
 * is not ours to restate.
 *
 * RETURNS FALSE RATHER THAN THROWING, and the caller then inserts a broker row
 * as if the match had never happened. The interesting failure is `23505`: a
 * concurrent import inserted the same key between the read and now (§F3), so
 * the key is taken, the link cannot have it, and falling through means the
 * insert below fails the same way and is retried as the update it should have
 * been. Both directions of that race end with one row and no lost trade.
 *
 *
 * MIGRATION 041: THE SYMBOL THE TRADER TYPED, CAPTURED HERE TOO
 * ------------------------------------------------------------
 *
 * THE RPC IS NOT THE ONLY LINK PATH, which is the thing to know about this
 * function. `link_broker_trade` covers the CONFIRMATION screen, and 041's
 * `plan_symbol = COALESCE(plan.plan_symbol, plan.symbol)` lives in it — but
 * this path never calls it, for the reason the note above gives: one statement,
 * no second row, no transaction to need. So without the capture below the
 * auto-link would still discard the trader's spelling, and the feature would
 * cover half the links in the product — the half the trader never sees happen,
 * and therefore the half they would be most surprised by.
 *
 * IT IS A SEPARATE STATEMENT AND THAT IS DELIBERATE. `plan_symbol` named in the
 * UPDATE below would make the whole auto-link answer PostgREST 42703 on a
 * database where 041 has not run: the link would fail, the trade would fall
 * through to the insert and arrive in the QUEUE instead, and the deploy would
 * have to wait for the migration — the hazard 038 and 040 both carry and state
 * in their headers. As its own statement, its failure costs exactly the capture
 * and nothing else, so this feature imposes NO deploy order at all.
 *
 * `.is('plan_symbol', null)` IS THE `COALESCE`, written as a predicate: it is
 * what makes a re-link keep the original it already captured instead of
 * overwriting it with whatever `symbol` holds now. On this path the column is
 * in fact always NULL — condition 8 of the matching rule refuses any plan
 * carrying a `link_confirmed_at`, so the matcher can only reach a plan that has
 * never been linked — but the predicate costs nothing, and it means the two
 * link paths implement the same rule rather than one of them resting on that
 * argument.
 */
async function linkOnto(
  client: SupabaseClient,
  userId: string,
  planId: string,
  /** The symbol the trader typed on this plan, from the candidate read. */
  planSymbol: string | null,
  trade: BrokerTrade,
  nowMs: number,
  refusals: string[],
  derived: Derived
): Promise<boolean> {
  // A plan with no symbol has nothing to keep, and writing NULL over NULL is a
  // statement for no reason. THE ERROR IS DISCARDED, not pushed to `refusals`:
  // a failed capture is not a failed link, and all it changes is that an unlink
  // of this row behaves as it did before 041 — which the dialog's own
  // conditional already accounts for.
  if (typeof planSymbol === 'string' && planSymbol !== '') {
    await client
      .from('trade_plans')
      .update({ plan_symbol: planSymbol })
      .eq('id', planId)
      .eq('user_id', userId)
      .is('plan_symbol', null);
  }

  const { error } = await client
    .from('trade_plans')
    .update({
      ...facts(trade, derived),
      broker_trade_key: trade.brokerTradeKey,
      unplanned: false,
      link_confirmed_at: new Date(nowMs).toISOString(),
      link_method: 'auto',
    })
    .eq('id', planId)
    .eq('user_id', userId);

  if (!error) return true;
  refusals.push(`link:${error.code ?? 'none'}`);
  return false;
}

/** Restate the facts on a row we have already read. Zero writes when correct. */
async function restate(
  client: SupabaseClient,
  userId: string,
  id: string,
  stored: Record<string, unknown>,
  trade: BrokerTrade,
  counts: BrokerImportCounts,
  refusals: string[],
  derived: Derived
): Promise<void> {
  const changes = {
    ...changedFacts(stored, facts(trade, derived)),
    // NOT facts, and NOT run through the comparison: these are only ever
    // written into a NULL, so a second pull finds them non-null and sends
    // nothing. Idempotence holds without them being compared at all.
    ...fillWhenEmpty({ stop: derived.stopHistories?.get(trade.brokerTradeKey), stored }),
  };

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
  refusals: string[],
  derived: Derived
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
  await restate(client, userId, String(stored.id), stored, trade, counts, refusals, derived);
}

/**
 * Which trades are worth reading the broker's orders for (REF-113 Stage 3).
 *
 * ONE SELECT, AND IT IS WHAT MAKES THE SECOND RUN OF A DAY NEARLY FREE. A trade
 * that already carries a `stop_history` costs no upstream request at all, so the
 * end-of-day summary, the Sync button and (from Stage 4) the dedicated cron can
 * all run on the same day without reading the same orders three times.
 *
 * THE FILTER IS `stop_history IS NULL` AND IT IS EVALUATED IN JAVASCRIPT ON
 * PURPOSE. The rows have to be read anyway to tell "no row yet" from "a row with
 * no history", and a `.is('stop_history', null)` predicate would hide the first
 * case inside the second: a trade the journal has never seen has no row to be
 * null, and it is the one that most needs asking about.
 *
 * FOUR REASONS A TRADE IS NOT A CANDIDATE, and three of them are somebody else's
 * rule restated:
 *
 *   - the import is switched off              → nothing may be SELECTed at all
 *   - the cycle has not closed                → rule 1; it is not imported
 *   - the row is hidden                       → rule 2 (E12); it is not touched
 *   - the row already has a history           → asked and answered
 *
 * AND THE SECOND LINE USED TO REFUSE TRADES THAT HAD CLOSED HOURS EARLIER,
 * WHICH REF-117 STAGE 2 FIXED HERE WITHOUT TOUCHING THIS FUNCTION. The filter
 * was `positionFlat`, a question about whether the CONTRACT was flat right now:
 * a Position is one row per contract per trading day with a live `netPos`, so
 * re-entering a contract put that row back to non-zero and every trade already
 * closed on it dropped out of this list again. It returned empty,
 * `readStopHistories` made no request, and the columns stayed NULL with nothing
 * but `skippedOpen` in the import's own log line to explain it — and waiting was
 * not free, because `/order/list` is `depthDays = 0`, so a position still open
 * when the trading day rolled took the orders with it and the trade degraded to
 * `'interday'` permanently (measured 19.10,
 * ~/Desktop/reflect-reports/ref-113-why-no-write.md).
 *
 * The filter is now `cycleClosed`, which is a property of the trade rather than
 * of the contract, so a closed cycle is a candidate the moment the trader is out
 * and stays one. **That is decision ד of the why-no-write report, delivered as a
 * side effect of the grouping change rather than as REF-113 Stage 4 work.** The
 * Stage 4b watcher in app/api/tradovate/live/route.ts is still what fires the
 * capture before 17:00 CT destroys the orders; its trigger — "a contract went
 * flat" — is now exactly "a cycle closed".
 *
 * A FAILED READ RETURNS NOTHING, which costs the run its stop histories and
 * nothing else. The same swallow ./orders.ts makes, for the same reason: an
 * annotation must not be able to cost a trader their journal rows.
 */
export async function tradesNeedingStopHistory(params: {
  client: SupabaseClient;
  userId: string;
  trades: readonly BrokerTrade[];
  env?: NodeJS.ProcessEnv;
}): Promise<BrokerTrade[]> {
  const { client, userId, trades, env = process.env } = params;

  // Before the select, not after: `stop_history` is a column migration 038
  // adds, so without the flag there is nothing here that may be named.
  if (!isImportEnabled(env)) return [];

  const flat = trades.filter((trade) => trade.cycleClosed);
  if (flat.length === 0) return [];

  const keys = [...new Set(flat.map((trade) => trade.brokerTradeKey))];
  const { data, error } = await client
    .from('trade_plans')
    .select('broker_trade_key, stop_history, hidden')
    .eq('user_id', userId)
    .in('broker_trade_key', keys);

  if (error) {
    // The code, never the message: a PostgREST message can echo the row back.
    console.info(redactSecrets(`[tradovate][import] stopcandidates:${error.code ?? 'none'}`));
    return [];
  }

  const answered = new Set<string>();
  for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
    const key = row.broker_trade_key;
    if (typeof key !== 'string') continue;
    const hasHistory = row.stop_history !== null && row.stop_history !== undefined;
    if (hasHistory || row.hidden === true) answered.add(key);
  }

  return flat.filter((trade) => !answered.has(trade.brokerTradeKey));
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
    `linkedAuto=${counts.linkedAuto} queued=${counts.queued} ` +
    `updated=${counts.updated} unchanged=${counts.unchanged} ` +
    `skippedOpen=${counts.skippedOpen} skippedHidden=${counts.skippedHidden} ` +
    `failed=${counts.failed}` +
    (refusals.length > 0 ? ` refusals=${[...new Set(refusals)].join(',')}` : '');

  if (counts.failed > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));
}
