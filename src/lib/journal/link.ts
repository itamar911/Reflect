/**
 * The three link states of a broker row, and the two writes that leave them
 * (REF-107 Stage 3b, §A and §C).
 *
 * The STATE half is pure and browser-safe — a row in, a word out — because four
 * readers need it and three of them are components: the `מקור` row in the
 * detail modal, the banner's count on /trades, the confirmation panel's own
 * gate, and the regression suite. The WRITE half takes a `SupabaseClient` as a
 * parameter and never builds one, so the suite can drive both outcomes of every
 * branch without a database.
 *
 *
 * THE FOUR STATES, DERIVED AND NEVER STORED
 * -----------------------------------------
 *
 * Migration 035 added two columns and no status enum, which was the right
 * shape: a state machine stored next to the facts that define it is a state
 * machine that can disagree with them. So the state is read off three columns
 * the row already had to carry (§A):
 *
 *   | `source`     | `unplanned` | `link_confirmed_at` | state      |
 *   |--------------|-------------|---------------------|------------|
 *   | `tradovate`  | false       | not null            | `linked`   |
 *   | `tradovate`  | true        | null                | `queued`   |
 *   | `tradovate`  | true        | not null            | `declined` |
 *   | `manual`     | —           | —                   | not a broker row |
 *
 * A ROW WRITTEN BEFORE 035 READS AS `queued`, AND THAT IS THE TRUTH ABOUT IT.
 * The import has been live since 15.10 and every row it wrote carries
 * `unplanned = true` with no `link_confirmed_at`, because the column did not
 * exist. Those rows have genuinely never been assigned to a plan, so they
 * belong in the queue, and the banner counting them on the first load after
 * this ships is the feature working rather than a migration artefact.
 *
 *
 * WHY `declined` KEEPS `unplanned = true`
 * ---------------------------------------
 *
 * Because it IS unplanned — the trader has just said so. `link_confirmed_at` is
 * what separates "we have not asked yet" from "we asked and the answer was no",
 * and that separation is the whole reason the column exists: without it the
 * queue can never empty, and a queue that cannot empty is the failure §E16
 * warns about.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Which of the three things a broker row can be. */
export type LinkState = 'linked' | 'queued' | 'declined';

/** The columns {@link linkState} reads. Every one optional — see the header. */
export interface LinkableRow {
  source?: string | null;
  unplanned?: boolean | null;
  link_confirmed_at?: string | null;
  hidden?: boolean | null;
}

/**
 * The row's link state, or null when the question does not apply.
 *
 * Null for a manual plan, and that is not the same as "unlinked": a plan the
 * trader typed has no broker trade behind it and nothing to be linked to. The
 * detail modal shows no `מקור` row at all for it, which is the decision Stage 2
 * made and argued for — a journal that labels its own default case "ידני"
 * treats hand entry as the exception.
 */
export function linkState(row: LinkableRow): LinkState | null {
  if (row.source !== 'tradovate') return null;
  if (row.unplanned !== true) return 'linked';
  return row.link_confirmed_at ? 'declined' : 'queued';
}

/**
 * Whether this row is waiting for the trader to decide.
 *
 * The queue's definition, in one place, because two readers must not be able to
 * disagree about it: the banner counts these and the modal offers the panel for
 * exactly these. `hidden` is excluded here as well as by every caller's own
 * `visibleTrades` — a row the trader deleted is not waiting for anything.
 */
export function isQueuedBrokerRow(row: LinkableRow): boolean {
  return row.hidden !== true && linkState(row) === 'queued';
}

/**
 * What the `מקור` row says, per state.
 *
 * Three sentences and not two. Stage 2 shipped `Tradovate` and
 * `Tradovate · לא תוכננה`, and the investigation's §A found that the second one
 * would be shown on a LINKED trade the moment the merge cleared `unplanned` —
 * "not planned" printed over a trade the trader planned carefully. The third
 * state is the fix, and it is the one a trader sees most often once the queue
 * is being worked.
 */
export const LINK_STATE_COPY: Record<LinkState, string> = {
  linked: 'Tradovate · מקושרת לתוכנית',
  queued: 'Tradovate · ממתינה לשיוך',
  declined: 'Tradovate · לא תוכננה',
};

/**
 * The banner on /trades. Singular and plural spelled out, not templated.
 *
 * Same rule as `addedSentence` in lib/tradovate/sync-response.ts, and the same
 * reason it gives: "1 עסקאות" is the kind of thing that makes a product look
 * unfinished, and in Hebrew the verb changes too, so the two forms are written
 * out rather than assembled.
 */
export function queueBannerText(count: number): string {
  return count === 1
    ? 'עסקה אחת מ-Tradovate ממתינה לשיוך'
    : `${count} עסקאות מ-Tradovate ממתינות לשיוך`;
}

/**
 * The delete-confirmation sentence, which on a linked row has to say more.
 *
 * §F4: after the link the plan and the broker trade ARE ONE ROW, so hiding it
 * hides the trader's own intent with it — the strategy they chose, the reason
 * they wrote, the stop they set. A trader who meant to remove a duplicate
 * import would lose the most valuable thing this product asked them for, and
 * the only place to say so is the dialog that is about to do it.
 */
export function deleteWarningText(row: LinkableRow): string {
  return linkState(row) === 'linked'
    ? 'העסקה הזאת מקושרת לתוכנית שכתבת — מחיקה תסתיר גם את התוכנית, כולל האסטרטגיה, הסטופ והסיבה שתיעדת. להמשיך?'
    : 'האם אתה בטוח שברצונך למחוק עסקה זו?';
}

// ── The proposed flags (§E) ──────────────────────────────────────────────────

/** One flag, the value proposed for it, and why — shown beside the checkbox. */
export interface FlagProposal {
  /** The `trade_plans` column. Written only if the trader leaves it checked. */
  column: 'proper_size' | 'exited_early' | 'followed_plan';
  /** The Hebrew label beside the checkbox. */
  label: string;
  /** What we think, from the comparison. The checkbox's initial state. */
  value: boolean;
  /** The comparison itself, in one line. This is what makes it a proposal. */
  reason: string;
}

/** The plan's side of the comparison: what the trader committed to. */
export interface PlanIntent {
  entry_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  /** `units` is the newer column; older plans only carry `quantity`. */
  units?: number | null;
  quantity?: number | null;
}

/** The broker's side: what was actually executed. */
export interface ExecutedFacts {
  direction?: 'long' | 'short' | null;
  entry_price?: number | null;
  exit_price?: number | null;
  quantity?: number | null;
}

/**
 * How far an entry may slip from the planned price and still count as
 * following the plan: a quarter of the planned risk.
 *
 * AN INVENTED NUMBER, AND IT IS EXPOSED RATHER THAN HIDDEN. It cannot be zero —
 * a market order never fills at the typed price — and it cannot be one, which
 * would call an entry a quarter of the way to the stop "as planned". A quarter
 * of the distance the trader themselves chose to risk scales with their own
 * stop instead of assuming a tick size, and the rationale string prints the
 * comparison so the trader can disagree with it in one click.
 */
const ENTRY_SLIPPAGE_SHARE_OF_RISK = 0.25;

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
};

/** Two prices as a short Hebrew comparison, e.g. `2 מול 2`. */
const versus = (a: number, b: number): string => `${a} מול ${b}`;

/**
 * The three flags that can be derived from a plan and its execution (§E).
 *
 * PROPOSALS AND NOT WRITES, which is the decision the Stage 3 comment recorded.
 * A flag computed silently is a flag the trader never agreed to, and two of
 * these three are JUDGEMENTS — §E says so: "early" is a judgement, because an
 * exit at 80% of target on a news print is a decision and not a failure, and
 * "followed the plan" is three comparisons none of which is what a trader means
 * by the phrase. So each one arrives checked, with the comparison beside it,
 * and the trader unchecks what they disagree with.
 *
 * A FLAG THAT CANNOT BE COMPUTED IS NOT RETURNED. There is no "unknown"
 * checkbox: a plan with no target cannot say whether the exit was early, and
 * offering an unchecked box with "we could not tell" invites the trader to
 * confirm a `false` that means nothing. `kept_sl`/`moved_sl` are absent from
 * this list for the harder version of the same reason — §E found the order
 * history is not in the pull at all, which is REF-113.
 */
export function proposeFlags(plan: PlanIntent, facts: ExecutedFacts): FlagProposal[] {
  const proposals: FlagProposal[] = [];

  // proper_size — the one §E calls unambiguous: two numbers, one comparison.
  // `units ?? quantity` is the precedence the journal already uses when it
  // hands a size to CloseTrade, because `units` is the newer column.
  const planned = finite(plan.units) ?? finite(plan.quantity);
  const filled = finite(facts.quantity);
  if (planned !== null && filled !== null) {
    proposals.push({
      column: 'proper_size',
      label: 'גודל פוזיציה כמתוכנן',
      value: planned === filled,
      reason:
        planned === filled
          ? `כמות תואמת: ${versus(planned, filled)}`
          : `כמות שונה מהמתוכנן: ${versus(planned, filled)}`,
    });
  }

  const direction = facts.direction ?? null;
  const entry = finite(facts.entry_price);
  const exit = finite(facts.exit_price);
  const target = finite(plan.take_profit);
  const stop = finite(plan.stop_loss);

  // Everything below needs a direction and a round trip to compare at all.
  if (direction === null || entry === null || exit === null) return proposals;

  const long = direction === 'long';
  const profited = long ? exit > entry : exit < entry;
  // "At or beyond the target", not "equal to it": the exit is a quantity-
  // weighted average of real fills and will essentially never equal a typed
  // price, so equality would read every target hit as an early exit.
  const reachedTarget = target !== null && (long ? exit >= target : exit <= target);
  const reachedStop = stop !== null && (long ? exit <= stop : exit >= stop);

  if (target !== null) {
    proposals.push({
      column: 'exited_early',
      label: 'יציאה מוקדמת',
      value: profited && !reachedTarget,
      reason: !profited
        ? 'העסקה נסגרה בהפסד — לא יציאה מוקדמת מרווח'
        : reachedTarget
          ? `היציאה הגיעה ליעד: ${versus(exit, target)}`
          : `יציאה ברווח לפני היעד: ${versus(exit, target)}`,
    });
  }

  // followed_plan needs all three of the plan's prices: without the stop there
  // is no risk distance to measure the entry's slippage against, and without
  // the target there is no planned way out to check the exit reached.
  const plannedEntry = finite(plan.entry_price);
  if (plannedEntry !== null && stop !== null && target !== null) {
    const risk = Math.abs(plannedEntry - stop);
    const slippage = Math.abs(entry - plannedEntry);
    const tolerance = risk * ENTRY_SLIPPAGE_SHARE_OF_RISK;
    const enteredAsPlanned = risk > 0 && slippage <= tolerance;
    const leftAsPlanned = reachedTarget || reachedStop;

    proposals.push({
      column: 'followed_plan',
      label: 'עקבתי אחרי התוכנית',
      value: enteredAsPlanned && leftAsPlanned,
      reason: !enteredAsPlanned
        ? `הכניסה רחוקה מהמתוכנן: ${versus(entry, plannedEntry)}`
        : leftAsPlanned
          ? 'כניסה ויציאה בטווח שתוכנן'
          : 'הכניסה כמתוכנן, היציאה לא ביעד ולא בסטופ',
    });
  }

  return proposals;
}

// ── The two writes (§C) ─────────────────────────────────────────────────────

/** What a link attempt did. `code` is a SQLSTATE, never a message. */
export type LinkOutcome =
  | { ok: true; flagsStored: boolean }
  | { ok: false; reason: 'busy' | 'rejected'; code?: string };

/**
 * The broker rows a confirm or a decline is currently in flight for.
 *
 * THE CLIENT HALF OF THE DOUBLE-CONFIRM GUARD, and the server half is the
 * `FOR UPDATE` in migration 035's `link_broker_trade`: two confirms of the same
 * row serialise there, and the loser finds the broker row already deleted and
 * raises `P0002`. So the database is the authority and this cannot corrupt
 * anything on its own — what it prevents is a double click, or a confirm racing
 * a decline, turning into an error message about a link that in fact succeeded.
 *
 * Module scope, keyed by the broker row's id, because the two callers are a
 * list of candidate buttons and a decline button in the same panel — per-button
 * state could not see the other one. Released in a `finally`, so a thrown fetch
 * does not strand the row.
 */
const inFlight = new Set<string>();

/** For the suite: no run may leak state into the next one. */
export function resetLinkGuard(): void {
  inFlight.clear();
}

/**
 * Link a queued broker row onto the plan behind it.
 *
 * THE RPC AND NOT THREE STATEMENTS, and §0ג is the whole argument: the partial
 * UNIQUE on `(user_id, broker_trade_key)` forces the merge into a fixed order —
 * clear the key, move the facts, delete the source row — and the browser has no
 * transaction to put them in. A failure between the second and the third leaves
 * a trade with no row at all. `link_broker_trade` is `SECURITY DEFINER` for
 * exactly that reason and no other, and it re-checks `auth.uid()` against BOTH
 * rows in its body because that is the RLS it is stepping around.
 *
 * THE FLAGS ARE A SECOND STATEMENT, AND A FAILURE THERE IS NOT A FAILED LINK.
 * They are intent columns: the function deliberately does not touch them, the
 * trader has just agreed to them, and losing three booleans is not a reason to
 * tell somebody their trade was not linked when it was. `flagsStored` says
 * which happened.
 */
export async function confirmLink(params: {
  client: SupabaseClient;
  /** The queued `tradovate` row. Deleted by the function on success. */
  brokerRowId: string;
  /** The `manual` plan that keeps the row. Carries the facts afterwards. */
  planId: string;
  /** The proposals the trader left checked. Empty is fine. */
  flags?: Partial<Record<FlagProposal['column'], boolean>>;
}): Promise<LinkOutcome> {
  const { client, brokerRowId, planId, flags } = params;

  if (inFlight.has(brokerRowId)) return { ok: false, reason: 'busy' };
  inFlight.add(brokerRowId);

  try {
    const { error } = await client.rpc('link_broker_trade', {
      plan_id: planId,
      broker_row_id: brokerRowId,
      method: 'confirmed',
    });

    if (error) return { ok: false, reason: 'rejected', code: error.code };

    const values = flags ?? {};
    if (Object.keys(values).length === 0) return { ok: true, flagsStored: false };

    // On the PLAN's id: the broker row no longer exists, and the plan is the
    // row that now carries the whole trade.
    const { error: flagError } = await client
      .from('trade_plans')
      .update(values)
      .eq('id', planId);

    return { ok: true, flagsStored: !flagError };
  } finally {
    inFlight.delete(brokerRowId);
  }
}

/**
 * Record that this trade was never planned, and take it out of the queue.
 *
 * NO MERGE AND NO DELETE — the row stays exactly as it is, with its key, its
 * facts and `unplanned = true`. The only change is that we have now asked and
 * been answered, which is what `link_confirmed_at` records. The next import
 * finds the key, compares the thirteen facts, finds them identical and sends
 * nothing, so the answer survives every later sync for free.
 *
 * Guarded by the same set as {@link confirmLink}, so a decline cannot race a
 * confirm of the same row.
 */
export async function declineLink(params: {
  client: SupabaseClient;
  brokerRowId: string;
}): Promise<LinkOutcome> {
  const { client, brokerRowId } = params;

  if (inFlight.has(brokerRowId)) return { ok: false, reason: 'busy' };
  inFlight.add(brokerRowId);

  try {
    const { error } = await client
      .from('trade_plans')
      .update({ link_confirmed_at: new Date().toISOString(), link_method: 'declined' })
      .eq('id', brokerRowId);

    return error ? { ok: false, reason: 'rejected', code: error.code } : { ok: true, flagsStored: false };
  } finally {
    inFlight.delete(brokerRowId);
  }
}
