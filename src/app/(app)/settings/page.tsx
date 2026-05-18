import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import Card from '@/components/ui/Card';
import RulesEditor from '@/components/rules/RulesEditor';
import AlertsPanel from '@/components/settings/AlertsPanel';
import type { PresetRules, CustomRule } from '@/lib/types';

export const metadata = { title: 'הגדרות — Reflect' };

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [profileRes, presetRes, customRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).single(),
    supabase.from('preset_rules').select('*').eq('user_id', user.id).single(),
    supabase.from('custom_rules').select('*').eq('user_id', user.id).order('sort_order').order('created_at'),
  ]);

  const profile = profileRes.data;
  const plan = (profile?.subscription_tier ?? 'free') as 'free' | 'basic' | 'pro';
  const presetRules = presetRes.data as PresetRules | null;
  const customRules = (customRes.data ?? []) as CustomRule[];

  if (!presetRules) {
    return (
      <div className="px-4 py-5 text-center">
        <p className="text-sm text-tg-muted">שגיאה בטעינת החוקים. רענן את הדף.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-5 flex flex-col gap-5 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold text-tg-text">הגדרות</h1>

      {/* Profile section */}
      <Card>
        <h2 className="text-sm font-semibold text-tg-text mb-3">פרופיל</h2>
        <div className="flex flex-col gap-2">
          {[
            ['אימייל', user.email ?? '—'],
            ['שם', profile?.display_name ?? '—'],
            ['סגנון מסחר', tradingTypeLabel(profile?.trading_type)],
            ['שוק עיקרי', marketLabel(profile?.default_market)],
            ['רמת ניסיון', experienceLabel(profile?.experience_level)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between items-center py-1.5 border-b border-tg-border last:border-0">
              <span className="text-sm text-tg-text-2">{label}</span>
              <span className="text-sm font-medium text-tg-text">{value}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Rules Editor */}
      <Card>
        <h2 className="text-sm font-semibold text-tg-text mb-4">חוקי המסחר שלי</h2>
        <RulesEditor
          presetRules={presetRules}
          customRules={customRules}
          userId={user.id}
          plan={plan}
        />
      </Card>

      {/* Rule activation history — Pro */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-tg-text">היסטוריית הפעלות חוקים</h2>
          {plan !== 'pro' && (
            <span className="px-2 py-0.5 rounded-full text-xs font-bold"
              style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Pro</span>
          )}
        </div>
        {plan === 'pro' ? (
          <div className="flex items-center justify-center py-8 rounded-xl"
            style={{ background: 'var(--color-tg-surface-2)' }}>
            <div className="text-center">
              <div className="text-2xl mb-2">📜</div>
              <p className="text-sm text-tg-text-2">אין עדיין הפעלות חוקים מתועדות</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-8 rounded-xl"
            style={{ background: 'var(--color-tg-surface-2)' }}>
            <div className="text-center">
              <div className="text-2xl mb-2">📜</div>
              <p className="text-sm text-tg-text-2 mb-1">היסטוריית כל החוקים שהופעלו</p>
              <p className="text-xs text-tg-muted">תאריך · שם החוק · פעולה שבוצעה</p>
              <p className="text-xs font-medium mt-2" style={{ color: '#f59e0b' }}>זמין במסלול Pro</p>
            </div>
          </div>
        )}
      </Card>

      {/* Alerts */}
      <Card>
        <h2 className="text-sm font-semibold text-tg-text mb-4">התראות</h2>
        <AlertsPanel plan={plan} />
      </Card>

      {/* Pricing */}
      <div className="flex flex-col gap-3">
        <h2 className="text-base font-bold text-tg-text">מסלולים</h2>

        {/* Free */}
        <div className="rounded-2xl border-2 p-4" style={{
          borderColor: plan === 'free' ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
          background: 'var(--color-tg-surface)',
        }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-tg-text">חינמי</h3>
                {plan === 'free' && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>המסלול שלך</span>
                )}
              </div>
              <p className="text-xl font-bold text-tg-text mt-1">$0</p>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5">
            {[
              '2 עסקאות בשבוע',
              'תחקיר AI אחד בשבוע',
              'התראות בסיסיות',
              'ייצוא עסקה אחת בשבוע (CSV)',
              '3 חוקים מובנים קבועים',
            ].map((f) => <PlanFeature key={f} text={f} />)}
            {[
              'אין חוקים אישיים',
              'אין לוח ביצועים',
              'אין סיכום שבועי',
            ].map((f) => <PlanFeature key={f} text={f} disabled />)}
          </ul>
        </div>

        {/* Basic */}
        <div className="rounded-2xl border-2 p-4" style={{
          borderColor: plan === 'basic' ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
          background: 'var(--color-tg-surface)',
        }}>
          <div className="flex items-start justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-tg-text">Basic</h3>
                {plan === 'basic' && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>המסלול שלך</span>
                )}
              </div>
              <div className="flex items-baseline gap-1 mt-1">
                <p className="text-xl font-bold text-tg-text">$29</p>
                <span className="text-xs text-tg-muted">/ חודש</span>
              </div>
              <p className="text-xs text-tg-muted mt-0.5">או $299 / שנה · חסכון של $50</p>
            </div>
            {plan === 'free' && <span className="text-xs text-tg-muted mt-1">3 ימי ניסיון</span>}
          </div>
          <ul className="flex flex-col gap-1.5 mb-4">
            {[
              'עסקה אחת ביום',
              'תחקיר AI אחד ביום',
              'דפוס רגשי מרכזי + המלצה + ציון',
              'מנגנון ערעור על משוב AI',
              'לוח ביצועים — שבועיים אחורה',
              'סיכום שבועי AI',
              'עד 3 חוקים אישיים',
              'טריגרים: מספר עסקאות, הפסד יומי',
              'פעולות: התראה ואזהרה בלבד',
              'ייצוא CSV — שבועיים אחורה',
            ].map((f) => <PlanFeature key={f} text={f} />)}
          </ul>
          {plan === 'free' && (
            <button
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-150 active:scale-95"
              style={{ background: 'linear-gradient(135deg, var(--color-tg-primary), #8b5cf6)' }}
            >
              שדרג ל-Basic
            </button>
          )}
        </div>

        {/* Pro */}
        <div className="rounded-2xl border-2 p-4 relative overflow-hidden" style={{
          borderColor: plan === 'pro' ? '#f59e0b' : 'var(--color-tg-border)',
          background: 'var(--color-tg-surface)',
        }}>
          <div className="absolute top-3 left-3">
            {plan === 'pro' ? (
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>המסלול שלך</span>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-xs font-bold" style={{ background: 'linear-gradient(135deg, #f59e0b, #ef4444)', color: 'white' }}>
                פופולרי
              </span>
            )}
          </div>
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold text-tg-text">Pro</h3>
              <div className="flex items-baseline gap-1 mt-1">
                <p className="text-xl font-bold text-tg-text">$49</p>
                <span className="text-xs text-tg-muted">/ חודש</span>
              </div>
              <p className="text-xs text-tg-muted mt-0.5">או $499 / שנה · חסכון של $90</p>
            </div>
            {plan !== 'pro' && <span className="text-xs text-tg-muted mt-1">3 ימי ניסיון</span>}
          </div>
          <ul className="flex flex-col gap-1.5 mb-4">
            {[
              'עסקאות ותחקירים ללא הגבלה',
              'עומק תחקיר מלא — כל הדפוסים הרגשיים',
              'השוואה לעסקאות דומות בעבר',
              'זיהוי שעות חולשה',
              'לוח ביצועים ללא הגבלה',
              'מפת חום זמנים',
              'פילטרים עד שנה + טווח מותאם',
              'סיכום שבועי מלא עם ציטוט מהסוחר',
              'התראות דפוס בזמן אמת',
              'חוקים אישיים ללא הגבלה',
              'כל הטריגרים + פעולות מלאות',
              'נעילה עם טיימר + חסימה עצמית מלאה',
              'ייצוא CSV ו-Excel ללא הגבלה',
            ].map((f) => <PlanFeature key={f} text={f} pro />)}
          </ul>
          {plan !== 'pro' && (
            <button
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-150 active:scale-95"
              style={{ background: 'linear-gradient(135deg, #f59e0b, #ef4444)' }}
            >
              שדרג ל-Pro
            </button>
          )}
        </div>

        <p className="text-xs text-tg-muted text-center px-2">
          אינטגרציה עתידית: Binance · Interactive Brokers · eToro
        </p>
      </div>
    </div>
  );
}

function PlanFeature({ text, disabled, pro }: { text: string; disabled?: boolean; pro?: boolean }) {
  return (
    <li className="flex items-center gap-2">
      {disabled ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={pro ? '#f59e0b' : 'var(--color-tg-success)'} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className={`text-xs ${disabled ? 'text-tg-muted line-through' : 'text-tg-text-2'}`}>{text}</span>
    </li>
  );
}

function tradingTypeLabel(v?: string) {
  const map: Record<string, string> = { day: 'Day Trading', swing: 'Swing Trading', crypto: 'Crypto Trading' };
  return v ? (map[v] ?? v) : '—';
}
function marketLabel(v?: string) {
  const map: Record<string, string> = { stocks: 'מניות', crypto: 'קריפטו', forex: 'פורקס' };
  return v ? (map[v] ?? v) : '—';
}
function experienceLabel(v?: string) {
  const map: Record<string, string> = { beginner: 'מתחיל', intermediate: 'בינוני', advanced: 'מתקדם' };
  return v ? (map[v] ?? v) : '—';
}
