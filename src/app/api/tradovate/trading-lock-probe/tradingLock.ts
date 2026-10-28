/**
 * The Account Lockout measurement, one host at a time (REF-126 Stage 3).
 *
 * NAMED `tradingLock` AND NOT `lockout`. REF-126 Stage 2 §ד.3: `lockout` is
 * already taken in this codebase — `src/lib/tradovate/connections.ts` uses it
 * in about ten places for the RATE-LIMIT BACKOFF (`:2102`, `:2128`,
 * `:2281-2316`), which is an unrelated thing that would read as the same thing.
 *
 *
 * WHAT THIS ANSWERS, AND WHAT IT CANNOT
 * -------------------------------------
 *
 * It answers whether Reflect's OAuth token gets a VALID ANSWER from
 * `/user/accountlockoutstatus`, and on which host. That is a read, and it is a
 * proxy — a positive answer does NOT establish that the same token may CREATE a
 * lockout. `createaccountlockout` is documented "only the eval user may
 * initiate a trading lockout", and the status endpoint carries no such line, so
 * the two can legitimately differ. REF-126 Stage 4 is the only thing that
 * settles the write, and this module deliberately cannot perform it.
 *
 *
 * WHY THE CLAIM STEP EXISTS
 * -------------------------
 *
 * `/user/accountlockoutstatus` takes `{ accountIds }`, so something has to
 * decide which ids to ask about. "Every account in the response" is wrong: a
 * prop firm's API admin has OTHER TRADERS' accounts in their visible scope
 * (`src/lib/tradovate/accounts.ts:549-555`), and asking about those would put
 * someone else's account id in a request we made.
 *
 * So the ids are narrowed to this trader's own, the same two ways the product
 * narrows them (`src/lib/tradovate/accounts.ts:66-76`):
 *
 *   - **owned** — `account.userId === tradovateUserId`
 *   - **permitted** — a `TradingPermission` on the SAME HOST whose `userId` is
 *     this trader's, with `status` ∈ {`Accepted`, `Approved`}
 *
 * The second is not optional for this ticket: an evaluation account is
 * documented as OWNED BY THE FIRM'S API ADMIN with the trader holding a
 * permission on it, measured 14 Oct 2026 (`accounts.ts:70-76`). An
 * ownership-only filter would ask about nothing at all on exactly the host that
 * matters.
 *
 * Ids are HOST-LOCAL (`accounts.ts:137-142`), so this runs per host and never
 * mixes the two lists.
 *
 *
 * WHAT REACHES THE RESPONSE
 * -------------------------
 *
 * This module is a deliberate, narrow exception to the REF-113 probe's "no raw
 * values" rule, because REF-126 Stage 3 item 5.4 asks for the response itself:
 *
 *   - **The trader's own account ids**, in `accountIdsAsked` and in each status
 *     row. The owner needs them to line the answer up against the accounts they
 *     locked by hand. They are the owner's own, returned to the owner, behind a
 *     one-id allowlist.
 *   - **`errorText` / `error`, verbatim.** The documented failure strings are
 *     the measurement — "Unauthorized: only the eval user…" is the whole point
 *     of the exercise — and paraphrasing them would destroy it.
 *
 * Everything else stays inside the old rules: field SHAPES through
 * `fieldSurvey`, enum members through the vocabulary, and no instant anywhere —
 * `endTime` is converted to {@link endsInSeconds}, a whole-second offset, for
 * the reason `relativeSeconds` gives in ./survey.ts. A duration says how long
 * the lock has left; an absolute time says when that trader was at their desk.
 *
 * No balance, no price, no position, no fill and no account NAME is read by
 * anything here.
 */

import { callEndpoint, reportOf, type CallResult } from './call';
import { enumValues, fieldSurvey, type Row } from './survey';

/** The questions this mode exists to answer, restated in the response. */
export const TRADING_LOCK_QUESTIONS = {
  Q1:
    'האם טוקן ה-OAuth של Reflect מקבל תשובה תקינה מ-/user/accountlockoutstatus, ' +
    'ועל איזה host — demo, live, או שניהם?',
  Q2:
    'אילו חשבונות הם של הסוחר על כל host (בבעלות מול הרשאה), ' +
    'וכמה מהם בכלל אפשר לשאול עליהם?',
  Q3:
    'האם ה-endpoint מוגבל ל-Demo כפי שהתיעוד אומר, או שהוא עונה גם ב-Live? ' +
    '(401/403/404 על host אחד הוא תשובה, לא כשל.)',
  NOT_ANSWERED:
    'האם מותר ליצור נעילה — זו שאלת הכתיבה (Stage 4) והיא לא נבדקת פה. ' +
    'תשובה חיובית כאן אינה מוכיחה שכתיבה תעבוד.',
} as const;

/** Statuses that make a `TradingPermission` count, per `accounts.ts:164`. */
const ACCEPTED_PERMISSION_STATUSES = new Set(['Accepted', 'Approved']);

/**
 * How many account ids one request may carry.
 *
 * A bound rather than a limit anybody has hit: the request is one call whatever
 * the count, but an unbounded array built from a response we do not control is
 * the kind of thing that should have a ceiling written down. A trader with more
 * claimed accounts than this gets `accountIdsCapped: true` so the reader never
 * mistakes "we stopped asking" for "there was nothing more" — the same rule the
 * REF-113 probe applied to its deps fan-out.
 */
export const MAX_ACCOUNT_IDS = 25;

/** A lockout status row, as documented. Every field optional but `accountId`. */
export interface LockoutStatus {
  accountId: number;
  locked: boolean | null;
  /** Whole seconds from now. Negative means it has already passed. */
  endsInSeconds: number | null;
}

/** One `errors[]` entry from the status envelope. */
export interface LockoutError {
  accountId: number | null;
  error: string;
}

/**
 * `endTime` as a whole-second offset from now, or null.
 *
 * An offset and never the instant — see the module header. Rounded, so it is an
 * integer and survives the route's strict-subtree check.
 */
export function endsInSeconds(endTime: unknown, nowMs: number): number | null {
  if (typeof endTime !== 'string') return null;
  const parsed = Date.parse(endTime);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((parsed - nowMs) / 1000);
}

/**
 * Unpack `/user/accountlockoutstatus`'s `{ statuses, errors }` envelope.
 *
 * ONE DEFINITION, used by both the Stage 3 survey and the Stage 4 experiment.
 * Stage 4 decides whether to WRITE based on what this returns, so a second copy
 * that drifted would be a second opinion about whether an account is already
 * locked — which is exactly the question the irreversible call hangs on.
 *
 * `errorText` is read defensively: it is not in this endpoint's documented
 * schema, but it IS the shape every other Tradovate endpoint uses for a
 * failure — and it arrives with HTTP 200 (`src/lib/tradovate/types.ts:86-87`),
 * so `ok` alone would read a failure as a success. That is the trap REF-126
 * Stage 2 §ג.1 item 7 names.
 */
export function parseLockoutEnvelope(
  rows: Row[],
  nowMs: number
): { errorText: string | null; statuses: LockoutStatus[]; errors: LockoutError[] } {
  const envelope: Row = rows[0] ?? {};
  const rawStatuses = Array.isArray(envelope.statuses) ? envelope.statuses : [];
  const rawErrors = Array.isArray(envelope.errors) ? envelope.errors : [];

  const statuses: LockoutStatus[] = rawStatuses
    .filter((row): row is Row => !!row && typeof row === 'object')
    .map((row) => ({
      accountId: numberField(row, 'accountId') ?? -1,
      locked: typeof row.locked === 'boolean' ? row.locked : null,
      endsInSeconds: endsInSeconds(row.endTime, nowMs),
    }));

  const errors: LockoutError[] = rawErrors
    .filter((row): row is Row => !!row && typeof row === 'object')
    .map((row) => ({
      accountId: numberField(row, 'accountId'),
      error: stringField(row, 'error') ?? '<non-string>',
    }));

  return { errorText: stringField(envelope, 'errorText'), statuses, errors };
}

/** Read a numeric field off a row without widening anything. */
function numberField(row: Row, field: string): number | null {
  const value = row[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a string field off a row. */
function stringField(row: Row, field: string): string | null {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The ids on this host that are this trader's, with the two counts separated.
 *
 * Separated because they answer different questions: `owned` being zero and
 * `permitted` being non-zero is the signature of a prop-firm evaluation
 * account, which is precisely the case REF-126 is about.
 */
export function claimAccountIds(
  accounts: Row[],
  permissions: Row[],
  tradovateUserId: number | null
): { owned: number[]; permitted: number[]; claimed: number[]; capped: boolean } {
  if (tradovateUserId === null) {
    // Neither half of the claim can be checked, so nothing is claimed. The
    // fail-safe direction, for the reason `selectTradingAccounts` gives in
    // accounts.ts:571-581.
    return { owned: [], permitted: [], claimed: [], capped: false };
  }

  const owned: number[] = [];
  for (const account of accounts) {
    const id = numberField(account, 'id');
    if (id !== null && numberField(account, 'userId') === tradovateUserId) owned.push(id);
  }

  const permitted: number[] = [];
  for (const permission of permissions) {
    if (numberField(permission, 'userId') !== tradovateUserId) continue;
    const status = stringField(permission, 'status');
    if (status === null || !ACCEPTED_PERMISSION_STATUSES.has(status)) continue;
    const accountId = numberField(permission, 'accountId');
    if (accountId !== null) permitted.push(accountId);
  }

  // A permission on an account the trader also owns is one account, not two.
  const union = [...new Set([...owned, ...permitted])].sort((a, b) => a - b);
  return {
    owned,
    permitted,
    claimed: union.slice(0, MAX_ACCOUNT_IDS),
    capped: union.length > MAX_ACCOUNT_IDS,
  };
}

/**
 * The claimed account ids on ONE host, resolved by the two reads.
 *
 * Extracted so the Stage 4 write gate uses the SAME rule as the Stage 3 survey
 * rather than its own opinion about which accounts are the trader's. The write
 * is irreversible; it must not be guarded by a second implementation.
 *
 * Returns an empty list if either read failed — the fail-safe direction, and the
 * one that makes a failed read a refusal rather than a permission.
 */
export async function claimedIdsOnHost(options: {
  accessToken: string;
  apiUrl: string;
  userId: string;
  tradovateUserId: number | null;
}): Promise<{ claimed: number[]; accountsOk: boolean; permissionsOk: boolean }> {
  const { accessToken, apiUrl, userId, tradovateUserId } = options;
  const call = { accessToken, apiUrl, userId };

  const accountsCall = await callEndpoint('/account/list', call);
  const permissionsCall = await callEndpoint('/tradingPermission/list', call);

  if (!accountsCall.ok) {
    return { claimed: [], accountsOk: false, permissionsOk: permissionsCall.ok };
  }

  const claim = claimAccountIds(accountsCall.rows, permissionsCall.rows, tradovateUserId);
  return { claimed: claim.claimed, accountsOk: true, permissionsOk: permissionsCall.ok };
}

/** What one host's measurement looks like. */
export interface HostReport {
  step1AccountList: Omit<CallResult, 'rows'> & {
    fields: Record<string, unknown>;
    accountTypesSeen: string[];
  };
  step2TradingPermissionList: Omit<CallResult, 'rows'> & {
    fields: Record<string, unknown>;
    statusesSeen: string[];
  };
  claim: {
    tradovateUserIdKnown: boolean;
    ownedCount: number;
    permittedCount: number;
    /** The trader's own ids. See the module header on why these are emitted. */
    accountIdsAsked: number[];
    accountIdsCapped: boolean;
    note: string;
  };
  step3AccountLockoutStatus:
    | {
        asked: false;
        note: string;
      }
    | (Omit<CallResult, 'rows'> & {
        asked: true;
        fields: Record<string, unknown>;
        /** Verbatim. The documented failure strings ARE the measurement. */
        errorText: string | null;
        statuses: LockoutStatus[];
        errors: { accountId: number | null; error: string }[];
        /** Integers and booleans only — the route checks this subtree strictly. */
        measurement: {
          statusesReturned: number;
          errorsReturned: number;
          lockedCount: number;
          unlockedCount: number;
          answeredForEveryIdAsked: boolean;
        };
      });
}

/**
 * Probe one host. Never throws: every failure is recorded as an answer, which
 * is ./call.ts's contract and the whole reason a 401 on one host is a finding
 * rather than a crash.
 */
export async function probeHostTradingLock(options: {
  accessToken: string;
  apiUrl: string;
  userId: string;
  tradovateUserId: number | null;
  nowMs: number;
}): Promise<HostReport> {
  const { accessToken, apiUrl, userId, tradovateUserId, nowMs } = options;
  const call = { accessToken, apiUrl, userId };

  // Step 1 — discovery. The product's own first step on every pull.
  const accountsCall = await callEndpoint('/account/list', call);

  // Step 2 — the claim. A 404 here is the EXPECTED reply on a host with no
  // permissions, per the precedent fills.ts:815 records; ./call.ts reports it.
  const permissionsCall = await callEndpoint('/tradingPermission/list', call);

  const claim = claimAccountIds(accountsCall.rows, permissionsCall.rows, tradovateUserId);

  const report: HostReport = {
    step1AccountList: {
      ...reportOf(accountsCall),
      fields: fieldSurvey(accountsCall.rows),
      accountTypesSeen: enumValues(accountsCall.rows, 'accountType'),
    },
    step2TradingPermissionList: {
      ...reportOf(permissionsCall),
      fields: fieldSurvey(permissionsCall.rows),
      statusesSeen: enumValues(permissionsCall.rows, 'status'),
    },
    claim: {
      tradovateUserIdKnown: tradovateUserId !== null,
      ownedCount: claim.owned.length,
      permittedCount: claim.permitted.length,
      accountIdsAsked: claim.claimed,
      accountIdsCapped: claim.capped,
      note:
        tradovateUserId === null
          ? 'tradovate_user_id לא נשמר על החיבור — אי אפשר לאמת בעלות או הרשאה, ולכן לא נשאל כלום'
          : claim.permitted.length > 0 && claim.owned.length === 0
            ? 'אפס בבעלות, יש הרשאות — החתימה של חשבון eval של פירמת פרופ'
            : 'ראה ownedCount / permittedCount',
    },
    step3AccountLockoutStatus: {
      asked: false,
      note: 'לא נשאל: אין על המארח הזה אף חשבון שאומת כשל הסוחר',
    },
  };

  if (claim.claimed.length === 0) return report;

  // Step 3 — the measurement. A POST, and a read; see ./guard.ts.
  const lockoutCall = await callEndpoint('/user/accountlockoutstatus', {
    ...call,
    body: { accountIds: claim.claimed },
  });

  const { errorText, statuses, errors } = parseLockoutEnvelope(lockoutCall.rows, nowMs);
  const answeredIds = new Set(statuses.map((entry) => entry.accountId));

  report.step3AccountLockoutStatus = {
    asked: true,
    ...reportOf(lockoutCall),
    fields: fieldSurvey(lockoutCall.rows),
    errorText,
    statuses,
    errors,
    measurement: {
      statusesReturned: statuses.length,
      errorsReturned: errors.length,
      lockedCount: statuses.filter((entry) => entry.locked === true).length,
      unlockedCount: statuses.filter((entry) => entry.locked === false).length,
      answeredForEveryIdAsked: claim.claimed.every((id) => answeredIds.has(id)),
    },
  };

  return report;
}
