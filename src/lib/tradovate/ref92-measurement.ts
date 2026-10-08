/**
 * ===========================================================================
 * REF-92 MEASUREMENT — DELETE THIS FILE ONCE THE ANSWER IS RECORDED
 * ===========================================================================
 *
 * SERVER ONLY — see ./config.ts.
 *
 * One production connect, to settle one question: does POST /auth/oauthtoken
 * return an `apiHosts` object, and if it does, what do its values actually look
 * like? Option 4 of REF-92 — read the hosts from the exchange, fall back to a
 * renewal — is designed on the answer, so the answer is measured first.
 *
 *
 * WHY THIS IS NOT ALREADY KNOWN
 * -----------------------------
 *
 * The two documents disagree about which response carries the object:
 *
 *   - api.tradovate.com, named by NinjaTrader in writing on 25 Sep as the
 *     source of truth for all Tradovate API and OAuth matters, documents
 *     `apiHosts` on OAuthTokenResponse — the 200 of POST /auth/oauthtoken —
 *     and references its ApiHosts schema from nowhere else in the entire
 *     document. On that reading the exchange is the one place a client is meant
 *     to learn its hosts. (That page renders client-side; the OpenAPI document
 *     is embedded in its JavaScript bundle rather than served as a file.)
 *   - https://docs.ninjatrader.com/api/dynamic-api-hosts lists the carriers as
 *     accessTokenRequest, the social login token request, renewAccessToken,
 *     modifyCredentials, modifyPassword and setSocialCredentials.
 *     /auth/oauthtoken is not in that list, and the OAuth guide never mentions
 *     apiHosts at all.
 *
 * The Phase 2 fence did observe this once. It logged the raw body's top-level
 * field names through its own describeJsonShape() and recorded no apiHosts on
 * 1 Oct (commit 5808e1e, Q4) — so the claim in hosts.ts was observed, not
 * inferred from the empty column. Three things that run did not settle, and
 * this one does:
 *
 *   1. It logged no host VALUES, only names and types. Whether a value is a
 *      bare hostname or carries a scheme, a port or a path decides how the URL
 *      builder is written, and api.tradovate.com states nothing about it: the
 *      schema is `{type: "string", maxLength: 64}` with no description, format,
 *      pattern or example. Only the NinjaTrader page claims "a bare hostname
 *      with no scheme" — and that is the page already contradicted on which
 *      response carries the object.
 *   2. It never looked at GET /auth/me, which every connect calls anyway. The
 *      spec enumerates OAuthMeResponse without apiHosts, but the same spec
 *      omits it from AccessTokenResponse too and production proved that wrong
 *      for renewal, so the schema's silence is weak evidence either way.
 *   3. There is no standing signal. `exchangeCodeForToken` casts the parsed
 *      body to OAuthTokenResponse, an interface with no apiHosts field, and
 *      logs nothing. If the exchange began returning hosts tomorrow the
 *      shipped code would drop them without a trace — which is also why the
 *      1 Oct result cannot simply be assumed to still hold.
 *
 *
 * WHAT IS LOGGED, AND WHAT IS NOT
 * -------------------------------
 *
 * Names only, from two bodies:
 *
 *   - The raw POST /auth/oauthtoken body: top-level field NAMES and JSON types.
 *   - The raw GET /auth/me body: top-level field NAMES and JSON types. Names
 *     only is not a style choice there — that body carries the user's email
 *     address, full name and organization.
 *
 * Values, from one object and one object only:
 *
 *   - `apiHosts`, in full, keys and values. Hostnames are not credentials and
 *     seeing them is the entire point. {@link formatApiHosts} is the only
 *     function here that prints a value, it is only ever handed that object,
 *     and it prints a value only when it is a string — an unexpected nested
 *     object is reported by type, because this is not the place to find out
 *     what else a response might be carrying.
 *
 * Never logged, by construction rather than by care: any token, the
 * authorization code, any secret, any header, any other field value.
 * {@link describeJsonShape} cannot leak one because it never copies one — it
 * reads `typeof` and discards the value in the same expression. {@link
 * pickApiHosts} is what keeps a token out of the one value-printing path: what
 * the exchange hands back to the caller is the shape plus the apiHosts object,
 * never the body they came from. Every line still goes out through
 * redactSecrets(), because a defence resting on my reading of a call graph is
 * not a defence.
 *
 * Reachable only by an allowlisted user: the callback's allowlist gate returns
 * for everyone else long before the exchange happens.
 *
 *
 * TO REMOVE
 * ---------
 *   1. Delete this file.
 *   2. Delete the REF-92 MEASUREMENT block in
 *      src/app/api/tradovate/callback/route.ts — one fenced block plus its
 *      import.
 *   3. Delete the `measurement` field from ExchangedToken in ./oauth.ts, the
 *      import there, and the one line in exchangeCodeForToken() that fills it.
 *   4. Nothing in ./index.ts: both consumers import this module directly, so
 *      the barrel never learned about it.
 *   5. `npx tsc --noEmit` will find anything missed.
 */

import { redactSecrets } from './redact';

/** Field name to JSON type. Values are never carried. */
export type JsonShape = Record<string, string>;

/** Longest value {@link formatApiHosts} prints before truncating it. */
const MAX_VALUE_CHARS = 120;

/**
 * Describe an object's top-level shape without retaining any value.
 *
 * `null` is reported distinctly from 'object' because an absent field and a
 * field explicitly set to null are different answers: absent means the server
 * does not send it, null means it does and left it empty.
 *
 * Carried over verbatim from the Phase 2 fence, deliberately. It is the same
 * question asked of the same endpoint, and a reimplementation would make the
 * two runs' output incomparable.
 */
export function describeJsonShape(value: unknown): JsonShape {
  if (typeof value !== 'object' || value === null) return {};

  const shape: JsonShape = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) shape[key] = 'null';
    else if (Array.isArray(entry)) shape[key] = `array[${entry.length}]`;
    else shape[key] = typeof entry;
  }
  return shape;
}

/** Render a shape for a log line: "access_token:string, expires_in:number". */
export function formatShape(shape: JsonShape): string {
  const entries = Object.entries(shape);
  if (entries.length === 0) return '(no fields)';
  return entries.map(([name, type]) => `${name}:${type}`).join(', ');
}

/**
 * Lift just the `apiHosts` object out of a parsed response body.
 *
 * The narrow waist between a response and the one function allowed to print
 * values: a caller hands the whole body in and gets back either an object that
 * can only be hostnames, or undefined. No later step can be handed a token by
 * accident, however the call graph is rearranged.
 *
 * Returns undefined for a missing field, for an explicit null, and for a field
 * that is present but not an object. All three mean "no hosts here", and the
 * shape line already tells those cases apart.
 */
export function pickApiHosts(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const hosts = (body as Record<string, unknown>).apiHosts;
  if (typeof hosts !== 'object' || hosts === null || Array.isArray(hosts)) return undefined;
  return hosts as Record<string, unknown>;
}

/**
 * Render an apiHosts object in full: "live: live.tradovateapi.com, demo: ...".
 *
 * THE ONE PLACE A VALUE IS PRINTED. Keys and string values go out verbatim,
 * because the question is whether a value carries a scheme, a port or a path,
 * and a normalised rendering would answer it by erasing it. Separated with
 * ": " rather than "=" so the line cannot collide with redactSecrets()'s
 * `key=value` form-body pattern and come back partly placeholdered.
 *
 * A non-string value is reported by type and not printed. The documented shape
 * is seven required strings plus a handful of optional ones; anything else is
 * an unknown this measurement is not chartered to read aloud.
 */
export function formatApiHosts(hosts: Record<string, unknown>): string {
  const entries = Object.entries(hosts);
  if (entries.length === 0) return '(empty object)';

  return entries
    .map(([key, value]) => {
      if (typeof value !== 'string') {
        const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        return `${key}: <${kind}, not printed>`;
      }
      const shown =
        value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...(truncated)` : value;
      return `${key}: ${shown}`;
    })
    .join(', ');
}

/**
 * Emit one measurement line.
 *
 * Every caller already passes non-secret material; redactSecrets() runs anyway
 * as the backstop described in the header. console.info rather than warn or
 * error: this is an expected observation, not a fault, and it should not colour
 * a Vercel log red or trip anything watching for errors.
 */
export function logRef92(label: string, detail: string): void {
  console.info(`[tradovate][ref92] ${label}: ${redactSecrets(detail)}`);
}
