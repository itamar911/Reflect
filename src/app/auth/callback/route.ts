import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { classifyAuthError, safeNextPath } from '@/lib/auth/authRedirects';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const type = searchParams.get('type');
  const next = safeNextPath(searchParams.get('next'));

  // Supabase appends error/error_description (no code) when the link is expired or already used
  const errorCode = searchParams.get('error_code');
  const errorDescription = searchParams.get('error_description');
  if (searchParams.get('error')) {
    const expired =
      errorCode === 'otp_expired' || /expired|invalid/i.test(errorDescription ?? '');
    return NextResponse.redirect(
      `${origin}/login?error=${expired ? 'link_expired' : 'auth_callback_error'}`
    );
  }

  if (code) {
    if (type === 'recovery') {
      return NextResponse.redirect(`${origin}/reset-password?code=${code}`);
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    // Six distinct failures land here and only two of them are expiry, so the
    // error is classified rather than discarded. The cross-browser PKCE case
    // (verifier_missing) is no longer something the user has to work around:
    // links minted from {{ .TokenHash }} go to /auth/confirm, which carries no
    // PKCE state and works on any device. It stays in the mapping as a canary
    // for links issued before that switch.
    return NextResponse.redirect(`${origin}/login?error=${classifyAuthError(error)}`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
