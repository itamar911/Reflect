import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const type = searchParams.get('type');
  const next = searchParams.get('next') ?? '/dashboard';

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
    // PKCE limitation: the code verifier lives in a cookie in the browser that
    // initiated the flow. Opening the email link in a different browser (common
    // on mobile) always fails the exchange — the fix for the user is the same
    // as an expired link: request a new one.
    return NextResponse.redirect(`${origin}/login?error=link_expired`);
  }

  return NextResponse.redirect(`${origin}/login?error=auth_callback_error`);
}
