/**
 * Who is allowed to connect a Tradovate account.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * THE RULE, AND IT IS THE WHOLE MODULE:
 *
 *   TRADOVATE_OAUTH_ALLOWED_USER_IDS empty or unset = everyone allowed.
 *   Non-empty = restrict to exactly those ids.
 *
 * So the Tradovate connection is OPEN TO EVERY SIGNED-IN USER by default, and
 * the variable is a rollback lever rather than a gate: launching is clearing
 * it, and rolling back is pasting one id into it. One environment change in
 * either direction, no deploy and no code revert.
 *
 *
 * THIS IS THE REVERSE OF WHAT THIS FILE USED TO SAY (REF-112, §6)
 * --------------------------------------------------------------
 *
 * It used to FAIL CLOSED: a missing variable, an empty variable, or a value
 * that parsed to no usable ids all meant *nobody is allowed*, and the header
 * said so in capitals and told the next reader to delete this module when the
 * connection shipped to all users.
 *
 * That default was right for the reason it gave. The registered OAuth redirect
 * URI is the production one and nothing else (§5.18), so the flow could only
 * ever be exercised against a production deployment — and until that test had
 * passed, production was carrying an untested OAuth path that writes tokens to
 * the database. The failure mode of a typo in the variable had to be "the owner
 * cannot connect either", not "every user can".
 *
 * That test has passed, so the thing the fail-closed default was protecting is
 * no longer at risk, and the cost of keeping it has reversed: with the variable
 * cleared, fail-closed means nobody can connect at all.
 *
 * THE MODULE IS NOT DELETED, AND THAT IS THE POINT. §6 of the investigation
 * found no feature-flag infrastructure anywhere in this repository, so a
 * rollback had to be designed in rather than discovered. Deleting the guards
 * would have made re-closing the connection a code change, a review and a
 * deploy — at exactly the moment when the reason to re-close it is that
 * something is going wrong in production. Inverting one boolean instead keeps
 * all 10 server enforcement points, all 6 UI gates and all 4 check scripts
 * working as they are, and turns the variable into the lever.
 *
 * The old header's "delete this module" instruction is therefore gone rather
 * than merely stale. Leaving it above inverted logic would have been the worst
 * available outcome: the next reader would have trusted a comment that is now
 * exactly backwards.
 *
 *
 * ONE FUNCTION DECIDES, AND NOTHING COPIES IT
 * -------------------------------------------
 *
 * {@link isUserAllowed} is the only answer to "may this user use the Tradovate
 * connection", and every one of the 20 places that asks calls it — the 10
 * server enforcement points (connect, callback, today, trades, sync, live, the
 * import, orders and keep-alive crons, and the import-before-email eligibility
 * in the send-alerts cron), the 6 server-rendered UI gates, and the 4 check
 * scripts. None of them parses the variable itself and none of them has its own
 * copy of the rule, which is what makes flipping the default a one-line change
 * instead of a hunt.
 *
 * A PARTIAL ROLLBACK WOULD BE WORSE THAN NONE, which is why they all read the
 * same function. §3 of the investigation names the sharpest case: if
 * `runKeepAlive` were ever to stop honouring this, the cron would silently
 * refresh no one and every connection would die at token expiry with no signal
 * anywhere.
 *
 * The settings UI also hides the button for a restricted user, but that is
 * cosmetic — a hidden button is a link anyone can still navigate to, and both
 * OAuth routes check this independently.
 */

/** The variable holding the allowlist. Comma-separated Supabase user ids. */
export const TRADOVATE_ALLOWLIST_ENV_VAR = 'TRADOVATE_OAUTH_ALLOWED_USER_IDS';

/**
 * Parse the allowlist into normalised ids.
 *
 * Tolerant of the shapes a comma-separated list arrives in after a copy-paste
 * out of a dashboard: surrounding whitespace, newlines, a trailing comma, and
 * mixed case. Not tolerant of anything else — an entry that is not a plausible
 * id is dropped rather than matched loosely.
 *
 * UNCHANGED BY THE INVERSION, deliberately. An empty result still means "no
 * usable ids were configured"; what changed is only what the callers conclude
 * from that. Keeping the parser's meaning fixed is what lets
 * {@link isUserAllowed} and {@link isAllowlistRestricting} be read as one rule
 * stated twice rather than two rules that have to be kept in agreement.
 */
export function parseAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[TRADOVATE_ALLOWLIST_ENV_VAR];
  if (!raw) return [];

  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * True when this Supabase user may use the Tradovate connection.
 *
 * NO IDS CONFIGURED MEANS EVERYONE, which is the inversion. See the header for
 * why, and note the one consequence worth stating at the call site: a TYPO in
 * the variable no longer locks everybody out, it opens the connection to
 * everybody. That is the intended direction now — the open state is the
 * launched state — but it does mean the variable can no longer be trusted to
 * announce its own failure, so {@link isAllowlistRestricting} exists for a
 * deployment check to assert the state on purpose.
 *
 * AN EMPTY USER ID IS STILL REFUSED, and it is the one thing that did not
 * invert. Every caller takes the id from a Supabase session or from a
 * `connection.user_id` on a row, so an empty string here is not an
 * unrestricted deployment — it is a caller that has lost track of whose
 * request this is, and answering "allowed" to that would be answering a
 * question nobody asked about anybody.
 *
 * Ids are compared case-insensitively because Postgres renders a uuid in
 * lowercase but people paste them in whatever case they were shown. No
 * constant-time comparison: a user id is not a secret, it is in the session
 * the caller already holds, and treating it as one would imply it is safe to
 * put somewhere a secret would not be.
 */
export function isUserAllowed(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = userId.trim().toLowerCase();
  if (!id) return false;

  const allowed = parseAllowlist(env);
  // The inversion, in one line: no list is not a closed gate any more.
  if (allowed.length === 0) return true;

  return allowed.includes(id);
}

/**
 * Whether the variable is currently RESTRICTING the connection to a list.
 *
 * RENAMED FROM `isAllowlistConfigured`, and the rename is load-bearing rather
 * than cosmetic. That name asked "did anybody set this up", and under
 * fail-closed the answer doubled as "is the gate shut" — which is how the
 * routes and the three crons used it, to tell "the gate is shut because nobody
 * configured it" apart from "the gate is shut because you are not on the list"
 * in their server-side logging. After the inversion an unconfigured variable is
 * the OPEN state, so every one of those uses read exactly backwards, and all of
 * them are gone. Renaming the export is what turned each of them into a
 * compile error instead of a log line that lies.
 *
 * NOT AN ENFORCEMENT CHECK AND MUST NEVER BECOME ONE. {@link isUserAllowed} is
 * the only function that decides whether a user may connect; this one reports
 * the deployment's state so a launch or rollback can be verified on purpose.
 * Its only caller is scripts/tradovate-oauth-check.ts, which prints a COUNT and
 * never an id.
 */
export function isAllowlistRestricting(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAllowlist(env).length > 0;
}
