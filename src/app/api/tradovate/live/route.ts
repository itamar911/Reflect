/**
 * GET /api/tradovate/live — what the signed-in trader is holding right now
 * (REF-108 Stage 1).
 *
 * The third route that reads trading data, after /today (scalars) and /trades
 * (rows). This one answers a different question from either: not "what did you
 * do today" but "what are you in, right now, and in which portfolio".
 *
 *
 * ONE P&L FIELD, THE BROKER'S, AND THE SUITE STILL ENFORCES THE REST
 * ------------------------------------------------------------------
 *
 * REF-108 asked for an unrealised figure in dollars and we still cannot
 * COMPUTE one: a mark price needs the Market Data feed, which is **Denied in
 * our OAuth registration** and needs CME sub-vendor registration Reflect does
 * not have. See the header on lib/tradovate/positions.ts for why the plausible
 * fallback — pricing against the trader's own last fill — was rejected rather
 * than labelled.
 *
 * Stage 4a adds a figure that is not ours. `/cashBalance/getcashbalancesnapshot`
 * returns an `openPnL` the broker computes, measured 19.10 with Market Data
 * still denied, and {@link LiveAccountLine.openPnl} carries exactly that one
 * field — **per account, because that is the only shape the endpoint offers.**
 * The body still carries no price, no average entry and no arithmetic of ours.
 *
 * `scripts/tradovate-today-check.ts` asserts the EXACT KEY SET rather than
 * spot-checking a few names, in two places, so this stage had to edit both on
 * purpose — which is the whole point of pinning a key set, and the same device
 * /today uses to keep trade rows out of the rule engine's route. The assertions
 * that did NOT change are the ones that matter now: no price-shaped key beyond
 * this one, and **no `netLiq` or `totalCashValue`** — the same snapshot body
 * carries the trader's account balance, and three independent things keep it
 * off this wire (lib/tradovate/types.ts declares neither, `readOpenPnl` returns
 * a number rather than an object, and the projection below names one field).
 *
 * NOTHING RENDERS IT YET. Stage 4a ships alone, exactly as Stage 1 did.
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
 *
 *
 * IT WRITES NOW, AND ONLY ON A TRANSITION (REF-113 Stage 4b)
 * ---------------------------------------------------------
 *
 * This was a read-only route and is not one any more, so the reason has to be
 * written down where somebody will read it before they undo it.
 *
 * REF-113 records what the broker says about a trader's stop by reading
 * `/order/list`, and that endpoint has NO DEPTH AT ALL — `depthDays = 0`,
 * measured 19.10. The orders behind today's trades exist until the trading day
 * rolls at ~17:00 CT and then they are gone at any price. On top of that, a
 * trade is only a candidate for the read while its position is FLAT
 * (`BrokerTrade.positionFlat`, §A3 rule 1), and a Position is one row per
 * contract per trading day with a live `netPos` — so RE-ENTERING a contract
 * puts that row back to non-zero and withholds the annotation from every trade
 * already closed on it.
 *
 * Put those two together and the trader who loses the most is the one who rolls
 * positions on one contract all day: at 21:30, when
 * /api/cron/tradovate-orders fires, they are still holding, every earlier trade
 * on the contract reads `positionFlat: false`, the job skips them, and an hour
 * later the orders are destroyed. A FIXED HOUR CANNOT COVER THEM. The only
 * instant that can is the moment the position goes flat — and this route, which
 * reads `/position/list` every fifteen seconds, is the only thing in the
 * product that is looking at that moment. That is decision ד of
 * ~/Desktop/reflect-reports/ref-113-why-no-write.md.
 *
 * SO THE WRITE IS BOUNDED BY A TRANSITION AND NOT BY THE POLL. {@link
 * CAPTURE_MIN_GAP_MS} and the `pending` flag beside it are the whole
 * mechanism: a contract that was held on the previous poll and is not held on
 * this one fires ONE capture, a second transition inside the cool-down is
 * remembered rather than dropped, and a quiet poll — which is almost every poll
 * — does exactly what it did before this stage. A failure cannot reach the
 * response: the capture runs after it, through `after()`, and swallows
 * everything.
 *
 * /api/tradovate/today is already a GET that writes and its header argues the
 * case; this is the second, with a narrower trigger and a harder deadline.
 */

import { after, NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  classifyDayPullFailure,
  describeDayPullFailureKind,
} from '@/lib/rules/brokerDayContext';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { tradovateGet, tradovatePost } from '@/lib/tradovate/client';
import { flushUserCalls } from '@/lib/tradovate/call-meter';
import { getUserTradingApi, notingPenalty } from '@/lib/tradovate/connections';
import { isImportEnabled } from '@/lib/tradovate/import';
import { ORDERS_LOOKBACK_MS } from '@/lib/tradovate/orders-cron';
import {
  loadOpenPositions,
  type HostAccountPositions,
  type LiveReader,
  type OpenPositionsPull,
} from '@/lib/tradovate/positions';
import { redactSecrets } from '@/lib/tradovate/redact';
import { syncUserTrades } from '@/lib/tradovate/sync';
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

/**
 * The shortest gap between two stop captures for one trader (REF-113 Stage 4b).
 *
 * ONE MINUTE, AND NOTHING IS DROPPED BY IT. A capture is a day pull plus the
 * order read — on the order of fifteen to twenty upstream requests — and a
 * trader scaling out of three contracts produces three flat transitions inside
 * a minute. The second and third would ask the same question: the candidate
 * read is `stop_history IS NULL` over the WHOLE DAY, so the first capture has
 * already answered for every trade the later ones would have found.
 *
 * A TRANSITION SEEN INSIDE THE GAP IS REMEMBERED, NOT DISCARDED — the `pending`
 * flag on {@link flatWatch}. That matters and it is the part that is easy to get
 * wrong: contract A goes flat at 10:00:00 and contract B at 10:00:20, and if the
 * second were simply dropped, B's trades would wait for the 21:30 cron and lose
 * their annotation if the trader is holding something by then. Instead the next
 * poll past the minute fires for it.
 *
 * It is a guard against FLAPPING and not a rate limit. A trader who genuinely
 * round-trips one contract twenty times in a day gets twenty captures, which is
 * a few hundred requests against a documented five thousand an hour — and each
 * one is buying an annotation that is destroyed at 17:00 CT.
 */
export const CAPTURE_MIN_GAP_MS = 60_000;

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
  /**
   * The broker's own unrealised P&L for this portfolio, in dollars, or null
   * (REF-108 Stage 4a).
   *
   * ON THE ACCOUNT LINE AND NOT ON A POSITION, because that is the only shape
   * the broker offers: `/cashBalance/getcashbalancesnapshot` takes an
   * `accountId` and answers with an account-level aggregate, so a portfolio
   * holding ES and NQ has ONE figure covering both. See the header on
   * lib/tradovate/positions.ts.
   *
   * **`null` IS NOT `0`.** Break-even is an answer; "we could not get one" is
   * not. Nothing in this stage renders either — Stage 4b decides what a null
   * looks like, and the floor it starts from is the line without a number.
   */
  openPnl: number | null;
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

/**
 * What this trader was holding on the previous pull, so that a contract leaving
 * the list can be noticed (REF-113 Stage 4b).
 *
 * KEYED BY USER AND REPLACED RATHER THAN MERGED, which is {@link cached}'s rule
 * and has the same consequence: two traders polling through one serverless
 * instance take turns, and each turn starts with no previous holdings and
 * therefore cannot see a transition. That is an UNDER-FIRE — the 21:30 cron is
 * still there — and it is the direction to fail in. The alternative, a map
 * keyed by user, is a map of one trader's live exposure held across another
 * trader's request, which is the one thing this route's privacy note refuses.
 *
 * `held` IS ONLY EVER WRITTEN FROM A VERIFIED PULL. A broker that refused us
 * knows nothing about what is open, and treating "we could not ask" as "nothing
 * is held" would fabricate a transition for every contract on the next
 * successful poll.
 */
let flatWatch: {
  userId: string;
  /** `${host}:${brokerAccountId}:${contractId}` for every contract held. */
  held: Set<string>;
  /** A transition has been seen and no capture has run for it yet. */
  pending: boolean;
  /** When a capture last STARTED. Zero means never, for this user. */
  lastCaptureAtMs: number;
} | null = null;

/** Drop the held answer and the holdings. Test seam, and nothing else. */
export function forgetLivePull(): void {
  cached = null;
  inFlight = null;
  flatWatch = null;
}

/**
 * One key per contract held, across every host and account.
 *
 * FROM THE PULL AND NOT FROM THE RESPONSE, which is the load-bearing half. The
 * response drops positions on accounts the sync has not recorded yet (see
 * `unresolved` below), and a position going flat on an unrecorded account is
 * exactly as much of a deadline as one on a named portfolio — the trade rows are
 * written either way. Reading the response would have made the trigger depend
 * on whether a portfolio card exists.
 *
 * **AND FROM `positions` ALONE — `openPnl` IS NOT READ HERE AND MUST NOT BE
 * (Stage 4a).** The pull now carries the broker's open figure beside the
 * holdings, and it is a tempting second signal: a figure that went to zero
 * looks like a position that closed. It is not one. `readOpenPnl` answers null
 * for a refused snapshot and zero for a genuine break-even, so letting either
 * one into this set would fabricate a flat transition — which fires a full
 * import through `after()` (REF-113 Stage 4b) on a trader who never left their
 * position. The holdings are decided by `/position/list` and by nothing else,
 * exactly as they were before this stage.
 */
function heldKeys(accounts: readonly HostAccountPositions[]): Set<string> {
  const keys = new Set<string>();
  for (const account of accounts) {
    for (const position of account.positions) {
      keys.add(`${account.host}:${account.brokerAccountId}:${position.contractId}`);
    }
  }
  return keys;
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
  /**
   * Read the broker's protective orders for this trader's unanswered trades,
   * because a position just went flat (REF-113 Stage 4b).
   *
   * MUST NOT THROW AND MUST NOT BE AWAITED BY THE RESPONSE. It is the whole
   * import — a day pull, the accounts pass, the order read and a batch of
   * statements — and this route is on a fifteen-second timer. {@link GET}
   * supplies one that swallows everything and reports counts; omitting it
   * disables the trigger entirely, which is what the groups that are not about
   * it do.
   */
  captureStops?: (userId: string) => Promise<void>;
  /**
   * Run work after the response has been sent. Production is Next's `after()`.
   *
   * A SEAM BECAUSE `after()` IS NOT CALLABLE OUTSIDE A REQUEST SCOPE, and the
   * regression suite drives this handler as a plain function. The suite passes
   * one that collects the work so it can await it and assert on what ran; the
   * default here is `after()` itself, so a caller that forgets the seam still
   * gets production behaviour rather than silence.
   */
  schedule?: (work: () => Promise<void>) => void;
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

  // The same check as every other route in this integration, through the same
  // function: open to every signed-in user unless TRADOVATE_OAUTH_ALLOWED_USER_IDS
  // names ids, in which case only those (allowlist.ts). `reflect_only` rather
  // than a 403 — a user with no broker view is in a state the UI renders, not
  // an error.
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
        // NAMED RATHER THAN SPREAD, and this is the line that keeps the broker's
        // contract id off the wire. `LivePosition` carries it from Stage 4b for
        // the flat-transition check; `LivePositionLine` is the browser's shape
        // and has three fields. `openedAtMs` stays optional — the field is
        // absent when `position.timestamp` did not parse, and absent is a
        // different claim from a zero.
        positions: account.positions.map((position) => ({
          contractName: position.contractName,
          netPos: position.netPos,
          ...(position.openedAtMs === undefined ? {} : { openedAtMs: position.openedAtMs }),
        })),
        // ONE FIELD OFF THE SNAPSHOT, NAMED, FOR THE SAME REASON (Stage 4a).
        // The snapshot body also carries `netLiq` and `totalCashValue` — the
        // trader's account BALANCE — and the defence against those reaching the
        // browser is in three independent places: they are not declared on
        // `TradovateCashBalanceSnapshot`, `readOpenPnl` returns a number rather
        // than an object, and this line names the one field instead of
        // spreading. scripts/tradovate-today-check.ts asserts the response's
        // exact key set over all three.
        openPnl: account.openPnl,
      });
    }

    // ── A position went flat (REF-113 Stage 4b) ──────────────────────────────
    //
    // See the header on why a fifteen-second poll is the right place for this
    // and why a fixed hour cannot replace it. Everything below is decided from
    // the PULL rather than from `accounts`, so an unrecorded portfolio still
    // counts.
    noticeFlatTransition(userId, pull.accounts, deps);

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

/**
 * Compare this pull's holdings with the previous one and, if a contract has
 * left the list, fire one stop capture (REF-113 Stage 4b).
 *
 * CALLED ONLY FROM THE VERIFIED BRANCH, and only once per actual upstream pull:
 * {@link respondToLiveRequest} holds its answer for {@link FRESH_MS} and shares
 * an in-flight promise, so three mounted consumers on a fifteen-second timer
 * reach this at most once every ten seconds — and almost always with nothing to
 * say.
 *
 * THE FIRST PULL FOR A TRADER NEVER FIRES, and that is right rather than a gap.
 * With no previous holdings there is no transition to see; a trader who closed
 * a position and then opened the app is covered by the Sync button's own
 * auto-trigger, which already asks for the orders (`shouldAutoSync` in
 * lib/tradovate/syncClock.ts, and `readStops: true` on POST /api/tradovate/sync).
 *
 * IT CANNOT THROW INTO THE PULL. The capture is handed to {@link
 * LiveRouteDeps.schedule} and never awaited, and the one supplied by {@link GET}
 * swallows everything. Nothing here reaches the response.
 */
function noticeFlatTransition(
  userId: string,
  accounts: readonly HostAccountPositions[],
  deps: LiveRouteDeps
): void {
  const keys = heldKeys(accounts);
  const watching = flatWatch && flatWatch.userId === userId ? flatWatch : null;

  // A key that was held and is not any more. ONE IS ENOUGH: the candidate read
  // is `stop_history IS NULL` over the whole day, so a single capture answers
  // for every contract, and counting them would only change a log line.
  const wentFlat = watching !== null && [...watching.held].some((key) => !keys.has(key));

  const pending = (watching?.pending ?? false) || wentFlat;
  const lastCaptureAtMs = watching?.lastCaptureAtMs ?? 0;
  const now = deps.now();
  const cooled = now - lastCaptureAtMs >= CAPTURE_MIN_GAP_MS;
  const fire = pending && cooled && deps.captureStops !== undefined;

  // WRITTEN BEFORE THE CAPTURE IS SCHEDULED, so that a capture which is still
  // running when the next poll arrives cannot be started a second time. The
  // clock is stamped at the START for the same reason `shareBrokerSync` stamps
  // its own in `finally`: what has to be rate-limited is the asking.
  flatWatch = {
    userId,
    held: keys,
    pending: fire ? false : pending,
    lastCaptureAtMs: fire ? now : lastCaptureAtMs,
  };

  if (!fire) return;

  const capture = deps.captureStops;
  if (!capture) return;

  const schedule = deps.schedule ?? ((work: () => Promise<void>) => after(work));
  schedule(() => capture(userId));
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
      //
      // A `LiveReader` rather than a `TradovateReader` from Stage 4a: the
      // cash-balance snapshot is a POST. The extra verb is declared on the
      // loader's own interface rather than on `TradovateReader`, so this is the
      // only place in the product that supplies one — see the note on
      // `LiveReader` in lib/tradovate/positions.ts for why the shared type did
      // not move.
      //
      // BOTH VERBS GO THROUGH `notingPenalty` (REF-112 §4.5 item 3), and this
      // is the route that made the cap necessary: the penalty escalates to a
      // `p-captcha` a third-party application cannot clear, and a route polled
      // 240 times an hour is what escalates it. The verdict is recorded here
      // and the error rethrown unchanged, so `buildPull`'s catch still answers
      // `broker_unavailable` — which on this route is the figure's ABSENCE,
      // silence rather than an error (Stage 4b deleted `NO_PRICE_NOTE` and
      // replaced it with nothing).
      const readerFor = (apiUrl: string): LiveReader => ({
        get: (path, query) =>
          notingPenalty(userId, () =>
            tradovateGet(path, query, { accessToken: api.accessToken, apiUrl, userId })
          ),
        post: (path, body) =>
          notingPenalty(userId, () =>
            tradovatePost(path, body, { accessToken: api.accessToken, apiUrl, userId })
          ),
      });

      try {
        return await loadOpenPositions({
          readers: {
            live: readerFor(api.hosts.live.url),
            demo: readerFor(api.hosts.demo.url),
          },
          environment: api.environment,
          tradovateUserId: api.tradovateUserId,
        });
      } finally {
        // The call counter, for a route that does not go through
        // `syncUserTrades` (REF-112 §4.5 item 1). In a `finally` because a pull
        // that failed still made every request up to the failure, and subject to
        // FLUSH_MIN_GAP_MS so the poll does not write once per poll.
        await flushUserCalls({ userIds: [userId] });
      }
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

    /**
     * A contract just went flat, so read the orders behind the day's trades
     * before Tradovate destroys them (REF-113 Stage 4b).
     *
     * SWALLOWS EVERYTHING. It runs through `after()`, so nothing it does can
     * reach the response — but a rejection there is an unhandled one, and on a
     * route that runs 240 times an hour that is a log full of stack traces for
     * an annotation. The failure costs one nullable column and the 21:30 cron
     * is still behind it.
     *
     * THE SESSION CLIENT WRITES AND THE SERVICE ROLE READS, which is
     * lib/tradovate/sync.ts' documented split and the same arrangement POST
     * /api/tradovate/sync uses: the rows go in under the trader's own RLS, and
     * only the token, the hosts and the declaration need the service role.
     * Better than the crons, which have no session to write as. The client is
     * BUILT BEFORE `after()` is reached, inside this closure's `supabase()` —
     * the cookie store is readable from `after()` but a write is not, and
     * lib/supabase/server.ts already swallows a refused `setAll` for exactly
     * that case.
     */
    captureStops: async (userId) => {
      try {
        const now = Date.now();
        const { counts } = await syncUserTrades({
          userId,
          client: await supabase(),
          admin: createAdminClient(),
          // UTC midnight, like both crons, and deliberately NOT the trading
          // day's open (REF-125). That boundary is computable here now, but
          // `fills.ts` prices `min(dayStartMs, windowStartMs)` and a trading
          // day reaches up to 72 hours back across a weekend — so using it
          // would widen what this route prices for nothing. `syncUserTrades`
          // discards the scalars cut at this instant, and `windowStartMs`
          // below is what decides which trades are reached.
          dayStartMs: new Date(now).setUTCHours(0, 0, 0, 0),
          // The same day the dedicated cron reaches, and the same constant, so
          // the two triggers cannot disagree about what "today's trades" means.
          windowStartMs: now - ORDERS_LOOKBACK_MS,
          // The reason the whole branch exists.
          readStops: true,
        });

        // COUNTS ONLY, and the line is worth its noise because this trigger
        // fires a handful of times a day rather than on a timer: without it
        // there is nothing anywhere that says the transition was noticed.
        console.info(
          redactSecrets(
            '[tradovate][live] a position went flat, so the stop orders were read ' +
              `(updated=${counts.updated} unchanged=${counts.unchanged} ` +
              `imported=${counts.imported} skippedOpen=${counts.skippedOpen})`
          )
        );
      } catch (error) {
        // The KIND and nothing else, for this route's own reason: a message
        // from this chain can name a contract or a product id, and one from
        // PostgREST can echo a row.
        const kind = error instanceof Error ? error.name : 'non-Error throw';
        console.warn(`[tradovate][live] the flat-transition stop read failed (${kind})`);
      }
    },
  });
}
