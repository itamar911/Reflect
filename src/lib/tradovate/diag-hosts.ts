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
