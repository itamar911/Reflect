import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import RulesEditor from '@/components/rules/RulesEditor';
import type { PresetRules, CustomRule } from '@/lib/types';
import { Zap } from 'lucide-react';

export const metadata = { title: 'חוקי מסחר — Reflect' };

export default async function RulesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [profileRes, presetRes, customRes] = await Promise.all([
    supabase.from('profiles').select('subscription_tier').eq('id', user.id).single(),
    supabase.from('preset_rules').select('*').eq('user_id', user.id).single(),
    supabase.from('custom_rules').select('*').eq('user_id', user.id).order('sort_order').order('created_at'),
  ]);

  const plan        = (profileRes.data?.subscription_tier ?? 'free') as 'free' | 'basic' | 'pro';
  const presetRules = presetRes.data as PresetRules | null;
  const customRules = (customRes.data ?? []) as CustomRule[];

  if (!presetRules) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm" style={{ color: 'var(--color-tg-muted)' }}>שגיאה בטעינת החוקים. רענן את הדף.</p>
      </div>
    );
  }

  const activeCustom = customRules.filter((r) => r.is_active).length;

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-5">

      {/* ── Header ─────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00d2d2" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--color-tg-text)' }}>חוקי מסחר</h1>
        </div>
        <p className="text-sm" style={{ color: 'var(--color-tg-text-2)' }}>
          החוקים שמגנים עליך מעצמך — מאומתים לפני כל עסקה
        </p>
      </div>

      {/* ── Stats strip ────────────────────────────────────────────── */}
      <div
        className="flex gap-3 rounded-2xl p-4"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
      >
        <StatPill
          label="חוקים מובנים"
          value="5"
          color="var(--color-tg-text)"
        />
        <div style={{ width: 1, background: 'var(--color-tg-border)' }} />
        <StatPill
          label="חוקים אישיים פעילים"
          value={String(activeCustom)}
          color={activeCustom > 0 ? '#00d2d2' : 'var(--color-tg-muted)'}
        />
        <div style={{ width: 1, background: 'var(--color-tg-border)' }} />
        <StatPill
          label="מסלול"
          value={plan === 'pro' ? 'Pro' : plan === 'basic' ? 'Basic' : 'Free'}
          color={plan === 'pro' ? '#00d2d2' : plan === 'basic' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)'}
        />
      </div>

      {/* ── How rules work (collapsible info) ─────────────────────── */}
      <HowItWorks />

      {/* ── Rules editor ───────────────────────────────────────────── */}
      <div
        className="rounded-2xl p-4"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
      >
        <RulesEditor
          presetRules={presetRules}
          customRules={customRules}
          userId={user.id}
          plan={plan}
        />
      </div>

      {/* ── Rule activation history ────────────────────────────────── */}
      <div
        className="rounded-2xl p-4"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--color-tg-text)' }}>
            היסטוריית הפעלות חוקים
          </h2>
          {plan !== 'pro' && (
            <span
              className="px-2 py-0.5 rounded-full text-[11px] font-bold"
              style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
            >
              Pro
            </span>
          )}
        </div>

        {plan === 'pro' ? (
          <div
            className="flex items-center justify-center py-8 rounded-xl"
            style={{ background: 'var(--color-tg-surface-2)' }}
          >
            <div className="text-center">
              <div className="text-2xl mb-2">📜</div>
              <p className="text-sm" style={{ color: 'var(--color-tg-text-2)' }}>
                אין עדיין הפעלות חוקים מתועדות
              </p>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center justify-center py-7 rounded-xl"
            style={{ background: 'var(--color-tg-surface-2)' }}
          >
            <div className="text-center">
              <div className="text-2xl mb-2">📜</div>
              <p className="text-sm mb-1" style={{ color: 'var(--color-tg-text-2)' }}>
                היסטוריית כל החוקים שהופעלו
              </p>
              <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
                תאריך · שם החוק · פעולה שבוצעה
              </p>
              <p className="text-xs font-semibold mt-2" style={{ color: '#00d2d2' }}>
                זמין במסלול Pro
              </p>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex-1 flex flex-col items-center gap-0.5">
      <p className="text-base font-bold leading-none" style={{ color }}>{value}</p>
      <p className="text-[10px] text-center leading-tight" style={{ color: 'var(--color-tg-muted)' }}>{label}</p>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { icon: '📝', text: 'מגדיר חוק: "אם X קרה — אז Y"' },
    { icon: <Zap size={16} />, text: 'לפני כל עסקה — המערכת בודקת את כל החוקים' },
    { icon: '🛡️', text: 'חריגה מפעילה אזהרה, נעילה, או חסימה עצמית' },
  ];

  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3"
      style={{ background: 'rgba(0,210,210,0.05)', border: '1px solid rgba(0,210,210,0.12)' }}
    >
      <p className="text-xs font-semibold" style={{ color: '#00d2d2' }}>איך זה עובד?</p>
      <div className="flex flex-col gap-2">
        {steps.map(({ icon, text }) => (
          <div key={text} className="flex items-center gap-2.5">
            <span className="text-base shrink-0">{icon}</span>
            <p className="text-xs" style={{ color: 'var(--color-tg-text-2)' }}>{text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
