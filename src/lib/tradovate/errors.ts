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
