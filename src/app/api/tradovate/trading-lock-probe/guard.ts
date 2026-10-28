/**
 * Read-only guard for the Account Lockout probe (REF-126 Stage 3).
 *
 * Ported from the deleted REF-113 probe (`e2240c6:src/app/api/tradovate/probe/
 * guard.ts`), which in turn ported it from `scripts/spike/tradovate-spike.mjs`.
 * The denylist regex is reproduced character for character, as both of those
 * headers require.
 *
 *
 * THE ALLOWLIST IS THE CONTROL. THE DENYLIST IS A NET.
 * ---------------------------------------------------
 *
 * This is the one thing that changed from the REF-113 version, and it changed
 * because REF-126 Stage 2 measured it: `/user/expireaccountlockout` and
 * `/accountRiskStatus/setadminautoliqaction` BOTH PASS the denylist below, and
 * both are writes. The regex matches name shapes, not semantics — exactly what
 * `src/lib/tradovate/client.ts:411-417` warns about ("A verb says nothing about
 * what an endpoint does").
 *
 * So nothing here relies on the denylist to decide what is safe. The three
 * paths in {@link PROBE_ENDPOINTS} are reads because the vendor documentation
 * says so, one by one, and for no other reason. The denylist stays because it
 * costs nothing and would catch a typo that turned a listed read into a listed
 * write — but it is the second line, not the first.
 *
 * `/user/createaccountlockout` is REFUSED by both halves: it is absent from the
 * allowlist, and it matches the denylist on `create`. That is deliberate and it
 * is the point — the write experiment (REF-126 Stage 4) cannot happen by
 * editing a path string here.
 */

/**
 * The endpoints this probe may call, and nothing else.
 *
 * All three are reads. Each is cited, because "it passed the denylist" is not a
 * reason:
 *
 * - `/account/list` — GET, the discovery step the product already takes on
 *   every pull (`src/lib/tradovate/fills.ts:859`).
 *     https://partner.tradovate.com/api/rest-api-endpoints/accounting/account-list
 * - `/tradingPermission/list` — GET, already read by the product
 *   (`src/lib/tradovate/fills.ts:815`). Needed because a prop firm's evaluation
 *   account is owned by the firm's API admin and the trader only holds a
 *   permission on it (`src/lib/tradovate/accounts.ts:70-76`), so ownership
 *   alone cannot answer "is this account the trader's".
 * - `/user/accountlockoutstatus` — POST taking `{ accountIds }`, and a READ:
 *   the documentation describes it as returning lockout state and defines no
 *   effect. It is the only endpoint here the product does not already call.
 *     https://partner.tradovate.com/api/rest-api-endpoints/users/account-lockout-status
 *
 * THE POST IS NOT EVIDENCE OF ANYTHING. It is a POST because Tradovate models
 * a multi-id lookup as one, the same way `/cashBalance/getcashbalancesnapshot`
 * is — see `src/lib/tradovate/client.ts:404-417`, which is where that sentence
 * is written down for the product.
 */
export const PROBE_ENDPOINTS = [
  '/account/list',
  '/tradingPermission/list',
  /** POST, and a read. See the module header and the note above. */
  '/user/accountlockoutstatus',
] as const;

export type ProbeEndpoint = (typeof PROBE_ENDPOINTS)[number];

const ALLOWED = new Set<string>(PROBE_ENDPOINTS);

/**
 * Belt and braces, exactly as the spike words it: even if something lands in
 * the allowlist by mistake, anything that looks like it mutates trading state
 * is refused outright.
 *
 * Reproduced character for character from the spike and from the REF-113 probe.
 * Verified against every path in {@link PROBE_ENDPOINTS}: none matches. Note
 * that `/user/accountlockoutstatus` does not contain `create`, `update`,
 * `delete` or `cancel` — and that `/user/createaccountlockout` does.
 *
 * ITS LIMITS ARE DOCUMENTED IN THE HEADER. Do not add an endpoint on the
 * strength of this regex alone.
 */
const MUTATING =
  /place|cancel|modify|liquidat|closeposition|startorderstrategy|interrupt|accept|create|update|delete/i;

/**
 * Throw unless this path is a known read.
 *
 * Fails closed in both directions: an unlisted path is refused even if it is
 * harmless, and a listed path is refused if it looks like a mutation.
 */
export function assertReadOnly(path: string): void {
  if (MUTATING.test(path)) {
    throw new Error(`READ-ONLY GUARD: refusing "${path}" (matches the mutation pattern)`);
  }
  if (!ALLOWED.has(path)) {
    throw new Error(`READ-ONLY GUARD: refusing "${path}" (not in the probe allowlist)`);
  }
}

/**
 * The four write endpoints REF-126 names, asserted to be refused.
 *
 * Reported in the response so a reader can see the refusal rather than trust
 * this file. Two of them pass the denylist — see the module header — so this
 * is really a test of the allowlist, which is the control.
 */
export const WRITE_ENDPOINTS_THAT_MUST_BE_REFUSED = [
  '/user/createaccountlockout',
  '/user/expireaccountlockout',
  '/accountRiskStatus/setadminautoliqaction',
  '/userAccountAutoLiq/updateuserautoliqs',
] as const;

/** Self-check used by the route's preflight — see the note there. */
export function guardSelfCheck(): {
  ok: boolean;
  offenders: string[];
  writesRefused: { path: string; refused: boolean; byDenylist: boolean }[];
} {
  const offenders = PROBE_ENDPOINTS.filter((path) => MUTATING.test(path));

  const writesRefused = WRITE_ENDPOINTS_THAT_MUST_BE_REFUSED.map((path) => {
    let refused = false;
    try {
      assertReadOnly(path);
    } catch {
      refused = true;
    }
    return { path, refused, byDenylist: MUTATING.test(path) };
  });

  return {
    ok: offenders.length === 0 && writesRefused.every((entry) => entry.refused),
    offenders: [...offenders],
    writesRefused,
  };
}
