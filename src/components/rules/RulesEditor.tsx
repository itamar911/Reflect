'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import PresetRulesPanel from './PresetRulesPanel';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { Lock, ClipboardList } from 'lucide-react';
import {
  CONDITION_LABELS,
  ACTION_LABELS,
  COOLDOWN_MINUTE_OPTIONS,
  formatCooldownMinutes,
  conditionNeedsThreshold,
  describeCustomRule,
} from '@/lib/validators/RulesetValidator';
import type { PresetRules, CustomRule, ConditionType, ActionType } from '@/lib/types';

type Tab = 'preset' | 'custom';
type Plan = 'free' | 'basic' | 'pro';

interface RulesEditorProps {
  presetRules: PresetRules;
  customRules: CustomRule[];
  userId: string;
  plan?: Plan;
}

const ACTION_VARIANTS: Record<ActionType, 'warning' | 'danger'> = {
  warn: 'warning',
  block_day: 'danger',
  block_timer: 'danger',
};

const CONDITION_TYPES = Object.keys(CONDITION_LABELS) as ConditionType[];
const ACTION_TYPES = Object.keys(ACTION_LABELS) as ActionType[];

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
            'הפסד יומי עבר אחוז מהתיק (%) ← חסום כניסה לעסקה נוספת',
            'השעה עברה 21:00 (24h) ← חסום עם טיימר',
            'הרגשתי FOMO בעסקה האחרונה ← הצג אזהרה בלבד',
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
          <span className="text-sm font-semibold text-tg-text">{rule.name}</span>
          <Badge variant={ACTION_VARIANTS[rule.action_type]}>
            {ACTION_LABELS[rule.action_type]}
            {rule.action_type === 'block_timer' && rule.cooldown_minutes ? ` · ${formatCooldownMinutes(rule.cooldown_minutes)}` : ''}
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

      <div className="flex gap-2 text-xs">
        <span className="px-2 py-0.5 rounded-md font-medium shrink-0"
          style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
          אם
        </span>
        <span className="text-tg-text-2">{describeCustomRule(rule)}</span>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between mt-3">
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

function CustomRuleBuilder({
  userId, plan, onSave, onCancel,
}: {
  userId: string;
  plan: Plan;
  onSave: (rule: CustomRule) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: describeCustomRule({ condition_type: 'daily_loss_dollar', threshold_value: 200 }),
    nameTouched: false,
    condition_type: 'daily_loss_dollar' as ConditionType,
    threshold_value: '200',
    action_type: 'warn' as ActionType,
    cooldown_minutes: String(COOLDOWN_MINUTE_OPTIONS[1].minutes),
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const needsThreshold = conditionNeedsThreshold(form.condition_type);

  function applyCondition(condition_type: ConditionType) {
    const threshold = needsThresholdFor(condition_type) ? form.threshold_value || '1' : '';
    setForm((f) => ({
      ...f,
      condition_type,
      threshold_value: threshold,
      name: f.nameTouched ? f.name : describeCustomRule({ condition_type, threshold_value: threshold ? parseFloat(threshold) : null }),
    }));
  }

  function needsThresholdFor(c: ConditionType) {
    return conditionNeedsThreshold(c);
  }

  function applyThreshold(value: string) {
    setForm((f) => ({
      ...f,
      threshold_value: value,
      name: f.nameTouched ? f.name : describeCustomRule({ condition_type: f.condition_type, threshold_value: value ? parseFloat(value) : null }),
    }));
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'שם החוק חובה';
    if (needsThreshold && (form.threshold_value.trim() === '' || isNaN(parseFloat(form.threshold_value)))) {
      e.threshold_value = 'יש להזין ערך';
    }
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
        name: form.name.trim(),
        condition_type: form.condition_type,
        threshold_value: needsThreshold ? parseFloat(form.threshold_value) : null,
        action_type: form.action_type,
        cooldown_minutes: form.action_type === 'block_timer' ? parseInt(form.cooldown_minutes) : null,
        is_active: true,
      })
      .select()
      .single();

    if (!error && data) onSave(data as CustomRule);
    setLoading(false);
  }

  const isBlockLocked = plan === 'basic';

  return (
    <div className="p-4 rounded-2xl border border-tg-primary/30 flex flex-col gap-4 animate-fade-in"
      style={{ background: 'var(--color-tg-surface)' }}>
      <h3 className="text-sm font-semibold text-tg-text">חוק חדש</h3>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-tg-text-2">שם החוק</label>
        <input
          type="text"
          maxLength={50}
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value, nameTouched: true })}
          className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: errors.name ? 'var(--color-tg-danger)' : 'var(--color-tg-border)' }}
        />
        {errors.name && <p className="text-xs text-tg-danger">{errors.name}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-tg-text-2">תנאי</label>
        <select
          value={form.condition_type}
          onChange={(e) => applyCondition(e.target.value as ConditionType)}
          className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}
        >
          {CONDITION_TYPES.map((c) => (
            <option key={c} value={c}>{CONDITION_LABELS[c]}</option>
          ))}
        </select>
      </div>

      {needsThreshold && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-tg-text-2">ערך</label>
          <input
            type="number"
            value={form.threshold_value}
            onChange={(e) => applyThreshold(e.target.value)}
            className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary transition-colors"
            style={{ background: 'var(--color-tg-surface-2)', borderColor: errors.threshold_value ? 'var(--color-tg-danger)' : 'var(--color-tg-border)' }}
          />
          {errors.threshold_value && <p className="text-xs text-tg-danger">{errors.threshold_value}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-tg-text-2">פעולה</label>
        <div className="grid grid-cols-1 gap-2">
          {ACTION_TYPES.map((key) => {
            const disabled = isBlockLocked && key !== 'warn';
            return (
              <button
                key={key}
                type="button"
                onClick={() => !disabled && setForm({ ...form, action_type: key })}
                className="py-2 px-3 rounded-xl text-xs font-medium border transition-all duration-150 text-center flex items-center justify-center gap-1"
                style={{
                  background: form.action_type === key ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                  borderColor: form.action_type === key ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                  color: form.action_type === key ? 'var(--color-tg-primary)' : disabled ? 'var(--color-tg-muted)' : 'var(--color-tg-text-2)',
                  opacity: disabled ? 0.6 : 1,
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                {ACTION_LABELS[key]}
                {disabled && <span className="text-[10px] font-bold" style={{ color: '#00d2d2' }}>Pro</span>}
              </button>
            );
          })}
        </div>
        {isBlockLocked && (
          <p className="text-xs text-tg-muted">חסימות זמינות ב-Pro · ב-Basic ניתן להציג אזהרה בלבד</p>
        )}

        {form.action_type === 'block_timer' && (
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl"
            style={{ background: 'var(--color-tg-surface-2)' }}>
            <label className="text-xs font-medium text-tg-text-2">משך הנעילה</label>
            <select
              value={form.cooldown_minutes}
              onChange={(e) => setForm({ ...form, cooldown_minutes: e.target.value })}
              className="w-24 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary text-center"
              style={{ background: 'var(--color-tg-surface)', borderColor: 'var(--color-tg-border)' }}
            >
              {COOLDOWN_MINUTE_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-1">
        <Button variant="secondary" onClick={onCancel} className="flex-1">ביטול</Button>
        <Button onClick={handleSave} loading={loading} className="flex-1">שמור חוק</Button>
      </div>
    </div>
  );
}
