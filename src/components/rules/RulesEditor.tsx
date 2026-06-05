'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import PresetRulesPanel from './PresetRulesPanel';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { Lock, ClipboardList } from 'lucide-react';
import type { PresetRules, CustomRule, Enforcement } from '@/lib/types';

type Tab = 'preset' | 'custom';
type Plan = 'free' | 'basic' | 'pro';

interface RulesEditorProps {
  presetRules: PresetRules;
  customRules: CustomRule[];
  userId: string;
  plan?: Plan;
}

const ENFORCEMENT_LABELS: Record<Enforcement, string> = {
  reminder: 'התראה',
  warning: 'אזהרה',
  block: 'נעילה עם טיימר',
};
const ENFORCEMENT_VARIANTS: Record<Enforcement, 'default' | 'warning' | 'danger'> = {
  reminder: 'default',
  warning: 'warning',
  block: 'danger',
};

export default function RulesEditor({ presetRules: initialPreset, customRules: initialCustom, userId, plan = 'free' }: RulesEditorProps) {
  const [tab, setTab] = useState<Tab>('preset');
  const [preset, setPreset] = useState<PresetRules>(initialPreset);
  const [customRules, setCustomRules] = useState<CustomRule[]>(initialCustom);
  const [showBuilder, setShowBuilder] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {/* Tabs */}
      <div className="flex rounded-xl p-1 gap-1"
        style={{ background: 'var(--color-tg-surface-2)' }}>
        {(['preset', 'custom'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all duration-150 flex items-center justify-center gap-1.5"
            style={{
              background: tab === t ? 'var(--color-tg-surface)' : 'transparent',
              color: tab === t ? 'var(--color-tg-text)' : 'var(--color-tg-text-2)',
              boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
            }}
          >
            {t === 'preset' ? 'חוקים מובנים' : (
              <>
                חוקים אישיים{customRules.length > 0 ? ` (${customRules.length})` : ''}
                {plan === 'free' && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
                  </svg>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      {tab === 'preset' && (
        <PresetRulesPanel rules={preset} onSave={setPreset} plan={plan} />
      )}

      {tab === 'custom' && (
        <CustomRulesTab
          rules={customRules}
          userId={userId}
          onUpdate={setCustomRules}
          showBuilder={showBuilder}
          setShowBuilder={setShowBuilder}
          plan={plan}
        />
      )}
    </div>
  );
}

function CustomRulesTab({
  rules, userId, onUpdate, showBuilder, setShowBuilder, plan,
}: {
  rules: CustomRule[];
  userId: string;
  onUpdate: (r: CustomRule[]) => void;
  showBuilder: boolean;
  setShowBuilder: (v: boolean) => void;
  plan: Plan;
}) {
  const maxRules = plan === 'basic' ? 3 : plan === 'pro' ? Infinity : 0;
  const canAdd = rules.length < maxRules;

  if (plan === 'free') {
    return (
      <div className="text-center py-10">
        <div className="mb-3"><Lock size={36} /></div>
        <p className="text-sm font-medium text-tg-text mb-1">חוקים אישיים זמינים ב-Basic ומעלה</p>
        <p className="text-xs text-tg-muted mb-5">עד 3 חוקים ב-Basic · ללא הגבלה ב-Pro</p>
        <div className="flex flex-col gap-2 text-right px-2 mb-5">
          {[
            'אם הפסדתי יותר מ-3% היום ← לא להיכנס לעסקה נוספת',
            'אם מסחר אחרי 21:00 ← לא לפתוח עסקות חדשות',
            'אם הרגשתי FOMO בעסקה הקודמת ← לקחת הפסקה של שעה',
          ].map((ex) => (
            <div key={ex} className="flex items-start gap-2 px-3 py-2 rounded-xl text-xs text-tg-muted"
              style={{ background: 'var(--color-tg-surface-2)' }}>
              <span>{ex}</span>
            </div>
          ))}
        </div>
        <Button variant="secondary" onClick={() => {}}>שדרג ל-Basic</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {plan === 'basic' && (
        <div className="flex items-center justify-between px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}>
          <span>חוקים אישיים: {rules.length} / 3</span>
          {rules.length >= 3 && <span style={{ color: 'var(--color-tg-warning)' }}>הגעת למגבלה · שדרג ל-Pro לחוקים נוספים</span>}
        </div>
      )}

      {rules.length === 0 && !showBuilder && (
        <div className="text-center py-10">
          <div className="mb-2"><ClipboardList size={36} /></div>
          <p className="text-sm text-tg-text-2 mb-4">אין עדיין חוקים אישיים</p>
          <Button onClick={() => setShowBuilder(true)}>+ הוסף חוק ראשון</Button>
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex flex-col gap-3">
          {rules.map((rule) => (
            <CustomRuleCard
              key={rule.id}
              rule={rule}
              onToggle={async (id, active) => {
                const supabase = createClient();
                await supabase.from('custom_rules').update({ is_active: active }).eq('id', id);
                onUpdate(rules.map((r) => r.id === id ? { ...r, is_active: active } : r));
              }}
              onDelete={async (id) => {
                const supabase = createClient();
                await supabase.from('custom_rules').delete().eq('id', id);
                onUpdate(rules.filter((r) => r.id !== id));
              }}
            />
          ))}
          {canAdd && (
            <Button variant="secondary" onClick={() => setShowBuilder(true)} className="mt-2">
              + הוסף חוק
            </Button>
          )}
        </div>
      )}

      {showBuilder && (
        <CustomRuleBuilder
          userId={userId}
          plan={plan}
          onSave={(rule) => {
            onUpdate([...rules, rule]);
            setShowBuilder(false);
          }}
          onCancel={() => setShowBuilder(false)}
        />
      )}
    </div>
  );
}

function CustomRuleCard({
  rule, onToggle, onDelete,
}: {
  rule: CustomRule;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className="p-4 rounded-2xl border transition-all duration-150"
      style={{
        background: 'var(--color-tg-surface)',
        borderColor: rule.is_active ? 'var(--color-tg-border-light)' : 'var(--color-tg-border)',
        opacity: rule.is_active ? 1 : 0.6,
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-tg-text">{rule.rule_name}</span>
          <Badge variant={ENFORCEMENT_VARIANTS[rule.enforcement]}>
            {ENFORCEMENT_LABELS[rule.enforcement]}
          </Badge>
        </div>
        <button
          onClick={() => onDelete(rule.id)}
          className="text-tg-muted hover:text-tg-danger transition-colors shrink-0"
          title="מחק חוק"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col gap-1.5 mb-3">
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-0.5 rounded-md font-medium shrink-0"
            style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
            אם
          </span>
          <span className="text-tg-text-2">{rule.trigger_condition}</span>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="px-2 py-0.5 rounded-md font-medium shrink-0"
            style={{ background: 'var(--color-tg-success-muted)', color: 'var(--color-tg-success)' }}>
            אז
          </span>
          <span className="text-tg-text-2">{rule.action_required}</span>
        </div>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-tg-muted">{rule.is_active ? 'פעיל' : 'כבוי'}</span>
        <button
          onClick={() => onToggle(rule.id, !rule.is_active)}
          className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
          style={{ background: rule.is_active ? 'var(--color-tg-primary)' : 'var(--color-tg-border)' }}
        >
          <span
            className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm"
            style={{ transform: rule.is_active ? 'translateX(-18px)' : 'translateX(-2px)' }}
          />
        </button>
      </div>
    </div>
  );
}

const TRIGGER_EXAMPLES_BASIC = [
  'כמות העסקאות היום עברה 3',
  'ההפסד היומי עבר $200',
  'השוק עלה ביותר מ-2% בשעה האחרונה',
];

const TRIGGER_EXAMPLES_PRO = [
  'השעה היא אחרי 21:00',
  'יום שני (תחילת שבוע)',
  'הרגשתי FOMO בעסקה האחרונה',
  'ירידה רצופה של 3 עסקאות',
];

const ACTION_EXAMPLES = [
  'לא להיכנס לעסקה נוספת היום',
  'להמתין 30 דקות לפני כניסה',
  'לקחת הפסקה של שעה',
  'לסגור את כל הפוזיציות הפתוחות',
];

function CustomRuleBuilder({
  userId, plan, onSave, onCancel,
}: {
  userId: string;
  plan: Plan;
  onSave: (rule: CustomRule) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    rule_name: '',
    trigger_condition: '',
    action_required: '',
    enforcement: 'warning' as Enforcement,
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    if (!form.rule_name.trim()) e.rule_name = 'שם החוק חובה';
    if (!form.trigger_condition.trim()) e.trigger_condition = 'תנאי הטריגר חובה';
    if (!form.action_required.trim()) e.action_required = 'הפעולה חובה';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase
      .from('custom_rules')
      .insert({
        user_id: userId,
        rule_name: form.rule_name.trim(),
        trigger_condition: form.trigger_condition.trim(),
        action_required: form.action_required.trim(),
        enforcement: form.enforcement,
        is_active: true,
      })
      .select()
      .single();

    if (!error && data) onSave(data as CustomRule);
    setLoading(false);
  }

  return (
    <div className="p-4 rounded-2xl border border-tg-primary/30 flex flex-col gap-4 animate-fade-in"
      style={{ background: 'var(--color-tg-surface)' }}>
      <h3 className="text-sm font-semibold text-tg-text">חוק חדש — אם/אז</h3>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-tg-text-2">שם החוק</label>
        <input
          type="text"
          maxLength={50}
          placeholder='לדוגמה: "הפסד גדול ביום"'
          value={form.rule_name}
          onChange={(e) => setForm({ ...form, rule_name: e.target.value })}
          className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: errors.rule_name ? 'var(--color-tg-danger)' : 'var(--color-tg-border)' }}
        />
        {errors.rule_name && <p className="text-xs text-tg-danger">{errors.rule_name}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-md text-xs font-medium"
            style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
            אם (טריגר)
          </span>
        </div>
        <textarea
          rows={2}
          placeholder='לדוגמה: "הפסדתי יותר מ-3% מההון היום"'
          value={form.trigger_condition}
          onChange={(e) => setForm({ ...form, trigger_condition: e.target.value })}
          className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors resize-none"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: errors.trigger_condition ? 'var(--color-tg-danger)' : 'var(--color-tg-border)' }}
        />
        {errors.trigger_condition && <p className="text-xs text-tg-danger">{errors.trigger_condition}</p>}
        <div className="flex flex-col gap-1">
          <p className="text-xs text-tg-muted">דוגמאות מהירות:</p>
          <div className="flex flex-wrap gap-1.5">
            {TRIGGER_EXAMPLES_BASIC.map((ex) => (
              <button key={ex} type="button"
                onClick={() => setForm({ ...form, trigger_condition: ex })}
                className="px-2 py-1 rounded-lg text-xs border transition-all duration-150"
                style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text-2)' }}>
                {ex}
              </button>
            ))}
            {TRIGGER_EXAMPLES_PRO.map((ex) => (
              <button key={ex} type="button"
                onClick={plan === 'pro' ? () => setForm({ ...form, trigger_condition: ex }) : undefined}
                className="px-2 py-1 rounded-lg text-xs border flex items-center gap-1"
                style={{
                  background: 'var(--color-tg-surface-2)',
                  borderColor: 'var(--color-tg-border)',
                  color: plan === 'pro' ? 'var(--color-tg-text-2)' : 'var(--color-tg-muted)',
                  opacity: plan === 'pro' ? 1 : 0.6,
                  cursor: plan === 'pro' ? 'pointer' : 'default',
                }}>
                {ex}
                {plan !== 'pro' && <span className="text-[10px] font-bold" style={{ color: '#00d2d2' }}>Pro</span>}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded-md text-xs font-medium"
            style={{ background: 'var(--color-tg-success-muted)', color: 'var(--color-tg-success)' }}>
            אז (פעולה)
          </span>
        </div>
        <textarea
          rows={2}
          placeholder='לדוגמה: "לא להיכנס לעסקה נוספת היום"'
          value={form.action_required}
          onChange={(e) => setForm({ ...form, action_required: e.target.value })}
          className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors resize-none"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: errors.action_required ? 'var(--color-tg-danger)' : 'var(--color-tg-border)' }}
        />
        {errors.action_required && <p className="text-xs text-tg-danger">{errors.action_required}</p>}
        <div className="flex flex-col gap-1">
          <p className="text-xs text-tg-muted">דוגמאות מהירות:</p>
          <div className="flex flex-wrap gap-1.5">
            {ACTION_EXAMPLES.map((ex) => (
              <button key={ex} type="button"
                onClick={() => setForm({ ...form, action_required: ex })}
                className="px-2 py-1 rounded-lg text-xs border transition-all duration-150"
                style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text-2)' }}>
                {ex}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Enforcement */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-tg-text-2">עוצמת האכיפה</label>
        <div className="grid grid-cols-2 gap-2">
          {(Object.entries(ENFORCEMENT_LABELS) as [Enforcement, string][]).map(([key, label]) => {
            const isBasicLocked = plan === 'basic' && key === 'block';
            const disabled = isBasicLocked;
            return (
              <button
                key={key}
                type="button"
                onClick={() => !disabled && setForm({ ...form, enforcement: key })}
                className="py-2 px-2 rounded-xl text-xs font-medium border transition-all duration-150 text-center flex items-center justify-center gap-1"
                style={{
                  background: form.enforcement === key ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                  borderColor: form.enforcement === key ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                  color: form.enforcement === key ? 'var(--color-tg-primary)' : disabled ? 'var(--color-tg-muted)' : 'var(--color-tg-text-2)',
                  opacity: disabled ? 0.6 : 1,
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                {label}
                {isBasicLocked && <span className="text-[10px] font-bold" style={{ color: '#00d2d2' }}>Pro</span>}
              </button>
            );
          })}
          {/* Self-block — Pro only */}
          <button
            type="button"
            onClick={() => {}}
            className="py-2 px-2 rounded-xl text-xs font-medium border text-center flex items-center justify-center gap-1"
            style={{
              background: 'var(--color-tg-surface-2)',
              borderColor: 'var(--color-tg-border)',
              color: 'var(--color-tg-muted)',
              opacity: 0.6,
              cursor: 'default',
            }}
          >
            חסימה עצמית מלאה
            <span className="text-[10px] font-bold" style={{ color: '#00d2d2' }}>Pro</span>
          </button>
        </div>
        {plan !== 'pro' && (
          <p className="text-xs text-tg-muted">נעילה וחסימה עצמית מלאה זמינות ב-Pro</p>
        )}
        {/* Self-block explanation — always visible */}
        <div className="flex items-start gap-2 p-3 rounded-xl"
          style={{ background: 'rgba(0,210,210,0.08)', border: '1px solid rgba(0,210,210,0.2)' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00d2d2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <div>
            <p className="text-xs font-semibold" style={{ color: '#00d2d2' }}>חסימה עצמית מלאה — Pro</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-tg-text-2)' }}>
              כשהחוק מופעל — לא ניתן להגיש תוכנית עסקה. לא ניתן לעקוף. אתה בוחר מראש לחסום את עצמך. הסבר מלא יוצג לפני ההפעלה.
            </p>
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-1">
        <Button variant="secondary" onClick={onCancel} className="flex-1">ביטול</Button>
        <Button onClick={handleSave} loading={loading} className="flex-1">שמור חוק</Button>
      </div>
    </div>
  );
}
