import type { AuthError } from '@supabase/supabase-js';

/**
 * The error codes /auth/callback and /auth/confirm are allowed to put on
 * ?error=. Both routes classify through classifyAuthError() so the two never
 * drift, and AuthScreen renders one Hebrew string per code.
 */
export type AuthCallbackErrorCode =
  | 'verifier_missing'
  | 'link_used'
  | 'link_expired'
  | 'service_error'
  | 'auth_callback_error';

/**
 * Maps an AuthError onto the code the user-facing message is chosen from.
 * Every branch here was a distinct failure that used to arrive as
 * "link expired", which is only true for two of them.
 */
export function classifyAuthError(error: AuthError | null): AuthCallbackErrorCode {
  if (!error) return 'auth_callback_error';

  switch (error.code) {
    // Thrown by auth-js locally, before any request is made, when the PKCE
    // code verifier cookie is not on this device. Nothing expired and nothing
    // was reused — the link was simply opened somewhere else.
    case 'pkce_code_verifier_not_found':
      return 'verifier_missing';

    // The flow state is gone because the code was already exchanged: the only
    // failure here that genuinely means "already used".
    case 'flow_state_not_found':
      return 'link_used';

    // otp_expired is the emailed token's own TTL; flow_state_expired is the
    // shorter PKCE flow-state TTL. Both are real expiry.
    case 'otp_expired':
    case 'flow_state_expired':
      return 'link_expired';

    // Retryable: the link is still good, the service is not.
    case 'unexpected_failure':
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'service_error';
  }

  // Network failure reaching Supabase, or a 5xx from it. Telling the user to
  // request a new link here just loops them through the same outage.
  if (error.name === 'AuthRetryableFetchError') return 'service_error';
  if (typeof error.status === 'number' && error.status >= 500) return 'service_error';

  return 'auth_callback_error';
}

/**
 * Validates the `next` query param before it is concatenated onto the origin.
 *
 * Must be a single-slash-rooted relative path. `//host` and `/\host` are
 * rejected specifically: browsers do not agree on how they normalise, and both
 * are one parser quirk away from turning `${origin}${next}` into a
 * protocol-relative URL pointing off-site. Anything else falls back to
 * /dashboard rather than being sanitised — a caller passing something odd gets
 * the default, not a guess at what it meant.
 */
export function safeNextPath(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/')) return '/dashboard';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
  return next;
}
