/**
 * Tradovate credentials and endpoint configuration.
 *
 * SERVER ONLY. This module reads the Tradovate password and API secret out of
 * the environment. Never import it into anything that reaches the browser —
 * same rule as `src/lib/supabase/admin.ts`.
 *
 * Nothing here throws on missing configuration. Callers get a result object and
 * decide how to report it, so a missing env var surfaces as a clear message
 * naming the variables rather than an unhandled exception.
 */

import type { TradovateConfig } from './types';

/** Every environment variable the integration reads. */
export const TRADOVATE_ENV_VARS = [
  'TRADOVATE_API_URL',
  'TRADOVATE_USERNAME',
  'TRADOVATE_PASSWORD',
  'TRADOVATE_APP_ID',
  'TRADOVATE_APP_VERSION',
  'TRADOVATE_CID',
  'TRADOVATE_SEC',
  'TRADOVATE_DEVICE_ID',
] as const;

export type TradovateEnvVar = (typeof TRADOVATE_ENV_VARS)[number];

export type ConfigResult =
  | { ok: true; config: TradovateConfig }
  | { ok: false; missing: TradovateEnvVar[]; invalid: { name: TradovateEnvVar; reason: string }[] };

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/tradovate is server-only: it reads TRADOVATE_PASSWORD and TRADOVATE_SEC ' +
        'from the environment and must never be bundled into client code.'
    );
  }
}

/**
 * Read and validate the Tradovate configuration.
 *
 * Returns `{ ok: false }` with the offending variable names rather than
 * throwing, so a CLI or route handler can print something actionable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  assertServerOnly();

  const missing: TradovateEnvVar[] = [];
  const invalid: { name: TradovateEnvVar; reason: string }[] = [];

  for (const name of TRADOVATE_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') missing.push(name);
  }

  // `cid` is a numeric application id. Tradovate rejects it as a string, and a
  // non-numeric value would otherwise fail at authentication with an opaque
  // error rather than here, where we can name the variable.
  const rawCid = env.TRADOVATE_CID?.trim();
  if (rawCid && !/^\d+$/.test(rawCid)) {
    invalid.push({ name: 'TRADOVATE_CID', reason: `expected a number, got ${JSON.stringify(rawCid)}` });
  }

  const rawUrl = env.TRADOVATE_API_URL?.trim();
  if (rawUrl) {
    try {
      new URL(rawUrl);
    } catch {
      invalid.push({ name: 'TRADOVATE_API_URL', reason: `not a valid URL: ${JSON.stringify(rawUrl)}` });
    }
  }

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };

  return {
    ok: true,
    config: {
      // Demo is https://demo.tradovateapi.com/v1; live swaps in via this var
      // alone. Trailing slashes are stripped so callers can pass paths as
      // '/auth/accesstokenrequest' without doubling up.
      apiUrl: rawUrl!.replace(/\/+$/, ''),
      username: env.TRADOVATE_USERNAME!.trim(),
      password: env.TRADOVATE_PASSWORD!,
      appId: env.TRADOVATE_APP_ID!.trim(),
      appVersion: env.TRADOVATE_APP_VERSION!.trim(),
      cid: Number(rawCid),
      sec: env.TRADOVATE_SEC!.trim(),
      deviceId: env.TRADOVATE_DEVICE_ID!.trim(),
    },
  };
}

/** Human-readable explanation of a failed {@link loadConfig}, ready to print. */
export function describeConfigError(result: Extract<ConfigResult, { ok: false }>): string {
  const lines: string[] = ['Tradovate configuration is incomplete.'];

  if (result.missing.length > 0) {
    lines.push('', `Missing or empty (${result.missing.length}):`);
    for (const name of result.missing) lines.push(`  - ${name}`);
  }
  if (result.invalid.length > 0) {
    lines.push('', `Present but invalid (${result.invalid.length}):`);
    for (const { name, reason } of result.invalid) lines.push(`  - ${name}: ${reason}`);
  }

  lines.push(
    '',
    'Set these in .env.local (or the deployment environment). See .env.example',
    'for the shape and the Tradovate section of README.md for where each value',
    'comes from.'
  );
  return lines.join('\n');
}
