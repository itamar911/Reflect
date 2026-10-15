/**
 * Pull one user's finished trades and write them to the journal (REF-107
 * Stage 2).
 *
 * SERVER ONLY. The one place that joins the two halves of the import — the
 * broker read (./fills.ts) and the database write (./import.ts) — so that the
 * two triggers which have to make a pull of their own do not each assemble it:
 * POST /api/tradovate/sync and the daily /api/cron/tradovate-import.
 *
 * /api/tradovate/today deliberately does NOT go through here. That trigger is
 * free precisely because it already has a pull in hand, and routing it through
 * a function that makes one would throw away the only thing that makes it free
 * (E9). It calls `importBrokerTrades` directly with the rows it already built.
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

import { tradovateGet } from './client';
import { getUserTradingApi, readIsTradeSource } from './connections';
import { loadBrokerDay, type TradovateReader } from './fills';
import { importBrokerTrades, isImportEnabled, type BrokerImportCounts } from './import';

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
}

/** A pull and the import it fed. `asOf` is the pull's, for the caller to report. */
export interface SyncResult {
  counts: BrokerImportCounts;
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
  const { userId, client, admin, dayStartMs, windowStartMs, env = process.env } = request;

  const enabled = isImportEnabled(env);
  const isTradeSource = enabled ? await readIsTradeSource(userId, { admin }) : false;

  if (!enabled || !isTradeSource) {
    // `importBrokerTrades` with an empty list would return the same thing. It
    // is called anyway, with nothing, so that the "did not run" shape has one
    // definition and lives in the module that owns it.
    const counts = await importBrokerTrades({ client, userId, trades: [], isTradeSource, env });
    return { counts, asOf: new Date().toISOString(), isTradeSource, importEnabled: enabled };
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

  const { day, trades } = await loadBrokerDay({
    readers: {
      live: readerFor(api.hosts.live.url),
      demo: readerFor(api.hosts.demo.url),
    },
    environment: api.environment,
    dayStartMs,
    windowStartMs,
    tradovateUserId: api.tradovateUserId,
  });

  // `day` is used for its timestamp alone. The scalars are the rules' business
  // and no rule is being evaluated here; the rows are the point.
  const counts = await importBrokerTrades({ client, userId, trades, isTradeSource, env });

  return { counts, asOf: day.asOf, isTradeSource, importEnabled: enabled };
}
