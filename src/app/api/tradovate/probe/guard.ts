/**
 * Read-only guard for the diagnostic probe.
 *
 * A direct port of the two independent guards in
 * `scripts/spike/tradovate-spike.mjs` — an endpoint allowlist and a mutation
 * denylist — and ported rather than imported because that script is ESM with
 * no exports for these and is due for deletion. The semantics are identical on
 * purpose; the spike's header says the denylist regex "was not touched and must
 * not be", and it is reproduced here character for character.
 *
 * Why a probe needs this at all: the spike ran against a demo account on the
 * owner's machine. This runs in production, with a real trader's OAuth token,
 * against both the demo AND live trading hosts. The blast radius of a typo in a
 * path string is larger here than it was there, not smaller.
 *
 * Every path below is a read. The one POST — the cash-balance snapshot — is
 * called out in {@link PROBE_ENDPOINTS} for the reason the spike gives: it
 * passes the denylist and it still must not become a precedent for "the
 * denylist allowed it, so it must be fine".
 */

/**
 * The endpoints the probe may call, and nothing else.
 *
 * Deps endpoints (`/deps?masterid=…`) are the Tradovate convention for "the
 * children of this entity". They are reads of the same entities the spike read
 * with `/list`, scoped to one master — see the note on fan-out in ./orders.ts.
 */
export const PROBE_ENDPOINTS = [
  // --- live mode (REF-108 Q8/Q9, REF-110) ---
  '/position/list',
  '/account/list',
  /** POST, and a read. See the module header. */
  '/cashBalance/getcashbalancesnapshot',

  // --- orders mode (REF-113 Q1-Q7) ---
  '/order/list',
  '/orderVersion/deps',
  '/orderStrategy/list',
  '/orderStrategyLink/deps',
  '/command/list',
  '/commandReport/deps',
  '/executionReport/deps',

  // --- orders mode, Q8 (REF-113 §4.2) — TEMPORARY, deleted with ./q8.ts ---
  //
  // All four are reads, and the last three are the documented
  // contract → maturity → product walk `src/lib/tradovate/fills.ts` already
  // takes on every pull. Q8 needs `/fill/list` for the entry price its distances
  // are measured from and the product's `tickSize` for the unit they are
  // measured in; neither number is ever emitted. See ./q8.ts.
  //
  // Checked against the denylist below the same way the rest of this list was:
  // none of the four contains `place`, `cancel`, `modify`, `create`, `update` or
  // `delete`. `/contract/item` is not `/contract/create`, and `/product/item`
  // reads a contract specification rather than anything of the trader's.
  '/fill/list',
  '/contract/item',
  '/contractMaturity/item',
  '/product/item',

  // --- fills mode (REF-117 Stage 0) — TEMPORARY, deleted with ./fills.ts ---
  //
  // The one endpoint that mode adds. A read, and one
  // `src/lib/tradovate/fills.ts` already makes on every day pull — it is the
  // source of the grouping REF-117 is measuring. `/fill/list` and
  // `/position/list` are listed above already and are not repeated.
  //
  // Checked against the denylist the same way the rest of this list was:
  // `/fillPair/list` contains no `place`, `cancel`, `modify`, `create`,
  // `update` or `delete`.
  '/fillPair/list',
] as const;

export type ProbeEndpoint = (typeof PROBE_ENDPOINTS)[number];

const ALLOWED = new Set<string>(PROBE_ENDPOINTS);

/**
 * Belt and braces, exactly as the spike words it: even if something lands in
 * the allowlist by mistake, anything that looks like it mutates trading state
 * is refused outright.
 *
 * Verified against every path in {@link PROBE_ENDPOINTS}: none of them matches.
 * `/orderStrategy/list` does not match `startorderstrategy`, which needs the
 * `start` prefix — the same observation the spike records when it added that
 * endpoint.
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

/** Self-check used by the route's preflight — see the note there. */
export function guardSelfCheck(): { ok: boolean; offenders: string[] } {
  const offenders = PROBE_ENDPOINTS.filter((path) => MUTATING.test(path));
  return { ok: offenders.length === 0, offenders: [...offenders] };
}
