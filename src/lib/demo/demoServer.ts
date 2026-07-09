// Fixture-backed stand-in for the server supabase client, returned by
// lib/supabase/server.ts when the request carries the middleware-set
// x-demo-mode header. Implements exactly the surface the app's server code
// uses: auth.getUser() and from(...) query chains.
import type { SupabaseClient } from '@supabase/supabase-js';
import { createDemoQuery } from './demoDb';
import { DEMO_TABLES, DEMO_USER } from './fixtures';

export function createDemoServerClient(): SupabaseClient {
  const client = {
    auth: {
      getUser: async () => ({ data: { user: DEMO_USER }, error: null }),
      getSession: async () => ({ data: { session: null }, error: null }),
    },
    from: (table: string) => createDemoQuery(DEMO_TABLES[table]),
  };
  return client as unknown as SupabaseClient;
}
