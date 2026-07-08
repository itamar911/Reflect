import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const hasAuthCookies = request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'));

  // A transient getUser() failure (network error, Supabase 5xx) must not be
  // treated as "logged out" — with auth cookies present we let the request
  // through and rely on the page-level getUser() gates; the next request retries.
  let user = null;
  let authUnavailable = false;
  try {
    const { data, error } = await supabase.auth.getUser();
    user = data.user;
    if (error && hasAuthCookies) {
      authUnavailable = error.status === undefined || error.status === 0 || error.status >= 500;
    }
  } catch {
    authUnavailable = hasAuthCookies;
  }

  const { pathname } = request.nextUrl;

  const isAuthRoute =
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password') ||
    pathname.startsWith('/auth/');

  const isApiRoute = pathname.startsWith('/api/');

  const isMarketingRoute =
    pathname.startsWith('/terms') ||
    pathname.startsWith('/privacy');

  const isPublicRoute = pathname === '/' || isAuthRoute || isApiRoute || isMarketingRoute;

  // Redirects must carry any auth cookies getUser() rotated onto supabaseResponse,
  // otherwise the browser keeps a stale refresh token and the session dies later.
  function redirectWithCookies(to: string) {
    const response = NextResponse.redirect(new URL(to, request.url));
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  }

  if (!user && !authUnavailable && !isPublicRoute) {
    return redirectWithCookies('/login');
  }

  if (user && isAuthRoute && !pathname.startsWith('/auth/') && !pathname.startsWith('/reset-password')) {
    return redirectWithCookies('/dashboard');
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
