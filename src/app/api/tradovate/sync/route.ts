/**
 * POST /api/tradovate/sync — import the signed-in user's finished trades now
 * (REF-107 Stage 2, E9).
 *
 * The second of E9's three triggers, and the one that exists because the first
 * one is not enough. The free trigger fires when the trader opens the TRADE
 * FORM (/api/tradovate/today), which is a thing they do before entering a
 * trade — not when they sit down to read their journal. This is the button
 * ("סנכרן עכשיו") for that moment.
 *
 * THE UI IS NOT IN THIS STAGE. The route ships first on purpose: it is the
 * half that can be driven and tested end to end without a browser, and a button
 * wired to a route that does not exist yet is worse than a route nobody has
 * clicked.
 *
 *
 * WHY POST, AND WHY THAT IS NOT PEDANTRY
 * --------------------------------------
 *
 * /api/tradovate/today is a GET that writes, and its header argues the case:
 * the rows are already built there, so the import is free, and the alternative
 * is not importing. Here there is no such excuse — the pull exists only to
 * write — so the method says what the request does. It also means a browser
 * prefetch, a link preview or a retried GET cannot spend seven upstream calls
 * and a batch of inserts on a trader's behalf.
 *
 *
 * WHAT CROSSES THE WIRE
 * ---------------------
 *
 * COUNTS AND A PROVENANCE, AND NOT ONE TRADE. This is the only route in the
 * import path that a trader triggers deliberately, and it is tempting to answer
 * with the rows it just wrote so the journal can render them without a reload.
 * It does not: the journal reads `trade_plans` under the user's own RLS like
 * every other page, and sending the rows back from here would make this a
 * second, parallel way for a position to leave the server — with its own
 * caching rules to get wrong. The client refreshes; the rows are in the table.
 *
 * `source` is the same four-state vocabulary as /today and /trades, so a client
 * renders "your connection lapsed" identically on all three.
 *
 *
 * STATUS CODES
 * ------------
 *
 * 200 for all four provenance states, as on the other two routes and for the
 * reason given there: "your connection lapsed" is an answer. 401 for a caller
 * with no session. 400 for a window that cannot be read.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  classifyDayPullFailure,
  describeDayPullFailureKind,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { redactSecrets } from '@/lib/tradovate/redact';
import { syncUserTrades } from '@/lib/tradovate/sync';
import type { BrokerImportCounts } from '@/lib/tradovate/import';
import {
  MAX_SINCE_AGE_MS,
  parseTradesWindow,
  type TradesWindowParse,
} from '@/lib/tradovate/trading-day';
import type { RuleContextSource } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store: a count of one user's trades, written one second ago. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/**
 * The outcome of asking for a sync.
 *
 * Shaped like the other two routes' pulls — discriminated on `source`, three
 * states carrying nothing — so the client's branch is the one it already has.
 */
export type BrokerSyncResult =
  | ({
      source: 'broker_verified';
      /** The earliest close this run covered, ISO 8601. */
      windowStart: string;
      /** When this was read from Tradovate, ISO 8601. */
      asOf: string;
    } & BrokerImportCounts)
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

function answer(result: BrokerSyncResult) {
  return NextResponse.json(result, { headers: NO_STORE });
}

/** The three stateless outcomes. Narrow enough that no cast is needed. */
function stateless(source: Exclude<RuleContextSource, 'broker_verified'>): BrokerSyncResult {
  return { source };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Fails closed, like every other route in this integration: an unset or empty
  // TRADOVATE_OAUTH_ALLOWED_USER_IDS allows nobody (allowlist.ts). Answered
  // before the window is parsed, so a deployment with the integration off does
  // no work and leaks no 400s about parameters it would never have used.
  if (!isUserAllowed(user.id)) return answer(stateless('reflect_only'));

  // The same window parser as /trades, and `dayStart` is mandatory for the same
  // reason: the trader's local midnight is the one instant no server can
  // compute (lib/tradovate/trading-day.ts). A button that wants everything it
  // can get sends `since` too, bounded to seven days.
  const requested = parseTradesWindow(new URL(request.url).searchParams, Date.now());
  if (!requested.ok) return badWindow(requested);

  try {
    const { counts, asOf } = await syncUserTrades({
      userId: user.id,
      // The user's own session client for the WRITE — RLS enforces ownership —
      // and the service-role client for the token and host reads it cannot make.
      // See lib/tradovate/sync.ts on why these are two parameters.
      client: supabase,
      admin: createAdminClient(),
      dayStartMs: requested.dayStartMs,
      windowStartMs: requested.windowStartMs,
    });

    return answer({
      source: 'broker_verified',
      windowStart: new Date(requested.windowStartMs).toISOString(),
      asOf,
      ...counts,
    });
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // The KIND of failure and nothing else, through redactSecrets, exactly as
    // /trades does and for the same reason: describeDayPullFailure's messages
    // name contract and product ids, and this is a route whose whole subject
    // matter is a trader's positions.
    console.warn(
      redactSecrets(
        `[tradovate] sync did not import (${source}): ${describeDayPullFailureKind(error)}`
      )
    );

    return answer(stateless(source));
  }
}

/** A window that could not be read. Names the parameter and the reason only. */
function badWindow(bad: Extract<TradesWindowParse, { ok: false }>): NextResponse {
  const detail =
    bad.param === 'since'
      ? ` (an instant, no older than ${MAX_SINCE_AGE_MS / 86_400_000} days)`
      : '';
  return NextResponse.json(
    { error: `Invalid ${bad.param}: ${bad.reason}${detail}` },
    { status: 400, headers: NO_STORE }
  );
}
