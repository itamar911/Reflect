/**
 * Guards for the Account Lockout probe (REF-126 Stages 3 and 4).
 *
 * Ported from the deleted REF-113 probe (`e2240c6:src/app/api/tradovate/probe/
 * guard.ts`), which in turn ported it from `scripts/spike/tradovate-spike.mjs`.
 * The denylist regex is reproduced character for character, as both of those
 * headers require.
 *
 *
 * TWO DOORS, AND THEY ARE NOT THE SAME DOOR
 * -----------------------------------------
 *
 * Stage 4 adds the first write this product has ever made to Tradovate, and the
 * shape of this file is the main thing standing between "one deliberate write"
 * and "a route that can write".
 *
 *   - {@link assertReadOnly} — the read door. Unchanged in meaning: every path
 *     that goes through it is a read, and `/user/createaccountlockout` is
 *     REFUSED BY IT, both for being absent from {@link PROBE_ENDPOINTS} and for
 *     matching the denylist. That invariant is worth keeping, so the write was
 *     NOT added to the read allowlist.
 *   - {@link assertTheOneWrite} — the write door. It accepts exactly one string
 *     and nothing else: not a prefix, not a pattern, not a list with one entry
 *     today and two tomorrow. A second write endpoint cannot be added by
 *     appending to an array; it needs a new function and an argument for it.
 *
 * `./call.ts` mirrors the split: `callEndpoint` can only reach the read door,
 * and `callTheOneWrite` is the only thing that can reach the other.
 *
 *
 * THE ALLOWLIST IS THE CONTROL. THE DENYLIST IS A NET.
 * ---------------------------------------------------
 *
 * REF-126 Stage 2 measured this: `/user/expireaccountlockout` and
 * `/accountRiskStatus/setadminautoliqaction` BOTH PASS the denylist below, and
 * both are writes. The regex matches name shapes, not semantics — exactly what
 * `src/lib/tradovate/client.ts:411-417` warns about ("A verb says nothing about
 * what an endpoint does").
 *
 * So nothing here relies on the denylist to decide what is safe. Every path in
 * {@link PROBE_ENDPOINTS} is a read because the vendor documentation says so,
 * one by one, and {@link guardSelfCheck} reports both doors' verdicts in the
 * response so a reader can see the refusals rather than trust this comment.
 */

/**
 * The endpoints the probe may READ, and nothing else.
 *
 * Each is cited, because "it passed the denylist" is not a reason:
 *
 * - `/account/list` — GET, the discovery step the product already takes on
 *   every pull (`src/lib/tradovate/fills.ts:859`).
 *     https://partner.tradovate.com/api/rest-api-endpoints/accounting/account-list
 * - `/tradingPermission/list` — GET, already read by the product
 *   (`src/lib/tradovate/fills.ts:815`). Needed because a prop firm's evaluation
 *   account is owned by the firm's API admin and the trader only holds a
 *   permission on it (`src/lib/tradovate/accounts.ts:70-76`), so ownership
 *   alone cannot answer "is this account the trader's" — and Stage 3 measured
 *   exactly that: 0 owned, 3 permitted.
 * - `/user/accountlockoutstatus` — POST taking `{ accountIds }`, and a READ:
 *   the documentation describes it as returning lockout state and defines no
 *   effect. Stage 3 confirmed it answers HTTP 200 with `errorText: null`.
 *     https://partner.tradovate.com/api/rest-api-endpoints/users/account-lockout-status
 *
 * ADDED FOR STAGE 4's PREFLIGHT (REF-126 Stage 4 item 4), both GETs, both
 * already read by the product on every pull:
 *
 * - `/position/list` — GET (`src/lib/tradovate/positions.ts:328`). The lockout
 *   LIQUIDATES open positions, so this is the check that there are none. It is
 *   read for `netPos` and `accountId` only; no price is touched.
 *     https://partner.tradovate.com/api/rest-api-endpoints/positions/position-list
 * - `/order/list` — GET (`src/lib/tradovate/orders.ts:2613`). The lockout
 *   CANCELS working orders, so this is the check that there are none. It is
 *   read for `ordStatus` and `accountId` only.
 *     https://partner.tradovate.com/api/rest-api-endpoints/orders/order-list
 *
 * THE POST IS NOT EVIDENCE OF ANYTHING. `/user/accountlockoutstatus` is a POST
 * because Tradovate models a multi-id lookup as one, the same way
 * `/cashBalance/getcashbalancesnapshot` is — see
 * `src/lib/tradovate/client.ts:404-417`, where that sentence is written down
 * for the product.
 */
export const PROBE_ENDPOINTS = [
  '/account/list',
  '/tradingPermission/list',
  /** POST, and a read. See the module header and the note above. */
  '/user/accountlockoutstatus',
  '/position/list',
  '/order/list',
] as const;

export type ProbeEndpoint = (typeof PROBE_ENDPOINTS)[number];

const ALLOWED = new Set<string>(PROBE_ENDPOINTS);

/**
 * THE ONLY WRITE. One string, and the only write this product makes anywhere.
 *
 * `POST /user/createaccountlockout`, body `{ accountId, durationMinutes }`.
 * Documented "Available to: All authenticated users (own account only)" and
 * "only the eval user may initiate a trading lockout. Org admins and super
 * admins not permitted to create lockouts".
 *   https://partner.tradovate.com/api/rest-api-endpoints/users/create-account-lockout
 *
 * WHAT IT DOES, FROM THE VENDOR'S OWN WORDS, because the gating only makes
 * sense if this is in front of the next person who reads it:
 *
 *   "Closes positions and blocks orders. When a trader activates a lockout,
 *    open positions on the account are liquidated and new orders are rejected
 *    until the lockout expires."
 *
 *   "Traders can't cancel their own lockouts. Once activated, the lockout stays
 *    in effect until it expires or an organization administrator manually
 *    unlocks it."
 *
 * The trader cannot undo it. `expireaccountlockout` is org-admin-only, which on
 * an evaluation account means THE PROP FIRM and not us — it is deliberately not
 * reachable from this file by either door.
 */
export const THE_ONE_WRITE = '/user/createaccountlockout';

/**
 * Throw unless this path is a known read.
 *
 * Fails closed in both directions: an unlisted path is refused even if it is
 * harmless, and a listed path is refused if it looks like a mutation.
 *
 * {@link THE_ONE_WRITE} IS REFUSED HERE, deliberately and by both halves. The
 * write has its own door.
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
 * Throw unless this path is exactly {@link THE_ONE_WRITE}.
 *
 * An equality test and not a membership test, on purpose. A `Set` with one
 * entry invites a second; `===` against a single exported constant does not.
 * The denylist is NOT consulted here — it would refuse this path on `create`,
 * which is correct for the read door and meaningless for this one.
 */
export function assertTheOneWrite(path: string): void {
  if (path !== THE_ONE_WRITE) {
    throw new Error(`WRITE GUARD: refusing "${path}" (the only permitted write is ${THE_ONE_WRITE})`);
  }
}

/**
 * Belt and braces, exactly as the spike words it: even if something lands in
 * the read allowlist by mistake, anything that looks like it mutates trading
 * state is refused outright.
 *
 * Reproduced character for character from the spike and from the REF-113 probe.
 * Verified against every path in {@link PROBE_ENDPOINTS}: none matches.
 *
 * ITS LIMITS ARE DOCUMENTED IN THE HEADER. Do not add an endpoint on the
 * strength of this regex alone.
 */
const MUTATING =
  /place|cancel|modify|liquidat|closeposition|startorderstrategy|interrupt|accept|create|update|delete/i;

/**
 * The write endpoints REF-126 names, and what each door says about them.
 *
 * Reported in the response so a reader can see the refusals rather than trust
 * this file. The interesting column is `byDenylist`: two of these are writes
 * that the regex waves through, which is why the allowlist is the control.
 *
 * `/user/createaccountlockout` is the one row where `readDoor` and `writeDoor`
 * disagree, and that disagreement IS the design.
 */
export const WRITE_ENDPOINTS = [
  '/user/createaccountlockout',
  '/user/expireaccountlockout',
  '/accountRiskStatus/setadminautoliqaction',
  '/userAccountAutoLiq/updateuserautoliqs',
] as const;

function refuses(assert: (path: string) => void, path: string): boolean {
  try {
    assert(path);
    return false;
  } catch {
    return true;
  }
}

/** Self-check used by both handlers' preflight — see the note there. */
export function guardSelfCheck(): {
  ok: boolean;
  offenders: string[];
  writeDoorAcceptsOnly: string;
  writeEndpoints: {
    path: string;
    refusedByReadDoor: boolean;
    refusedByWriteDoor: boolean;
    byDenylist: boolean;
  }[];
} {
  const offenders = PROBE_ENDPOINTS.filter((path) => MUTATING.test(path));

  const writeEndpoints = WRITE_ENDPOINTS.map((path) => ({
    path,
    refusedByReadDoor: refuses(assertReadOnly, path),
    refusedByWriteDoor: refuses(assertTheOneWrite, path),
    byDenylist: MUTATING.test(path),
  }));

  // Every write must be refused by the read door, and every write EXCEPT the
  // one must be refused by the write door too.
  const ok =
    offenders.length === 0 &&
    writeEndpoints.every(
      (entry) =>
        entry.refusedByReadDoor &&
        (entry.path === THE_ONE_WRITE ? !entry.refusedByWriteDoor : entry.refusedByWriteDoor)
    );

  return { ok, offenders: [...offenders], writeDoorAcceptsOnly: THE_ONE_WRITE, writeEndpoints };
}
