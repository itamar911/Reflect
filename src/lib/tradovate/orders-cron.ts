/**
 * The stop-capture run: read the day's protective orders before the trading day
 * rolls, for every connected trader (REF-113 Stage 4).
 *
 * SERVER ONLY. Driven by /api/cron/tradovate-orders once a day, and separate
 * from that route for the same reason ./import-cron.ts is separate from its
 * own: the route owns the cron secret and builds the service-role client, and
 * this owns the loop. That split is what lets the loop be driven against a
 * stubbed Supabase client without the test fabricating an authenticated request
 * or holding a real key.
 *
 *
 * WHY A SECOND CRON, WHEN ONE ALREADY IMPORTS EVERY NIGHT
 * ------------------------------------------------------
 *
 * Because the nightly one CANNOT READ ORDERS, and no amount of fixing makes it
 * able to. `/api/cron/tradovate-import` runs at 03:30 UTC. If the trading day
 * rolls at 17:00 CT that is 22:00 UTC in summer and 23:00 in winter, so the
 * nightly job fires FOUR AND A HALF TO FIVE AND A HALF HOURS AFTER Tradovate
 * has already cleared `/order/list` of the day it is importing. `/order/list`
 * has no depth at all — `depthDays = 0`, measured 19.10, and the evening before
 * the measurement it returned nothing — so there is no backfill at any price.
 * The fills survive; the orders do not.
 *
 * The two triggers that CAN see orders both need the trader to show up, or
 * nearly:
 *
 *   POST /api/tradovate/sync    the trader pressed the button
 *   the end-of-day summary      per user, at the hour they chose — which for a
 *                               21:00 Israel default is 13:00 CT, TWO HOURS
 *                               BEFORE the American session closes
 *
 * So the honest answer to "what about a trader who never opens the app" was,
 * until this file: their stop history is never read. And the answer for a
 * trader who DOES get a summary was: everything but their last two hours of
 * trading. This closes both.
 *
 *
 * 21:30 UTC, AND THE THIRTY MINUTES IN SUMMER ARE THE WHOLE MARGIN
 * ---------------------------------------------------------------
 *
 *   | regime      | 21:30 UTC is | after the 15:00 CT close | before the roll |
 *   |-------------|--------------|--------------------------|-----------------|
 *   | summer CDT  | 16:30 CT     | +90 min                  | −30 min         |
 *   | winter CST  | 15:30 CT     | +30 min                  | −90 min         |
 *
 * It works in both regimes and in the weeks where the American and Israeli DST
 * transitions do not line up, because it is anchored to CT and CT is what
 * decides the roll. THE 17:00 CT ROLL IS A CONVENTION AND NOT A MEASUREMENT —
 * ./trading-day.ts says so in as many words, and the support article it comes
 * from is not fetchable. Thirty minutes of margin on an unmeasured boundary is
 * thin, and the decision (Imri, 19.10) is to adopt the hour and move it if the
 * counts say it is wrong. {@link ORDERS_LOOKBACK_MS} is where a wrong guess
 * shows up, and it shows up as `unknown` verdicts rather than as silence.
 *
 *
 * WHAT IT REPORTS, AND WHAT IT REFUSES TO
 * ---------------------------------------
 *
 * COUNTS ONLY. No user ids, no symbols, no prices, no order ids, no account
 * ids — not in the return value and not in a log line. Same rule and the same
 * words as ./import-cron.ts and ./keepalive.ts. The stop-order read's own line
 * is emitted by ./orders.ts and is counts-only there for a sharper reason: the
 * body of a failed `/orderVersion/deps` is the trader's stop prices.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isAllowlistConfigured, isUserAllowed } from './allowlist';
import { listConnectionsForImport } from './connections';
import { isImportEnabled, type BrokerImportCounts } from './import';
import { redactSecrets } from './redact';
import { syncUserTrades } from './sync';

/**
 * How far back one run reaches. Twenty-four hours, and the number is a choice
 * between two kinds of wrong.
 *
 * The run fires at 21:30 UTC and the trading day it is capturing began at
 * 22:00 UTC (summer) or 23:00 (winter) the previous calendar day — so the day
 * is between twenty-two and a half and twenty-three and a half hours old.
 * Twenty-four covers all of it in both regimes.
 *
 * IT ALSO REACHES THIRTY TO NINETY MINUTES PAST THE ROLL, into the tail of the
 * PREVIOUS trading day, and that is deliberate rather than slack. A trade that
 * closed in that tail and was never synced has orders that are already gone,
 * so the derivation answers `'interday'` — which is a PERMANENT `'unknown'`
 * (./orders.ts), stored rather than retried. That is the correct answer for it:
 * "we looked and could not read the orders" is what lets the trade card say so
 * instead of looking like "the stop was not moved". The alternative — a
 * twenty-one-hour window that cannot cross the roll — would leave the first one
 * to two and a half hours after the roll uncovered, which is the Asian session,
 * and would say nothing at all about it.
 *
 * NOT {@link import('./import-cron').IMPORT_LOOKBACK_MS} (forty-eight hours).
 * That window exists so a nightly job can absorb every trader's offset and a
 * missed run; this one is pinned to a boundary and a second day of it would be
 * a day of contract pricing for trades whose orders cannot be read.
 */
export const ORDERS_LOOKBACK_MS = 24 * 60 * 60_000;

/** What one run did. Counts only — see the header. */
export interface StopCaptureCounts {
  /** Active connections found. */
  found: number;
  /** Users whose capture was attempted: past the allowlist and the declaration. */
  attempted: number;
  /**
   * Rows whose execution facts were restated — which for this run is very
   * nearly "rows that got a stop history".
   *
   * NOT EXACTLY, and the gap is worth knowing before reading the number: a row
   * is also `updated` when a price or a P&L figure changed, and a row whose
   * stop history was derived as a TRANSIENT `'unknown'` (capped, or a read that
   * failed) is dropped rather than stored and so is `unchanged`. The authority
   * on what the stop read itself did is ./orders.ts' own line, which carries
   * `moved=`/`kept=`/`none=`/`unknown=`/`dropped=`.
   */
  updated: number;
  /** Existing rows already correct. No write was sent for these. */
  unchanged: number;
  /**
   * Rows inserted. Expected to be ZERO ON ALMOST EVERY RUN, and a non-zero is
   * informative rather than wrong: it means this job saw a trade the form, the
   * Sync button and the nightly cron had all missed, which is the gap it exists
   * to cover.
   */
  imported: number;
  /**
   * Trades not imported because the position is not known to be flat (§A3).
   *
   * THE NUMBER TO WATCH ON THIS JOB. A trader still holding a contract at 21:30
   * puts that contract's Position row back to non-zero, so every trade they
   * closed on it earlier reads `positionFlat: false` and is dropped BEFORE a
   * single order is read — and then the day rolls and those orders are gone.
   * A fixed hour cannot fix that for somebody who rolls positions all day,
   * which is why Stage 4 also fires the read the moment a position goes flat
   * (app/api/tradovate/live/route.ts). A persistently non-zero count here is
   * that trader, and it is the signature to look for.
   */
  skippedOpen: number;
  /** Trades not imported because the row is hidden (E12). */
  skippedHidden: number;
  /** Rows the database refused. */
  failed: number;
  /** Users not attempted: not allowlisted, or the broker is not their source (E7). */
  skippedUsers: number;
  /** Users whose PULL failed. Nothing was concluded and nothing was written. */
  failedUsers: number;
}

const EMPTY: StopCaptureCounts = Object.freeze({
  found: 0,
  attempted: 0,
  updated: 0,
  unchanged: 0,
  imported: 0,
  skippedOpen: 0,
  skippedHidden: 0,
  failed: 0,
  skippedUsers: 0,
  failedUsers: 0,
});

/** Add one user's result into the run's totals. */
function accumulate(run: StopCaptureCounts, counts: BrokerImportCounts): void {
  run.imported += counts.imported;
  run.updated += counts.updated;
  run.unchanged += counts.unchanged;
  run.skippedOpen += counts.skippedOpen;
  run.skippedHidden += counts.skippedHidden;
  run.failed += counts.failed;
}

/**
 * Read the day's protective orders for every connected trader.
 *
 * SEQUENTIAL, AND ONE USER'S FAILURE DOES NOT STOP THE REST — ./import-cron.ts'
 * two rules, and they bind harder here. Sequential because this run makes MORE
 * upstream requests per trader than the nightly one does (the stop read adds
 * `/order/list`, `/orderStrategy/list`, `/command/list` and a `deps` per
 * candidate order on top of the day pull), all against a third party whose
 * documented penalty for crossing an undocumented limit escalates to a
 * `p-captcha` a third-party application cannot clear. Every error is caught per
 * user because an exception escaping this loop would abandon every trader after
 * the one that threw — on a job that runs once a day, half an hour before the
 * evidence is destroyed.
 *
 * IT CANNOT COST A TRADER THEIR ROWS. `readStopHistories` swallows every read
 * and wraps the derivation (./orders.ts), so the worst a refusing broker does
 * here is leave the three nullable columns absent and leave the trade a
 * candidate for a run that no longer exists. That is the trade this whole
 * module is built on: an annotation is not allowed to take down an import.
 */
export async function runStopCapture(params: {
  admin: SupabaseClient;
  now?: number;
  lookbackMs?: number;
  /** Test seam for the allowlist and the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the pull. Production passes the real one by omission. */
  sync?: typeof syncUserTrades;
}): Promise<StopCaptureCounts> {
  const {
    admin,
    now = Date.now(),
    lookbackMs = ORDERS_LOOKBACK_MS,
    env = process.env,
    sync = syncUserTrades,
  } = params;

  const run: StopCaptureCounts = { ...EMPTY };

  // Before the listing, not after: `is_trade_source` is a column migration 034
  // adds and `stop_history` one that 038 adds, so without the flag there is
  // nothing this function may safely SELECT. An empty run rather than a thrown
  // 42703.
  if (!isImportEnabled(env)) {
    console.info('[tradovate][orders-cron] TRADOVATE_IMPORT_ENABLED is not 1; nothing was read');
    return run;
  }

  const connections = await listConnectionsForImport({ admin });
  run.found = connections.length;

  // The same fail-closed allowlist the user-facing routes enforce. Worth a log
  // line for ./import-cron.ts' reason: fail-closed means an unset variable
  // reads for exactly nobody, and a run that did nothing would otherwise look
  // identical to a run with nothing to do.
  if (connections.length > 0 && !isAllowlistConfigured(env)) {
    console.warn(
      '[tradovate][orders-cron] TRADOVATE_OAUTH_ALLOWED_USER_IDS is unset or empty, so every ' +
        `connection is skipped (${connections.length} were found). No orders were read.`
    );
  }

  // THE DAY BOUNDARY THIS JOB CANNOT KNOW (§C10.5), and here it matters even
  // less than it does nightly: `syncUserTrades` discards the scalars cut at
  // `dayStartMs`, every column the import writes takes its value from the
  // broker's own fill timestamps, and `windowStartMs` is what decides which
  // trades are reached. UTC midnight, like the nightly job, so there is one
  // convention rather than two.
  const dayStartMs = new Date(now).setUTCHours(0, 0, 0, 0);
  const windowStartMs = now - lookbackMs;

  const failureKinds: string[] = [];

  for (const connection of connections) {
    // A user id is the one identifier worth having in this log and is exactly
    // what must not be written to it, so a skip is counted and not narrated.
    if (!isUserAllowed(connection.user_id, env)) {
      run.skippedUsers += 1;
      continue;
    }

    // E7, read from the row we already have. A trader who has said Tradovate is
    // not their source of trades gets no pull and no rows — and this is the one
    // place that saves the pull as well as the write, because the decision is
    // already in hand.
    if (connection.is_trade_source !== true) {
      run.skippedUsers += 1;
      continue;
    }

    run.attempted += 1;

    try {
      const { counts } = await sync({
        userId: connection.user_id,
        // THE ONE PLACE THE WRITE IS NOT UNDER THE USER'S RLS, and the reason
        // is structural: a cron has no session. The service role is used for
        // the listing above and then for this user's own rows, with the user id
        // taken from the connection row and never from a request.
        // ./import.ts' header names the three properties that stand in for RLS
        // here, and every statement it issues carries the user.
        client: admin,
        admin,
        dayStartMs,
        windowStartMs,
        env,
        // THE WHOLE REASON THIS FILE EXISTS. Every other field above is
        // ./import-cron.ts' with a narrower window; this one line is the
        // difference, and the half-hour before the trading day rolls is the
        // only time in the twenty-four that it can be true and mean something.
        readStops: true,
      });
      accumulate(run, counts);
    } catch (error) {
      run.failedUsers += 1;
      // The error's NAME, deduplicated at the end. A message from this chain
      // can name a contract or a product id, and one from PostgREST can echo a
      // row.
      failureKinds.push(error instanceof Error ? error.name : 'non-Error throw');
    }
  }

  const line =
    `[tradovate][orders-cron] found=${run.found} attempted=${run.attempted} ` +
    `imported=${run.imported} updated=${run.updated} unchanged=${run.unchanged} ` +
    `skippedOpen=${run.skippedOpen} skippedHidden=${run.skippedHidden} ` +
    `failed=${run.failed} skippedUsers=${run.skippedUsers} ` +
    `failedUsers=${run.failedUsers}` +
    (failureKinds.length > 0 ? ` kinds=${[...new Set(failureKinds)].join(',')}` : '');

  if (run.failedUsers > 0 || run.failed > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));

  return run;
}
