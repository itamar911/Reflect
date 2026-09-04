/**
 * Verify TRADOVATE_TOKEN_ENCRYPTION_KEY.
 *
 *   npm run tradovate:verify-key
 *
 * Two questions, answered in order:
 *
 *   1. Does the configured value decode cleanly to exactly 32 bytes?
 *   2. Does a real round trip through src/lib/tradovate/token-crypto.ts work
 *      with that key — encrypt, decrypt, and get the same bytes back?
 *
 * "Cleanly" is load-bearing in the first question. Node's base64 decoder discards
 * characters it does not recognise, so a key with a stray quote still yields 32
 * usable bytes — different bytes from the ones intended. That case fails here
 * rather than warning, because a key that works in isolation but differs from the
 * deployed one is the failure this script exists to catch.
 *
 * The second question is the one that matters. A key can be the right length
 * and still be wrong; only a round trip proves the module can actually use it.
 * The checks below go a little further and confirm the AAD binding rejects a
 * ciphertext addressed to a different user or column, because a key that
 * "works" but silently ignores the binding would be a real regression.
 *
 * Deliberately separate from tradovate-verify.ts. That script needs all eight
 * password-grant variables and opens a Tradovate session — one of the two a user
 * is allowed — to answer a question about credentials. This one needs no
 * network, no credentials, and no session, so requiring them here would mean you
 * could not check the encryption key until the rest of the integration was
 * configured.
 *
 * Nothing here prints the key, any part of it, any ciphertext, or any derived
 * key material. The dummy plaintext is a fixed non-secret string.
 */

import {
  decryptToken,
  encryptToken,
  isEncryptionKeyValid,
} from '../src/lib/tradovate/token-crypto';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CONFIG = 2;

/** Not a secret, and never treated as one. Fixed so runs are comparable. */
const DUMMY_PLAINTEXT = 'tradovate-key-check-dummy-value';
const DUMMY_USER = '00000000-0000-4000-8000-000000000000';
const OTHER_USER = '11111111-1111-4111-8111-111111111111';

const KEY_BYTES = 32;

let failures = 0;

function report(ok: boolean, label: string, detail = ''): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

/** Assert that a call throws. Used for the checks that must be rejected. */
function reportThrows(label: string, fn: () => unknown, detail = ''): boolean {
  try {
    fn();
    return report(false, label, 'did not throw — it should have');
  } catch {
    return report(true, label, detail);
  }
}

/**
 * Describe how token-crypto will read this value, mirroring its own logic: 64
 * hex characters are treated as hex, everything else as base64.
 */
function describeEncoding(raw: string): { encoding: 'hex' | 'base64'; bytes: number } {
  const isHex = /^[0-9a-fA-F]{64}$/.test(raw);
  const decoded = isHex ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return { encoding: isHex ? 'hex' : 'base64', bytes: decoded.length };
}

function main(): number {
  console.log('Tradovate token encryption key check\n');

  const raw = process.env.TRADOVATE_TOKEN_ENCRYPTION_KEY?.trim();

  if (!raw) {
    console.error('  TRADOVATE_TOKEN_ENCRYPTION_KEY is not set (or is empty).\n');
    console.error('  Generate one with:');
    console.error(
      '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n'
    );
    console.error('  Then set it in .env.local and in the deployment environment.');
    return EXIT_CONFIG;
  }

  const { encoding, bytes } = describeEncoding(raw);

  console.log(`  Read as     ${encoding}`);
  console.log(`  Characters  ${raw.length}`);
  console.log(`  Decodes to  ${bytes} bytes\n`);

  // --- Step 1: shape -------------------------------------------------------

  const lengthOk = report(
    bytes === KEY_BYTES,
    `decodes to exactly ${KEY_BYTES} bytes`,
    bytes === KEY_BYTES ? '' : `got ${bytes} — AES-256 needs ${KEY_BYTES}`
  );

  // Buffer.from(x, 'base64') silently discards characters outside the alphabet,
  // so a value with a stray quote or space still decodes to 32 bytes — just not
  // the 32 bytes that were meant. This fails rather than warns: such a key works
  // perfectly in isolation, which is exactly what makes it dangerous. It will not
  // be byte-identical to the same key pasted correctly into the deployment
  // environment, and tokens encrypted under one spelling are unreadable under the
  // other. A check that only warned would let that reach production green.
  const strictBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) || /^[A-Za-z0-9_-]+={0,2}$/.test(raw);
  if (encoding === 'base64') {
    const clean = report(
      strictBase64,
      'contains only base64 characters',
      strictBase64 ? '' : 'stray characters are silently discarded when decoding'
    );
    if (!clean) {
      console.log(
        '\n  The decoded key is therefore not the one you pasted. It will still\n' +
          '  encrypt and decrypt self-consistently, so this would pass unnoticed —\n' +
          '  but it will not match the same key set in the deployment environment,\n' +
          '  and every token encrypted under the other spelling becomes permanently\n' +
          '  unreadable. Check for a stray quote, space, or line break.\n'
      );
    }
  }

  const acceptedOk = report(isEncryptionKeyValid(), 'token-crypto accepts the key');

  // Only bail early on a key that cannot be used at all — that makes every check
  // below meaningless. A key with stray characters has already been marked
  // failed, but it does encrypt, so the round trip below still reports honestly
  // instead of being skipped with a misleading "not usable".
  if (!lengthOk || !acceptedOk) {
    console.log('\n  FAIL — the key is not usable. Nothing was encrypted.\n');
    return EXIT_FAILED;
  }

  // --- Step 2: round trip --------------------------------------------------

  console.log('');

  let ciphertext: string;
  try {
    ciphertext = encryptToken(DUMMY_PLAINTEXT, 'access', DUMMY_USER);
  } catch (error) {
    report(false, 'encrypt a dummy value', error instanceof Error ? error.message : 'unknown error');
    console.log('\n  FAIL — encryption failed with the configured key.\n');
    return EXIT_FAILED;
  }
  report(true, 'encrypt a dummy value');

  const parts = ciphertext.split('.');
  report(
    parts.length === 4 && parts[0] === 'v1',
    'ciphertext is a v1 envelope',
    `${parts.length} segments`
  );

  // Cheap, but it is the check that would catch a catastrophic "encryption"
  // that quietly passed the plaintext through.
  report(!ciphertext.includes(DUMMY_PLAINTEXT), 'ciphertext does not contain the plaintext');

  report(
    encryptToken(DUMMY_PLAINTEXT, 'access', DUMMY_USER) !== ciphertext,
    'a second encryption differs (fresh IV per call)'
  );

  try {
    const decrypted = decryptToken(ciphertext, 'access', DUMMY_USER);
    report(decrypted === DUMMY_PLAINTEXT, 'decrypt returns the original value');
  } catch (error) {
    report(false, 'decrypt returns the original value', error instanceof Error ? error.message : '');
  }

  // --- Step 3: the AAD binding still binds ---------------------------------

  reportThrows(
    'rejects a ciphertext bound to another user',
    () => decryptToken(ciphertext, 'access', OTHER_USER)
  );
  reportThrows(
    'rejects a ciphertext bound to another column',
    () => decryptToken(ciphertext, 'refresh', DUMMY_USER)
  );
  reportThrows('rejects a tampered ciphertext', () => {
    const tampered = ciphertext.split('.');
    const body = Buffer.from(tampered[3], 'base64url');
    body[0] ^= 0xff;
    tampered[3] = body.toString('base64url');
    return decryptToken(tampered.join('.'), 'access', DUMMY_USER);
  });

  if (failures > 0) {
    console.log(`\n  FAIL — ${failures} check${failures === 1 ? '' : 's'} failed.\n`);
    return EXIT_FAILED;
  }

  console.log('\n  PASS — the key decodes correctly and token-crypto can use it.\n');
  console.log(
    '  Note: this proves the key works, not that it is the same key your\n' +
      '  deployment uses. Tokens encrypted under a different key cannot be\n' +
      '  decrypted after a key change; affected users must reconnect.'
  );
  return EXIT_OK;
}

try {
  process.exit(main());
} catch (error) {
  // Nothing above should escape, but if it does, print a message rather than a
  // stack trace — a stack could carry a value from inside token-crypto.
  console.error(`\n  FAIL — ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(EXIT_FAILED);
}
