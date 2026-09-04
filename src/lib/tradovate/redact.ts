/**
 * Secret redaction for anything that might be logged or thrown.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * The OAuth endpoints make this necessary rather than merely tidy. Existing
 * errors carry the raw response body (see TradovateRequestError, which puts
 * `body.slice(0, 300)` in its message), and the body of a successful token
 * exchange *is* the access token. A failed exchange echoes the authorization
 * code back in `error_description`. Both would end up in Vercel's logs through
 * an ordinary `throw`.
 *
 * So: every OAuth response body passes through {@link redactSecrets} before it
 * reaches an Error, and nothing in this integration logs a token, an
 * authorization code, or the encryption key — redacted or otherwise.
 */

const PLACEHOLDER = '[redacted]';

/**
 * Secret-bearing field names, matched case-insensitively.
 *
 * `code` is in here because an OAuth authorization code is single-use but not
 * harmless: until it is exchanged or expires, anyone holding it plus the client
 * secret can mint a token.
 */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'accessToken',
  'refreshToken',
  'mdAccessToken',
  'id_token',
  'client_secret',
  'clientSecret',
  'password',
  'sec',
  'code',
];

const keyGroup = SECRET_KEYS.join('|');

/** `"access_token": "…"` and `'access_token':'…'` in JSON. */
const JSON_PATTERN = new RegExp(
  `(["'](?:${keyGroup})["']\\s*:\\s*)(["'])(?:\\\\.|(?!\\2).)*\\2`,
  'gi'
);

/** `access_token=…` in a form body or query string. */
const FORM_PATTERN = new RegExp(`\\b(${keyGroup})=([^&\\s"']+)`, 'gi');

/** `Authorization: Bearer …`, however it has been stringified. */
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Replace anything that looks like a credential with `[redacted]`.
 *
 * Deliberately over-eager: a redacted field that turned out to be harmless costs
 * nothing, while one missed token in a log is a real incident. Use it on any
 * upstream response body before putting it in an error, and on any string headed
 * for a log that came from outside this process.
 */
export function redactSecrets(input: string, extraSecrets: readonly (string | undefined)[] = []): string {
  if (!input) return input;

  let out = input
    .replace(JSON_PATTERN, `$1$2${PLACEHOLDER}$2`)
    .replace(FORM_PATTERN, `$1=${PLACEHOLDER}`)
    .replace(BEARER_PATTERN, `$1${PLACEHOLDER}`);

  // Last line of defence: known secret values matched literally, for the shapes
  // the patterns above do not model. `extraSecrets` is how a caller adds one it
  // holds in a variable — notably the authorization code, which Tradovate echoes
  // back inside free-form `error_description` prose where no key=value pattern
  // can find it. Short values are skipped: a two-character secret would turn the
  // whole message into placeholders and tell us nothing.
  for (const value of [
    ...extraSecrets,
    process.env.TRADOVATE_OAUTH_CLIENT_SECRET,
    process.env.TRADOVATE_TOKEN_ENCRYPTION_KEY,
    process.env.TRADOVATE_SEC,
    process.env.TRADOVATE_PASSWORD,
  ]) {
    const trimmed = value?.trim();
    if (trimmed && trimmed.length >= 8) out = out.split(trimmed).join(PLACEHOLDER);
  }

  return out;
}

/**
 * A URL safe to put in an error or a log: query values for secret-bearing
 * parameters are replaced, everything else is left readable.
 *
 * The authorization URL carries `client_id` (public) and the callback carries
 * `code` (not public), so neither can be logged whole.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_KEYS.some((secret) => secret.toLowerCase() === key.toLowerCase())) {
        parsed.searchParams.set(key, PLACEHOLDER);
      }
    }
    return parsed.toString();
  } catch {
    return redactSecrets(url);
  }
}
