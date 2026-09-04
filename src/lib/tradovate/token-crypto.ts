/**
 * Encryption for stored Tradovate tokens.
 *
 * SERVER ONLY — see ./config.ts.
 *
 * This is the only module in the codebase that handles a raw Tradovate token
 * alongside the encryption key. Everything else moves ciphertext around or
 * receives a plaintext token from ./connections.ts and hands it straight to an
 * Authorization header. Keep it that way: the value of encrypting at rest
 * collapses the moment a second module starts decrypting.
 *
 * Scheme: AES-256-GCM, a fresh 96-bit IV per encryption, key from
 * TRADOVATE_TOKEN_ENCRYPTION_KEY.
 *
 * Ciphertext format (all segments base64url, dot-separated):
 *
 *   v1.<iv>.<authTag>.<ciphertext>
 *
 * The version prefix is what makes key rotation possible later — a v2 reader can
 * still decrypt v1 rows while it re-encrypts them.
 *
 * Additional authenticated data binds each ciphertext to the user and the column
 * it belongs in ("tradovate:access:<userId>"). GCM then rejects a ciphertext
 * that has been moved between rows or between the access and refresh columns,
 * so someone with write access to the table cannot graft one user's token onto
 * another user's connection.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { TradovateConfigError } from './errors';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

/** Which column a ciphertext belongs to; part of the AAD binding. */
export type TokenPurpose = 'access' | 'refresh';

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Parse TRADOVATE_TOKEN_ENCRYPTION_KEY into 32 raw bytes.
 *
 * Accepts hex (64 chars) or base64/base64url, because both are things people
 * paste out of a key generator. Anything that does not decode to exactly 32
 * bytes is a configuration error, not a runtime failure to paper over — a short
 * key silently weakened is worse than a route that refuses to start.
 *
 * The key itself never appears in the thrown message.
 */
function loadKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.TRADOVATE_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new TradovateConfigError(
      'TRADOVATE_TOKEN_ENCRYPTION_KEY is not set. Generate one with ' +
        '`node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"`.',
      ['TRADOVATE_TOKEN_ENCRYPTION_KEY']
    );
  }

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');

  if (decoded.length !== KEY_BYTES) {
    throw new TradovateConfigError(
      `TRADOVATE_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        'Provide 64 hex characters or 32 bytes of base64.',
      ['TRADOVATE_TOKEN_ENCRYPTION_KEY']
    );
  }
  return decoded;
}

/**
 * True when the encryption key is present and well formed.
 *
 * For startup checks and ./oauth-config.ts, which reports all configuration
 * problems together rather than failing on the first one.
 */
export function isEncryptionKeyValid(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadKey(env);
    return true;
  } catch {
    return false;
  }
}

function aad(purpose: TokenPurpose, userId: string): Buffer {
  return Buffer.from(`tradovate:${purpose}:${userId}`, 'utf8');
}

/** Encrypt a token for storage. The return value is safe to write to Postgres. */
export function encryptToken(plaintext: string, purpose: TokenPurpose, userId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(purpose, userId));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, b64url(iv), b64url(cipher.getAuthTag()), b64url(ciphertext)].join('.');
}

/**
 * Decrypt a stored token.
 *
 * Throws on a wrong key, a tampered ciphertext, or a ciphertext bound to a
 * different user or column. The message never includes any part of the
 * ciphertext or the key — a decryption failure tells you only that it failed.
 */
export function decryptToken(stored: string, purpose: TokenPurpose, userId: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TradovateConfigError(
      `Stored Tradovate token is not in the expected ${VERSION} envelope format.`
    );
  }

  const [, ivPart, tagPart, ctPart] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TradovateConfigError('Stored Tradovate token has a malformed IV or auth tag.');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, loadKey(), iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(purpose, userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    // Deliberately not chaining `cause`: OpenSSL's message is uninformative
    // here anyway, and dropping it guarantees nothing derived from the key or
    // the ciphertext can ride along into a log.
    void cause;
    throw new TradovateConfigError(
      'Failed to decrypt a stored Tradovate token. The encryption key may have changed, ' +
        'or the row may have been altered. The user must reconnect their account.'
    );
  }
}

/**
 * Derive an independent 32-byte key from TRADOVATE_TOKEN_ENCRYPTION_KEY.
 *
 * ./oauth-state.ts needs a key to sign the state cookie with. Handing it the
 * encryption key directly would mean one key doing two unrelated jobs, so it
 * gets an HKDF-derived subkey instead: signing state cookies reveals nothing
 * about the key that protects the tokens, and a future third use gets its own
 * subkey by passing a different label.
 *
 * Returns a fresh Buffer; callers must not retain it beyond the operation.
 */
export function deriveSubkey(label: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadKey(), Buffer.alloc(0), Buffer.from(label, 'utf8'), KEY_BYTES)
  );
}

/**
 * Constant-time string comparison, for the OAuth state check in ./oauth-state.ts.
 *
 * Lives here because this is the module that already owns the crypto imports.
 * Length is compared first and non-secretly: state values are fixed length, so
 * a length mismatch is a malformed request rather than a signal worth hiding.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
