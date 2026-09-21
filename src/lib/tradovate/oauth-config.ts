/**
 * OAuth client configuration.
 *
 * SERVER ONLY — see ./config.ts, whose report-don't-throw contract this follows
 * exactly: nothing here throws on missing configuration, callers get a result
 * object and decide how to report it, and describeConfigError() renders it.
 *
 * Separate from loadConfig() because the two are used by different deployments.
 * loadConfig() covers the password grant Reflect uses for its own API access and
 * demands TRADOVATE_USERNAME/PASSWORD; the OAuth flow connects an *end user's*
 * account and needs none of them. Requiring both sets would force an
 * OAuth-only deployment to invent a password it never uses.
 *
 * Endpoint URLs are LOOKED UP per environment, not derived, with escape
 * hatches. See ./hosts.ts for the documented values and the citation for each.
 *
 * This used to derive the token URL as `<origin of TRADOVATE_API_URL>/auth/
 * oauthtoken`. That happens to be right for Live and is wrong for Demo, which
 * exchanges against a different domain than it trades on — the derivation
 * produced https://demo.tradovateapi.com/auth/oauthtoken, a URL that appears in
 * neither official page. The dynamic-hosts documentation names this exact
 * mistake ("Assumes the Demo and Live hosts share a domain, or derives one host
 * from the other") as a thing that breaks clients, so the environment is now
 * identified explicitly and the hosts read from a table.
 *
 * TRADOVATE_OAUTH_AUTHORIZE_URL and TRADOVATE_OAUTH_TOKEN_URL remain as
 * overrides for a Tradovate environment this table does not know about.
 */

import { type ConfigFailure } from './config';
import {
  AUTHORIZE_URLS,
  LIVE_API_URL,
  TOKEN_URLS,
  detectEnvironment,
  type TradovateEnvironment,
} from './hosts';
import { isEncryptionKeyValid } from './token-crypto';

/** Variables the OAuth flow requires. */
export const TRADOVATE_OAUTH_ENV_VARS = [
  'TRADOVATE_API_URL',
  'TRADOVATE_OAUTH_CLIENT_ID',
  'TRADOVATE_OAUTH_CLIENT_SECRET',
  'TRADOVATE_OAUTH_REDIRECT_URI',
  'TRADOVATE_TOKEN_ENCRYPTION_KEY',
] as const;

/** Optional overrides, only needed against a non-standard Tradovate environment. */
export const TRADOVATE_OAUTH_OPTIONAL_ENV_VARS = [
  'TRADOVATE_OAUTH_AUTHORIZE_URL',
  'TRADOVATE_OAUTH_TOKEN_URL',
] as const;

export type TradovateOAuthEnvVar =
  | (typeof TRADOVATE_OAUTH_ENV_VARS)[number]
  | (typeof TRADOVATE_OAUTH_OPTIONAL_ENV_VARS)[number];

export interface TradovateOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the redirect URI registered with Tradovate, byte for byte. */
  redirectUri: string;
  /** Where the user is sent to approve the connection. */
  authorizeUrl: string;
  /** Where the authorization code is exchanged for a token. */
  tokenUrl: string;
  /**
   * Trading REST base including /v1, for this connection's environment. Used
   * for /auth/renewaccesstoken. NOT for /auth/me — see liveApiUrl.
   */
  apiUrl: string;
  /**
   * REST base for the Live-only endpoints, chiefly GET /v1/auth/me. Equal to
   * apiUrl when the environment is live; the Live host regardless when it is
   * demo. See the citation on LIVE_API_URL in ./hosts.ts.
   */
  liveApiUrl: string;
  /**
   * Which Tradovate environment this configuration targets. Recorded on every
   * saved connection so a demo token is never mistaken for a live one.
   */
  environment: TradovateEnvironment;
}

export type OAuthConfigResult =
  | { ok: true; config: TradovateOAuthConfig }
  | ConfigFailure<TradovateOAuthEnvVar>;

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/tradovate/oauth-config is server-only: it reads ' +
        'TRADOVATE_OAUTH_CLIENT_SECRET and TRADOVATE_TOKEN_ENCRYPTION_KEY from the ' +
        'environment and must never be bundled into client code.'
    );
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Read and validate the OAuth configuration.
 *
 * Reports every problem at once rather than failing on the first, so a
 * half-configured deployment produces one actionable message.
 */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfigResult {
  assertServerOnly();

  const missing: TradovateOAuthEnvVar[] = [];
  const invalid: { name: TradovateOAuthEnvVar; reason: string }[] = [];

  for (const name of TRADOVATE_OAUTH_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') missing.push(name);
  }

  const rawApiUrl = env.TRADOVATE_API_URL?.trim();
  const apiUrl = rawApiUrl ? parseUrl(rawApiUrl) : null;
  if (rawApiUrl && !apiUrl) {
    invalid.push({ name: 'TRADOVATE_API_URL', reason: `not a valid URL: ${JSON.stringify(rawApiUrl)}` });
  }

  // The environment decides the authorize and token hosts, and is recorded on
  // the stored connection. An unrecognised host is a configuration error rather
  // than a default: guessing wrong means minting a token against one server and
  // filing it as though it belonged to the other. Dedicated-infrastructure
  // hosts land here, which is Q4 in the plan — a pure-OAuth client has no
  // documented way to discover them before the first renewal.
  const environment = apiUrl ? detectEnvironment(apiUrl.toString()) : null;
  if (apiUrl && !environment) {
    invalid.push({
      name: 'TRADOVATE_API_URL',
      reason:
        `host ${JSON.stringify(apiUrl.hostname)} is not a known Tradovate environment — ` +
        'expected demo.tradovateapi.com or live.tradovateapi.com',
    });
  }

  // The redirect URI is compared byte for byte by Tradovate at both the
  // authorize and exchange steps, and a relative or mistyped value fails there
  // with an opaque error. Catch it here instead, where we can name the variable.
  const rawRedirect = env.TRADOVATE_OAUTH_REDIRECT_URI?.trim();
  const redirect = rawRedirect ? parseUrl(rawRedirect) : null;
  if (rawRedirect && !redirect) {
    invalid.push({
      name: 'TRADOVATE_OAUTH_REDIRECT_URI',
      reason: `not an absolute URL: ${JSON.stringify(rawRedirect)}`,
    });
  } else if (redirect && redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') {
    // The authorization code arrives on this URL. Over plain HTTP anywhere but a
    // developer's own machine it is readable in transit.
    invalid.push({
      name: 'TRADOVATE_OAUTH_REDIRECT_URI',
      reason: 'must use https (http is allowed only for localhost during development)',
    });
  }

  // Validated here, not at first use: a bad key would otherwise surface as a
  // failed decryption long after the tokens were written.
  if (env.TRADOVATE_TOKEN_ENCRYPTION_KEY?.trim() && !isEncryptionKeyValid(env)) {
    invalid.push({
      name: 'TRADOVATE_TOKEN_ENCRYPTION_KEY',
      reason: 'must decode to 32 bytes — 64 hex characters, or 32 bytes of base64',
    });
  }

  for (const name of TRADOVATE_OAUTH_OPTIONAL_ENV_VARS) {
    const raw = env[name]?.trim();
    if (raw && !parseUrl(raw)) invalid.push({ name, reason: `not a valid URL: ${JSON.stringify(raw)}` });
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };

  return {
    ok: true,
    config: {
      clientId: env.TRADOVATE_OAUTH_CLIENT_ID!.trim(),
      // Not trimmed: a secret is opaque and may legitimately end in whitespace.
      clientSecret: env.TRADOVATE_OAUTH_CLIENT_SECRET!,
      redirectUri: rawRedirect!,
      authorizeUrl: env.TRADOVATE_OAUTH_AUTHORIZE_URL?.trim() || AUTHORIZE_URLS[environment!],
      tokenUrl: env.TRADOVATE_OAUTH_TOKEN_URL?.trim() || TOKEN_URLS[environment!],
      apiUrl: rawApiUrl!.replace(/\/+$/, ''),
      liveApiUrl: environment === 'live' ? rawApiUrl!.replace(/\/+$/, '') : LIVE_API_URL,
      environment: environment!,
    },
  };
}
