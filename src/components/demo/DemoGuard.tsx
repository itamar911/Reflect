'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import { DEMO_UPSELL_EVENT } from '@/lib/demo/demoDb';
import { useHydrated } from '@/lib/hooks';

/**
 * Mounted (only) on /demo pages. Hosts the signup-upsell modal raised by
 * mutation attempts (see lib/demo/fetchGuard.ts and lib/supabase/client.ts
 * for the interception itself) and injects a robots-noindex meta on top of
 * the middleware's X-Robots-Tag header.
 */
export default function DemoGuard() {
  const [upsellOpen, setUpsellOpen] = useState(false);
  const mounted = useHydrated();

  // noindex meta
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  // upsell open/close
  useEffect(() => {
    const open = () => setUpsellOpen(true);
    window.addEventListener(DEMO_UPSELL_EVENT, open);
    return () => window.removeEventListener(DEMO_UPSELL_EVENT, open);
  }, []);

  useEffect(() => {
    if (!upsellOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setUpsellOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [upsellOpen]);

  if (!mounted || !upsellOpen) return null;

  return createPortal(
    <div
      dir="rtl"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={() => setUpsellOpen(false)}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-6 flex flex-col items-center gap-4 text-center"
        style={{
          background: 'var(--color-tg-surface)',
          border: '1px solid var(--color-tg-border)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.3)' }}
        >
          <Lock size={20} color="#00d2d2" />
        </div>
        <p className="text-base font-bold" style={{ color: 'var(--color-tg-text)' }}>
          בדמו אי אפשר לשמור — התחילו לתעד בחשבון משלכם
        </p>
        <p className="text-sm" style={{ color: 'var(--color-tg-text-2)' }}>
          כל מה שאתם רואים כאן עובד בדיוק כך בחשבון אמיתי — עם הנתונים שלכם.
        </p>
        <div className="w-full flex flex-col gap-2 pt-1">
          <a
            href="/signup"
            className="w-full py-2.5 rounded-xl text-sm font-bold transition-opacity hover:opacity-85"
            style={{ background: '#00d2d2', color: '#0a0a0f' }}
          >
            התחילו 5 ימי ניסיון
          </a>
          <button
            onClick={() => setUpsellOpen(false)}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-80"
            style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}
          >
            המשך לגלוש בדמו
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
