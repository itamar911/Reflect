import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { classifyAuthError, safeNextPath } from '@/lib/auth/authRedirects';

// Email OTP types we are willing to verify. `type` arrives from the query
// string, so it is whitelisted rather than cast — EmailOtpType widens to
// `string & {}` and would accept anything.
const EMAIL_OTP_TYPES = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
] as const;

type EmailOtpType = (typeof EMAIL_OTP_TYPES)[number];

function isEmailOtpType(value: string): value is EmailOtpType {
  return (EMAIL_OTP_TYPES as readonly string[]).includes(value);
}

/**
 * Token-hash confirmation handler.
 *
 * Unlike /auth/callback this carries no PKCE state: verifyOtp sends the hash
 * straight to Supabase, so the link works in whatever browser or device opens
 * it — the mail-app-on-another-phone case that /auth/callback cannot serve.
 * Reached from the emailed link once the Supabase template is switched to
 * {{ .TokenHash }}; the session verifyOtp establishes is written onto this
 * redirect by the cookie writer in src/lib/supabase/server.ts.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = safeNextPath(searchParams.get('next'));

  if (!tokenHash || !type || !isEmailOtpType(type)) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (!error) {
    return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=${classifyAuthError(error)}`);
}
