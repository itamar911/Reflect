/**
 * GET /api/tradovate/probe — a TEMPORARY diagnostic route (REF-113 Stage 0).
 *
 * **This is not product code and nothing in the app imports it.** It replaces
 * `scripts/spike/tradovate-spike.mjs` as the way to answer REF-113 Q1-Q7,
 * REF-108 Q8/Q9 and REF-110's account-naming question, for one reason: the
 * spike authenticates with a username, a password and a CID/SEC API key against
 * a demo account, and those four things describe a vendor trial, not a trader.
 * This asks the same questions through the OAuth connection the product
 * actually uses, so the answers describe the integration we are shipping.
 *
 * The spike stays where it is. It is not deleted here and it still works.
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
 *      to run a diagnostic that walks it, and the probe should not inherit a
 *      list that grows as the feature rolls out. Unset means NOBODY, including
 *      the owner — the same default lib/tradovate/allowlist.ts argues for.
 *   3. The read-only guard in ./guard.ts, on every upstream call.
 *
 * **404, not 403**, for a caller who is signed in but not on the list: a 403
 * confirms the route exists and that there is a list to be on. There is no
 * product surface that links here, so a 404 is also the truthful answer to
 * "is there anything here for you".
 *
 *
 * WHAT IT MAY RETURN
 * ------------------
 *
 * Field names, field types, presence booleans, counts, enum members from a
 * fixed vocabulary, and durations in seconds. See ./survey.ts, which owns that
 * rule and fails closed.
 *
 * It may NOT return ids, symbols, prices, quantities, account names, instants
 * or hostnames — the brief's list. Two mechanisms, in this order:
 *
 *   - **By construction.** Nothing reads a raw value into the response. Every
 *     sample goes through `safeSample`, whose allowlist emits a value only for
 *     a known low-cardinality enum.
 *   - **By check.** {@link scanForLeaks} re-reads the finished payload and
 *     asserts every emitted sample matches the safe grammar. It runs on every
 *     request and its result is in the response, so a reader can see that it
 *     ran rather than trusting this comment.
 *
 * `redactSecrets` is then applied to the serialised body. It is the LAST line
 * of defence and not the primary one: it knows about tokens and passwords, not
 * about stop prices, and a design that leaned on it for trading data would be
 * relying on it for something it was never written to do.
 *
 * The two hosts are reported as the logical names `demo` and `live`, which are
 * the keys `UserTradingApi.hosts` already uses. No URL is emitted.
 *
 *
 * NO WRITES. No database write, no migration, no log line carrying a value.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { getUserTradingApi } from '@/lib/tradovate/connections';
import { redactSecrets } from '@/lib/tradovate/redact';

import { guardSelfCheck } from './guard';
import { LIVE_QUESTIONS, probeLiveHost } from './live';
import { ORDER_QUESTIONS, probeOrdersHost, WINDOW_HOURS } from './orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Comma-separated Supabase user ids. Unset or empty means nobody. */
export const PROBE_ENV_VAR = 'TRADOVATE_PROBE_USER_ID';

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
 * position means a raw value reached the response, which is the one failure
 * this route must not have.
 */
const SAFE_SAMPLE = /^(<(string|number|boolean|bigint|symbol|function|object|undefined)>|<array len=\d+>|null|true|false|[A-Za-z][A-Za-z0-9_-]{0,31})$/;

/**
 * Re-read the finished payload and confirm no raw value is in it.
 *
 * Walks every `fields` map and checks each `sample`. Returns the offending
 * paths rather than throwing: a probe that refuses to answer because its own
 * self-check tripped tells the owner less than one that answers and says so.
 */
export function scanForLeaks(payload: unknown): { ok: boolean; samplesChecked: number; offenders: string[] } {
  const offenders: string[] = [];
  let checked = 0;

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (key === 'sample') {
        checked += 1;
        if (typeof value !== 'string' || !SAFE_SAMPLE.test(value)) offenders.push(here);
        continue;
      }
      walk(value, here);
    }
  };

  walk(payload, '');
  return { ok: offenders.length === 0, samplesChecked: checked, offenders };
}

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate 1 and 2 answer identically — see the header on why this is a 404.
  if (!user?.id) return notFound();
  if (!isProbeUser(user.id)) return notFound();

  const mode = new URL(request.url).searchParams.get('mode');
  if (mode !== 'live' && mode !== 'orders') {
    return NextResponse.json(
      { error: 'mode must be "live" or "orders"', example: '/api/tradovate/probe?mode=live' },
      { status: 400, headers: NO_STORE }
    );
  }

  // The read-only allowlist is checked per call in ./call.ts; this reports the
  // denylist's verdict on the allowlist itself, so the response can state that
  // no listed endpoint is mutation-shaped rather than asking a reader to trust it.
  const guard = guardSelfCheck();

  let api: Awaited<ReturnType<typeof getUserTradingApi>>;
  try {
    // Pairs the token with the hosts it is addressed to. Wraps
    // getUserAccessToken — there is no password path and no CID/SEC here, which
    // is the whole reason this route exists rather than the spike.
    api = await getUserTradingApi(user.id);
  } catch {
    // No detail: the message can name the connection's state, and the caller
    // already knows whether they connected an account.
    return NextResponse.json(
      { error: 'no usable Tradovate connection for this user' },
      { status: 409, headers: NO_STORE }
    );
  }

  const hosts: Record<string, unknown> = {};
  for (const host of ['demo', 'live'] as const) {
    const options = { accessToken: api.accessToken, apiUrl: api.hosts[host].url };
    // Both hosts are asked for REF-90's reason: the token's mint server says
    // nothing about where the trader's accounts live. A host with no
    // provisioning answers 401/403, which ./call.ts records as an answer.
    hosts[host] =
      mode === 'live' ? await probeLiveHost(options) : await probeOrdersHost(options);
  }

  const payload = {
    mode,
    generatedAt: new Date().toISOString(),
    windowHours: mode === 'orders' ? WINDOW_HOURS : null,
    questions: mode === 'live' ? LIVE_QUESTIONS : ORDER_QUESTIONS,
    readOnlyGuard: {
      ok: guard.ok,
      mutationShapedEndpoints: guard.offenders,
      note: 'כל endpoint עובר allowlist + denylist של מוטציות לפני כל קריאה',
    },
    hosts,
  };

  const leakGuard = scanForLeaks(payload);

  // Serialise, redact, parse back. redactSecrets takes a string, and this is
  // the last thing that happens to the body — see the header on why it is the
  // net and not the mechanism.
  const body = JSON.parse(redactSecrets(JSON.stringify({ ...payload, leakGuard })));

  return NextResponse.json(body, { headers: NO_STORE });
}
