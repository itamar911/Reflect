/**
 * Pull one user's finished trades and write them to the journal (REF-107
 * Stage 2).
 *
 * SERVER ONLY. The one place that joins the halves of the import — the broker
 * read (./fills.ts), the accounts pass (./account-sync.ts), the stop-order read
 * (./orders.ts) and the journal write (./import.ts) — so that the two triggers
 * which have to make a pull of their own do not each assemble it: POST
 * /api/tradovate/sync and the daily /api/cron/tradovate-import.
 *
 * THE FOUR HALVES ARE NOT ALL RUN BY EVERY CALLER. `readStops` is off by
 * default, because the nightly cron is structurally incapable of reading orders
 * — see the field, which has the clock arithmetic.
 *
 * /api/tradovate/today deliberately does NOT go through here. That trigger is
 * free precisely because it already has a pull in hand, and routing it through
 * a function that makes one would throw away the only thing that makes it free
 * (E9). It calls `importBrokerTrades` directly with the rows it already built.
 *
 * SO /today DOES NOT RECORD ACCOUNTS EITHER, and that is a deliberate scope
 * line for REF-110 Stages 1-2 rather than an oversight. It would be nearly
 * free — the pull it already makes now carries `BrokerDay.accounts` — but it
 * would put four more statements on the critical path of opening the trade
 * form, for a table nothing renders yet. The cost of leaving it out is bounded
 * and small: a trader's accounts are recorded on their next Sync or on the
 * nightly cron, whichever comes first, so the gap closes within a day for
 * everybody and immediately for anybody who presses the button. The rows
 * /today imports in the meantime are assigned by the backfill pass on that
 * same run. Revisit when the screen exists and a trader can notice the delay.
 *
 *
 * WHY THE WRITE CLIENT AND THE READ CLIENT ARE TWO PARAMETERS
 * ----------------------------------------------------------
 *
 * Because they are two different identities, and conflating them is the risk
 * §C12 names:
 *
 * - `client` is where the ROWS go, and therefore whose RLS applies. On the sync
 *   route it is the user's own session client, so the database enforces
 *   ownership exactly as it does for every write the browser makes today.
 * - `admin` is for the server-only reads — the decrypted token, the resolved
 *   hosts, the trade-source declaration. Those columns are unreadable from the
 *   browser by construction (migration 017), so this one has to be the
 *   service-role client and there is no version of this that does not use it.
 *
 * In the cron the two are the same object, because a background job has no
 * session. What stands in for RLS there is in ./import.ts' header: `userId` is
 * never read from a request, and every statement carries it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { syncBrokerAccounts, type AccountSyncCounts } from './account-sync';
import { tradovateGet } from './client';
import { getUserTradingApi, readIsTradeSource } from './connections';
import { loadBrokerDay, type TradovateReader } from './fills';
import {
  importBrokerTrades,
  isImportEnabled,
  tradesNeedingStopHistory,
  type BrokerImportCounts,
} from './import';
import { readStopHistories } from './orders';

export interface SyncRequest {
  userId: string;
  /** Where the rows are written, and the identity they are written as. */
  client: SupabaseClient;
  /** Service-role client for the token, the hosts and the declaration. */
  admin: SupabaseClient;
  /** The trader's local midnight. Only the discarded scalars are cut at it. */
  dayStartMs: number;
  /**
   * The earliest close to reach back to.
   *
   * This is the ONLY parameter that changes what the pull costs: §A2 measured
   * that the four list reads are unfiltered and cost the same for any window,
   * and that PRICING grows at one contract chain per distinct contract in it.
   */
  windowStartMs: number;
  /** Test seam for the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether to read the broker's protective orders too (REF-113 Stage 3).
   *
   * OFF BY DEFAULT, AND THE DEFAULT IS THE DECISION RATHER THAN THE SAFE
   * CHOICE. Three callers reach this function and they are not equivalent:
   *
   *   POST /api/tradovate/sync        true  — the trader is here, now, today
   *   the end-of-day summary          true  — same trading day, per user, at
   *                                           the hour that user chose
   *   /api/cron/tradovate-import      FALSE — and it could not be otherwise
   *
   * The nightly cron runs at 03:30 UTC. If the trading day rolls over at 17:00
   * CT, that is 22:00 or 23:00 UTC, so the cron fires FOUR AND A HALF TO FIVE
   * AND A HALF HOURS AFTER Tradovate has already cleared `/order/list` of the
   * day it is importing. It cannot see those orders — not on that run, and not
   * on any later one, because `/order/list` has no depth at all (`depthDays=0`,
   * measured 19.10). Asking would be seven to nine requests per trader per
   * night against a rate-limited third party, for an empty answer.
   *
   * So the cron does not ask, the trades it imports keep `stop_history = NULL`,
   * and NULL is what leaves them candidates for a run that can actually see the
   * orders. Stage 4 is the dedicated cron, timed to the trading day rather than
   * to midnight, that closes the gap for a trader who never opens the app.
   */
  readStops?: boolean;
}

/** A pull and the import it fed. `asOf` is the pull's, for the caller to report. */
export interface SyncResult {
  counts: BrokerImportCounts;
  /**
   * What the account pass recorded (REF-110 Stages 1-2).
   *
   * Counts only, and nothing upstream branches on them — the sync route does
   * not send them to the browser and the cron totals the trade counts alone.
   * They are here so that a caller CAN report them and so the regression suite
   * has something to assert against; the log line in ./account-sync.ts is what
   * an operator actually reads.
   */
  accounts: AccountSyncCounts;
  /** When this was read from Tradovate, ISO 8601. */
  asOf: string;
  /**
   * Whether the connection declares the broker a trade source (E7).
   *
   * NOT ENOUGH ON ITS OWN TO EXPLAIN A RUN THAT DID NOT HAPPEN, and the
   * regression suite asserts why: this is false whenever the FLAG is off too,
   * because the column cannot be read before migration 034 has run. So it is
   * exactly `counts.ran`, and a caller trying to tell "switched off" from "the
   * trader said no" has to read {@link importEnabled} instead. Kept because it
   * is the honest name for what the import gate was given.
   */
  isTradeSource: boolean;
  /**
   * Whether TRADOVATE_IMPORT_ENABLED was set for this run (REF-107 Stage 2.5).
   *
   * The field that separates the two `ran: false` states. With it false, no
   * column was read and no declaration was consulted — the deployment has the
   * import switched off. With it true and `ran` still false, the one remaining
   * reason is the trader's own declaration, which is a setting they can
   * change and therefore a different sentence.
   */
  importEnabled: boolean;
}

/**
 * Read the window and import what closed in it.
 *
 * THROWS WHAT THE PULL THROWS — TradovateNotConnectedError,
 * TradovateTransientError, TradovateUnpriceableError — so the caller maps them
 * through `classifyDayPullFailure` exactly as /today and /trades do. The IMPORT
 * does not throw; it returns counts, with refusals counted as `failed`.
 *
 * NO PULL AT ALL WHEN THERE IS NOTHING TO WRITE. Both gates are checked before
 * the first upstream request: an import that is switched off, or a connection
 * the trader has declared is not a source of trades, means seven to nine calls
 * against a rate-limited third party for a result that would be discarded.
 * /today cannot make this saving — it needs the pull for the figures — which is
 * the one behavioural difference between the triggers.
 */
export async function syncUserTrades(request: SyncRequest): Promise<SyncResult> {
  const {
    userId,
    client,
    admin,
    dayStartMs,
    windowStartMs,
    env = process.env,
    readStops = false,
  } = request;

  const enabled = isImportEnabled(env);
  const isTradeSource = enabled ? await readIsTradeSource(userId, { admin }) : false;

  if (!enabled || !isTradeSource) {
    // `importBrokerTrades` with an empty list would return the same thing. It
    // is called anyway, with nothing, so that the "did not run" shape has one
    // definition and lives in the module that owns it.
    const counts = await importBrokerTrades({ client, userId, trades: [], isTradeSource, env });
    // Same reasoning, and the same shape: the account pass is asked with no
    // hosts so that its "did not run" answer comes from the module that owns
    // it rather than from a literal written here. It issues no statement —
    // `isImportEnabled` stops it before the read, and an empty host list has
    // nothing to close.
    const { counts: accounts } = await syncBrokerAccounts({ client, userId, hosts: [], env });
    return {
      counts,
      accounts,
      asOf: new Date().toISOString(),
      isTradeSource,
      importEnabled: enabled,
    };
  }

  const api = await getUserTradingApi(userId, { admin });

  // ONE READER PER HOST, token and host travelling together — the invariant
  // ./client.ts enforces in the type system, and the same construction as
  // /today and /trades. Both hosts are built because both are asked:
  // `environment` is the token's mint server and says nothing about where the
  // trader's accounts live (REF-90).
  const readerFor = (apiUrl: string): TradovateReader => ({
    get: (path, query) => tradovateGet(path, query, { accessToken: api.accessToken, apiUrl }),
  });

  const { day, trades, accounts: hosts } = await loadBrokerDay({
    readers: {
      live: readerFor(api.hosts.live.url),
      demo: readerFor(api.hosts.demo.url),
    },
    environment: api.environment,
    dayStartMs,
    windowStartMs,
    tradovateUserId: api.tradovateUserId,
  });

  // THE ACCOUNTS FIRST, AND THE ORDER IS THE POINT (REF-110 Stages 1-2).
  //
  // The import needs `identities` to stamp `account_id` on the rows it writes,
  // and that map only exists once the accounts have rows of their own. Run the
  // other way round, every trade in a trader's FIRST sync would land
  // unassigned and wait for the next run's backfill to find it — correct in the
  // end, and a day late for no reason.
  //
  // `hosts` carries one entry per host that ANSWERED discovery, which is what
  // scopes the closure rule. It costs ZERO UPSTREAM REQUESTS: every account in
  // it came out of the `/account/list` the pull above already made.
  const { counts: accounts, identities } = await syncBrokerAccounts({
    client,
    userId,
    hosts,
    env,
  });

  // THE STOP ORDERS, AND ONLY FOR THE TRADES THAT STILL NEED THEM (REF-113
  // Stage 3). Two reads gate it and both matter: `tradesNeedingStopHistory` is
  // one select that drops everything already answered, and `readStopHistories`
  // returns only what is worth storing. A run with nothing new to ask about
  // makes ZERO upstream requests here, which is what lets three triggers share
  // a trading day without reading the same orders three times.
  //
  // It runs AFTER the pull and BEFORE the import, because the import is what
  // writes the three columns and it writes them in the same statement as the
  // facts. And it cannot throw: ./orders.ts swallows every READ and wraps the
  // DERIVATION, so a broker that refuses the order endpoints — or evidence the
  // derivation chokes on — costs this run its annotations and not its rows.
  // The derivation half of that was true by inspection for three stages and is
  // true by construction now; what sits on the other side of the bet is this
  // whole function, the journal rows of the trader's day included.
  //
  // A RUN WITH NOTHING TO ASK ABOUT NOW SAYS SO IN THE LOG rather than passing
  // in silence, which is the other half of the same lesson — see the zero-
  // candidate branch in `readStopHistories`.
  const stopHistories = readStops
    ? await readStopHistories({
        readers: {
          live: readerFor(api.hosts.live.url),
          demo: readerFor(api.hosts.demo.url),
        },
        trades: await tradesNeedingStopHistory({ client, userId, trades, env }),
      })
    : undefined;

  // `day` is used for its timestamp alone. The scalars are the rules' business
  // and no rule is being evaluated here; the rows are the point.
  const counts = await importBrokerTrades({
    client,
    userId,
    trades,
    isTradeSource,
    env,
    accountIds: identities,
    stopHistories,
  });

  return { counts, accounts, asOf: day.asOf, isTradeSource, importEnabled: enabled };
}
