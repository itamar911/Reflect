'use client';

import { createBrowserClient } from '@supabase/ssr';
import { createDemoQuery, createDemoChannel, triggerDemoUpsell } from '@/lib/demo/demoDb';

function isDemoPath() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/demo');
}

export function createClient() {
  const client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  if (!isDemoPath()) return client;

  // Demo mode: no Supabase traffic leaves the browser. Reads resolve from the
  // SAME fixture set the server renders (lazy-loaded so it stays out of the
  // main bundle) — a client-side refetch can never diverge from the SSR data.
  // Writes raise the signup upsell, realtime channels never connect.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) =>
          createDemoQuery(
            () => import('@/lib/demo/fixtures').then(m => m.DEMO_TABLES[table] ?? []),
            triggerDemoUpsell,
          );
      }
      if (prop === 'channel') return () => createDemoChannel();
      if (prop === 'removeChannel') return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}
