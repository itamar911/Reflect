import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// App sections browsable in demo mode (everything else under /demo bounces home)
const DEMO_SECTIONS = new Set([
  'dashboard', 'journal', 'trades', 'stats', 'setups',
  'notebook', 'coach', 'rules', 'strategies',
]);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // x-demo-mode is set exclusively by the /demo rewrite below. Reject it on
  // any incoming request — otherwise a client could spoof it to make server
  // code (including AI route auth) treat them as the demo user.
  if (request.headers.has('x-demo-mode')) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  // /demo/* — public, fixture-backed view of the real app. The URL keeps the
  // /demo prefix in the browser; the request is rewritten to the real page
  // with the demo header so the server data layer serves fixtures.
  if (pathname === '/demo' || pathname === '/demo/') {
    return NextResponse.redirect(new URL('/demo/dashboard', request.url));
  }
  if (pathname.startsWith('/demo/')) {
    const target = pathname.slice('/demo'.length);
    if (!DEMO_SECTIONS.has(target.split('/')[1])) {
      return NextResponse.redirect(new URL('/demo/dashboard', request.url));
    }
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-demo-mode', '1');
    const response = NextResponse.rewrite(
      new URL(target + request.nextUrl.search, request.url),
      { request: { headers: requestHeaders } },
    );
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return response;
  }

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
