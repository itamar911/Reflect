/**
 * THE WRITE EXPERIMENT (REF-126 Stage 4). One account, one minute, one call.
 *
 * This is the first and only write Reflect makes to Tradovate. It answers the
 * question Stage 3 could not: does an OAuth token issued to a VENDOR count as
 * "the eval user" for `POST /user/createaccountlockout`, which is documented
 * "only the eval user may initiate a trading lockout"?
 *
 * Stage 3 established that the same token READS lockout state fine (HTTP 200,
 * `errorText: null`, and it saw the real 15-minute manual lock on 71454220).
 * That is not evidence about the write: the status endpoint carries no
 * eval-user restriction and this one does.
 *
 *
 * WHAT THE CALL DOES TO A REAL ACCOUNT, FROM THE VENDOR'S OWN WORDS
 * -----------------------------------------------------------------
 *
 *   "open positions on the account are liquidated and new orders are rejected
 *    until the lockout expires"
 *   "Traders can't cancel their own lockouts."
 *
 * THE TRADER CANNOT UNDO IT. `expireaccountlockout` is organization-admin-only,
 * which on an evaluation account means the PROP FIRM, not us. So one minute is
 * not a conservative choice of duration — it is the ONLY acceptable one, and it
 * is not a parameter: `DURATION_MINUTES` in ./call.ts is a constant and there is
 * nowhere to pass a different number.
 *
 *
 * THE PREFLIGHT FAILS CLOSED ON EVERY UNCERTAINTY
 * -----------------------------------------------
 *
 * Three reads run first, and ANY of them being unable to answer blocks the
 * write. That is the opposite of the product's usual posture — `loadBrokerDay`
 * drops a host that did not answer and carries on — and the inversion is
 * deliberate: carrying on means liquidating a position we failed to see.
 *
 * So the blocking conditions include all of:
 *
 *   - the account is already locked                  → nothing to learn, and the
 *                                                      documented error would be
 *                                                      "already has an active
 *                                                      lockout"
 *   - the status read FAILED                         → we cannot know if it is
 *   - the status response omitted this account       → the host does not claim
 *                                                      to know it
 *   - an open position (`netPos !== 0`)              → it would be liquidated
 *   - the position read FAILED                       → we cannot know if there is
 *   - a working order                                → it would be cancelled
 *   - the order read FAILED                          → we cannot know if there is
 *   - an order whose `ordStatus` we do not recognise → see {@link isOrderActive}
 *
 * `ordStatus` is typed `string` and not a union (`src/lib/tradovate/types.ts:623`),
 * which is honest about the API, so an unrecognised value is treated as ACTIVE
 * and blocks. A new Tradovate status should stop the experiment, not slip past a
 * list written in October.
 */

import { callEndpoint, callTheOneWrite, DURATION_MINUTES, type WriteResult } from './call';
import { enumValues, type Row } from './survey';
import { parseLockoutEnvelope, type LockoutError, type LockoutStatus } from './tradingLock';

/**
 * The exact string the operator must type to arm the write.
 *
 * Not a checkbox and not a pre-filled field: typing it is the deliberate act,
 * and it is what makes a stray POST — a prefetch, a refresh, a repeated
 * browser-back — unable to lock an account.
 */
export const CONFIRM_TOKEN = 'LOCK-1-MIN';

/**
 * Order states that are TERMINAL, and therefore harmless.
 *
 * Everything not in here is treated as active. Both British and American
 * spellings of "cancelled" are listed because the documentation and the wire
 * have each been seen with one of them, and guessing wrong in this direction
 * would mean treating a live order as dead.
 */
const TERMINAL_ORDER_STATUSES = new Set([
  'filled',
  'canceled',
  'cancelled',
  'completed',
  'expired',
  'rejected',
]);

/**
 * Whether an order still stands, and so would be cancelled by a lockout.
 *
 * FAILS CLOSED. A missing, non-string or unrecognised `ordStatus` counts as
 * active. The list above is of states we are confident are over; anything else
 * — `Working`, `PendingNew`, `PendingReplace`, `PendingCancel`, `Suspended`,
 * `Unknown`, or a value Tradovate adds next year — blocks the write.
 */
export function isOrderActive(ordStatus: unknown): boolean {
  if (typeof ordStatus !== 'string' || ordStatus.trim() === '') return true;
  return !TERMINAL_ORDER_STATUSES.has(ordStatus.trim().toLowerCase());
}

/** Why the write did not happen, as a fixed vocabulary. */
export type BlockReason =
  | 'already_locked'
  | 'lock_status_unreadable'
  | 'account_missing_from_status'
  | 'open_position'
  | 'positions_unreadable'
  | 'working_order'
  | 'orders_unreadable';

const BLOCK_NOTES: Record<BlockReason, string> = {
  already_locked: 'החשבון כבר נעול — אין מה ללמוד, ו-Tradovate היה מחזיר שגיאת "active lockout"',
  lock_status_unreadable: 'קריאת סטטוס הנעילה נכשלה — אי אפשר לדעת אם החשבון נעול, ולכן לא נכתב',
  account_missing_from_status: 'החשבון לא הופיע בתשובת הסטטוס — המארח לא מכיר אותו, ולכן לא נכתב',
  open_position: 'יש פוזיציה פתוחה בחשבון — נעילה הייתה סוגרת אותה',
  positions_unreadable: 'קריאת הפוזיציות נכשלה — אי אפשר לדעת אם יש פוזיציה פתוחה, ולכן לא נכתב',
  working_order: 'יש פקודה פעילה בחשבון — נעילה הייתה מבטלת אותה',
  orders_unreadable: 'קריאת הפקודות נכשלה — אי אפשר לדעת אם יש פקודה פעילה, ולכן לא נכתב',
};

export interface PreflightReport {
  passed: boolean;
  blockedBy: BlockReason | null;
  note: string;
  lockStatusBefore: {
    outcome: string;
    errorText: string | null;
    statuses: LockoutStatus[];
    errors: LockoutError[];
  };
  positions: { outcome: string; openForThisAccount: number };
  orders: { outcome: string; activeForThisAccount: number; ordStatusesSeen: string[] };
  /** Integers and booleans only — the route checks this subtree strictly. */
  measurement: {
    alreadyLocked: boolean;
    openPositions: number;
    activeOrders: number;
    allThreeReadsAnswered: boolean;
  };
}

export interface ExperimentReport {
  accountId: number;
  durationMinutes: number;
  preflight: PreflightReport;
  write:
    | { attempted: false; note: string }
    | (WriteResult & {
        attempted: true;
        /** Read this, NOT `completed`. Tradovate answers failure with HTTP 200. */
        errorText: string | null;
        /** The verdict, and the only line that matters. */
        verdict: 'created' | 'refused' | 'call_failed' | 'ambiguous';
      });
  lockStatusAfter:
    | { read: false; note: string }
    | {
        read: true;
        outcome: string;
        errorText: string | null;
        statuses: LockoutStatus[];
        errors: LockoutError[];
        measurement: { lockedNow: boolean; endsInSeconds: number | null };
      };
}

/** Read a numeric field off a row without widening anything. */
function numberField(row: Row, field: string): number | null {
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(row: Row, field: string): string | null {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Run the experiment on one account.
 *
 * Never throws: every failure is an answer, which is ./call.ts's contract.
 */
export async function runCreateLockExperiment(options: {
  accessToken: string;
  apiUrl: string;
  userId: string;
  accountId: number;
  nowMs: number;
}): Promise<ExperimentReport> {
  const { accessToken, apiUrl, userId, accountId, nowMs } = options;
  const call = { accessToken, apiUrl, userId };

  // ---- Preflight read 1: is it already locked? -----------------------------
  const statusCall = await callEndpoint('/user/accountlockoutstatus', {
    ...call,
    body: { accountIds: [accountId] },
  });
  const before = parseLockoutEnvelope(statusCall.rows, nowMs);
  const mine = before.statuses.find((entry) => entry.accountId === accountId);

  // ---- Preflight read 2: any open position? -------------------------------
  const positionsCall = await callEndpoint('/position/list', call);
  const openPositions = positionsCall.rows.filter(
    (row) => numberField(row, 'accountId') === accountId && (numberField(row, 'netPos') ?? 0) !== 0
  );

  // ---- Preflight read 3: any working order? -------------------------------
  const ordersCall = await callEndpoint('/order/list', call);
  const accountOrders = ordersCall.rows.filter((row) => numberField(row, 'accountId') === accountId);
  const activeOrders = accountOrders.filter((row) => isOrderActive(row.ordStatus));

  // ---- The verdict, in the order the questions matter ---------------------
  let blockedBy: BlockReason | null = null;
  if (!statusCall.ok) blockedBy = 'lock_status_unreadable';
  else if (before.errorText !== null) blockedBy = 'lock_status_unreadable';
  else if (!mine) blockedBy = 'account_missing_from_status';
  else if (mine.locked !== false) blockedBy = 'already_locked';
  else if (!positionsCall.ok) blockedBy = 'positions_unreadable';
  else if (openPositions.length > 0) blockedBy = 'open_position';
  else if (!ordersCall.ok) blockedBy = 'orders_unreadable';
  else if (activeOrders.length > 0) blockedBy = 'working_order';

  const preflight: PreflightReport = {
    passed: blockedBy === null,
    blockedBy,
    note: blockedBy === null ? 'שלוש הבדיקות עברו — החשבון שטוח, בלי פקודות, ולא נעול' : BLOCK_NOTES[blockedBy],
    lockStatusBefore: {
      outcome: statusCall.outcome,
      errorText: before.errorText,
      statuses: before.statuses,
      errors: before.errors,
    },
    positions: { outcome: positionsCall.outcome, openForThisAccount: openPositions.length },
    orders: {
      outcome: ordersCall.outcome,
      activeForThisAccount: activeOrders.length,
      ordStatusesSeen: enumValues(accountOrders, 'ordStatus'),
    },
    measurement: {
      // `locked !== false` rather than `locked === true`: a null reading is not
      // a licence to write.
      alreadyLocked: mine?.locked !== false,
      openPositions: openPositions.length,
      activeOrders: activeOrders.length,
      allThreeReadsAnswered: statusCall.ok && positionsCall.ok && ordersCall.ok,
    },
  };

  if (blockedBy !== null) {
    return {
      accountId,
      durationMinutes: DURATION_MINUTES,
      preflight,
      write: { attempted: false, note: `לא נכתב: ${BLOCK_NOTES[blockedBy]}` },
      lockStatusAfter: { read: false, note: 'לא נקרא — לא בוצעה כתיבה' },
    };
  }

  // ---- THE WRITE. One call. No retry. ------------------------------------
  const write = await callTheOneWrite({ ...call, accountId });

  // `errorText` and NOT `completed` — Tradovate answers a failure with HTTP 200
  // and this field (`src/lib/tradovate/types.ts:86-87`).
  const body: Row = write.response && typeof write.response === 'object' ? (write.response as Row) : {};
  const errorText = stringField(body, 'errorText');
  const okFlag = typeof body.ok === 'boolean' ? body.ok : null;

  const verdict = !write.completed
    ? ('call_failed' as const)
    : errorText !== null
      ? ('refused' as const)
      : okFlag === true
        ? ('created' as const)
        : // Completed, no errorText, but no affirmative `ok` either. Not called a
          // success: the after-read below is what settles it.
          ('ambiguous' as const);

  // ---- Re-read, rather than infer -----------------------------------------
  // Always, including after a failed call: a call that threw may still have been
  // applied upstream (see the note in callTheOneWrite). This read is the only
  // thing that knows what actually happened.
  const afterCall = await callEndpoint('/user/accountlockoutstatus', {
    ...call,
    body: { accountIds: [accountId] },
  });
  const after = parseLockoutEnvelope(afterCall.rows, nowMs);
  const mineAfter = after.statuses.find((entry) => entry.accountId === accountId);

  return {
    accountId,
    durationMinutes: DURATION_MINUTES,
    preflight,
    write: { attempted: true, ...write, errorText, verdict },
    lockStatusAfter: {
      read: true,
      outcome: afterCall.outcome,
      errorText: after.errorText,
      statuses: after.statuses,
      errors: after.errors,
      measurement: {
        lockedNow: mineAfter?.locked === true,
        endsInSeconds: mineAfter?.endsInSeconds ?? null,
      },
    },
  };
}
