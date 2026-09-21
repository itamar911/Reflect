/**
 * Verify the Tradovate OAuth configuration.
 *
 *   npm run tradovate:check
 *
 * Answers one question: is this deployment configured well enough for the OAuth
 * flow to run? It makes no network request, opens no Tradovate session, and
 * touches no database — so it can be run anywhere, any number of times, and it
 * cannot burn a rate limit or evict one of the user's two concurrent sessions.
 *
 * It does NOT touch Supabase. Per CLAUDE.md, a script that reaches Supabase has
 * to be added by name to the deny list in .claude/settings.json, because those
 * rules are enumerated rather than a catch-all. This one does not, so it needs
 * no deny rule. Keep it that way: if this ever grows a database check, it must
 * be added to that list in the same change.
 *
 *
 * NO VALUE IS EVER PRINTED
 * ------------------------
 *
 * Not in full, not truncated, not fingerprinted. The predecessor script
 * (scripts/tradovate-verify.ts) printed the first six characters of a live
 * access token, on the reasoning that the output gets pasted into chats. That
 * reasoning is the argument against doing it, not for it.
 *
 * What is printed: a PASS/FAIL per variable, a character count, and derived
 * facts that are constants from the documentation rather than secrets — the
 * authorize and token URLs, and which environment TRADOVATE_API_URL selects.
 *
 * The single exception is opt-in. TRADOVATE_OAUTH_REDIRECT_URI is a public
 * value, registered with Tradovate and visible in the browser's address bar
 * during every connection, and a byte-level mismatch between it and the
 * registered value is the most common way this flow fails — the documented
 * result is `invalid_grant`, which says nothing about which of the two sides is
 * wrong. So `--print-redirect-uri` prints it, and it is off by default.
 *
 * Exit codes: 0 configured, 2 not configured. There is no 1 — nothing here can
 * fail at runtime, only be absent or malformed.
 */

import {
  AUTHORIZE_URLS,
  LIVE_API_URL,
  TOKEN_URLS,
  TOKEN_URLS_ALTERNATIVE,
  TOKEN_URL_SOURCE,
  detectEnvironment,
} from '../src/lib/tradovate/hosts';
import {
  isAllowlistConfigured,
  parseAllowlist,
  TRADOVATE_ALLOWLIST_ENV_VAR,
} from '../src/lib/tradovate/allowlist';
import { isEncryptionKeyValid } from '../src/lib/tradovate/token-crypto';

const EXIT_OK = 0;
const EXIT_CONFIG = 2;

const SHOW_REDIRECT = process.argv.includes('--print-redirect-uri');

let failures = 0;
let warnings = 0;

function pass(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? `  — ${detail}` : ''}`);
}

function fail(label: string, detail = ''): void {
  failures++;
  console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
}

function warn(label: string, detail = ''): void {
  warnings++;
  console.log(`  WARN  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Character count, never content. */
function lengthOf(value: string): string {
  return `${value.length} characters`;
}

function checkClientId(): void {
  const raw = process.env.TRADOVATE_OAUTH_CLIENT_ID;
  if (!raw || raw.trim() === '') {
    fail('TRADOVATE_OAUTH_CLIENT_ID', 'missing or empty');
    return;
  }
  if (raw !== raw.trim()) {
    warn('TRADOVATE_OAUTH_CLIENT_ID', 'has leading or trailing whitespace; it will be trimmed');
  }
  pass('TRADOVATE_OAUTH_CLIENT_ID', lengthOf(raw.trim()));
}

function checkClientSecret(): void {
  const raw = process.env.TRADOVATE_OAUTH_CLIENT_SECRET;
  if (!raw || raw.trim() === '') {
    fail('TRADOVATE_OAUTH_CLIENT_SECRET', 'missing or empty');
    return;
  }
  // Not trimmed by loadOAuthConfig(): a secret is opaque and may legitimately
  // end in whitespace. Far more often it is a paste artefact, so say so and let
  // the owner decide — this is the one case where the check cannot be certain.
  if (raw !== raw.trim()) {
    warn(
      'TRADOVATE_OAUTH_CLIENT_SECRET',
      'has leading or trailing whitespace, which is sent as-is — verify it is intentional'
    );
  }
  pass('TRADOVATE_OAUTH_CLIENT_SECRET', lengthOf(raw));
}

function checkRedirectUri(): void {
  const raw = process.env.TRADOVATE_OAUTH_REDIRECT_URI?.trim();
  if (!raw) {
    fail('TRADOVATE_OAUTH_REDIRECT_URI', 'missing or empty');
    return;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('TRADOVATE_OAUTH_REDIRECT_URI', 'not an absolute URL');
    return;
  }

  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    fail('TRADOVATE_OAUTH_REDIRECT_URI', 'must use https (http allowed only for localhost)');
    return;
  }

  // Tradovate compares this byte for byte at both the authorize and the
  // exchange step. Anything that changes the bytes without changing the meaning
  // is worth flagging before it costs a confusing invalid_grant.
  if (url.search) warn('TRADOVATE_OAUTH_REDIRECT_URI', 'carries a query string');
  if (url.hash) warn('TRADOVATE_OAUTH_REDIRECT_URI', 'carries a fragment');
  if (raw.endsWith('/')) {
    warn('TRADOVATE_OAUTH_REDIRECT_URI', 'ends in a trailing slash — it must match exactly');
  }

  pass(
    'TRADOVATE_OAUTH_REDIRECT_URI',
    `${url.protocol.replace(':', '')}, path ${url.pathname === '/' ? '(root)' : 'set'}`
  );

  if (SHOW_REDIRECT) {
    console.log(`        value: ${raw}`);
    console.log('        (public, registered value — shown because --print-redirect-uri was passed)');
  }
}

function checkEncryptionKey(): void {
  const raw = process.env.TRADOVATE_TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim() === '') {
    fail('TRADOVATE_TOKEN_ENCRYPTION_KEY', 'missing or empty');
    return;
  }
  if (!isEncryptionKeyValid()) {
    fail(
      'TRADOVATE_TOKEN_ENCRYPTION_KEY',
      'does not decode to 32 bytes — expected 64 hex characters or 32 bytes of base64'
    );
    return;
  }
  pass('TRADOVATE_TOKEN_ENCRYPTION_KEY', 'decodes to 32 bytes');
}

/** Returns the detected environment so the endpoint report can use it. */
function checkApiUrl(): 'demo' | 'live' | null {
  const raw = process.env.TRADOVATE_API_URL?.trim();
  if (!raw) {
    fail('TRADOVATE_API_URL', 'missing or empty');
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('TRADOVATE_API_URL', 'not a valid URL');
    return null;
  }

  const environment = detectEnvironment(raw);
  if (!environment) {
    fail(
      'TRADOVATE_API_URL',
      `host ${url.hostname} is not a known Tradovate environment ` +
        '(expected demo.tradovateapi.com or live.tradovateapi.com)'
    );
    return null;
  }

  if (!url.pathname.replace(/\/+$/, '').endsWith('/v1')) {
    warn('TRADOVATE_API_URL', 'does not end in /v1 — the trading REST base normally does');
  }

  pass('TRADOVATE_API_URL', `environment: ${environment}`);
  return environment;
}

function checkAllowlist(): void {
  const entries = parseAllowlist();
  if (!isAllowlistConfigured()) {
    // Not a FAIL: an unset allowlist is a valid, safe state — it means the
    // feature is closed. It is only a problem if you were expecting to test.
    warn(
      TRADOVATE_ALLOWLIST_ENV_VAR,
      'unset or empty — the connection is closed to every user (fail-closed default)'
    );
    return;
  }
  // Count only. A Supabase user id is not a secret, but it identifies a person,
  // and this output is meant to be safe to paste anywhere.
  pass(TRADOVATE_ALLOWLIST_ENV_VAR, `${entries.length} user id${entries.length === 1 ? '' : 's'} allowed`);
}

function reportEndpoints(environment: 'demo' | 'live' | null): void {
  console.log('\nResolved endpoints (constants from the documentation, not secrets)\n');

  if (!environment) {
    console.log('  (skipped — TRADOVATE_API_URL did not resolve to a known environment)');
    return;
  }

  const authorizeOverride = process.env.TRADOVATE_OAUTH_AUTHORIZE_URL?.trim();
  const tokenOverride = process.env.TRADOVATE_OAUTH_TOKEN_URL?.trim();

  console.log(`  environment     ${environment}`);
  console.log(
    `  authorize       ${authorizeOverride || AUTHORIZE_URLS[environment]}` +
      (authorizeOverride ? '   (overridden by TRADOVATE_OAUTH_AUTHORIZE_URL)' : '')
  );
  console.log(
    `  token exchange  ${tokenOverride || TOKEN_URLS[environment]}` +
      (tokenOverride ? '   (overridden by TRADOVATE_OAUTH_TOKEN_URL)' : `   (source: ${TOKEN_URL_SOURCE})`)
  );
  console.log(`  /auth/me        ${LIVE_API_URL}/auth/me   (Live-only endpoint, per the docs)`);

  if (!tokenOverride) {
    console.log(
      `\n  The two official pages disagree about the token endpoint. The alternative is\n` +
        `    ${TOKEN_URLS_ALTERNATIVE[environment]}\n` +
        `  If the exchange fails with invalid_client or a 404, flip TOKEN_URL_SOURCE in\n` +
        '  src/lib/tradovate/hosts.ts. See that file for the citations.'
    );
  }
}

function main(): number {
  console.log('Tradovate OAuth configuration check\n');
  console.log('  No value is printed. No network request is made.\n');

  checkClientId();
  checkClientSecret();
  checkRedirectUri();
  const environment = checkApiUrl();
  checkEncryptionKey();
  checkAllowlist();

  reportEndpoints(environment);

  console.log('');
  if (failures > 0) {
    console.log(`  ${failures} problem${failures === 1 ? '' : 's'} found. The OAuth flow cannot run.`);
    console.log('  Set these in .env.local for local work, and in Vercel Production for the');
    console.log('  live test. See .env.example for the full list.');
    return EXIT_CONFIG;
  }

  console.log(
    `  Configuration is complete${warnings > 0 ? `, with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`
  );
  if (!SHOW_REDIRECT) {
    console.log('  Pass --print-redirect-uri to display the redirect URI for a byte-for-byte');
    console.log('  comparison against the one registered with Tradovate.');
  }
  return EXIT_OK;
}

process.exit(main());
