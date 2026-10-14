/**
 * TEMPORARY (diag/ref-90-hosts) — is the account list empty, or are we asking
 * the wrong host?
 *
 * SERVER ONLY — see ./config.ts.
 *
 * REF-90's 14.10 measurement came back `accounts=0 … filter: total=0`: a 200
 * carrying an empty array, so Tradovate answered truthfully and not one of the
 * seven conditions in ./accounts.ts was ever evaluated. What remains is the
 * question the counts cannot reach — WHICH HOST was asked.
 * {@link resolveTradingApiUrl} routes by the connection's `environment` column,
 * and that column is a copy of this deployment's TRADOVATE_API_URL rather than
 * a property of the user (see ./hosts.ts `detectEnvironment`). Tradovate's
 * prop-firm documentation provisions evaluation accounts in the DEMO
 * environment, and the token exchange returns a per-user `demo` host on every
 * connection — "demo — Always — … This is the host that varies by
 * organization" (https://docs.ninjatrader.com/api/dynamic-api-hosts). So a
 * trader whose only account is a prop firm's would own nothing in the scope we
 * query, and `[]` is the correct answer to the wrong question.
 *
 * This asks BOTH hosts the same question with the same token and reports four
 * integers per host. One page load distinguishes the three live hypotheses:
 *
 *   demo n>0 owned>0   the account was always there; route by purpose, not by
 *                      the environment column
 *   demo status=401    tokens are environment-scoped; a much larger problem
 *                      that needs NinjaTrader support before any code
 *   both n=0           not an environment problem; move to the entitlement and
 *                      visible-scope questions instead
 *
 *
 * WHAT IT REPORTS, AND WHAT IT REFUSES TO
 * ---------------------------------------
 *
 * Counts and two enum words. **No hostname, ever** — not in the return value
 * and not in a log line. That is the one field this diagnostic could carry that
 * the counts diagnostic could not, and it is the one that must not be logged:
 * `apiHosts.demo` is documented as varying by organization, so printing it
 * would name the prop firm this user trades for. `source` answers the question
 * a hostname would be reached for ("did the row even carry a per-organization
 * host") without naming it.
 *
 * Also absent, for the same reasons as the counts line in the route: no user
 * id, no `tradovate_user_id`, no account ids or names, no P&L, no timestamps,
 * no token. {@link HostProbe} is counts-only BY TYPE, so the route cannot log
 * a hostname by accident — the value it is handed does not contain one.
 *
 * READ ONLY. Two GETs and no writes. It does not touch the OAuth URLs,
 * TRADOVATE_API_URL, or the stored row.
 *
 *
 * THE SECOND QUESTION (diag/ref-90-perms, Stage 0)
 * ------------------------------------------------
 *
 * The host probe answered the first one and opened a second. It came back
 * `configured=live live: … n=0 owned=0 | demo: … n=1 owned=0`: the account is
 * on demo, a live-minted token reads demo fine — and the account's `userId` is
 * NOT ours, so the ownership test at ./accounts.ts:107 would drop it even once
 * the routing is fixed. Two hypotheses survive that, and they are a small PR
 * apart:
 *
 *   A  the account belongs to the firm's admin user and our trader holds a
 *      TradingPermission on it     → ./accounts.ts gains `owned OR permitted`
 *   B  user identity is numbered PER HOST, and /auth/me (live-only) gave us the
 *      live id for a human whose demo id is different
 *                                  → the stored id is the wrong key entirely,
 *                                     and no permission join can fix it
 *
 * {@link probeTradingPermissions} separates them with five more integers per
 * host: a permission of ours on demo is A, while `users=1 self=0` — a visible
 * user registry that does not contain us — is B.
 *
 * It reads TWO MORE ENTITIES, AND BOTH CARRY REAL PII. `TradingPermission` has
 * `accountHolderContact`, `accountHolderEmail`, `ctaContact` and `ctaEmail` —
 * two names and two email addresses, required fields — and `/user/list` carries
 * `name` and `email`. Nothing above the probe may ever see them, so the probe
 * reads `userId`, `id` and `status` and NOTHING ELSE, and {@link PermProbeSide}
 * is integers plus one closed union of words BY TYPE, exactly as
 * {@link HostProbeSide} is the reason a hostname cannot be logged by accident.
 * A `status` that is not one of the five documented words reports `other`
 * rather than itself — an unvalidated string from this entity is precisely what
 * must not reach a log line.
 *
 * Still read only. Four more GETs, no writes.
 */

import type { ResolvedApiUrl } from './api-hosts';
import { TradovateRequestError } from './errors';
import type { TradovateEnvironment } from './hosts';

/**
 * The HTTP status, or 'err' when the call did not produce one.
 *
 * 'err' covers a network fault, a rate-limit penalty ({@link
 * TradovatePenaltyError} after ./client.ts has exhausted its waits), an
 * unparsable body, and a bug of ours — all of which are "no answer from this
 * host" rather than an answer. Distinguishing them further would mean
 * classifying error shapes in a diagnostic that exists to be deleted; the
 * route's own failure warning already names the exception when one escapes.
 */
export type HostProbeStatus = number | 'err';

/** What one host said. Four integers and one enum word. */
export interface HostProbeSide {
  /** Whether the URL came from the row's `api_hosts` or from ./hosts.ts. */
  source: ResolvedApiUrl['source'];
  status: HostProbeStatus;
  /**
   * Length of the returned array.
   *
   * -1 for a 200 that did not carry an array at all, which is NOT the same
   * finding as an empty one: REF-90 §1 had to rule out an `{errorText: …}`
   * body by deduction from a `TypeError`, and one integer settles it here.
   */
  n: number;
  /** How many of them have `userId === tradovate_user_id`. */
  owned: number;
}

/** What both hosts said, plus which one the product path would have used. */
export interface HostProbe {
  configured: TradovateEnvironment;
  live: HostProbeSide;
  demo: HostProbeSide;
}

/** A host was not asked at all. The shape a zeroed side takes. */
const NOT_ASKED: HostProbeSide = { source: 'fallback', status: 'err', n: 0, owned: 0 };

/**
 * One line, in the order a reader needs it: what we would have asked, then
 * what each host actually said.
 *
 * Asserted in full by scripts/tradovate-today-check.ts — a format string is
 * wrong silently or not at all.
 */
export function formatHostProbe(probe: HostProbe): string {
  const side = (s: HostProbeSide): string =>
    `source=${s.source} status=${s.status} n=${s.n} owned=${s.owned}`;

  return (
    `configured=${probe.configured} ` +
    `live: ${side(probe.live)} | ` +
    `demo: ${side(probe.demo)}`
  );
}

/**
 * How many of a body's entries belong to this trader.
 *
 * Defensive about the body because this is a diagnostic reading an unvalidated
 * response from a host we have never successfully called: anything that is not
 * an array answers -1, and a null `tradovateUserId` answers 0 rather than
 * guessing — the same fail-safe direction as selectTradingAccounts().
 */
function countOwned(body: unknown, tradovateUserId: number | null): { n: number; owned: number } {
  if (!Array.isArray(body)) return { n: -1, owned: 0 };
  if (tradovateUserId === null) return { n: body.length, owned: 0 };

  let owned = 0;
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    if ((entry as { userId?: unknown }).userId === tradovateUserId) owned++;
  }
  return { n: body.length, owned };
}

/**
 * Ask one host for the account list and reduce the answer to four integers.
 *
 * Every failure is caught here, so one host cannot cost us the other's answer —
 * which is the whole point of asking both. A thrown
 * {@link TradovateRequestError} still carries the status it failed with, and
 * that status is the most informative thing this probe can learn: a 401 from
 * demo is the finding that would make this a much bigger ticket.
 */
async function probeOne(params: {
  host: ResolvedApiUrl;
  tradovateUserId: number | null;
  get: (apiUrl: string) => Promise<unknown>;
}): Promise<HostProbeSide> {
  const { host, tradovateUserId, get } = params;

  try {
    const body = await get(host.url);
    const { n, owned } = countOwned(body, tradovateUserId);
    // ./client.ts returns only on a 2xx and throws on everything else, so the
    // status is not observable here beyond "it succeeded". 200 is what
    // /account/list answers with; a 204 would arrive as a null body and show
    // as n=-1, which is visible rather than silent.
    return { source: host.source, status: 200, n, owned };
  } catch (error) {
    return {
      source: host.source,
      status: error instanceof TradovateRequestError ? error.status : 'err',
      n: 0,
      owned: 0,
    };
  }
}

/**
 * Ask both hosts, sequentially.
 *
 * Sequential rather than parallel for the reason the keep-alive loop gives:
 * Tradovate rate-limits per second as well as per hour, and two simultaneous
 * calls on behalf of a user who did not ask for either is the wrong way to
 * spend that budget. There is no deadline here — this runs after the response
 * has already been computed.
 */
export async function probeAccountHosts(params: {
  configured: TradovateEnvironment;
  hosts: Record<TradovateEnvironment, ResolvedApiUrl>;
  tradovateUserId: number | null;
  get: (apiUrl: string) => Promise<unknown>;
}): Promise<HostProbe> {
  const { configured, hosts, tradovateUserId, get } = params;

  const live = hosts.live
    ? await probeOne({ host: hosts.live, tradovateUserId, get })
    : NOT_ASKED;
  const demo = hosts.demo
    ? await probeOne({ host: hosts.demo, tradovateUserId, get })
    : NOT_ASKED;

  return { configured, live, demo };
}

// ── The permission probe (diag/ref-90-perms, Stage 0) ───────────────────────

/** The five documented `TradingPermission.status` values. */
const PERMISSION_STATUSES = [
  'Accepted',
  'Approved',
  'Declined',
  'Requested',
  'Revoked',
] as const;

/**
 * One word for the status of the permission we found, and the three ways there
 * is no word to give:
 *
 * - `'-'`  no permission of ours in the list, so nothing has a status.
 * - `'err'` the list did not answer at all.
 * - `'other'` a 200 carrying a `status` that is not one of the five documented
 *   words. It reports `other` and NOT the value: `/tradingPermission/list` is
 *   unverified (the docs page 404s, see the design note §2.2), its real
 *   response shape is therefore unknown, and an unknown string from an entity
 *   whose other fields are two names and two email addresses is the last thing
 *   that should be interpolated into a log line. A deliberate dead end — if
 *   this is what the probe reports, read the status from a debugger, not here.
 */
export type PermStatusWord = (typeof PERMISSION_STATUSES)[number] | '-' | 'err' | 'other';

/**
 * What one host said about permissions and users. Four integers and one word,
 * BY TYPE — there is no field here that could hold a name, an email, an
 * account id or a hostname, which is what makes the formatter below safe to
 * read rather than something to audit.
 */
export interface PermProbeSide {
  /**
   * Length of `/tradingPermission/list`, in the logged-on user's visible scope.
   *
   * -1 for a non-array 200 and for a call that failed — distinguished by
   * `status`, which is `err` only in the second case. Both readings matter:
   * the path is a convention rather than a documented slug, so `perms=-1
   * status=err` is the answer "not where we guessed", and `perms=-1 status=-`
   * is "answered, but not with a list".
   */
  perms: number;
  /** How many of them have `userId === tradovate_user_id`. */
  mine: number;
  /** The status of the FIRST `mine` permission. {@link PermStatusWord}. */
  status: PermStatusWord;
  /** Length of `/user/list`. -1 for a non-array 200 or a failed call. */
  users: number;
  /**
   * 1 when some entry has `id === tradovate_user_id`.
   *
   * The whole of hypothesis B rests on this one bit: `users>0 self=0` on demo
   * says the host has a user registry that does not contain the id /auth/me
   * gave us, and then no permission join can help.
   */
  self: 0 | 1;
}

/** What both hosts said. No `configured` — the host probe's line carries it. */
export interface PermProbe {
  live: PermProbeSide;
  demo: PermProbeSide;
}

/** Neither endpoint was asked, because the host itself was absent. */
const PERM_NOT_ASKED: PermProbeSide = { perms: -1, mine: 0, status: 'err', users: -1, self: 0 };

/**
 * One line, in the order the hypotheses are tested: how many permissions exist,
 * how many are ours, what the first one of ours says, then the user registry.
 *
 * Asserted in full by scripts/tradovate-today-check.ts, like the host line.
 */
export function formatPermProbe(probe: PermProbe): string {
  const side = (s: PermProbeSide): string =>
    `perms=${s.perms} mine=${s.mine} status=${s.status} users=${s.users} self=${s.self}`;

  return `live: ${side(probe.live)} | demo: ${side(probe.demo)}`;
}

/**
 * Reduce a `/tradingPermission/list` body to two integers and one word.
 *
 * READS `userId` AND `status`, AND NOTHING ELSE. Not
 * `accountHolderContact`/`accountHolderEmail`, not `ctaContact`/`ctaEmail`, not
 * even `accountId` — which the rule in §2.3 will need and this probe does not,
 * so it is not read.
 *
 * Defensive about the body for the reason the whole module is: this is an
 * endpoint we have never successfully called, at a path taken from a naming
 * convention. A null `tradovateUserId` counts nothing rather than guessing,
 * the same fail-safe direction as selectTradingAccounts().
 */
function readPermissions(
  body: unknown,
  tradovateUserId: number | null
): { perms: number; mine: number; status: PermStatusWord } {
  if (!Array.isArray(body)) return { perms: -1, mine: 0, status: '-' };
  if (tradovateUserId === null) return { perms: body.length, mine: 0, status: '-' };

  let mine = 0;
  let status: PermStatusWord = '-';

  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { userId, status: raw } = entry as { userId?: unknown; status?: unknown };
    if (userId !== tradovateUserId) continue;

    mine++;
    if (mine > 1) continue;
    status =
      typeof raw === 'string' && (PERMISSION_STATUSES as readonly string[]).includes(raw)
        ? (raw as PermStatusWord)
        : 'other';
  }

  return { perms: body.length, mine, status };
}

/**
 * Reduce a `/user/list` body to one integer and one bit.
 *
 * READS `id` AND NOTHING ELSE — this entity carries `name` and `email`.
 */
function readUsers(
  body: unknown,
  tradovateUserId: number | null
): { users: number; self: 0 | 1 } {
  if (!Array.isArray(body)) return { users: -1, self: 0 };
  if (tradovateUserId === null) return { users: body.length, self: 0 };

  let self: 0 | 1 = 0;
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    if ((entry as { id?: unknown }).id === tradovateUserId) self = 1;
  }

  return { users: body.length, self };
}

/**
 * Ask one host both questions.
 *
 * Each call is caught SEPARATELY, so a 404 on the unverified permission path
 * does not cost us the `/user/list` answer that decides hypothesis B — the same
 * reasoning that makes the host probe ask both hosts. The catch wraps the
 * reduction as well as the request, so a bug in either reports `err` rather
 * than escaping: the pull this runs after has already succeeded, and a
 * diagnostic must not be able to turn a served response into a failure.
 */
async function probePermissionsOne(params: {
  apiUrl: string;
  tradovateUserId: number | null;
  get: (apiUrl: string, path: string) => Promise<unknown>;
}): Promise<PermProbeSide> {
  const { apiUrl, tradovateUserId, get } = params;

  let perms = -1;
  let mine = 0;
  let status: PermStatusWord = 'err';
  try {
    ({ perms, mine, status } = readPermissions(
      await get(apiUrl, '/tradingPermission/list'),
      tradovateUserId
    ));
  } catch {
    // The status code is not carried: `status` is spoken for by the permission's
    // own enum word, and one field cannot mean two things. `err` says the call
    // did not answer, which is the reading that matters here — a 401 and a 404
    // both mean this join is not available to us at this path.
    perms = -1;
    mine = 0;
    status = 'err';
  }

  let users = -1;
  let self: 0 | 1 = 0;
  try {
    ({ users, self } = readUsers(await get(apiUrl, '/user/list'), tradovateUserId));
  } catch {
    users = -1;
    self = 0;
  }

  return { perms, mine, status, users, self };
}

/**
 * Ask both hosts, sequentially, for the same reason {@link probeAccountHosts}
 * does: Tradovate rate-limits per second as well as per hour, and this is four
 * calls made on behalf of a user who asked for none of them. There is no
 * deadline — the response has already been computed.
 *
 * CANNOT THROW. Every call and every reduction is caught in
 * {@link probePermissionsOne}, and a failure is one word in the line.
 */
export async function probeTradingPermissions(params: {
  hosts: Record<TradovateEnvironment, ResolvedApiUrl>;
  tradovateUserId: number | null;
  get: (apiUrl: string, path: string) => Promise<unknown>;
}): Promise<PermProbe> {
  const { hosts, tradovateUserId, get } = params;

  const live = hosts.live
    ? await probePermissionsOne({ apiUrl: hosts.live.url, tradovateUserId, get })
    : PERM_NOT_ASKED;
  const demo = hosts.demo
    ? await probePermissionsOne({ apiUrl: hosts.demo.url, tradovateUserId, get })
    : PERM_NOT_ASKED;

  return { live, demo };
}
