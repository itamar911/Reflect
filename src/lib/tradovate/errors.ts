/**
 * Error types for the Tradovate integration.
 *
 * These exist so callers can distinguish "wait and retry later" from "your
 * credentials are wrong" from "the server is unhappy" without string-matching
 * on messages.
 */

/** Base class so callers can `catch (e) { if (e instanceof TradovateError) … }`. */
export class TradovateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TradovateError';
  }
}

/** Configuration is missing or malformed; nothing was sent. */
export class TradovateConfigError extends TradovateError {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'TradovateConfigError';
    this.missing = missing;
  }
}

/**
 * Tradovate accepted the request but rejected the credentials. The HTTP status
 * for this is 200 with an `errorText` field, not a 401.
 */
export class TradovateAuthError extends TradovateError {
  readonly errorText: string;

  constructor(errorText: string) {
    super(`Tradovate rejected the credentials: ${errorText}`);
    this.name = 'TradovateAuthError';
    this.errorText = errorText;
  }
}

/**
 * A time penalty was returned and we exhausted our retry budget, or the penalty
 * was a captcha challenge that a third-party application cannot satisfy.
 */
export class TradovatePenaltyError extends TradovateError {
  /** Seconds Tradovate asked us to wait, when it told us. */
  readonly retryAfterSeconds?: number;
  /** True when Tradovate demanded a captcha — wait roughly an hour. */
  readonly captcha: boolean;

  constructor(message: string, opts: { retryAfterSeconds?: number; captcha?: boolean } = {}) {
    super(message);
    this.name = 'TradovatePenaltyError';
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.captcha = opts.captcha ?? false;
  }
}

/** Non-2xx HTTP response, or a body we could not parse. */
export class TradovateRequestError extends TradovateError {
  readonly status: number;
  readonly path: string;
  readonly body: string;

  constructor(path: string, status: number, body: string) {
    super(`Tradovate ${path} failed with HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'TradovateRequestError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

/**
 * The same failure, with the response body dropped (REF-110 Stage 1).
 *
 * WHAT THIS IS FOR. {@link TradovateRequestError} puts `body.slice(0, 300)` in
 * its message, which is right for almost every endpoint in this integration:
 * an error body naming a contract id or a malformed parameter is the only thing
 * that makes a 400 diagnosable. It is wrong for exactly the reads whose body is
 * the TRADER'S OWN DATA, and `/account/list` is the first of them — its body is
 * a list of the trader's account names, and a prop firm's name is in them.
 *
 * So a caller that knows what a body holds reduces the error AT THE CALL SITE,
 * before it travels: the status, the path and the type survive, which is
 * everything the classifiers and the retry logic read, and the 300 characters
 * of account names do not.
 *
 * ONLY `TradovateRequestError` IS REDUCED, and everything else is returned
 * untouched. A `TradovatePenaltyError` carries no body, a network fault carries
 * no body, and a programming error must not be laundered into something that
 * looks like an upstream failure. Returns rather than throws, so the call site
 * reads `throw withoutResponseBody(error)` and the control flow stays visible
 * where it is.
 *
 * `body` becomes the empty string rather than a placeholder: the field is
 * declared and readable, and a placeholder would be a value a reader might
 * try to parse.
 */
export function withoutResponseBody(error: unknown): unknown {
  if (!(error instanceof TradovateRequestError)) return error;
  return new TradovateRequestError(error.path, error.status, '');
}

/**
 * The OAuth flow failed in a way that is about the flow itself rather than the
 * transport: a state mismatch, a missing code, or an `error` field in the token
 * response.
 *
 * `oauthError` carries Tradovate's own machine-readable code (`access_denied`,
 * `invalid_grant`, …) when it gave one, so a route can branch on it — notably to
 * treat `access_denied` as the user simply declining, not a failure.
 *
 * The message is expected to have been through redactSecrets() already; nothing
 * here re-reads a response body.
 */
export class TradovateOAuthError extends TradovateError {
  /** Tradovate's `error` field, when present. */
  readonly oauthError?: string;
  /** The stage that failed, for triage without exposing values. */
  readonly stage: 'authorize' | 'state' | 'exchange' | 'identify' | 'revoke';

  constructor(
    message: string,
    opts: { stage: TradovateOAuthError['stage']; oauthError?: string } = { stage: 'exchange' }
  ) {
    super(message);
    this.name = 'TradovateOAuthError';
    this.stage = opts.stage;
    this.oauthError = opts.oauthError;
  }
}

/**
 * The operation failed for a reason that is expected to pass on its own: a rate
 * limit, a network fault, a 5xx, or an answer we could not make sense of.
 *
 * The point of this type is what it tells a caller NOT to do. It means the
 * stored credential was never judged — so nothing should be marked expired,
 * nothing should be written to the database, and the user must not be told to
 * reconnect. Retry later instead.
 *
 * Contrast TradovateNotConnectedError, which is the opposite claim: the
 * credential was presented and refused. Collapsing the two is REF-101 — a
 * per-IP rate limit on /auth/renewaccesstoken was turning live connections into
 * permanently dead rows.
 *
 * `reason` is for triage and for mapping to `rule_context_source`; all four
 * values belong to `broker_unavailable`, never `broker_expired`.
 *
 * Carries no `cause`. An upstream failure can hold the response body, and on
 * these endpoints the body can be a token.
 */
export class TradovateTransientError extends TradovateError {
  readonly reason: 'penalty' | 'network' | 'server' | 'unknown';
  /** Seconds to wait, when the upstream told us. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: { reason: TradovateTransientError['reason']; retryAfterSeconds?: number }
  ) {
    super(message);
    this.name = 'TradovateTransientError';
    this.reason = opts.reason;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/**
 * Tradovate answered, and the answer cannot be stated in the unit the rules
 * compare against (REF-90).
 *
 * Three things can cause it, and all three mean the same thing: a round trip
 * this user closed today cannot be turned into a dollar figure. A product with
 * no `valuePerPoint` leaves a number of POINTS, which is the unit bug
 * lib/rules/tradeRuleContext.ts records having already shipped once. A product
 * denominated in anything but US dollars cannot be added to a total REF-99
 * made dollars-only. A fill pair whose legs are missing from /fill/list cannot
 * even be dated.
 *
 * WHY THIS IS AN ERROR RATHER THAN A SKIP. Dropping the trade we cannot price
 * and totalling the rest would under-report a real loss, and under-reporting is
 * the failure that lifts a block the trader set for themselves — silently, with
 * a panel saying the figures came from the broker. Refusing the whole pull falls
 * back to Reflect's own data and says so on screen, which is wrong in the
 * direction a discipline tool can afford.
 *
 * Mapped to `broker_unavailable`. That value means "the fetch did not produce
 * usable figures", which is exactly what happened; it does not claim the cause
 * was transient, and this one is not — a non-USD account stays non-USD. The
 * reason is logged, through redactSecrets() like every other diagnostic here.
 */
export class TradovateUnpriceableError extends TradovateError {
  readonly reason: 'no_value_per_point' | 'foreign_currency' | 'unknown_currency' | 'missing_fill';

  constructor(message: string, reason: TradovateUnpriceableError['reason']) {
    super(message);
    this.name = 'TradovateUnpriceableError';
    this.reason = reason;
  }
}

/**
 * A user has no usable Tradovate connection: never connected, disconnected, or
 * the token lapsed with nothing in ./connections.ts able to recover it (a
 * refresh token may be stored, but nothing redeems one).
 *
 * Distinct from TradovateAuthError because the remedy is different — this one is
 * fixed by the user reconnecting, not by correcting server configuration.
 *
 * Throw this only on evidence that the credential itself was refused. When the
 * renewal merely failed to complete, that is TradovateTransientError.
 */
export class TradovateNotConnectedError extends TradovateError {
  readonly userId: string;
  readonly status: 'missing' | 'expired' | 'revoked';

  constructor(userId: string, status: TradovateNotConnectedError['status']) {
    super(`No usable Tradovate connection for this user (${status}). They need to reconnect.`);
    this.name = 'TradovateNotConnectedError';
    this.userId = userId;
    this.status = status;
  }
}
