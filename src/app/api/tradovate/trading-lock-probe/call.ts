/**
 * One guarded, non-fatal call to a Tradovate read endpoint.
 *
 * Two behaviours this file exists for:
 *
 *   1. **Nothing here is fatal.** The brief asks for 401/403 to be *recorded as
 *      an answer* rather than crashing the probe, and that generalises: a host
 *      the trader has no provisioning on, an entity a host does not expose, a
 *      rate-limit penalty — each is a finding about the API, which is what this
 *      route exists to collect. The spike reached the same conclusion for the
 *      same reason ("recorded, never fatal", citing the /tradingPermission/list
 *      precedent in fills.ts where a 404 is the expected reply).
 *
 *   2. **No response body ever escapes.** `TradovateRequestError` puts
 *      `body.slice(0, 300)` into its message — and for a failed `/account/list`
 *      that body is a list of the trader's account names, which is exactly the
 *      leak REF-110 §F had to fix retrospectively. So the status is kept and the
 *      message is thrown away; `withoutResponseBody` is the product-side
 *      equivalent of the same decision.
 */

import { tradovateRequest } from '@/lib/tradovate/client';
import {
  TradovateAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
} from '@/lib/tradovate/errors';

import { assertReadOnly, assertTheOneWrite, THE_ONE_WRITE } from './guard';
import type { Row } from './survey';

/** What one endpoint call is allowed to say about itself. */
export interface CallResult {
  /** HTTP status where one was observed; null when the failure was not an HTTP one. */
  status: number | null;
  ok: boolean;
  /** Rows on success, empty otherwise. Never serialised — measured, then dropped. */
  rows: Row[];
  /** How many rows came back, or null if the call did not answer. */
  count: number | null;
  /**
   * A fixed vocabulary, never a server message. See the header: an upstream
   * message can have been built from a response body.
   */
  outcome:
    | 'ok'
    | 'unauthorized'
    | 'not_found'
    | 'rate_limited'
    | 'bad_request'
    | 'server_error'
    | 'not_answered';
  /** Hebrew gloss for the owner reading this in a ticket. */
  note: string;
}

/**
 * Classify a thrown error into the fixed vocabulary above.
 *
 * Deliberately total: anything unrecognised becomes `not_answered` with no
 * detail carried over, rather than falling through to the error's own text.
 */
function classify(error: unknown): { status: number | null; outcome: CallResult['outcome']; note: string } {
  if (error instanceof TradovateAuthError) {
    return { status: 401, outcome: 'unauthorized', note: 'לא בהרשאה — הטוקן נדחה על המארח הזה' };
  }
  if (error instanceof TradovatePenaltyError) {
    return { status: 429, outcome: 'rate_limited', note: 'הוגבל קצב — לא נמדד, יש להמתין' };
  }
  if (error instanceof TradovateRequestError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return { status, outcome: 'unauthorized', note: 'לא בהרשאה — אין הרשאה לישות הזו על המארח הזה' };
    }
    if (status === 404) {
      return { status, outcome: 'not_found', note: 'הישות לא קיימת על המארח הזה' };
    }
    if (status === 429) {
      return { status, outcome: 'rate_limited', note: 'הוגבל קצב — לא נמדד, יש להמתין' };
    }
    if (status >= 500) {
      return { status, outcome: 'server_error', note: 'שגיאת שרת אצל הברוקר' };
    }
    return { status, outcome: 'bad_request', note: 'הבקשה נדחתה' };
  }
  return { status: null, outcome: 'not_answered', note: 'הקריאה לא הושלמה' };
}

/**
 * Call one endpoint. Guarded, non-fatal, and body-free on failure.
 *
 * `method` defaults to GET. The one POST this probe makes —
 * `/user/accountlockoutstatus` — passes `body`, and is a read; see the note in
 * ./guard.ts before adding a second, and note that the VERB is not the reason
 * it is treated as one.
 *
 * `userId` IS REQUIRED, AND IS NEW SINCE THE REF-113 PROBE. REF-112 made it
 * part of `UserTokenRequestOptions` (`src/lib/tradovate/client.ts:112-124`): a
 * user's token must travel with the host it is addressed to AND with whose it
 * is. The REF-113 version of this file predates that and no longer type-checks.
 * The id reaches ./call-meter.ts and nothing else — it is never sent upstream.
 */
export async function callEndpoint(
  path: string,
  options: {
    accessToken: string;
    apiUrl: string;
    userId: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
  }
): Promise<CallResult> {
  assertReadOnly(path);

  try {
    const payload = await tradovateRequest<unknown>(path, {
      accessToken: options.accessToken,
      apiUrl: options.apiUrl,
      userId: options.userId,
      query: options.query,
      body: options.body,
      method: options.body ? 'POST' : 'GET',
    });

    // A list endpoint answers with an array; `/user/accountlockoutstatus`
    // answers with one `{ statuses, errors }` envelope. Both are normalised to
    // rows so the survey has one input shape — ./tradingLock.ts unwraps the
    // envelope from `rows[0]`.
    const rows: Row[] = Array.isArray(payload)
      ? (payload as Row[])
      : payload && typeof payload === 'object'
        ? [payload as Row]
        : [];

    return { status: 200, ok: true, rows, count: rows.length, outcome: 'ok', note: 'נמדד' };
  } catch (error) {
    const { status, outcome, note } = classify(error);
    return { status, ok: false, rows: [], count: null, outcome, note };
  }
}

/** The part of a {@link CallResult} that is safe to serialise. */
export function reportOf(result: CallResult): Omit<CallResult, 'rows'> {
  const { rows: _rows, ...rest } = result;
  void _rows;
  return rest;
}

/**
 * THE ONE WRITE (REF-126 Stage 4). A separate function on purpose.
 *
 * {@link callEndpoint} can only reach `assertReadOnly`, so no amount of editing
 * a path string there can produce a write. This is the only function in the
 * repository that can reach `assertTheOneWrite`, and it accepts no `path`
 * argument at all — the endpoint is {@link THE_ONE_WRITE} and the body is
 * `{ accountId, durationMinutes }` with nothing else expressible.
 *
 * `durationMinutes` IS NOT A PARAMETER. REF-126 Stage 4 requires it hardcoded
 * to 1, and it is — see {@link DURATION_MINUTES}. A caller cannot ask for an
 * hour by passing a number, because there is nowhere to pass one.
 *
 * NO RETRY, EVER. Stage 4 item 5 says one call, and the documented failure
 * "Account {id} already has an active lockout for user {userId}. New lockout
 * requests are not permitted until the existing lockout expires." is the reason
 * it matters: a retry after an apparent failure could be a retry after a
 * SUCCESS, and the second attempt would then report a false negative about a
 * lock that is really in place. One call, whatever happens.
 *
 * THE RESPONSE IS RETURNED RAW, and that is deliberate: the caller must read
 * `errorText` rather than `ok`, because Tradovate answers a failure with HTTP
 * 200 and an `errorText` field (`src/lib/tradovate/types.ts:86-87`). A helper
 * that collapsed this to a boolean would be the bug.
 */
export const DURATION_MINUTES = 1;

export interface WriteResult {
  status: number | null;
  /** Whether the HTTP call completed — NOT whether the lockout was created. */
  completed: boolean;
  /** The upstream body, verbatim. `null` when the call did not complete. */
  response: unknown;
  outcome: CallResult['outcome'];
  note: string;
}

export async function callTheOneWrite(options: {
  accessToken: string;
  apiUrl: string;
  userId: string;
  accountId: number;
}): Promise<WriteResult> {
  assertTheOneWrite(THE_ONE_WRITE);

  try {
    const response = await tradovateRequest<unknown>(THE_ONE_WRITE, {
      accessToken: options.accessToken,
      apiUrl: options.apiUrl,
      userId: options.userId,
      body: { accountId: options.accountId, durationMinutes: DURATION_MINUTES },
      method: 'POST',
    });
    return { status: 200, completed: true, response, outcome: 'ok', note: 'הקריאה הושלמה — יש לקרוא errorText' };
  } catch (error) {
    const { status, outcome, note } = classify(error);
    // NOTE THE HONEST GAP: a call that threw may still have been APPLIED
    // upstream. A 500 or a dropped connection after Tradovate committed the
    // lockout looks identical here to one that never reached it. That is why
    // the handler re-reads the status afterwards instead of inferring it, and
    // why there is no retry.
    return { status, completed: false, response: null, outcome, note };
  }
}
