/**
 * How many Tradovate requests one trader has cost us today (REF-112 §4.5 item 1).
 *
 * SERVER ONLY — see ./config.ts. Writes through the service-role client.
 *
 * REF-112 §4.5 opens with this, and it is the first item on the list because
 * everything else on it is a guess without it:
 *
 *     "A per-user call budget or counter of any kind. Nothing counts. There is
 *      no way today to answer 'how many calls did user X make yesterday' — no
 *      in-memory counter, and no rate_limit / quota / penalty / last_sync_at /
 *      cooldown column anywhere in supabase/."
 *
 * This answers that one question and no other. §4.3's whole table of per-user
 * call counts — 45/day idle, 4,500-5,500 for a typical active trader,
 * 8,000-12,000+ for a heavy one — was COUNTED FROM THE CALL SITES BY READING
 * THE CODE, not measured. §4.1 is worse: the "documented 5,000 requests per
 * hour per user" that five code comments size the integration against appears
 * nowhere in the vendor documentation, and the FAQ says the opposite. So the
 * numbers the design rests on are an estimate against an invented limit, and
 * the first step out of that is to count what actually happens.
 *
 *
 * VISIBILITY ONLY. NOTHING READS THIS TO REFUSE A REQUEST
 * ------------------------------------------------------
 *
 * There is no cap here and there must not be one until §4.1 is settled. A
 * threshold built on an unsourced figure would either be so high it never fires
 * or would start refusing a trader's own pulls on the strength of a number
 * nobody can cite — and the failure mode of the second is a discipline tool
 * silently under-reporting a day, which ./fills.ts calls "the one direction
 * this integration must never fail in".
 *
 * What the number is FOR is the three decisions §4 cannot currently make: how
 * many users one deployment can carry, whether `/api/tradovate/live`'s poll
 * interval is the right one, and which caller to attack first if Tradovate
 * complains.
 *
 *
 * WHERE THE COUNT HAPPENS, AND WHY IT CANNOT BE FORGOTTEN
 * ------------------------------------------------------
 *
 * ./client.ts, inside `tradovateRequest`, which is the single function every
 * per-user Tradovate request passes through. That is the only place where
 * "a request was made" is a fact rather than an inference: counting at the call
 * sites would mean counting `DAY_PULL ≈ 8-10` and `LIVE_PULL = 3-4 flat, 5-7
 * holding` as constants, which is exactly the estimate this module exists to
 * replace.
 *
 * It cannot be forgotten because `UserTokenRequestOptions.userId` is REQUIRED:
 * a per-user request that does not name the user does not type-check. That is
 * the same device ./client.ts already uses for `apiUrl`, for the same stated
 * reason — "a defence that rests on everyone's build being clean is not one" —
 * and it is why this module is importable by ./client.ts at all. ./connections.ts
 * cannot be: ./oauth.ts imports ./client.ts, so the edge would close a cycle.
 *
 * REQUESTS MADE WITH THE APPLICATION'S OWN PASSWORD-GRANT SESSION ARE NOT
 * COUNTED, because there is no user to attribute them to. ./config.ts' header
 * records that path as having no production caller anyway.
 *
 *
 * WHY IT IS BUFFERED, AND WHAT THAT COSTS
 * ---------------------------------------
 *
 * The brief for this work says in so many words that in memory is not enough,
 * and it is right: a module-level counter on Vercel is per-lambda-instance and
 * dies with the instance, which is the same mistake REF-112 §4.6 item 5
 * identifies in every other cache in this integration.
 *
 * But a write per request is not the answer either. `/api/tradovate/live` is
 * 240 requests an hour per holding trader; one upsert per request would make
 * this diagnostic a bigger database load than the feature it measures. So the
 * count accumulates in memory and is flushed at most once every
 * {@link FLUSH_MIN_GAP_MS} per user, which turns a holding trader's hour into
 * roughly sixty writes instead of several hundred.
 *
 * WHAT IS LOST: the calls buffered since the last flush, if the instance is
 * frozen or recycled before the next one. At most a minute of one user's
 * requests, under-counted. That is the right direction for a diagnostic — it
 * can say "at least this many" — and it is why {@link flushUserCalls} takes a
 * `force` flag that the crons set, so a scheduled job always lands its total.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';

import { redactSecrets } from './redact';

/**
 * The shortest gap between two writes for one user.
 *
 * ONE MINUTE, chosen against the live poll rather than against the database.
 * That route is the highest-frequency caller in the product — its own header
 * admits to "a route that runs 240 times an hour per trader" — and its server
 * hold is ten seconds, so an unbuffered flush would be up to 360 writes an hour
 * for one trader. A minute bounds it at sixty and loses at most a minute of
 * counting to a recycled instance.
 */
export const FLUSH_MIN_GAP_MS = 60_000;

/** Calls counted but not yet written, per user. */
const pending = new Map<string, number>();

/** When this process last wrote for a user, so the gap above can be applied. */
const lastFlush = new Map<string, number>();

/**
 * Cap on tracked users, so a process serving many traders cannot grow these
 * maps without bound.
 *
 * The same device and the same number as `MAX_CACHED_USERS` in
 * ./connections.ts. An evicted user loses their buffered count, which is the
 * under-count this module's header already accepts; eviction is
 * oldest-inserted-first and only ever drops an entry that has nothing pending.
 */
const MAX_TRACKED_USERS = 500;

/** Logged once per process: see the note on {@link flushUserCalls}. */
let warnedKind: string | null = null;

/**
 * Record one upstream Tradovate request made with this trader's token.
 *
 * SYNCHRONOUS, ALLOCATION-FREE IN THE COMMON CASE, AND IT CANNOT THROW. It is
 * called on the hot path of every request in the integration, before the
 * `fetch`, so anything it did that could fail would be a diagnostic taking down
 * a pull.
 */
export function noteUserCall(userId: string): void {
  const current = pending.get(userId);
  if (current === undefined && pending.size >= MAX_TRACKED_USERS) {
    // Drop the oldest entry that is already written out. If every entry has
    // something pending, the new user is simply not tracked this time around —
    // under-counting, never losing somebody else's total.
    for (const [id, count] of pending) {
      if (count === 0) {
        pending.delete(id);
        lastFlush.delete(id);
        break;
      }
    }
    if (pending.size >= MAX_TRACKED_USERS) return;
  }
  pending.set(userId, (current ?? 0) + 1);
}

/**
 * How many calls are buffered for this user. Test seam, and nothing else.
 */
export function bufferedCalls(userId: string): number {
  return pending.get(userId) ?? 0;
}

/** Forget every buffered count and flush time. Test seam, and nothing else. */
export function forgetCallMeter(): void {
  pending.clear();
  lastFlush.clear();
  warnedKind = null;
}

/**
 * The UTC calendar day a count belongs to, as `YYYY-MM-DD`.
 *
 * UTC, LIKE EVERY OTHER BOUNDARY IN THIS INTEGRATION'S BACKGROUND JOBS — both
 * crons cut their day with `setUTCHours(0, 0, 0, 0)`. **IT IS NOT THE TRADING
 * DAY AND MUST NOT BE READ AS ONE**: the roll is ~17:00 CT, so a trader's
 * evening session straddles two rows here. That is acceptable because the
 * consumer is an operator reading a cron summary, and it is wrong for anything
 * a trader is shown — which is why nothing shows it.
 */
export function callDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Write the buffered counts for these users, subject to the gap.
 *
 * NEVER THROWS, and logs at most one kind per process. It is called in a
 * `finally` on the way out of a pull that has already done its real work, so a
 * failure here must cost the count and nothing else — and a 42703 or a
 * PGRST205 repeated by the live poll would bury every other line in the log.
 *
 * `userIds` OMITTED MEANS EVERY BUFFERED USER, which is what the crons want
 * after a batch. A route passes its own one user, so one trader's pull never
 * pays to write another's total.
 *
 * `force` SKIPS THE GAP. The crons set it because a scheduled job runs once and
 * then the instance may never serve again; its total has to land. An
 * interactive route does not, because the next poll is fifteen seconds away.
 */
export async function flushUserCalls(options: {
  admin?: SupabaseClient;
  userIds?: readonly string[];
  now?: number;
  force?: boolean;
} = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const force = options.force ?? false;
  const ids = options.userIds ?? [...pending.keys()];
  if (ids.length === 0) return;

  const due = ids.filter((id) => {
    if ((pending.get(id) ?? 0) <= 0) return false;
    if (force) return true;
    const last = lastFlush.get(id);
    return last === undefined || now - last >= FLUSH_MIN_GAP_MS;
  });
  if (due.length === 0) return;

  const admin = options.admin ?? createAdminClient();
  const day = callDay(now);

  for (const userId of due) {
    const calls = pending.get(userId) ?? 0;
    if (calls <= 0) continue;

    // CLEARED BEFORE THE AWAIT, not after. A second flush racing this one in
    // the same process would otherwise write the same calls twice, which is the
    // one direction a counter must not be wrong in — an over-count would make
    // this module's whole output unusable as evidence. If the write fails the
    // calls are lost instead, which the header already accounts for.
    pending.set(userId, 0);
    lastFlush.set(userId, now);

    // The atomic increment. `calls = calls + n` is not expressible through
    // PostgREST, and read-then-write loses counts whenever two of a trader's
    // lambdas flush at once — which the live poll makes the normal case rather
    // than a race to worry about later. Migration 042 defines the function.
    // TRY/CATCH AS WELL AS THE ERROR CHANNEL. supabase-js RETURNS a PostgREST
    // error rather than throwing one, but a transport failure still rejects —
    // and this runs in a `finally` on the way out of a pull, where a rejection
    // would replace the pull's own error with a bookkeeping one. Nothing this
    // function can do is worth that.
    let failure: string | null = null;
    try {
      const { error } = await admin.rpc('bump_tradovate_calls', {
        p_user_id: userId,
        p_day: day,
        p_calls: calls,
      });
      if (error) failure = error.code ?? 'no code';
    } catch (error) {
      failure = error instanceof Error ? error.name : 'non-Error throw';
    }

    if (failure !== null && warnedKind === null) {
      warnedKind = failure;
      console.warn(
        redactSecrets(
          `[tradovate][calls] the call counter could not be written (${warnedKind}); ` +
            'nothing is being counted. Migration 042 may not have run.'
        )
      );
    }
  }
}

/**
 * What these users have cost us today, for a cron's summary line.
 *
 * COUNTS ONLY, AND THE CALLER MUST KEEP IT THAT WAY. This returns a map keyed
 * by user id because the crons want a maximum as well as a total, and a
 * MAXIMUM IS THE INTERESTING NUMBER — §4.3's point is that the spread between
 * an idle trader (~45/day) and a heavy one (8,000-12,000+) is two orders of
 * magnitude, so a mean hides the user who is actually the problem. Neither the
 * key nor anything derived from it may reach a log line; ./import-cron.ts and
 * ./orders-cron.ts reduce this to two integers before they write anything.
 *
 * Returns an empty map on any failure, including migration 042 not having run.
 * A missing diagnostic must not turn a successful cron run into a failed one.
 */
export async function readDailyCalls(options: {
  admin: SupabaseClient;
  userIds: readonly string[];
  now?: number;
}): Promise<Map<string, number>> {
  const { admin, userIds } = options;
  if (userIds.length === 0) return new Map();

  const { data, error } = await admin
    .from('tradovate_call_counts')
    .select('user_id, calls')
    .eq('call_day', callDay(options.now ?? Date.now()))
    .in('user_id', [...userIds]);

  if (error || !data) return new Map();

  return new Map(
    (data as { user_id: string; calls: number }[]).map((row) => [row.user_id, row.calls])
  );
}

/**
 * The two integers a cron may log: the batch's total and its heaviest user.
 *
 * HERE RATHER THAN IN EACH CRON, so that the reduction from a keyed map to two
 * numbers happens once and in the module whose header carries the rule. A cron
 * that formatted the map itself is one refactor away from interpolating a user
 * id into a nightly log line.
 */
export function summariseCalls(calls: Map<string, number>): {
  total: number;
  heaviest: number;
} {
  let total = 0;
  let heaviest = 0;
  for (const count of calls.values()) {
    total += count;
    if (count > heaviest) heaviest = count;
  }
  return { total, heaviest };
}
