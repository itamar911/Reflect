/**
 * ============================================================================
 * PHASE 2 DIAGNOSTICS — DELETE THIS FILE WHEN THE PRODUCTION TEST HAS PASSED
 * ============================================================================
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Temporary instrumentation for the one production OAuth round trip that
 * settles the questions the documentation could not. It exists because those
 * answers are only observable once, on a real exchange, and guessing at them
 * has already produced one wrong implementation.
 *
 * What it is here to answer:
 *
 *   Q4  Does the token exchange return an `apiHosts` object? OAuthTokenResponse
 *       does not list one, and `oauthtoken` is absent from the list of
 *       responses documented to carry it, which would leave a pure-OAuth client
 *       unable to learn a dedicated-infrastructure user's hosts.
 *   Q8  Is a `refresh_token` actually issued? The REST reference lists
 *       `refresh_token` and `refresh_token_expires_in`; the OAuth guide never
 *       mentions either, and migration 017 asserts they are never issued.
 *   Q3  Does GET /v1/auth/renewaccesstoken accept an OAuth-issued token? The
 *       whole renewal design in ./connections.ts depends on it, and the OAuth
 *       guide says to re-run the flow instead, qualifying renewal as being
 *       "on the credential flow".
 *
 *
 * WHAT IS LOGGED, AND WHAT IS NOT
 * -------------------------------
 *
 * Logged: top-level field NAMES, their JSON TYPES, HTTP status codes, and
 * `expires_in` as a number. A lifetime in seconds is not a credential.
 *
 * Never logged, and never returned anywhere a logger could reach: any token,
 * any secret, the authorization code, any header, any field VALUE other than
 * the `expires_in` number. {@link describeJsonShape} cannot leak a value
 * because it never copies one — it reads `typeof` and discards the value in the
 * same expression. Everything still goes through redactSecrets() on the way out
 * regardless, because a defence that depends on my reasoning about a call graph
 * is not a defence.
 *
 *
 * TO REMOVE
 * ---------
 *   1. Delete this file.
 *   2. Delete the PHASE 2 DIAGNOSTICS blocks in
 *      src/app/api/tradovate/callback/route.ts (one block, clearly fenced).
 *   3. Delete the `diagnostics` field from ExchangedToken in ./oauth.ts and the
 *      one line in exchangeCodeForToken() that populates it.
 *   4. Delete the two exports from ./index.ts.
 *   5. npx tsc --noEmit will find anything missed.
 */

import { TradovateRequestError } from './errors';
import { redactSecrets } from './redact';
import { isPenaltyResponse } from './types';

/** Field name to JSON type. Values are never carried. */
export type JsonShape = Record<string, string>;

/**
 * Describe an object's top-level shape without retaining any value.
 *
 * `null` is reported distinctly from 'object' because a null `refresh_token`
 * and an absent one answer Q8 differently: absent means the field does not
 * exist, null means it exists and was deliberately left empty.
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

/** What one renewal probe observed. No token, no field values. */
export interface RenewalProbe {
  /** HTTP status of the renewal request. */
  status: number;
  /** Top-level field names and types from the response body. */
  shape: JsonShape;
  /** Whether the response carried an apiHosts object (dynamic-hosts support). */
  hasApiHosts: boolean;
  /** Whether the body looked like a rate-limit penalty rather than a result. */
  penalty: boolean;
  /**
   * The renewed credentials, when renewal succeeded.
   *
   * Returned so the caller can PERSIST them. The docs say renewal "returns a
   * fresh accessToken" and do not say whether the token presented stays valid
   * afterwards — so a probe that renewed and then threw the result away could
   * leave the stored token dead. Storing what came back is the safe reading.
   * This is the one piece of the diagnostics that is load-bearing; the caller
   * saves it inside the same fenced block.
   */
  renewed?: { accessToken: string; expirationTime: string };
}

/**
 * Attempt exactly one renewal with a freshly issued OAuth token.
 *
 * Deliberately NOT ./auth.ts::renewAccessToken: that function throws on
 * anything unexpected, and "what does it do when handed a delegated token" is
 * precisely the question. A throw would destroy the evidence. So this reads the
 * outcome and reports it, and never throws on a non-2xx.
 *
 * Costs one request against renewaccesstoken's budget of 15 per hour, which
 * counts all requests, not just failures. One per Phase 2 connect is fine; a
 * retry loop here would not be.
 */
export async function probeRenewal(apiUrl: string, accessToken: string): Promise<RenewalProbe> {
  const url = `${apiUrl.replace(/\/+$/, '')}/auth/renewaccesstoken`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });

  const text = await res.text();

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // The body is not JSON. Report the status and stop — the raw text is not
    // logged, because an unparsable body from an auth endpoint is exactly the
    // kind of thing that turns out to have a token in it.
    throw new TradovateRequestError('/auth/renewaccesstoken', res.status, '(unparsable body withheld)');
  }

  const shape = describeJsonShape(parsed);
  const body = (parsed ?? {}) as Record<string, unknown>;

  const probe: RenewalProbe = {
    status: res.status,
    shape,
    hasApiHosts: typeof body.apiHosts === 'object' && body.apiHosts !== null,
    penalty: isPenaltyResponse(parsed),
  };

  if (typeof body.accessToken === 'string' && typeof body.expirationTime === 'string') {
    probe.renewed = { accessToken: body.accessToken, expirationTime: body.expirationTime };
  }

  return probe;
}

/**
 * Emit one diagnostic line.
 *
 * Every caller already passes non-secret material; redactSecrets() runs anyway
 * as the backstop described in the header.
 */
export function logPhase2(label: string, detail: string): void {
  console.info(`[tradovate][phase2] ${label}: ${redactSecrets(detail)}`);
}
