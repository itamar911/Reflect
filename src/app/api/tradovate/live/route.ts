/**
 * GET /api/tradovate/live — what the signed-in trader is holding right now
 * (REF-108 Stage 1).
 *
 * The third route that reads trading data, after /today (scalars) and /trades
 * (rows). This one answers a different question from either: not "what did you
 * do today" but "what are you in, right now, and in which portfolio".
 *
 *
 * THERE IS NO P&L IN THIS RESPONSE, AND THE SUITE ENFORCES IT
 * -----------------------------------------------------------
 *
 * REF-108 asked for an unrealised figure in dollars and we cannot produce one:
 * a mark price needs the Market Data feed, which is **Denied in our OAuth
 * registration** and needs CME sub-vendor registration Reflect does not have.
 * See the header on lib/tradovate/positions.ts for why the plausible fallback
 * — pricing against the trader's own last fill — was rejected rather than
 * labelled.
 *
 * So the body carries no price, no average entry and no P&L field of any kind,
 * and `scripts/tradovate-today-check.ts` asserts that over the EXACT KEY SET
 * rather than by spot-checking a few names. A later change that adds one has
 * to delete that assertion on purpose — the same device /today uses to keep
 * trade rows out of the rule engine's route.
 *
 *
 * THE CACHE IS NOT AN OPTIMISATION
 * --------------------------------
 *
 * This is the only route in the product that is polled on a timer, and it has
 * THREE consumers that can be mounted at once (the day panel, the dashboard,
 * the portfolio cards). Without a shared hold, three components at fifteen
 * seconds is an effective five-second interval and triples every upstream
 * number.
 *
 * The vendor FAQ is explicit that there is no hard request cap and that limits
 * vary by hour, minute AND second, and the penalty escalates to `p-captcha`,
 * which **a third-party application cannot clear**: the trader waits about an
 * hour, and the rule engine's day pull waits with them. That is strictly worse
 * than a stale position line, which is why {@link FRESH_MS} exists and why
 * lib/tradovate/liveClock.ts polls slower than the ticket's fastest option.
 *
 * Ten seconds, against /today's thirty: this answer is supposed to be live,
 * and a trader who opens a position should see it within one poll rather than
 * two. The shapes are otherwise identical, deliberately —
 * lib/rules/brokerDayContext.ts solved this once.
 *
 *
 * PRIVACY
 * -------
 *
 * /api/tradovate/trades' bounds, restated for a route that runs 240 times an
 * hour per trader rather than once per page:
 *
 * - **Only to the trader themselves.** The session cookie names the user and
 *   the token is fetched for THAT id. No user id is read from the request, so
 *   there is no parameter to tamper with.
 * - **`no-store, private`**, like both existing routes.
 * - **Never the access token, never `api_hosts`.** A position's `host` is not
 *   even carried out of lib/tradovate/positions.ts' shape into the response —
 *   the browser has no use for it once the account is resolved to our UUID.
 * - **Logs are counts only**, and this is the highest-frequency log line in
 *   the product, so a leak here repeats 240 times an hour. `describeDayPullFailureKind`
 *   is used rather than `describeDayPullFailure` for the same reason /trades
 *   uses it: the message that the other one keeps can have been built from a
 *   response body.
 * - **`withoutResponseBody()` from the first commit**, not added later. It is
 *   applied inside `discoverHostAccounts`, where the code knows the body of a
 *   failed `/account/list` is a list of the trader's account names — REF-110
 *   §F had to add that retrospectively and this route inherits it.
 * - **The display name never reaches a log.** It is resolved under the
 *   trader's own RLS and put straight into the response; see the privacy note
 *   at the read site in lib/portfolios/read.ts, which is the authority on
 *   where that string may go.
 *
 *
 * STATUS CODES
 * ------------
 *
 * 200 for all four provenance states, for /today's reasons: "your connection
 * lapsed" is an ANSWER the client renders, not a fault of the request. 401 for
 * a caller with no session. There is no 400 — this route takes no parameters,
 * which is itself a small privacy property.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import {
  classifyDayPullFailure,
  describeDayPullFailureKind,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { tradovateGet } from '@/lib/tradovate/client';
import { getUserTradingApi } from '@/lib/tradovate/connections';
import type { TradovateReader } from '@/lib/tradovate/fills';
import { isImportEnabled } from '@/lib/tradovate/import';
import { loadOpenPositions, type OpenPositionsPull } from '@/lib/tradovate/positions';
import { redactSecrets } from '@/lib/tradovate/redact';
import { portfolioLabel } from '@/lib/portfolios/portfolio';
import { readPortfolios } from '@/lib/portfolios/read';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RuleContextSource } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No store, at every layer: this is one trader's live exposure. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/** The route. One constant, so the client and the tests cannot drift. */
export const BROKER_LIVE_PATH = '/api/tradovate/live';

/**
 * How long one answer stands for, per user. See the header on why this is a
 * correctness concern and not a performance one.
 */
export const FRESH_MS = 10_000;

/** One open position, as the browser receives it. No price — see the header. */
export interface LivePositionLine {
  contractName: string | null;
  netPos: number;
  openedAtMs?: number;
}

/** One portfolio's open positions, named the way the trader named it. */
export interface LiveAccountLine {
  /** OUR uuid — `accounts.id` — and never the broker's integer. */
  accountId: string;
  /** `nickname ?? display_name`, resolved under the trader's own RLS. */
  displayName: string;
  positions: LivePositionLine[];
}

/**
 * The outcome of asking the broker what is open.
 *
 * The same four-state union as /today and /trades, and the vocabulary is
 * `rule_context_source` from lib/types.ts — reusing it is what lets a client
 * render "your connection lapsed" identically on all three.
 */
export type BrokerLivePull =
  | { source: 'broker_verified'; asOf: string; accounts: LiveAccountLine[] }
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

function answer(pull: BrokerLivePull) {
  return NextResponse.json(pull, { headers: NO_STORE });
}

/** The three stateless outcomes. */
function stateless(source: Exclude<RuleContextSource, 'broker_verified'>): BrokerLivePull {
  return { source };
}

/**
 * The held answer, per user.
 *
 * Keyed by `userId` for `brokerDayContext`'s reason, restated because it
 * matters more on a polled route: signing out and back in as somebody else in
 * the same process must not be served the previous trader's positions. An
 * in-flight promise is shared so that three consumers arriving together make
 * ONE upstream pull rather than three.
 *
 * Module-level, so it is per serverless instance and not global. That is the
 * honest bound: on a cold start the first caller pays, which is the same
 * arrangement every cache in this integration has.
 */
let cached: { userId: string; at: number; pull: BrokerLivePull } | null = null;
let inFlight: { userId: string; work: Promise<BrokerLivePull> } | null = null;

/** Drop the held answer. Test seam, and nothing else. */
export function forgetLivePull(): void {
  cached = null;
  inFlight = null;
}

/**
 * What the handler needs from the world, so the suite can drive the handler.
 *
 * Same seam and the same reasoning as `TradesRouteDeps`: there is no module
 * mocker here, so the only way for a test to reach the 401, the allowlist
 * refusal and the cache is for those to be parameters.
 */
export interface LiveRouteDeps {
  currentUserId: () => Promise<string | null>;
  isAllowed: (userId: string) => boolean;
  /** Migration 037 has been run, so `accounts` can be read. */
  portfoliosEnabled: () => boolean;
  loadPositions: (userId: string) => Promise<OpenPositionsPull>;
  /** `(broker_account_id, host) → { accountId, displayName }`, under RLS. */
  resolveAccounts: (userId: string) => Promise<Map<string, { accountId: string; displayName: string }>>;
  now: () => number;
}

/** The join key, host-qualified — `accounts`' own identity (migration 037). */
function identityKey(host: string, brokerAccountId: number): string {
  return `${host}:${brokerAccountId}`;
}

/**
 * The route, with its seams supplied.
 *
 * Check order is /today's and /trades': session first, then the allowlist
 * (before any read, so a deployment with the integration off does no work),
 * then the migration gate, then the cache, then the pull.
 */
export async function respondToLiveRequest(deps: LiveRouteDeps): Promise<NextResponse> {
  const userId = await deps.currentUserId();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  // Fails closed, like every other gate in this integration: an unset or empty
  // allowlist allows nobody. `reflect_only` rather than a 403 — a user with no
  // broker view is in a state the UI renders, not an error.
  if (!deps.isAllowed(userId)) return answer(stateless('reflect_only'));

  // `accounts` is migration 037's, and without it there is no portfolio to
  // name a position after. Answering `reflect_only` rather than returning
  // unnamed positions keeps the response's shape honest: every account line
  // carries a display name or there is no account line.
  if (!deps.portfoliosEnabled()) return answer(stateless('reflect_only'));

  const now = deps.now();
  if (cached && cached.userId === userId && now - cached.at < FRESH_MS) {
    return answer(cached.pull);
  }
  if (inFlight && inFlight.userId === userId) return answer(await inFlight.work);

  const work = buildPull(userId, deps).finally(() => {
    if (inFlight && inFlight.work === work) inFlight = null;
  });
  inFlight = { userId, work };

  const pull = await work;
  // Held whatever the outcome, including the three failure states: a broker
  // that just refused us will refuse the next poll fifteen seconds later, and
  // re-asking on every consumer's timer turns one lapsed connection into a
  // stream of upstream calls. The same argument `shareBrokerSync` makes for
  // stamping its clock in `finally`.
  cached = { userId, at: deps.now(), pull };
  return answer(pull);
}

async function buildPull(userId: string, deps: LiveRouteDeps): Promise<BrokerLivePull> {
  try {
    const [pull, byIdentity] = await Promise.all([
      deps.loadPositions(userId),
      deps.resolveAccounts(userId),
    ]);

    const accounts: LiveAccountLine[] = [];
    let unresolved = 0;

    for (const account of pull.accounts) {
      const known = byIdentity.get(identityKey(account.host, account.brokerAccountId));
      // An account the sync has not recorded yet — a position opened in the
      // window between a trader's first trade and their first sync. DROPPED
      // rather than shown unnamed, because REF-108's 16.10 update is that the
      // figure is useless without the portfolio beside it, and a line reading
      // "you are holding something, somewhere" is worse than silence. It
      // resolves itself on the next sync, and the count below is how anyone
      // would notice if it did not.
      if (!known) {
        unresolved += 1;
        continue;
      }
      accounts.push({
        accountId: known.accountId,
        displayName: known.displayName,
        positions: account.positions,
      });
    }

    // COUNTS ONLY, and only when there is something to say. A quiet poll is
    // the common case and 240 log lines an hour of "nothing open" is noise
    // that would bury the one line that matters.
    if (unresolved > 0) {
      console.warn(
        redactSecrets(
          `[tradovate][live] positions on accounts not yet recorded (unresolved=${unresolved})`
        )
      );
    }

    return { source: 'broker_verified', asOf: pull.asOf, accounts };
  } catch (error) {
    const source = classifyDayPullFailure(error);

    // The KIND and nothing else — `describeDayPullFailureKind` drops the
    // message `describeDayPullFailure` keeps, because that message can have
    // been built from a response body and this route's whole subject matter
    // is a trader's live exposure. Through redactSecrets anyway.
    console.warn(
      redactSecrets(
        `[tradovate][live] positions pull did not answer (${source}): ` +
          describeDayPullFailureKind(error)
      )
    );
    return stateless(source);
  }
}

export async function GET() {
  let client: SupabaseClient | null = null;
  const supabase = async () => (client ??= await createClient());

  return respondToLiveRequest({
    currentUserId: async () => {
      const {
        data: { user },
      } = await (await supabase()).auth.getUser();
      return user?.id ?? null;
    },

    isAllowed: isUserAllowed,
    portfoliosEnabled: isImportEnabled,
    now: Date.now,

    loadPositions: async (userId) => {
      const api = await getUserTradingApi(userId);

      // ONE READER PER HOST, token and host travelling together — the
      // invariant lib/tradovate/client.ts enforces in the type system. Both
      // are built because both are asked: `environment` is the token's mint
      // server and says nothing about where the trader's accounts live.
      const readerFor = (apiUrl: string): TradovateReader => ({
        get: (path, query) => tradovateGet(path, query, { accessToken: api.accessToken, apiUrl }),
      });

      return loadOpenPositions({
        readers: {
          live: readerFor(api.hosts.live.url),
          demo: readerFor(api.hosts.demo.url),
        },
        environment: api.environment,
        tradovateUserId: api.tradovateUserId,
      });
    },

    resolveAccounts: async (userId) => {
      // The USER'S OWN session client, so 037's `accounts_owner` policy is
      // what decides which rows come back — the same arrangement /today uses
      // for its import. Hidden portfolios are included: hiding removes a card
      // from a screen, and it must not make an open position disappear.
      const portfolios = await readPortfolios(await supabase(), userId, true);

      const byIdentity = new Map<string, { accountId: string; displayName: string }>();
      for (const portfolio of portfolios) {
        if (portfolio.brokerAccountId === null || portfolio.brokerHost === null) continue;
        byIdentity.set(identityKey(portfolio.brokerHost, portfolio.brokerAccountId), {
          accountId: portfolio.id,
          displayName: portfolioLabel(portfolio),
        });
      }
      return byIdentity;
    },
  });
}
