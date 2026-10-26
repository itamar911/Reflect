/**
 * The Tradovate keep-alive: redeem every connection's refresh token before it
 * expires, so a connected user never has to reconnect (REF-100).
 *
 * SERVER ONLY — see ./config.ts. Driven by /api/cron/tradovate-keepalive once a
 * day, and tested directly by scripts/tradovate-refresh-check.ts.
 *
 * Separate from the route on purpose: the route owns the cron secret and builds
 * the service-role client, and this owns the loop. That split is what lets the
 * loop be driven against a stubbed Supabase client without the test having to
 * fabricate an authenticated request or hold a real key.
 *
 *
 * WHY A DAILY RUN IS ENOUGH
 * -------------------------
 *
 * The refresh token lasts 26 hours and ROTATES on every redemption (measured
 * 13 Oct 2026), so one successful redemption a day pushes the deadline a full
 * day out — the window never closes. 26 hours against a 24-hour cadence leaves
 * two hours of slack, which is what absorbs Vercel's scheduling drift (roughly
 * an hour on a daily cron) without the margin going negative.
 *
 * {@link KEEPALIVE_WINDOW_MS} is 25 hours, so in practice every active
 * connection is selected on every run. That is intended rather than sloppy: a
 * window narrower than the cadence would skip a connection whose expiry falls
 * just outside it and never look at it again before it lapsed. The cost of
 * redeeming early is nil — see REFRESH_REDEEM_MARGIN_MS in ./connections.ts.
 *
 *
 * WHAT IT REPORTS, AND WHAT IT REFUSES TO
 * ---------------------------------------
 *
 * Counts only. No user ids, no tokens, no row contents — not in the return
 * value and not in a log line. A daily job over every connected user is exactly
 * the wrong place to start writing identifiers into Vercel's logs, and a count
 * is all an operator needs to see that the mechanism is alive.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUserAllowed } from './allowlist';
import {
  countActiveConnections,
  listConnectionsDueForRefresh,
  redeemRefreshToken,
  type RefreshRedemption,
} from './connections';
import type { TradovateOAuthConfig } from './oauth-config';
import { redactSecrets } from './redact';

/**
 * How far ahead to look for refresh tokens about to expire.
 *
 * 25 hours, one more than the cadence, so no connection can fall between two
 * runs. With a 26-hour lifetime this selects essentially every active
 * connection every day, which is the intent.
 *
 * ONE POLICY, TWO NUMBERS. The request-path backstop uses
 * `REFRESH_REDEEM_MARGIN_MS` (12h, ./connections.ts) for the same decision, and
 * because this window selects everything, a successful run leaves every refresh
 * token *outside* that 12h margin for ~14 hours — so the backstop cannot fire
 * precisely when it is most needed. That is REF-100's 14.10 regression; the
 * `force` path in `redeemRefreshTokenIfDue()` is the fix. Widening this window
 * narrows that backstop's reach: change neither number without reading both.
 */
export const KEEPALIVE_WINDOW_MS = 25 * 60 * 60_000;

/** What one run did. Counts only — see the header. */
export interface KeepAliveCounts {
  /** Connections considered: due for refresh and past the allowlist. */
  checked: number;
  /** Redeemed and stored. */
  refreshed: number;
  /** Someone else redeemed first; the connection is alive either way. */
  superseded: number;
  /** Failed without a verdict. Nothing was written; the next run retries. */
  transient: number;
  /** Tradovate refused the refresh token. Marked 'expired'. */
  expired: number;
  /**
   * Selected but not attempted: not on the allowlist, or no longer active.
   * Nothing was sent for these.
   *
   * THE ENVIRONMENT MISMATCH IS NO LONGER COUNTED HERE (REF-112 §5.4). See
   * {@link KeepAliveCounts.strandedByEnvironment}.
   */
  skipped: number;
  /**
   * Connections this deployment CAN NEVER REFRESH, because the environment
   * that minted them is not the one it talks to (REF-112 §5.4).
   *
   * ITS OWN COUNTER, AND THAT IS ITEM 4 ON THIS SIDE. It was folded into
   * `skipped` with the note that "the distinction is not worth a second
   * counter", which was true of the other two things in there: an allowlist
   * miss and a row that moved on are both ordinary, both recur harmlessly,
   * and both resolve themselves.
   *
   * THIS ONE DOES NOT RESOLVE ITSELF. The row still says 'active', its
   * refresh token is quietly running out, and at a cutover EVERY pre-existing
   * connection lands here at once — migration 030 backfilled them all to
   * demo — and then expires at token lifetime, counted the whole time as
   * routine. It is a number an operator has to be able to watch go from 0 to
   * N on the first run after a deploy, which is the one moment it can still
   * be acted on.
   */
  strandedByEnvironment: number;
  /**
   * How many of the selected connections had no recorded refresh lifetime
   * (REF-112 follow-up item 2).
   *
   * NOT A SKIP, AND NOT DISJOINT FROM THE COUNTERS ABOVE. These rows used to be
   * filtered out of
   * {@link import('./connections').listConnectionsDueForRefresh} entirely and
   * are now handed to {@link import('./connections').redeemRefreshToken} like
   * any other, so each one is counted twice on purpose: once here, and once in
   * whichever outcome it reached. It overlaps every outcome counter and sums to
   * nothing with them.
   *
   * IT IS A COUNTER THAT SHOULD GO TO ZERO AND STAY THERE, which is what makes
   * it worth printing. A null lifetime is a pre-migration-030 row, and a
   * successful redemption records the real `refresh_token_expires_in` and fills
   * the column — permanently. So a healthy deployment shows this falling to 0
   * over a run or two and never rising again; a number that persists across
   * runs means the attempts are being refused, and the row is dying for a
   * reason the status column is about to record.
   */
  nullLifetime: number;
}

/**
 * Redeem the refresh token of every connection due for one.
 *
 * SEQUENTIAL, and one failure does not stop the rest. Sequential because the
 * point is to be gentle with a rate-limited third-party API on behalf of users
 * who did not ask for this request — there is no deadline here, only a daily
 * one — and because a parallel run would multiply the race the compare-and-swap
 * exists to handle for no gain.
 *
 * Every error is caught per connection. An exception escaping this loop would
 * abandon every connection after the one that threw, which over a daily job is
 * indistinguishable from the keep-alive not existing.
 */
export async function runKeepAlive(params: {
  admin: SupabaseClient;
  config: TradovateOAuthConfig;
  withinMs?: number;
  /** Test seam for the allowlist. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<KeepAliveCounts> {
  const { admin, config, withinMs = KEEPALIVE_WINDOW_MS, env = process.env } = params;

  const counts: KeepAliveCounts = {
    checked: 0,
    refreshed: 0,
    superseded: 0,
    transient: 0,
    expired: 0,
    skipped: 0,
    strandedByEnvironment: 0,
    nullLifetime: 0,
  };

  const due = await listConnectionsDueForRefresh({ admin, withinMs });

  // The warning that used to stand here is DELETED AND NOT REWRITTEN. It fired
  // when the variable was unset and said "every connection is skipped, nothing
  // was refreshed" — true under fail-closed and the exact opposite of the truth
  // now, because an unset variable is the open state in which every connection
  // IS refreshed. Renaming the export it called turned it into a compile error
  // rather than a log line that lies (./allowlist.ts).
  //
  // Nothing replaces it, because the state it was warning about no longer
  // exists: there is no configuration of this variable that silently refreshes
  // nobody. A restricted deployment skips exactly the ids its list excludes,
  // and `counts.skipped` already carries that number.
  //
  // THIS GUARD IS THE ONE §3 OF THE INVESTIGATION SINGLES OUT. It must keep
  // reading the same function as the two OAuth routes: a keep-alive that
  // stopped honouring a restriction would refresh connections the routes refuse
  // to create, and one that kept a restriction the routes had dropped would let
  // every new connection die at token expiry with no signal anywhere.
  for (const connection of due) {
    // A user id would be the one identifier worth having here and is exactly
    // what must not be logged, so the skip is counted and not narrated.
    if (!isUserAllowed(connection.user_id, env)) {
      counts.skipped += 1;
      continue;
    }

    counts.checked += 1;

    // REF-112 follow-up item 2. Counted before the attempt, because the point
    // is how many rows arrived here in that state rather than how many of them
    // worked — the outcome counters already answer the second question. See
    // {@link KeepAliveCounts.nullLifetime}.
    if (connection.refresh_expires_at === null) counts.nullLifetime += 1;

    let result: RefreshRedemption;
    try {
      result = await redeemRefreshToken({ connection, config, admin });
    } catch (error) {
      // redeemRefreshToken() classifies everything it can and returns rather
      // than throws, so reaching here means something unexpected — a failed
      // database write, most likely. Counted as transient: nothing can be
      // concluded about the connection, so nothing may be written about it.
      counts.transient += 1;
      const name = error instanceof Error ? error.name : 'non-Error throw';
      console.error(
        redactSecrets(`[tradovate][keepalive] unexpected failure redeeming a connection (${name})`)
      );
      continue;
    }

    switch (result.outcome) {
      case 'refreshed':
        counts.refreshed += 1;
        break;
      case 'superseded':
        counts.superseded += 1;
        break;
      case 'transient':
        counts.transient += 1;
        break;
      case 'expired':
        counts.expired += 1;
        break;
      case 'skipped':
        // Counted here rather than above because these were attempted far
        // enough to learn something.
        counts.checked -= 1;
        // REF-112 §5.4 — and this one IS worth a second counter. See
        // {@link KeepAliveCounts.strandedByEnvironment}: the other two skips
        // resolve themselves and this one is a connection that will expire
        // and never come back.
        if (result.reason === 'environment') counts.strandedByEnvironment += 1;
        else counts.skipped += 1;
        break;
    }
  }

  // REF-112 follow-up item 5. TWO SHAPES THAT MEAN "THE MECHANISM IS NOT
  // WORKING FOR SOMEBODY", AND BOTH WERE A SILENT `info`. The reason to raise
  // them is the one the stranding warning below already gives in capitals: this
  // line is not read until something is already wrong.
  //
  //   due=0 with at least one active connection — the §2(e) signature of the
  //   26.10 investigation, and the first thing it says to check. The selection
  //   found nothing while somebody IS connected, so that trader's refresh token
  //   is running out unwatched.
  //
  //   nothing renewed while something was due — every attempt failed.
  //
  // THE COUNT IS ONLY ASKED FOR WHEN IT CHANGES THE ANSWER. `due > 0` already
  // proves somebody is connected, so the extra statement is spent exactly once
  // a day and only on the run that would otherwise have nothing to say. A count
  // that FAILS returns null and raises nothing: "I could not tell" is not an
  // alarm, and an alarm nobody can act on is how a log line stops being read.
  const activeConnections = due.length === 0 ? await countActiveConnections({ admin }) : null;
  const nothingSelected = due.length === 0 && activeConnections !== null && activeConnections > 0;

  // `superseded` COUNTS AS RENEWED HERE, and it has to. It means another
  // redemption rotated the token first, so the connection is alive and the
  // mechanism demonstrably worked — just not in this process. Treating it as a
  // failure would warn about the one outcome that is already a success, which
  // is precisely the false alarm that teaches an operator to skip the line.
  const nothingRenewed = due.length > 0 && counts.refreshed === 0 && counts.superseded === 0;

  // Counts only, and the one line a healthy run leaves behind.
  const summary =
    `[tradovate][keepalive] due=${due.length} checked=${counts.checked} ` +
    `refreshed=${counts.refreshed} superseded=${counts.superseded} ` +
    `transient=${counts.transient} expired=${counts.expired} skipped=${counts.skipped} ` +
    `strandedByEnvironment=${counts.strandedByEnvironment} nullLifetime=${counts.nullLifetime}`;

  // THE SAME LINE AT A DIFFERENT LEVEL, rather than a second sentence beside
  // it. The counts ARE the diagnosis — the investigation's §3.1 reads this line
  // as a decision table — so what was missing was never more words, only the
  // severity that gets it in front of somebody.
  if (nothingSelected || nothingRenewed) console.warn(summary);
  else console.info(summary);

  // REF-112 §5.4. A SECOND LINE, AT WARN, BECAUSE THE FIRST ONE IS NOT READ
  // UNTIL SOMETHING IS ALREADY WRONG. Every connection in this count is going
  // to expire and cannot refresh its way out; the trader sees nothing until
  // the access token dies. At a cutover this is every pre-existing connection
  // at once, so the number is the alarm and the sentence is what makes it
  // legible in a log full of info lines. Counts only — no user id, no
  // environment name, nothing that identifies a row.
  if (counts.strandedByEnvironment > 0) {
    console.warn(
      `[tradovate][keepalive] ${counts.strandedByEnvironment} connection(s) cannot be ` +
        'refreshed by this deployment: they were minted against the other Tradovate ' +
        'environment and will expire at token lifetime. Each trader is shown ' +
        '"reconnect" on /accounts and the dashboard.'
    );
  }

  return counts;
}
