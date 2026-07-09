import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';

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
