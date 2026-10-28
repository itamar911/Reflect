/**
 * GET /api/tradovate/trading-lock-probe?mode=lockout — a TEMPORARY diagnostic
 * route (REF-126 Stage 3).
 *
 * **This is not product code, nothing in the app imports it, and it is due for
 * deletion the day it answers.** It exists to measure one thing: whether
 * Reflect's OAuth token gets a valid answer from Tradovate's Account Lockout
 * READ endpoint, and on which host. See ./tradingLock.ts for what that does and
 * does not establish.
 *
 * Restored from the deleted REF-113 probe at `e2240c6` — not `2102bf3` — and
 * the reason is {@link STRICT_SUBTREE_KEY}. `2102bf3` checked only `sample`
 * keys, which is enough when every emitted value is a field shape; `e2240c6`
 * added a subtree whose EVERY value is checked and whose numbers must be
 * integers. This probe reports measurements rather than only shapes, so it
 * needs the stronger guard. `live.ts`, `orders.ts` and `q8.ts` were not
 * restored: they answer REF-108/REF-110/REF-113 and have no business here.
 *
 *
 * HOW THIS IS CLOSED
 * ------------------
 *
 * Three gates, each failing closed, and a caller that fails any of them cannot
 * tell this route from one that does not exist:
 *
 *   1. A session. No session, no route.
 *   2. {@link PROBE_ENV_VAR} — a SEPARATE allowlist from the integration's own
 *      `TRADOVATE_OAUTH_ALLOWED_USER_IDS`. Deliberately separate: being allowed
 *      to connect a broker account is not the same permission as being allowed
 *      to run a diagnostic that walks it. Unset means NOBODY, including the
 *      owner.
 *   3. The read-only guard in ./guard.ts, on every upstream call — where the
 *      ALLOWLIST is the control and the denylist is only a net. REF-126 Stage 2
 *      measured why: two write endpoints pass that regex.
 *
 * **404, not 403, for every refusal** — including an unrecognised `mode`, which
 * the REF-113 version answered with a 400. REF-126 Stage 3 item 4 asks for one
 * refusal, and it is right: a 400 on a bad mode tells an unauthorised caller
 * that the route exists and that there is a mode worth guessing.
 *
 *
 * WHAT IT MAY RETURN
 * ------------------
 *
 * Field names, field types, presence booleans, counts, enum members from a
 * fixed vocabulary, and durations in seconds — ./survey.ts owns that rule and
 * fails closed.
 *
 * **Plus two deliberate exceptions, which ./tradingLock.ts argues for one at a
 * time: the trader's OWN account ids, and `errorText` verbatim.** The documented
 * failure strings are the measurement here, and the owner needs the ids to line
 * the answer up against the accounts they locked by hand. Both are the owner's
 * own data, returned to the owner, behind an allowlist holding one id.
 *
 * It may NOT return a balance, a price, a quantity, a position, a fill, an
 * account NAME, an instant, or a hostname. No `endTime` is emitted — only
 * `endsInSeconds`.
 *
 * Two mechanisms, in this order:
 *
 *   - **By construction.** Every field shape goes through `safeSample`, whose
 *     allowlist emits a value only for a known low-cardinality enum.
 *   - **By check.** {@link scanForLeaks} re-reads the finished payload. Its
 *     result is in the response, so a reader can see that it ran rather than
 *     trusting this comment.
 *
 * `redactSecrets` is then applied to the serialised body. It is the LAST line
 * of defence and not the primary one.
 *
 * The two hosts are reported as the logical names `demo` and `live`. No URL is
 * emitted.
 *
 *
 * NO WRITES OF ANY KIND. No Tradovate write — `createaccountlockout` is absent
 * from the allowlist AND matches the denylist, and ./guard.ts reports that
 * refusal in the response. No database write either: `notingPenalty` was
 * deliberately NOT wrapped around these calls, because it records a penalty row
 * and this route's "no DB write" property is worth more than that bookkeeping.
 * `getUserTradingApi` already refuses to run while a penalty is live, so this
 * cannot pile onto one, and ./call.ts reports `rate_limited` if a new one
 * appears. No log line carries a value; this route logs nothing at all.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { getUserTradingApi } from '@/lib/tradovate/connections';
import { redactSecrets } from '@/lib/tradovate/redact';

import { guardSelfCheck, PROBE_ENDPOINTS } from './guard';
import { MAX_ACCOUNT_IDS, probeHostTradingLock, TRADING_LOCK_QUESTIONS } from './tradingLock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Comma-separated Supabase user ids. Unset or empty means nobody. */
export const PROBE_ENV_VAR = 'TRADOVATE_PROBE_USER_ID';

/** The only accepted mode. Anything else is a 404 — see the header. */
const MODE = 'lockout';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

/** The 404 every refused caller gets, whatever the reason. */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
}

/**
 * Whether this user may run the probe. Fails closed in every direction, for
 * the reasons lib/tradovate/allowlist.ts spells out — a typo here should mean
 * "the owner cannot run it either", never "everyone can".
 */
export function isProbeUser(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = userId.trim().toLowerCase();
  if (!id) return false;
  const allowed = (env[PROBE_ENV_VAR] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return allowed.includes(id);
}

/**
 * The grammar every emitted sample must match.
 *
 * `safeSample` produces exactly these shapes: a type placeholder, an array
 * length, `null`, a boolean, or an enum member. Anything else in a `sample`
 * position means a raw value reached the response.
 */
const SAFE_SAMPLE =
  /^(<(string|number|boolean|bigint|symbol|function|object|undefined)>|<array len=\d+>|null|true|false|[A-Za-z][A-Za-z0-9_-]{0,31})$/;

/**
 * The subtree every value of which is checked, not just its `sample` fields.
 *
 * `measurement` (./tradingLock.ts) reports COUNTS and BOOLEANS rather than
 * field shapes, so it has no `sample` keys for the rule above to catch and the
 * rule above would wave it through. Under this key the grammar applies to every
 * string, every object KEY, and numbers must be INTEGERS.
 *
 * The integer rule is the one with teeth: every number in that block is a count
 * by construction, so anything fractional arriving there is a value that was
 * never meant to be a measurement.
 *
 * NOTE WHAT IS DELIBERATELY *OUTSIDE* IT: `accountIdsAsked`, `statuses` and
 * `errors`. Those carry the owner's own ids and the verbatim error strings that
 * REF-126 Stage 3 item 5.4 asks for, and ./tradingLock.ts argues for each. They
 * are exceptions that were decided, not ones that slipped through — which is
 * why they sit outside the strict block rather than having the block weakened
 * to admit them.
 */
const STRICT_SUBTREE_KEY = 'measurement';

/**
 * Re-read the finished payload and confirm no unintended raw value is in it.
 *
 * Returns the offending paths rather than throwing: a probe that refuses to
 * answer because its own self-check tripped tells the owner less than one that
 * answers and says so.
 */
export function scanForLeaks(payload: unknown): {
  ok: boolean;
  samplesChecked: number;
  strictValuesChecked: number;
  offenders: string[];
} {
  const offenders: string[] = [];
  let samples = 0;
  let strictValues = 0;

  /** A leaf inside the strict subtree. Booleans and nulls carry no measurement. */
  const strictLeaf = (value: unknown, path: string): void => {
    if (value === null || value === undefined || typeof value === 'boolean') return;
    strictValues += 1;
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) offenders.push(path);
      return;
    }
    if (typeof value !== 'string' || !SAFE_SAMPLE.test(value)) offenders.push(path);
  };

  const walk = (node: unknown, path: string, strict: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, strict));
      return;
    }
    if (!node || typeof node !== 'object') {
      if (strict) strictLeaf(node, path);
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (key === 'sample') {
        samples += 1;
        if (typeof value !== 'string' || !SAFE_SAMPLE.test(value)) offenders.push(here);
        continue;
      }
      // Entering the strict subtree is one-way: everything nested below it is
      // checked, so a block cannot opt its own children back out.
      const strictHere = strict || key === STRICT_SUBTREE_KEY;
      if (strictHere && !SAFE_SAMPLE.test(key)) offenders.push(`${here} <key>`);
      walk(value, here, strictHere);
    }
  };

  walk(payload, '', false);
  return {
    ok: offenders.length === 0,
    samplesChecked: samples,
    strictValuesChecked: strictValues,
    offenders,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // All three refusals answer identically — see the header on why.
  if (!user?.id) return notFound();
  if (!isProbeUser(user.id)) return notFound();
  if (new URL(request.url).searchParams.get('mode') !== MODE) return notFound();

  // The allowlist is checked per call in ./call.ts; this reports the guard's
  // verdict on itself, so the response can state that no listed endpoint is
  // mutation-shaped AND that the four named write endpoints are refused, rather
  // than asking a reader to trust it.
  const guard = guardSelfCheck();

  let api: Awaited<ReturnType<typeof getUserTradingApi>>;
  try {
    // Pairs the token with the hosts it is addressed to, decrypts it, renews it
    // if it is close to expiring, and refuses outright while a rate-limit
    // penalty is live.
    api = await getUserTradingApi(user.id);
  } catch {
    // No detail: the message can name the connection's state, and the caller
    // already knows whether they connected an account.
    return NextResponse.json(
      { error: 'no usable Tradovate connection for this user' },
      { status: 409, headers: NO_STORE }
    );
  }

  // One clock for the whole report, so two hosts' offsets are comparable.
  const nowMs = Date.now();

  const hosts: Record<string, unknown> = {};
  for (const host of ['demo', 'live'] as const) {
    // BOTH HOSTS, SEQUENTIALLY, AND NOT ROUTED BY `api.environment` — that
    // field is the token's MINT server and says nothing about where the
    // trader's accounts live (REF-90; `connections.ts:736-748`, which measured
    // an evaluation account on demo while live held nothing). A host with no
    // provisioning answers 401/403, which ./call.ts records as an answer.
    hosts[host] = await probeHostTradingLock({
      accessToken: api.accessToken,
      apiUrl: api.hosts[host].url,
      userId: user.id,
      tradovateUserId: api.tradovateUserId,
      nowMs,
    });
  }

  const payload = {
    ticket: 'REF-126 Stage 3',
    mode: MODE,
    generatedAt: new Date().toISOString(),
    questions: TRADING_LOCK_QUESTIONS,
    readOnlyGuard: {
      ok: guard.ok,
      allowlist: [...PROBE_ENDPOINTS],
      mutationShapedEndpoints: guard.offenders,
      writesRefused: guard.writesRefused,
      note:
        'ה-allowlist היא הבקרה; ה-denylist היא רשת בלבד. שימו לב ש-byDenylist=false ' +
        'על שני endpoints כותבים — בדיוק הפער שחלק ב\' של שלב 2 מדד.',
    },
    maxAccountIdsPerRequest: MAX_ACCOUNT_IDS,
    hosts,
  };

  const leakGuard = scanForLeaks(payload);

  // Serialise, redact, parse back. redactSecrets takes a string, and this is
  // the last thing that happens to the body — see the header on why it is the
  // net and not the mechanism.
  const body = JSON.parse(redactSecrets(JSON.stringify({ ...payload, leakGuard })));

  return NextResponse.json(body, { headers: NO_STORE });
}
