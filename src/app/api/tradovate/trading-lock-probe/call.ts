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

import { assertReadOnly } from './guard';
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
