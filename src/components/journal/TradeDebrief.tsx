'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface TradeDebriefProps {
  tradeId: string;
  existingAnswer?: string | null;
}

export default function TradeDebrief({ tradeId, existingAnswer }: TradeDebriefProps) {
  const [answer, setAnswer] = useState(existingAnswer ?? '');
  const [editing, setEditing] = useState(!existingAnswer);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    if (!answer.trim()) return;
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('trade_plans')
      .update({
        debrief_answer: answer.trim(),
        debrief_submitted_at: new Date().toISOString(),
      })
      .eq('id', tradeId);
    setSaving(false);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2500);
  }

  if (!editing && answer) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium" style={{ color: 'var(--color-tg-primary)' }}>תחקיר עצמי</p>
          <button
            onClick={() => setEditing(true)}
            className="text-xs transition-colors"
            style={{ color: 'var(--color-tg-text-2)' }}
          >
            ערוך
          </button>
        </div>
        <div className="px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}>
          {answer}
        </div>
        {saved && (
          <p className="text-xs" style={{ color: 'var(--color-tg-success)' }}>✓ נשמר</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-xs font-medium text-tg-text">מה גרם לך לצאת?</p>
      </div>
      <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
        המערכת לא שופטת — היא שואלת. ענה בכנות לעצמך.
      </p>
      <textarea
        rows={2}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="ספר מה קרה... הגעתי ל-SL? יצאתי מוקדם? פחדתי?"
        className="w-full px-3 py-2.5 rounded-xl text-xs border focus:outline-none transition-colors resize-none"
        style={{
          background: 'var(--color-tg-surface-2)',
          borderColor: 'var(--color-tg-border)',
          color: 'var(--color-tg-text)',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-tg-primary)'; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-tg-border)'; }}
      />
      <div className="flex gap-2">
        {existingAnswer && (
          <button
            onClick={() => { setAnswer(existingAnswer); setEditing(false); }}
            className="flex-1 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150"
            style={{ borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text-2)', background: 'transparent' }}
          >
            ביטול
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !answer.trim()}
          className="flex-1 py-1.5 rounded-xl text-xs font-semibold text-white transition-all duration-150 disabled:opacity-50"
          style={{ background: 'var(--color-tg-primary)' }}
        >
          {saving ? 'שומר...' : 'הגש תחקיר'}
        </button>
      </div>
    </div>
  );
}
