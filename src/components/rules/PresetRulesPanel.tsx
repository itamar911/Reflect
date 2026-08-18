'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import { COOLDOWN_MINUTE_OPTIONS } from '@/lib/validators/RulesetValidator';
import type { PresetRules, TradeStrategy } from '@/lib/types';
import type { PlanTier } from '@/lib/plans/config';

const STRATEGIES: TradeStrategy[] = ['Breakout', 'Trend Follow', 'Reversal', 'Range', 'Custom'];

interface PresetRulesPanelProps {
  rules: PresetRules;
  onSave: (rules: PresetRules) => void;
  plan?: PlanTier;
}

export default function PresetRulesPanel({ rules, onSave, plan = 'free' }: PresetRulesPanelProps) {
  const readOnly = plan === 'free';
  const [form, setForm] = useState({
    min_rr_ratio: String(rules.min_rr_ratio),
    max_daily_trades: String(rules.max_daily_trades),
    cooldown_after_losses: String(rules.cooldown_after_losses),
    cooldown_minutes: rules.cooldown_minutes ? String(rules.cooldown_minutes) : '',
    max_daily_loss: rules.max_daily_loss ? String(rules.max_daily_loss) : '',
    min_emotional_state: rules.min_emotional_state,
    allowed_strategies: rules.allowed_strategies,
  });
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  function toggleStrategy(s: TradeStrategy) {
    setForm((f) => ({
      ...f,
      allowed_strategies: f.allowed_strategies.includes(s)
        ? f.allowed_strategies.filter((x) => x !== s)
        : [...f.allowed_strategies, s],
    }));
  }

  async function handleSave() {
    setLoading(true);
    setError('');
    const supabase = createClient();

    const updates = {
      min_rr_ratio: parseFloat(form.min_rr_ratio) || 2,
      max_daily_trades: parseInt(form.max_daily_trades) || 5,
      cooldown_after_losses: parseInt(form.cooldown_after_losses) || 3,
      cooldown_minutes: form.cooldown_minutes ? parseInt(form.cooldown_minutes) : null,
      max_daily_loss: form.max_daily_loss ? parseFloat(form.max_daily_loss) : null,
      min_emotional_state: form.min_emotional_state,
      allowed_strategies: form.allowed_strategies,
      updated_at: new Date().toISOString(),
    };

    const { data, error: dbError } = await supabase
      .from('preset_rules')
      .update(updates)
      .eq('id', rules.id)
      .select()
      .single();

    if (dbError) {
      setError('שגיאה בשמירה. נסה שוב.');
    } else {
      onSave(data as PresetRules);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-6">
      {readOnly ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <span>במסלול חינמי החוקים קבועים ולא ניתנים לעריכה · <span style={{ color: 'var(--color-tg-primary)' }}>שדרג ל-Basic לעריכה מלאה</span></span>
        </div>
      ) : (
        <p className="text-sm text-tg-text-2">
          חוקים אלה יאומתו אוטומטית לפני כל עסקה. שנה ערכים לפי הצורך.
        </p>
      )}

      {/* R:R Minimum */}
      <RuleRow
        controlId="rule-min-rr"
        label="R:R מינימלי לעסקה"
        description="עסקה תחסם אם יחס הסיכון/תגמול נמוך מערך זה"
        score="20 נק׳ משמעת"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-tg-text-2">1:</span>
          <input
            type="number"
            min={0.5}
            max={10}
            step={0.5}
            id="rule-min-rr"
            aria-describedby="rule-min-rr-label-desc"
            value={form.min_rr_ratio}
            onChange={(e) => !readOnly && setForm({ ...form, min_rr_ratio: e.target.value })}
            readOnly={readOnly}
            className="w-20 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary text-center"
            style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', opacity: readOnly ? 0.7 : 1 }}
          />
        </div>
      </RuleRow>

      {/* Max daily trades */}
      <RuleRow
        controlId="rule-max-daily-trades"
        label="מקסימום עסקאות ביום"
        description="חריגה מהמגבלה תפעיל את מנגנון ה-Cooldown"
        score="15 נק׳ משמעת"
      >
        <input
          type="number"
          min={1}
          max={50}
          step={1}
          id="rule-max-daily-trades"
          aria-describedby="rule-max-daily-trades-label-desc"
          value={form.max_daily_trades}
          onChange={(e) => !readOnly && setForm({ ...form, max_daily_trades: e.target.value })}
          readOnly={readOnly}
          className="w-20 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary text-center"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', opacity: readOnly ? 0.7 : 1 }}
        />
      </RuleRow>

      {/* Cooldown after losses */}
      <RuleRow
        controlId="rule-cooldown-after-losses"
        label="Cooldown אחרי N הפסדים רצופים"
        description="נעילה זמנית אחרי סדרת הפסדות"
      >
        <input
          type="number"
          min={1}
          max={10}
          step={1}
          id="rule-cooldown-after-losses"
          aria-describedby="rule-cooldown-after-losses-label-desc"
          value={form.cooldown_after_losses}
          onChange={(e) => !readOnly && setForm({ ...form, cooldown_after_losses: e.target.value })}
          readOnly={readOnly}
          className="w-20 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary text-center"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', opacity: readOnly ? 0.7 : 1 }}
        />
      </RuleRow>

      {/* Cooldown duration */}
      <RuleRow
        controlId="rule-cooldown-minutes"
        label="משך ה-Cooldown"
        description="כמה זמן תיחסם כניסה לעסקה חדשה לאחר הפעלת ה-Cooldown — ריק = ללא הגבלת זמן"
      >
        <select
          id="rule-cooldown-minutes"
          aria-describedby="rule-cooldown-minutes-label-desc"
          value={form.cooldown_minutes}
          onChange={(e) => !readOnly && setForm({ ...form, cooldown_minutes: e.target.value })}
          disabled={readOnly}
          className="w-28 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary text-center"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', opacity: readOnly ? 0.7 : 1 }}
        >
          <option value="">ללא הגבלה</option>
          {COOLDOWN_MINUTE_OPTIONS.map((o) => (
            <option key={o.minutes} value={o.minutes}>{o.label}</option>
          ))}
        </select>
      </RuleRow>

      {/* Max daily loss */}
      <RuleRow
        controlId="rule-max-daily-loss"
        label="הפסד יומי מקסימלי ($)"
        description="עצירה כשחורגים מגבול ההפסד — ריק = ללא הגבלה"
      >
        <input
          type="number"
          min={0}
          step={10}
          placeholder="ללא הגבלה"
          id="rule-max-daily-loss"
          aria-describedby="rule-max-daily-loss-label-desc"
          value={form.max_daily_loss}
          onChange={(e) => !readOnly && setForm({ ...form, max_daily_loss: e.target.value })}
          readOnly={readOnly}
          className="w-32 h-9 px-3 rounded-xl text-sm text-tg-text border focus:outline-none focus:border-tg-primary"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', opacity: readOnly ? 0.7 : 1 }}
        />
      </RuleRow>

      {/* Min emotional state */}
      <RuleRow
        label="מצב רגשי מינימלי לכניסה"
        description="אזהרה/חסימה אם מתחת לסף"
      >
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              onClick={() => !readOnly && setForm({ ...form, min_emotional_state: n })}
              className="hit-40 relative w-9 h-9 rounded-xl text-sm font-medium border transition-all duration-150"
              style={{
                background: form.min_emotional_state === n ? 'var(--color-tg-primary)' : 'var(--color-tg-surface-2)',
                borderColor: form.min_emotional_state === n ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                color: form.min_emotional_state === n ? 'white' : 'var(--color-tg-text-2)',
                opacity: readOnly ? 0.7 : 1,
                cursor: readOnly ? 'default' : 'pointer',
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </RuleRow>

      {/* Allowed strategies */}
      <RuleRow
        label="אסטרטגיות מותרות"
        description="רשימה לבנה — עסקאות עם אסטרטגיה שאינה ברשימה יקבלו אזהרה"
      >
        <div className="flex flex-wrap gap-2 mt-1">
          {STRATEGIES.map((s) => (
            <button
              key={s}
              onClick={() => !readOnly && toggleStrategy(s)}
              className="px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150"
              style={{
                background: form.allowed_strategies.includes(s) ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface-2)',
                borderColor: form.allowed_strategies.includes(s) ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                color: form.allowed_strategies.includes(s) ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
                opacity: readOnly ? 0.7 : 1,
                cursor: readOnly ? 'default' : 'pointer',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </RuleRow>

      {/* Actions */}
      {!readOnly && (
        <>
          {error && (
            <p className="text-sm text-tg-danger px-3 py-2 rounded-xl"
              style={{ background: 'var(--color-tg-danger-muted)' }}>
              {error}
            </p>
          )}
          {saved && (
            <p className="text-sm text-tg-success px-3 py-2 rounded-xl"
              style={{ background: 'var(--color-tg-success-muted)' }}>
              החוקים נשמרו ויופעלו בעסקה הבאה
            </p>
          )}
          <Button onClick={handleSave} loading={loading}>
            שמור חוקים
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * The row's visible heading is the control's label — `controlId` wires it up as
 * a real `<label for>` so clicking it focuses the field and screen readers
 * announce it. Rows whose control is a group of buttons (no single labelable
 * element) pass no `controlId` and get `role="group"` + `aria-labelledby`
 * instead. The description below the heading becomes the field's
 * `aria-describedby`, so the "what this rule does" text is announced too.
 */
function RuleRow({
  label,
  description,
  score,
  controlId,
  children,
}: {
  label: string;
  description: string;
  score?: string;
  controlId?: string;
  children: React.ReactNode;
}) {
  const labelId = `${controlId ?? label}-label`;
  const Heading = controlId ? 'label' : 'p';
  return (
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-5 border-b border-tg-border last:border-0 last:pb-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Heading
            id={labelId}
            htmlFor={controlId}
            className="text-sm font-medium text-tg-text"
          >
            {label}
          </Heading>
          {score && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold"
              style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
              {score}
            </span>
          )}
        </div>
        <p id={`${labelId}-desc`} className="text-xs text-tg-text-2 mt-0.5">{description}</p>
      </div>
      {controlId ? (
        <div className="shrink-0">{children}</div>
      ) : (
        <div className="shrink-0" role="group" aria-labelledby={labelId} aria-describedby={`${labelId}-desc`}>
          {children}
        </div>
      )}
    </div>
  );
}
