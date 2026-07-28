import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

export async function createClient(): Promise<SupabaseClient> {
  // Demo mode: the middleware rewrites /demo/* to the real pages with this
  // header (and rejects it on any outside request), so the whole server tree
  // renders from fixtures — no auth, no DB.
  const headerStore = await headers();
  if (headerStore.get('x-demo-mode') === '1') {
    const { createDemoServerClient } = await import('@/lib/demo/demoServer');
    return createDemoServerClient();
  }

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from Server Component ג€” middleware handles session refresh
          }
        },
      },
    }
  );
}

// getUser() always revalidates against the Supabase Auth server (unlike
// getSession(), it's not a local cookie decode) — every (app) layout/page
// calls it independently, which without this would mean a separate network
// round-trip per call. React's cache() memoizes it per request, so within a
// single render pass (layout.tsx + the page.tsx it wraps) the round-trip
// happens once and every subsequent call reuses that result. This is purely
// a request-scoped memoization — every new request still fully revalidates.
export const getCachedUser = cache(async () => {
  const supabase = await createClient();
  return supabase.auth.getUser();
});
