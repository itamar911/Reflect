/**
 * GET /api/cron/send-alerts — the pre-market, end-of-day and weekly emails.
 *
 * STAGE 3a CHANGED FOUR THINGS HERE (REF-107 §H), one of them about the
 * broker and three of them bugs that predate it:
 *
 *   1. **The end-of-day summary imports before it counts.** The import cron
 *      runs at 03:30 UTC; the default summary goes out at 21:00 Israel the
 *      evening before. A broker trade closed on day N therefore reached the
 *      journal nine and a half hours AFTER the summary of day N had been
 *      sent, so that summary reported zero broker trades — permanently, for
 *      any trader who did not open the app themselves. Moving the cron cannot
 *      fix it: `end_of_day_time` is per-user and no single daily job can
 *      precede everyone. So the import happens here, per user, at the hour
 *      that user chose, which is the only moment that is right for all of
 *      them.
 *   2. **The day window is the trader's midnight, not the server's.**
 *      `setHours(0,0,0,0)` runs in UTC on Vercel, which is 02:00 or 03:00 in
 *      Israel — see lib/email/alertWindow.ts.
 *   3. **A profitable short counts as a win.** The win test was
 *      `exit_price > entry_price`, the REF-107 §0ד bug, which Stage 4 fixed
 *      in the identity card, the stats page and the weekly summary and did
 *      not fix here.
 *   4. **avgRR averages the rows that have an R:R.** It divided by every row
 *      with `?? 0`, so each imported trade — which has no `rr_ratio` by
 *      design — pulled the average toward zero. Latent until (1) landed, and
 *      guaranteed by it.
 */

import { NextResponse } from 'next/server';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withHidden } from '@/lib/trades/visible';
import { createAdminClient } from '@/lib/supabase/admin';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { listConnectionsForImport, markCronProgress } from '@/lib/tradovate/connections';
import { syncUserTrades } from '@/lib/tradovate/sync';
import { isWinningTrade, pnlRow, tradeMoneyPnl } from '@/lib/pnl';
import { alertRangeStart, zonedDayStart } from '@/lib/email/alertWindow';
import {
  dailySummaryEmail,
  preMarketEmail,
  weeklySummaryEmail,
  type AlertEmail,
} from '@/lib/email/alerts';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect <hello@reflecttrading.app>';

// ── Email sender ────────────────────────────────────────────────────────────

// Each builder carries its own subject — the summaries put live figures in it.
async function sendEmail(to: string, mail: AlertEmail) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Resend error');
  }
}

// ── Per-user email dispatch ──────────────────────────────────────────────────

type AlertType = 'pre_market' | 'end_of_day' | 'weekly_summary';

/**
 * The columns the figures below need.
 *
 * `direction`, `take_profit`, `pnl_amount` and `actual_pnl` were added in
 * Stage 3a and are what the win test now reads: `isWinningTrade` prefers the
 * money figure and falls back to DIRECTION-AWARE points, where the old
 * `exit_price > entry_price` could only ever describe a long.
 */
const ALERT_TRADE_COLUMNS =
  'status, entry_price, exit_price, take_profit, direction, ' +
  'rr_ratio, emotional_state, pnl_amount, actual_pnl';

/**
 * Pull this user's broker trades into the journal before the day is counted.
 *
 * NEVER THROWS. A broker that is down, a token that lapsed, a rate limit —
 * none of them is a reason to withhold the summary. The trader's own trades
 * are in the table either way, and an email reporting them without the
 * broker's is strictly better than no email. So the failure is logged as a
 * KIND and the caller carries on.
 *
 * ONE LINE, AND NOT THE USER ID. `describeDayPullFailureKind` is not reached
 * from here because the error can also come from the import half; the
 * error's own name is enough to tell a lapsed token from a timeout, and
 * anything more specific risks naming a contract or an account. The same rule
 * the rest of this integration logs under.
 */
export async function importBeforeSummary(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  now: Date,
  // The pull, as a parameter, so the suite can assert that a broker which
  // throws does not cost the trader their email. Production passes the real
  // one by omission.
  sync: typeof syncUserTrades = syncUserTrades
): Promise<void> {
  try {
    await sync({
      userId,
      // Both the write client and the read client are the service-role one:
      // a cron has no session. What stands in for RLS is in import.ts' header
      // — `userId` is never read from a request, and every statement carries
      // it. The same construction api/cron/tradovate-import uses.
      client: admin,
      admin,
      dayStartMs: zonedDayStart(now).getTime(),
      // The day only. This runs at the trader's own end of day, so the window
      // that matters is the one that just finished; a wider one would price
      // contracts the daily cron has already imported.
      windowStartMs: zonedDayStart(now).getTime(),
      // THE STOP ORDERS, AND THIS IS ONE OF THE TWO PLACES THEY CAN BE READ AT
      // ALL (REF-113 Stage 3). This job runs per user at the hour that user
      // chose, which is inside the same trading day as the trades it is
      // counting — and that day is the whole window `/order/list` has. The
      // 03:30 nightly cron is four and a half hours too late and asks for
      // nothing; see `readStops` in lib/tradovate/sync.ts.
      //
      // It is still EARLY for a trader whose day ends at 21:00 Israel — that is
      // 13:00 CT, two hours before the American session closes, so the last two
      // hours of trading are not covered here and the nightly job cannot save
      // them. That gap is what Stage 4's dedicated cron exists for.
      readStops: true,
    });
  } catch (error) {
    const kind = error instanceof Error ? error.name : 'unknown error';
    console.warn(`[send-alerts] import before summary failed (${kind}); sending anyway`);
  }
}

async function dispatchAlert(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  type: AlertType,
  options: { now: Date; importFirst: boolean }
) {
  // Profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', userId)
    .single();

  const name  = (profile?.display_name as string | null)?.split(' ')[0] ?? 'סוחר';
  const email = (profile?.email as string | null) ?? '';
  if (!email) return;

  const now = options.now;

  // BEFORE THE QUERY, and only for the end-of-day summary. `pre_market` reports
  // on a day that has not happened and `weekly_summary` on one the daily cron
  // has already covered; neither is worth a pull. The caller decides whether
  // this user is eligible at all — see `importFirst`.
  if (options.importFirst) await importBeforeSummary(supabase, userId, now);

  // The trader's own midnight, not the server's. lib/email/alertWindow.ts has
  // the argument; the short version is that `setHours` is UTC on Vercel and
  // used to drop every trade logged before 03:00 Israel time.
  const rangeStart = alertRangeStart(type, now);

  // stats.trades and avgRR below are computed over every row, so without this
  // an alert email would report a plan the user never entered back to them as a
  // trade they made (REF-82 §5.2).
  const { data: trades } = await supabase
    .from('trade_plans')
    // `hidden` only where the column exists (lib/trades/visible.ts).
    .select(withHidden(ALERT_TRADE_COLUMNS, isImportEnabled()))
    .eq('user_id', userId)
    .neq('status', 'not_entered')
    .gte('submitted_at', rangeStart);

  // A row the trader deleted does not trigger an alert about their day (E12).
  const allTrades = visibleTrades((trades ?? []) as unknown as Record<string, unknown>[]);
  const stats = summarise(allTrades);

  const dateLabel = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  if (type === 'pre_market') {
    await sendEmail(email, preMarketEmail(name));
  } else if (type === 'end_of_day') {
    await sendEmail(email, dailySummaryEmail(name, stats, dateLabel));
  } else {
    await sendEmail(email, weeklySummaryEmail(name, stats));
  }
}

/**
 * The four figures both summary emails report.
 *
 * Exported for the regression suite, which drives it with rows rather than
 * with a database — the three arithmetic bugs this function now avoids were
 * all invisible to a test that could only assert an email was sent.
 *
 * THE THREE RULES, each of which this used to get wrong:
 *
 *   - **A win is `isWinningTrade`**, which reads the money figure when there
 *     is one and direction-aware points when there is not. `exit_price >
 *     entry_price` described a long and called every profitable short a loss.
 *   - **avgRR averages the rows that HAVE an R:R.** Dividing by every row
 *     with `?? 0` turned each imported trade — which has no `rr_ratio`, by
 *     design, because nobody filled in a form — into a zero dragging the
 *     average down. The filter-before-average pattern is the one the stats
 *     page and the weekly summary already use.
 *   - **`totalPL` is money, through `tradeMoneyPnl`** — the same definition
 *     the stats page, the journal, the dashboard and the weekly card read, so
 *     the email cannot disagree with them about a day. It summed price points
 *     into a `$`-prefixed hero stat until REF-114: for a broker row the two
 *     price columns are quantity-weighted means, so the sum was the broker's
 *     own figure with quantity and point value divided out of every term —
 *     -$76.38 printed for a -$605.50 day. Points-vs-money is not only the
 *     printed figure: `totalPL` also picks the hero's colour, the Hebrew
 *     readout and the subject, and because quantity varies between trades the
 *     points sum can carry the OPPOSITE SIGN from the money sum, which arrives
 *     as a green email titled with a profit about a losing day. A closed row
 *     with no money figure at all therefore contributes 0 rather than its raw
 *     points — a sum that mixes points and dollars is wrong in a way no reader
 *     can see (lib/pnl.ts, identity.ts:76-84).
 */
export function summarise(rows: readonly Record<string, unknown>[]): {
  trades: number;
  winRate: number;
  avgRR: number;
  totalPL: number;
} {
  const closed = rows.filter((t) => t.status === 'closed' && t.exit_price != null);

  const wins = closed.filter((t) => isWinningTrade(pnlRow(t)) === true);
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;

  const rated = rows.filter((t) => t.rr_ratio != null && Number.isFinite(Number(t.rr_ratio)));
  const avgRR =
    rated.length > 0
      ? parseFloat(
          (rated.reduce((sum, t) => sum + Number(t.rr_ratio), 0) / rated.length).toFixed(1)
        )
      : 0;

  const totalPL = closed.reduce((sum, t) => sum + tradeMoneyPnl(pnlRow(t)), 0);

  return { trades: rows.length, winRate, avgRR, totalPL };
}

// ── Cron handler ─────────────────────────────────────────────────────────────

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sixty seconds, matching the other two Tradovate crons.
 *
 * This route used to be a handful of database reads and a fetch per user and
 * ran well inside the default. Now an end-of-day user can cost a broker pull
 * — eight to ten upstream requests, two to four seconds measured — and a
 * batch of them at the same hour would be cut off mid-send without this.
 * Paired with {@link IMPORT_CONCURRENCY}, which is what keeps the batch
 * inside the sixty.
 */
export const maxDuration = 60;

/**
 * How many users are dispatched at once.
 *
 * Four, and the number is about the upstream rather than about us: each
 * end-of-day job can hold a broker pull open for seconds, and firing every
 * user at the same instant would open as many concurrent sessions against a
 * rate-limited third party as happen to share that hour. Four keeps the
 * batch moving while leaving the per-user request budget intact.
 *
 * `Promise.allSettled` over the whole list — which is what this replaced —
 * had no bound at all. That was fine when a job was two reads and an email.
 */
const IMPORT_CONCURRENCY = 4;

/**
 * Run `jobs` with at most `limit` in flight, settling every one.
 *
 * Returns the same shape `Promise.allSettled` does and in the same order, so
 * the caller's counting is unchanged. Each worker pulls the next index until
 * the list is exhausted; a rejection is recorded and does not stop the rest,
 * which is the property the old code had and must keep — one trader's broken
 * connection must not cost everyone else their email.
 */
async function settleWithLimit<T>(
  jobs: readonly (() => Promise<T>)[],
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(jobs.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await jobs[index]() };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

// Parses a saved "HH:MM" setting into just the hour, matched against the
// Israel wall-clock hour of the current cron invocation. Falls back to the
// column's own default when the value is missing/malformed.
function parseHour(time: string | null | undefined, fallback: string): number {
  const raw = time || fallback;
  const hour = Number(raw.split(':')[0]);
  return Number.isFinite(hour) ? hour : Number(fallback.split(':')[0]);
}

/**
 * The hours a trader who never chose one can land on (REF-112 §4.6 item 3).
 *
 * THE PROBLEM IS THE DEFAULT AND NOT THE CHOICE. `end_of_day_time` defaults to
 * 21:00 for every user who has not touched the setting, so the whole user base
 * lands in ONE invocation — and each of those users costs a `DAY_PULL` plus a
 * `STOP_READ` at {@link IMPORT_CONCURRENCY} 4. At around a hundred users that
 * is roughly seventy-five seconds against a sixty-second
 * {@link maxDuration}, and because the import and the send share the job, THE
 * TAIL OF THE BATCH GETS NO EMAIL AT ALL.
 *
 * 21, 22 AND 23 — FORWARD AND NOT AROUND. A later hour is not merely a
 * different one, it is a better one: 21:00 Israel is 13:00 CT, which
 * lib/tradovate/orders-cron.ts points out is TWO HOURS BEFORE the American
 * session closes, so a summary sent at 21:00 reports a day that is still
 * running. Spreading backwards would make that worse for a third of users;
 * spreading forwards makes it better for two thirds.
 *
 * THREE HOURS AND NOT MORE, because the summary is still supposed to be an
 * end-of-day email. Midnight is a different product.
 */
const DEFAULT_END_OF_DAY_HOURS = [21, 22, 23] as const;

/**
 * A stable bucket for a user id.
 *
 * FNV-1a, which is here because it needs to be DETERMINISTIC AND STABLE rather
 * than because it needs to be good. A trader must land in the same hour every
 * night — an email that arrives at a different time each evening is worse than
 * one that arrives late — so this cannot be random, cannot depend on the number
 * of users, and cannot change when the list does. Hashing the id gives all
 * three for free and needs no stored assignment.
 *
 * NOT A CRYPTOGRAPHIC CHOICE AND NOTHING SECURITY-BEARING RESTS ON IT. The
 * input is a uuid the user already knows and the output is which hour their own
 * email arrives in.
 */
function hashBucket(userId: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    // `Math.imul` keeps it a 32-bit multiply; `>>> 0` keeps it unsigned, so the
    // modulo below cannot come out negative.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/**
 * Which Israel hour this trader's end-of-day summary belongs in.
 *
 * A TRADER WHO CHOSE A TIME KEEPS IT, EXACTLY. That is the whole shape of this
 * function: the spread applies only where there was no choice to respect, so
 * nobody who went to Settings and set 21:00 is moved off it. Reading a stored
 * "21:00" as "you did not choose" would be the one version of this that is
 * indefensible.
 *
 * Exported for the regression suite, which asserts both halves and the
 * stability of the bucket.
 */
export function endOfDayHour(time: string | null | undefined, userId: string): number {
  // A malformed value is treated as a choice that cannot be read rather than
  // as an absence — `parseHour` already falls back to 21:00 for it, and moving
  // it would be guessing twice.
  if (time) return parseHour(time, '21:00');

  return DEFAULT_END_OF_DAY_HOURS[hashBucket(userId, DEFAULT_END_OF_DAY_HOURS.length)];
}

/**
 * How many imports one invocation will run (REF-112 §4.6 item 3).
 *
 * THE SECOND HALF OF THE FIX, AND IT RATIONS THE IMPORT ONLY. The spread above
 * is what stops an hour being crowded in the first place; this is the floor
 * under it, for the hour that is crowded anyway — a hundred traders who all
 * chose 21:00 by hand, or a user base that has grown past what three buckets
 * can absorb.
 *
 * **THE EMAIL IS NEVER RATIONED.** Every planned alert is dispatched, every
 * time, and only `importFirst` is capped. That is not a compromise: a summary
 * built from the rows already in the journal is exactly what
 * `importBeforeSummary` was written to fall back to — "an email reporting them
 * without the broker's is strictly better than no email" — whereas a trader who
 * gets no email at all has lost the thing they asked for.
 *
 * FORTY, from the route's own arithmetic. An import is two to four seconds
 * measured, at concurrency 4, inside `maxDuration = 60` — so forty imports is
 * roughly thirty seconds of the budget, leaving the sends and the per-user
 * reads comfortably inside it. The investigation's ~100-user figure overran at
 * ~75 seconds; this is sized to stay under half of that.
 */
const ALERT_IMPORT_LIMIT = 40;

/** One row of `alert_settings`, as this route reads it. */
export interface AlertSetting {
  user_id: string;
  pre_market_enabled?: boolean | null;
  pre_market_time?: string | null;
  end_of_day_enabled?: boolean | null;
  end_of_day_time?: string | null;
  weekly_summary_enabled?: boolean | null;
  weekly_summary_time?: string | null;
}

/** An email this run will send, and whether to pull the broker first. */
export interface PlannedAlert {
  userId: string;
  type: AlertType;
  importFirst: boolean;
}

/**
 * Which emails this invocation owes, and which of them import first.
 *
 * Pure, and exported for the regression suite — the property worth asserting
 * is "AT MOST ONE IMPORT PER USER PER RUN, and only for the end-of-day
 * summary", and that is a statement about this list rather than about what
 * the network did.
 *
 * `importFirst` is false for `pre_market` (it reports on a day that has not
 * happened) and for `weekly_summary` (the daily cron has already covered
 * every day in its window). Only the end-of-day summary is the moment a
 * trader's day has just finished, which is the whole argument of §H.
 *
 *
 * TWO THINGS CHANGED IN REF-112 §4.6 ITEM 3, AND NEITHER DROPS AN EMAIL
 * --------------------------------------------------------------------
 *
 * 1. **The end-of-day hour comes from {@link endOfDayHour}**, so a trader who
 *    never chose a time is spread across three hours by a hash of their id
 *    instead of every one of them landing in the 21:00 invocation. A trader who
 *    DID choose keeps their hour exactly.
 *
 * 2. **`importFirst` is rationed by `importLimit`**, granted in `importable`'s
 *    order — which the caller supplies least-recently-imported first, so the
 *    users who missed out last night are at the front tonight. **THE EMAIL IS
 *    NOT RATIONED.** Every job this function plans is dispatched; the cap only
 *    decides which of them pay for a broker pull first. That is the difference
 *    between "your summary is missing today's broker trades" and "you got no
 *    summary", and only one of those is acceptable.
 *
 * `importable` IS AN ORDERED LIST AND NOT A SET, which is the only reason this
 * signature changed. A Set answers membership, and membership was enough while
 * every eligible user got an import; rationing needs to know WHO GOES FIRST,
 * and that order is a property of the database read rather than of this
 * function.
 */
export function chooseAlertJobs(
  settings: readonly AlertSetting[],
  context: {
    ilHour: number;
    isSunday: boolean;
    /** Eligible users, LEAST RECENTLY IMPORTED FIRST. Order is load-bearing. */
    importable: readonly string[];
    /** How many imports this invocation may run. Omitted means no cap. */
    importLimit?: number;
  }
): PlannedAlert[] {
  const planned: PlannedAlert[] = [];
  // Rank, not membership — see the note above. Built once rather than per user,
  // because `indexOf` inside the loop would be quadratic over the user base.
  const rank = new Map(context.importable.map((userId, index) => [userId, index]));

  for (const s of settings) {
    if (s.pre_market_enabled && parseHour(s.pre_market_time, '08:30') === context.ilHour)
      planned.push({ userId: s.user_id, type: 'pre_market', importFirst: false });

    if (s.end_of_day_enabled && endOfDayHour(s.end_of_day_time, s.user_id) === context.ilHour)
      planned.push({
        userId: s.user_id,
        type: 'end_of_day',
        importFirst: rank.has(s.user_id),
      });

    if (
      s.weekly_summary_enabled &&
      context.isSunday &&
      parseHour(s.weekly_summary_time, '09:00') === context.ilHour
    )
      planned.push({ userId: s.user_id, type: 'weekly_summary', importFirst: false });
  }

  // THE BUDGET, APPLIED AFTER PLANNING AND ONLY TO `importFirst`. The jobs
  // themselves are untouched, so `planned.length` — the number of emails — is
  // the same with and without a cap. Sorted by the caller's order and not by
  // the order the settings rows arrived in, so "who waited longest" decides
  // rather than whatever PostgREST returned first.
  const limit = context.importLimit;
  if (limit !== undefined) {
    const importing = planned
      .filter((job) => job.importFirst)
      .sort((a, b) => (rank.get(a.userId) ?? 0) - (rank.get(b.userId) ?? 0));

    for (const job of importing.slice(limit)) job.importFirst = false;
  }

  return planned;
}

export async function GET(request: Request) {
  // Verify Vercel cron secret. Rejects when CRON_SECRET is missing rather than
  // skipping the check — this route uses the service-role client and mails
  // every user, so an unset/renamed env var must fail closed, not open.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();

  // vercel.json defines 24 cron entries (one per UTC hour, each still firing
  // only once/day — required on Vercel's Hobby plan) so this route runs every
  // Israel wall-clock hour. Deriving the Israel hour/weekday directly from
  // `now` handles DST automatically instead of hardcoding a UTC offset. Each
  // user's saved *_time is matched at hour granularity — the finest
  // resolution available without a per-user timezone/minute scheduling system.
  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const ilHour   = Number(ilParts.find((p) => p.type === 'hour')?.value ?? '0');
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .indexOf(ilParts.find((p) => p.type === 'weekday')?.value ?? '');
  const isSunday = dayOfWeek === 0;

  // Fetch all alert settings, including the per-user send times
  const { data: settings, error } = await supabase
    .from('alert_settings')
    .select(
      'user_id, pre_market_enabled, pre_market_time, end_of_day_enabled, end_of_day_time, weekly_summary_enabled, weekly_summary_time'
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!settings || settings.length === 0) return NextResponse.json({ sent: 0, ilHour });

  // WHO IS ELIGIBLE FOR AN IMPORT BEFORE THEIR SUMMARY. Listed once for the
  // whole run rather than queried per user, because the alternative is a
  // round trip per dispatched email to answer a question one `IN` already
  // covers.
  //
  // Three gates, and each is the same one the import cron applies:
  //
  //   - the flag, because `is_trade_source` is a column 034 adds and listing
  //     without it is a 42703 (the listing is skipped entirely, not caught);
  //   - an ACTIVE connection, which `listConnectionsForImport` filters on;
  //   - `is_trade_source`, E7's declaration — a trader who said the broker is
  //     not where their trades come from should not have one pulled;
  //   - and the fail-closed allowlist, so a background job never writes rows
  //     for a trader the user-facing routes would refuse to serve.
  //
  // A listing failure is not fatal: no user is eligible, every email still
  // goes out, and the run reports zero imports rather than zero emails.
  let importable: string[] = [];
  if (isImportEnabled()) {
    try {
      // A CURSOR BUT NO LIMIT (REF-112 §4.6 items 1 and 3), and the asymmetry
      // is deliberate. The two crons take a bounded BATCH because they process
      // every active connection; this listing answers "who is ELIGIBLE", and it
      // is then intersected with the users whose chosen hour this invocation is
      // — already a small subset — so limiting here would ration the wrong
      // population. What it does need is the ORDER: least recently imported
      // first, so `chooseAlertJobs`' budget spends itself on the traders who
      // missed out last night rather than on whoever PostgREST returned first.
      const { connections } = await listConnectionsForImport({
        admin: supabase,
        cursor: 'last_alert_import_at',
      });
      importable = connections
        .filter((c) => c.is_trade_source && isUserAllowed(c.user_id))
        .map((c) => c.user_id);
    } catch {
      // The message would name the table and nothing useful beyond it.
      console.warn('[send-alerts] could not list connections; sending without an import');
    }
  }

  const planned = chooseAlertJobs(settings as AlertSetting[], {
    ilHour,
    isSunday,
    importable,
    importLimit: ALERT_IMPORT_LIMIT,
  });

  const results = await settleWithLimit(
    planned.map((job) => () =>
      dispatchAlert(supabase, job.userId, job.type, { now, importFirst: job.importFirst })
    ),
    IMPORT_CONCURRENCY
  );

  const sent   = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results
    .filter((r) => r.status === 'rejected')
    .map((r) => (r as PromiseRejectedResult).reason?.message ?? 'unknown');

  // The users who actually paid for a pull move to the back of the queue
  // (REF-112 §4.6 item 3). Only them: a trader whose import was rationed away
  // this hour has not been served, and stamping them would send them to the
  // back of a queue they never reached the front of.
  //
  // AFTER THE DISPATCH, so an invocation killed by the function timeout stamps
  // nothing and the same users lead the next one. `markCronProgress` never
  // throws — the emails are already sent and a bookkeeping failure must not
  // turn this into a 500 that Vercel retries.
  const imported = planned.filter((job) => job.importFirst).map((job) => job.userId);
  await markCronProgress({
    admin: supabase,
    cursor: 'last_alert_import_at',
    userIds: imported,
    now: now.getTime(),
  });

  // COUNTS ONLY, as everywhere else in this integration. `eligible` against
  // `imported` is what shows the budget biting: eligible far above imported for
  // several hours running means the user base has outgrown three default
  // buckets and the spread needs widening.
  return NextResponse.json({
    sent,
    failed,
    ilHour,
    isSunday,
    eligible: importable.length,
    imported: imported.length,
  });
}
