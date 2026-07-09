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

  // Demo mode: no Supabase traffic leaves the browser. Reads resolve empty
  // (pages get their data server-side from fixtures), writes raise the signup
  // upsell, realtime channels never connect.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') return () => createDemoQuery([], triggerDemoUpsell);
      if (prop === 'channel') return () => createDemoChannel();
      if (prop === 'removeChannel') return () => {};
      return Reflect.get(target, prop, receiver);
    },
  });
}
