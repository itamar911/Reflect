/**
 * Verify Tradovate credentials.
 *
 *   npm run tradovate:verify
 *
 * Authenticates against whatever TRADOVATE_API_URL points at (the demo
 * environment during development) and reports whether it worked, the userId,
 * and when the token expires. This is the first thing to run once credentials
 * are issued.
 *
 * Read-only: it authenticates and reads nothing else. It places no orders.
 *
 * Missing configuration is reported as a list of variable names and exit code
 * 2 — never an unhandled exception.
 */

import { loadConfig, describeConfigError } from '../src/lib/tradovate/config';
import { requestAccessToken, snapshotFromResponse } from '../src/lib/tradovate/auth';
import {
  TradovateAuthError,
  TradovatePenaltyError,
  TradovateRequestError,
} from '../src/lib/tradovate/errors';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CONFIG = 2;

/** Redact everything but a fingerprint — this output gets pasted into chats. */
function fingerprint(token: string): string {
  return `${token.slice(0, 6)}… (${token.length} chars)`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

async function main(): Promise<number> {
  console.log('Tradovate credential check\n');

  const result = loadConfig();
  if (!result.ok) {
    console.error(describeConfigError(result));
    return EXIT_CONFIG;
  }
  const config = result.config;

  console.log(`  Endpoint  ${config.apiUrl}`);
  console.log(`  Username  ${config.username}`);
  console.log(`  App       ${config.appId} v${config.appVersion}`);
  console.log(`  cid       ${config.cid}  (parsed as ${typeof config.cid})`);
  console.log(`  deviceId  ${config.deviceId}`);
  if (!/demo\.tradovateapi\.com/.test(config.apiUrl)) {
    console.log('\n  NOTE: this is not the demo endpoint. Check TRADOVATE_API_URL.');
  }
  console.log('\nAuthenticating…\n');

  const startedAt = Date.now();
  const response = await requestAccessToken(config);
  const token = snapshotFromResponse(response);
  const elapsed = Date.now() - startedAt;

  const remaining = token.expiresAt - Date.now();

  console.log('  SUCCESS\n');
  console.log(`  userId          ${token.userId}`);
  console.log(`  name            ${token.name ?? '(not returned)'}`);
  console.log(`  userStatus      ${token.userStatus ?? '(not returned)'}`);
  console.log(`  accessToken     ${fingerprint(token.accessToken)}`);
  console.log(
    `  mdAccessToken   ${
      token.mdAccessToken ? `${fingerprint(token.mdAccessToken)} — unused, no CME sub-vendor registration` : '(not returned)'
    }`
  );
  console.log(`  expirationTime  ${token.expirationTime}`);
  console.log(`  expires in      ${formatDuration(remaining)}`);
  console.log(`  round trip      ${elapsed} ms`);

  if (response.hasMarketData !== undefined) {
    console.log(`  hasMarketData   ${response.hasMarketData}`);
  }
  if (response.hasLive !== undefined) console.log(`  hasLive         ${response.hasLive}`);
  if (response.passwordExpirationTime) {
    console.log(`  password expires ${response.passwordExpirationTime}`);
  }

  console.log(
    '\n  Note: this opened a session. Tradovate allows two concurrent sessions\n' +
      '  per user; a third silently closes the oldest. Avoid running this in a\n' +
      '  loop alongside a running app.'
  );

  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // Everything below prints a diagnosis rather than a stack trace: this script
    // exists to tell you what is wrong with the credentials.
    if (error instanceof TradovateAuthError) {
      console.error(`  FAILED — Tradovate rejected the credentials.\n\n  ${error.errorText}\n`);
      console.error('  Check TRADOVATE_USERNAME / TRADOVATE_PASSWORD, and that');
      console.error('  TRADOVATE_CID and TRADOVATE_SEC match the issued API key pair.');
      process.exit(EXIT_FAILED);
    }
    if (error instanceof TradovatePenaltyError) {
      console.error(`  FAILED — rate limited.\n\n  ${error.message}\n`);
      if (error.captcha) {
        console.error('  A captcha challenge cannot be answered by an API client.');
        console.error('  Wait about an hour before trying again.');
      } else if (error.retryAfterSeconds !== undefined) {
        console.error(`  Retry in about ${Math.ceil(error.retryAfterSeconds)}s.`);
      }
      process.exit(EXIT_FAILED);
    }
    if (error instanceof TradovateRequestError) {
      console.error(`  FAILED — HTTP ${error.status} from ${error.path}\n\n  ${error.body.slice(0, 500)}\n`);
      console.error('  Check TRADOVATE_API_URL points at a valid Tradovate environment.');
      process.exit(EXIT_FAILED);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAILED — ${message}\n`);
    if (message.includes('fetch')) {
      console.error('  This looks like a network problem rather than a credential problem.');
    }
    process.exit(EXIT_FAILED);
  });
