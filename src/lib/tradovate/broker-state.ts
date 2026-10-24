/**
 * What a SCREEN can say about a trader's broker connection without pulling
 * (REF-112 §5.4, §5.12).
 *
 * SERVER ONLY — it reads `tradovate_connections` through the service-role
 * client and `process.env` through the OAuth config. The decision it feeds is
 * pure and lives in ./notices.ts, which is browser-safe; this module is the
 * I/O half and nothing else.
 *
 *
 * WHY /accounts AND THE DASHBOARD NEED THIS AT ALL
 * ------------------------------------------------
 *
 * Neither page makes a Tradovate request and neither should: /accounts is a
 * read of Reflect's own tables (app/(app)/accounts/page.tsx' header is
 * explicit that everything on it is rendered from what the sync recorded), and
 * the dashboard is a journal. So the sync panel is the only surface that can
 * report what a PULL found — and two of §5's failures are states a trader sits
 * in between pulls:
 *
 *   - The connection cannot be refreshed because the deployment's environment
 *     no longer matches the one that minted it (§5.4). There will be no next
 *     pull. Waiting for the panel to say so means never saying so.
 *   - The trader has a live connection and not one usable account (§5.12).
 *     /accounts is the screen whose entire subject is that list, and its empty
 *     state currently promises "תיק מהברוקר נוצר לבד בסנכרון הבא" — which, for
 *     this trader, will never happen.
 *
 * ONE EXTRA READ PER PAGE VIEW, of a single row by primary key, on two pages.
 * It is the same read /settings already makes on every view of that screen.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readConnectionSummary } from './connections';
import { loadOAuthConfig } from './oauth-config';
import type { BrokerState } from './notices';

/**
 * Read enough of a trader's connection to decide what to tell them.
 *
 * NEVER THROWS, and that is the contract these two callers need: this runs
 * during the render of a page whose subject is something else, and a broker
 * notice is the least important thing on either of them. Every failure
 * resolves to `connection: 'unreadable'`, which {@link
 * import('./notices').brokerStateNotices} answers with silence — "I could not
 * ask" is not "you are not connected", and a database hiccup must not tell a
 * trader their broker link is dead.
 *
 * `brokerAccounts` IS THE CALLER'S, not read here, because both callers have
 * already read the `accounts` table for their own reasons and a second query
 * for a number they are holding would be a statement spent on nothing.
 */
export async function readBrokerState(params: {
  userId: string;
  /** How many broker-sourced rows the trader has, or null for "not counted". */
  brokerAccounts: number | null;
  /** Test seam. Production reads process.env through loadOAuthConfig. */
  env?: NodeJS.ProcessEnv;
  admin?: SupabaseClient;
}): Promise<BrokerState> {
  const { userId, brokerAccounts, env, admin } = params;

  let read;
  try {
    read = await readConnectionSummary(userId, admin);
  } catch {
    // readConnectionSummary already reports its own failures as values,
    // including the service-role client failing to build. This catches what is
    // left — nothing known, so nothing claimed.
    return { connection: 'unreadable', environmentMismatch: false, brokerAccounts };
  }

  if (read.outcome === 'error') {
    return { connection: 'unreadable', environmentMismatch: false, brokerAccounts };
  }
  if (read.outcome === 'none') {
    return { connection: 'none', environmentMismatch: false, brokerAccounts };
  }

  // §5.4. THE COMPARISON `redeemRefreshToken` ALREADY MAKES, read from the
  // other side. It answers `{outcome: 'skipped', reason: 'environment'}` when
  // these two differ and ./keepalive.ts counts that as an ordinary skip — so
  // the row stays 'active' while the refresh token quietly runs out. The
  // status column cannot express this and that is why it is a separate flag.
  //
  // A CONFIG THAT WILL NOT LOAD IS NOT A MISMATCH. `loadOAuthConfig` fails
  // closed on a missing or malformed variable, and a deployment that cannot
  // read its own OAuth settings has told us nothing about this connection.
  // Claiming a mismatch there would put "your connection expired" in front of
  // every trader on the first bad deploy.
  const config = loadOAuthConfig(env);
  const environmentMismatch =
    config.ok && config.config.environment !== read.summary.environment;

  return { connection: read.summary.status, environmentMismatch, brokerAccounts };
}
