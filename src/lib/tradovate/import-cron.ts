/**
 * The daily broker import: capture the day that just ended, for every connected
 * trader (REF-107 Stage 2, E9).
 *
 * SERVER ONLY. Driven by /api/cron/tradovate-import once a day, and separate
 * from that route for the same reason ./keepalive.ts is separate from its own:
 * the route owns the cron secret and builds the service-role client, and this
 * owns the loop. That split is what lets the loop be driven against a stubbed
 * Supabase client without the test fabricating an authenticated request or
 * holding a real key.
 *
 *
 * WHY A CRON AT ALL, WHEN E9 DID NOT ASK FOR ONE
 * ----------------------------------------------
 *
 * E9 chose "on trade-form open + a Sync button" and left the cron behind E10 —
 * the unanswered question of which Vercel plan this project is on. E10 was
 * answered in passing on 15.10 ("now allowed on Pro", recorded on REF-107), and
 * the same day's reading of a live account supplied the argument for it:
 *
 *     A TRADE THE TRADER NEVER OPENS THE APP FOR IS A TRADE WE MAY NEVER SEE.
 *
 * Both of E9's triggers need the trader to show up. §A2 is unverified about how
 * far back `/fill/list` reaches, the one live reading could not settle it, and
 * the 15.10 note on prop accounts makes it worse: EVAL ACCOUNTS ROTATE. A
 * breached or reset account is a distinct `accountId`, and a closed account's
 * fills may stop being visible at all. A day captured while the account is
 * still live is a day we keep forever; a day we were never asked about may be
 * gone. That is what the cron buys, and it is why it is in Stage 2 rather than
 * deferred.
 *
 *
 * §A2 IS ANSWERED NOW, AND THE ANSWER MOVED THIS JOB (REF-117 Stage 2b)
 * --------------------------------------------------------------------
 *
 * `/fill/list` reaches back NO DISTANCE AT ALL. Measured 20.10: it,
 * `/fillPair/list` and `/position/list` are every one of them `depthDays = 0`,
 * cleared at Tradovate's daily reset exactly as `/order/list` is. The narrowing
 * variants reach nothing further — `/fillPair/deps` and `/fill/items` were asked
 * and returned precisely what the lists returned.
 *
 * SO THIS JOB RAN AT 03:30 UTC AND IMPORTED NOTHING, every night, since REF-107
 * Stage 2. 03:30 UTC is 22:30 CT the previous day, five and a half hours past
 * the 17:00 CT roll. It woke, asked for the day it was built to capture, and
 * got three empty lists. The argument above — that a day we are never asked
 * about may be gone — was right, and this job was not the thing collecting it.
 * Every row in a journal today arrived from a trigger that runs during the
 * session.
 *
 * It is a measurement nobody had to take: `./orders-cron.ts` spends a whole
 * header on the fact that 03:30 is "FOUR AND A HALF TO FIVE AND A HALF HOURS
 * AFTER Tradovate has already cleared `/order/list`", and then says "The fills
 * survive; the orders do not." The first half was reasoned carefully and the
 * second half was an assumption.
 *
 *
 * TWO PRE-ROLL PASSES, AND THE SECOND ONE IS NOT THIS FILE
 * -------------------------------------------------------
 *
 * This job now runs at **20:00 UTC** — 15:00 CDT, 14:00 CST — and
 * `/api/cron/tradovate-orders` still runs at 21:30 UTC. Both are before the
 * roll, ninety minutes apart, and the second one ALREADY DOES EVERYTHING THIS
 * ONE DOES: `./orders-cron.ts` calls the same `syncUserTrades`, which always
 * calls `importBrokerTrades`; its own header says every field is "./import-cron.ts'
 * with a narrower window" plus the one flag that asks for the orders.
 *
 * (That flag's NAME is deliberately not written here. `scripts/broker-import-check.ts`
 * asserts this file does not contain it — a source-level grep is the only way to
 * prove a call is never made — so naming it in a comment would fail a real
 * check for a prose reason. The flag is on `syncUserTrades` in ./sync.ts.)
 *
 * SO WHY KEEP BOTH. Because the data is destroyed at the roll and there is no
 * backfill at any price, which is the one situation where an idempotent second
 * attempt is worth its cost. The import is idempotence-by-measurement — a
 * re-import of unchanged trades issues ZERO writes, not "the same writes again"
 * (./import.ts) — so the later pass costs one day pull per trader and writes
 * nothing it does not have to. If 21:30 fails for a trader, 20:00 already has
 * their day; if 20:00 fails, 21:30 gets it.
 *
 * The order is the useful one, too. 20:00 is the cheaper job (no `/order/list`
 * fan-out), so the expensive one runs second and closest to the deadline, where
 * the thirty-minute summer margin `./orders-cron.ts` documents actually matters.
 *
 * WHAT IS STILL LOST, AND IT HAS TO BE SAID PLAINLY: a trader whose session ran
 * past 21:30 UTC and who never opened the app loses the trades they took after
 * it. The American close is 15:00 CT and the roll is 17:00 CT, so that is the
 * evening and overnight session — and for those trades there is no later trigger
 * that can reach them. REF-117 Stage 6 is where the trader gets told; a third
 * cron cannot fix it, because any hour before the roll has the same two hours
 * behind it.
 *
 *
 * THE WINDOW, AND WHY IT IS 48 HOURS AND NOT A DAY
 * ------------------------------------------------
 *
 * {@link IMPORT_LOOKBACK_MS}. The job runs at a fixed UTC hour and the traders
 * do not: a Tel Aviv trader's day ended at 21:00Z, a Chicago trader's at
 * 22:00Z the following calendar day, and `profiles.timezone` does not exist
 * (§C10.5, still unsolved). Two days of reach covers every offset and a missed
 * run, and it costs nothing in correctness because the import is idempotent by
 * key — a trade already in the journal is compared and skipped without a write.
 *
 * It is not free in LATENCY: §A2 measured that the four list reads cost the same
 * for any window and that PRICING grows at one contract chain per distinct
 * contract in it. Two days of a futures trader is one or two contracts. A
 * full-history window is tens, which is why Stage 5 is a different job with a
 * persistent contract cache and not this constant with a larger number.
 *
 *
 * WHAT IT REPORTS, AND WHAT IT REFUSES TO
 * ---------------------------------------
 *
 * COUNTS ONLY. No user ids, no symbols, no prices, no fill ids, no account ids
 * — not in the return value and not in a log line. A nightly job over every
 * connected trader is exactly the wrong place to start writing identifiers into
 * Vercel's logs, and a count is all an operator needs to see the mechanism is
 * alive. Same rule, same words, as ./keepalive.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUserAllowed } from './allowlist';
import {
  IMPORT_BATCH_LIMIT,
  listConnectionsForImport,
  markCronProgress,
} from './connections';
import { flushUserCalls, readDailyCalls, summariseCalls } from './call-meter';
import { isImportEnabled, type BrokerImportCounts } from './import';
import { redactSecrets } from './redact';
import { syncUserTrades } from './sync';

/**
 * How far back each run reaches. Two days — see the header.
 *
 * Deliberately NOT `MAX_SINCE_AGE_MS` (seven days, ./trading-day.ts). That
 * bound is what a SYNCHRONOUS ROUTE can promise somebody who is waiting; this
 * is a scheduled job whose job is the day in progress, and seven days of
 * pricing per user per run would be six days of contract lookups for trades
 * that were imported six days ago.
 *
 * AND SINCE REF-117 STAGE 2b IT IS A NO-OP, KEPT RATHER THAN CORRECTED. Every
 * list this reaches through is `depthDays = 0`, so there is nothing older than
 * the current trading day to widen to: 48 hours and 24 hours and ten minutes
 * all return the same three responses. `windowStartMs` only ever widened what
 * gets PRICED and RETURNED, never what the pull asks for — ./fills.ts'
 * `BrokerDayRequest` says so — so this cannot resurrect a row the API dropped.
 *
 * It stays at 48 hours because changing it would be a change with no effect,
 * and because the day the depth question is reopened — a new endpoint, a
 * narrowing variant that works, a vendor change — this is the number that
 * should already be generous. The suite pins it, so a future reader meets this
 * comment rather than the constant alone.
 */
export const IMPORT_LOOKBACK_MS = 48 * 60 * 60_000;

/** What one run did. Counts only — see the header. */
export interface ImportRunCounts {
  /** Connections in THIS RUN'S BATCH. See {@link active} for the population. */
  found: number;
  /**
   * How many active connections exist in total (REF-112 §4.6 item 1).
   *
   * `active > found` IS THE NUMBER TO WATCH: it means the batch was full and
   * somebody waited a night. It is not an error — that is what the rotation is
   * for — but a run where `active` is several times `found` is a deployment
   * that has outgrown {@link IMPORT_BATCH_LIMIT}, and this is where that
   * becomes visible instead of showing up as a trader's missing day.
   */
  active: number;
  /**
   * Whether the batch was taken in least-recently-processed order.
   *
   * False means migration 042 has not run: the batch is bounded but the same
   * users lead it every night. On the counts because it is the one thing about
   * a deployment in that state that an operator has to know.
   */
  rotating: boolean;
  /** Users whose import was attempted: past the allowlist and the declaration. */
  attempted: number;
  /** Rows inserted, totalled across users. */
  imported: number;
  /** Existing rows whose execution facts were restated. */
  updated: number;
  /** Existing rows already correct. No write was sent for these. */
  unchanged: number;
  /** Trades not imported because the position is not known to be flat (§A3). */
  skippedOpen: number;
  /** Trades not imported because the row is hidden (E12). */
  skippedHidden: number;
  /** Rows the database refused. */
  failed: number;
  /**
   * Users not attempted at all: not on the allowlist, or the connection does
   * not declare the broker a source of trades (E7). Nothing was sent upstream.
   */
  skippedUsers: number;
  /**
   * Users whose PULL failed. Nothing was concluded and nothing was written;
   * tomorrow's run retries, and so does the next form opening.
   */
  failedUsers: number;
}

const EMPTY: ImportRunCounts = Object.freeze({
  found: 0,
  active: 0,
  rotating: false,
  attempted: 0,
  imported: 0,
  updated: 0,
  unchanged: 0,
  skippedOpen: 0,
  skippedHidden: 0,
  failed: 0,
  skippedUsers: 0,
  failedUsers: 0,
});

/** Add one user's result into the run's totals. */
function accumulate(run: ImportRunCounts, counts: BrokerImportCounts): void {
  run.imported += counts.imported;
  run.updated += counts.updated;
  run.unchanged += counts.unchanged;
  run.skippedOpen += counts.skippedOpen;
  run.skippedHidden += counts.skippedHidden;
  run.failed += counts.failed;
}

/**
 * Import yesterday and today for every connected trader.
 *
 * SEQUENTIAL, AND ONE USER'S FAILURE DOES NOT STOP THE REST. Sequential because
 * the point is to be gentle with a rate-limited third-party API on behalf of
 * users who did not ask for this request — there is no deadline here, only a
 * nightly one — and because the alternative is N × nine concurrent upstream
 * calls against a documented per-user quota for no gain.
 *
 * Every error is caught per user. An exception escaping this loop would abandon
 * every trader after the one that threw, which over a nightly job is
 * indistinguishable from the import not existing.
 */
export async function runBrokerImport(params: {
  admin: SupabaseClient;
  now?: number;
  lookbackMs?: number;
  /** How many connections this run takes. Test seam; production uses the constant. */
  batchLimit?: number;
  /** Test seam for the allowlist and the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<ImportRunCounts> {
  const {
    admin,
    now = Date.now(),
    lookbackMs = IMPORT_LOOKBACK_MS,
    batchLimit = IMPORT_BATCH_LIMIT,
    env = process.env,
  } = params;

  const run: ImportRunCounts = { ...EMPTY };

  // Before the listing, not after: `is_trade_source` is a column migration 034
  // adds, so without the flag there is nothing this function may safely SELECT,
  // let alone write. An empty run rather than a thrown 42703.
  if (!isImportEnabled(env)) {
    console.info('[tradovate][import-cron] TRADOVATE_IMPORT_ENABLED is not 1; nothing was read');
    return run;
  }

  // A BOUNDED BATCH, LEAST-RECENTLY-PROCESSED FIRST (REF-112 §4.6 item 1).
  // This listing used to return EVERY active connection with no limit, no range
  // and no cursor, ordered by `user_id`, and the loop below walked it serially
  // inside a sixty-second function — so past roughly twenty traders the run was
  // cut off, and because the order never rotated it was cut off at the same
  // place every night. The tail was starved permanently.
  const listing = await listConnectionsForImport({
    admin,
    cursor: 'last_import_at',
    limit: batchLimit,
  });
  const connections = listing.connections;
  run.found = connections.length;
  run.active = listing.active;
  run.rotating = listing.rotating;

  // The "unset or empty, so every connection is skipped" warning is DELETED,
  // not rewritten — see the same place in ./keepalive.ts. It described the
  // fail-closed default, and after the inversion an unset variable is the state
  // in which every connection IS imported. `run.skippedUsers` already carries
  // the number a restricted deployment leaves out.
  // THE DAY BOUNDARY THIS JOB DELIBERATELY DOES NOT USE (REF-125).
  // `currentTradingDayStart()` is computable here now — 17:00 America/Chicago
  // is the exchange's hour, not the trader's, so unlike the browser midnight
  // this replaced it needs no `profiles.timezone` and no request to ask. It is
  // still not what this job wants, and the reason is COST rather than
  // correctness: `fills.ts` takes `min(dayStartMs, windowStartMs)` as the
  // window it prices, and a trading-day open reaches up to 72 hours back
  // across a weekend where UTC midnight reaches at most 24. That would widen
  // what a cron prices, every night, to no end — the scalars cut at this
  // instant are discarded by `syncUserTrades`, every column the import writes
  // takes its value from the broker's own fill timestamps, and `windowStartMs`
  // below is what actually decides which trades are reached.
  const dayStartMs = new Date(now).setUTCHours(0, 0, 0, 0);
  const windowStartMs = now - lookbackMs;

  const failureKinds: string[] = [];

  for (const connection of connections) {
    // A user id would be the one identifier worth having in this log and is
    // exactly what must not be written to it, so a skip is counted and not
    // narrated — the same choice ./keepalive.ts made.
    if (!isUserAllowed(connection.user_id, env)) {
      run.skippedUsers += 1;
      continue;
    }

    // E7, read from the row we already have rather than per user. A trader who
    // has said Tradovate is not the source of trades for their account gets no
    // pull and no rows — and this is the one place that saves the pull as well
    // as the write, because the decision is already in hand.
    if (connection.is_trade_source !== true) {
      run.skippedUsers += 1;
      continue;
    }

    run.attempted += 1;

    try {
      const { counts } = await syncUserTrades({
        userId: connection.user_id,
        // THE ONE PLACE THE WRITE IS NOT UNDER THE USER'S RLS, and the reason
        // is structural: a nightly job has no session. The service role is used
        // for the listing above and then for this user's own rows, with the
        // user id taken from the connection row and never from a request.
        // lib/tradovate/import.ts' header names the three properties that stand
        // in for RLS here, and every statement it issues carries the user.
        client: admin,
        admin,
        dayStartMs,
        windowStartMs,
        env,
      });
      accumulate(run, counts);
    } catch (error) {
      run.failedUsers += 1;
      // The error's NAME, deduplicated at the end. A message from this chain
      // can name a contract or a product id, and a message from PostgREST can
      // echo a row.
      failureKinds.push(error instanceof Error ? error.name : 'non-Error throw');
    }
  }

  // THE CURSOR MOVES FOR EVERY CONNECTION IN THE BATCH, skipped and failed ones
  // included — see `markCronProgress` on why a skip that did not stamp would
  // hold the head of the queue forever. After the loop, so a run killed by the
  // function timeout stamps nothing and the next one reaches the same users:
  // repeating an idempotent import is cheap, and skipping it is not.
  const batchIds = connections.map((connection) => connection.user_id);

  await markCronProgress({ admin, cursor: 'last_import_at', userIds: batchIds, now });

  // THE COUNTER'S WHOLE PURPOSE: a number in the summary (REF-112 §4.5 item 1).
  // `force` because a cron runs once and the instance may never serve again,
  // so its totals have to land rather than wait out FLUSH_MIN_GAP_MS.
  await flushUserCalls({ admin, userIds: batchIds, now, force: true });

  // TWO INTEGERS AND NEVER A USER ID. `readDailyCalls` returns a keyed map
  // because the MAXIMUM is the interesting figure — §4.3's point is that an
  // idle trader (~45/day) and a heavy one (8,000-12,000+) differ by two orders
  // of magnitude, so a mean hides the user who is actually the problem — and
  // `summariseCalls` reduces it to a total and that maximum before anything is
  // written. The map's keys do not reach this function.
  const calls = summariseCalls(await readDailyCalls({ admin, userIds: batchIds, now }));

  const line =
    `[tradovate][import-cron] found=${run.found} active=${run.active} ` +
    `rotating=${run.rotating} attempted=${run.attempted} ` +
    `imported=${run.imported} updated=${run.updated} unchanged=${run.unchanged} ` +
    `skippedOpen=${run.skippedOpen} skippedHidden=${run.skippedHidden} ` +
    `failed=${run.failed} skippedUsers=${run.skippedUsers} ` +
    `failedUsers=${run.failedUsers} ` +
    `calls=${calls.total} heaviestUser=${calls.heaviest}` +
    (failureKinds.length > 0 ? ` kinds=${[...new Set(failureKinds)].join(',')}` : '');

  if (run.failedUsers > 0 || run.failed > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));

  return run;
}
