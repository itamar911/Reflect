/**
 * Who is allowed to connect a Tradovate account.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * The registered OAuth redirect URI is the production one
 * (https://reflecttrading.app/api/tradovate/callback) and nothing else, so the
 * flow can only be exercised against a production deployment. Until that test
 * has passed, production is carrying an untested OAuth path that writes tokens
 * to the database — so it is closed to everyone except an explicit allowlist.
 *
 * FAIL CLOSED. A missing variable, an empty variable, or a value that parses to
 * no usable ids all mean *nobody is allowed*. This is the opposite of the usual
 * feature-flag default and it is deliberate: the failure mode of a typo here
 * should be "the owner cannot connect either", not "every user can".
 *
 * This is the real gate. The settings UI also hides the button for users who
 * are not on the list, but that is cosmetic — a hidden button is a link anyone
 * can still navigate to, and both routes check this independently.
 *
 * Remove this module when the Tradovate connection ships to all users. The
 * routes, not this file, are the place to start looking: delete the guard
 * clauses there and this becomes dead code.
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
 * Ids are compared case-insensitively because Postgres renders a uuid in
 * lowercase but people paste them in whatever case they were shown. No
 * constant-time comparison: a user id is not a secret, it is in the session
 * the caller already holds, and treating it as one would imply it is safe to
 * put somewhere a secret would not be.
 */
export function isUserAllowed(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = userId.trim().toLowerCase();
  if (!id) return false;
  return parseAllowlist(env).includes(id);
}

/**
 * Whether the allowlist is configured at all.
 *
 * Lets a route tell "the gate is shut because nobody set it up" apart from
 * "the gate is shut because you are not on it" in its *server-side* logging.
 * Both look identical to the user, on purpose: the response says only that the
 * feature is unavailable, so probing it reveals nothing about who is on the
 * list or whether one exists.
 */
export function isAllowlistConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAllowlist(env).length > 0;
}
