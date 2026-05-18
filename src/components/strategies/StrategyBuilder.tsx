'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';

export interface PersonalStrategy {
  id: string;
  user_id: string;
  name: string;
  description: string;
  direction: 'long' | 'short' | 'both';
  stop_loss_points: number | null;
  take_profit_points: number | null;
  risk_rules: string;
  preferred_hours: string;
  markets: string[];
  is_builtin: boolean;
  created_at: string;
}

const BUILTIN_TEMPLATES = [
  { name: 'Asia Range Breakout', description: 'כניסה על פריצה מטווח אסיה בתחילת סשן לונדון (02:00-04:00 EST). מחפש Break of Structure מעל/מתחת לגבולות הטווח.' },
  { name: 'London Breakout', description: 'כניסה בפתיחת סשן לונדון (03:00-04:00 EST) על פריצת high/low של 30 הדקות הראשונות.' },
  { name: 'ICT — Order Blocks', description: 'Inner Circle Trader. כניסה על Order Blocks עם Liquidity Grab, מגמת Higher Timeframe, FVG לאישור.' },
  { name: 'SMC — BOS/CHoCH', description: 'Smart Money Concepts. כניסה על Break of Structure או Change of Character, Supply/Demand Zones.' },
  { name: 'Scalping', description: 'עסקאות מהירות על 1M-5M. הזדמנויות קצרות עם Stop Tight, יחס 1:1.5 מינימום.' },
  { name: 'Swing Trading', description: 'עסקאות על 4H-Daily. מחכה לתיקון בטרנד ברור, Stop מתחת/מעל swing high/low.' },
  { name: 'VWAP Reversion', description: 'חזרה ל-VWAP אחרי סטייה גדולה. כניסה על rejection מ-VWAP עם momentum חלש.' },
  { name: 'Gap Fill', description: 'מילוי פערים בפתיחת שוק. Gap מעל 0.5% שנפתח בנר הראשון — כניסה בכיוון הפאן.' },
];

const DIRECTION_LABELS = { long: 'Long בלבד', short: 'Short בלבד', both: 'שניהם' };
const MARKET_OPTIONS = ['Forex', 'Crypto', 'Futures', 'Stocks', 'Indices'];

interface StrategyBuilderProps {
  userId: string;
  initialStrategies: PersonalStrategy[];
}

const EMPTY_FORM = {
  name: '',
  description: '',
  direction: 'both' as 'long' | 'short' | 'both',
  stop_loss_points: '',
  take_profit_points: '',
  risk_rules: '',
  preferred_hours: '',
  markets: [] as string[],
};

export default function StrategyBuilder({ userId, initialStrategies }: StrategyBuilderProps) {
  const [strategies, setStrategies] = useState<PersonalStrategy[]>(initialStrategies);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const supabase = createClient();

  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(s: PersonalStrategy) {
    setEditId(s.id);
    setForm({
      name: s.name,
      description: s.description,
      direction: s.direction,
      stop_loss_points: s.stop_loss_points != null ? String(s.stop_loss_points) : '',
      take_profit_points: s.take_profit_points != null ? String(s.take_profit_points) : '',
      risk_rules: s.risk_rules,
      preferred_hours: s.preferred_hours,
      markets: s.markets,
    });
    setShowForm(true);
  }

  function useTemplate(t: typeof BUILTIN_TEMPLATES[0]) {
    setForm({ ...EMPTY_FORM, name: t.name, description: t.description });
    setEditId(null);
    setShowForm(true);
  }

  function toggleMarket(m: string) {
    setForm((f) => ({
      ...f,
      markets: f.markets.includes(m) ? f.markets.filter((x) => x !== m) : [...f.markets, m],
    }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.description.trim()) return;
    setSaving(true);

    const payload = {
      user_id: userId,
      name: form.name.trim(),
      description: form.description.trim(),
      direction: form.direction,
      stop_loss_points: form.stop_loss_points ? parseFloat(form.stop_loss_points) : null,
      take_profit_points: form.take_profit_points ? parseFloat(form.take_profit_points) : null,
      risk_rules: form.risk_rules.trim(),
      preferred_hours: form.preferred_hours.trim(),
      markets: form.markets,
    };

    if (editId) {
      const { data } = await supabase.from('personal_strategies').update(payload).eq('id', editId).select().single();
      if (data) setStrategies((prev) => prev.map((s) => s.id === editId ? data as PersonalStrategy : s));
    } else {
      const { data } = await supabase.from('personal_strategies').insert(payload).select().single();
      if (data) setStrategies((prev) => [...prev, data as PersonalStrategy]);
    }

    setSaving(false);
    setShowForm(false);
    setEditId(null);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    await supabase.from('personal_strategies').delete().eq('id', id);
    setStrategies((prev) => prev.filter((s) => s.id !== id));
    setDeletingId(null);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Strategy list */}
      {strategies.length === 0 && !showForm && (
        <div className="text-center py-8 rounded-xl"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <div className="text-3xl mb-2">📐</div>
          <p className="text-sm text-tg-text-2 mb-1">אין אסטרטגיות עדיין</p>
          <p className="text-xs text-tg-muted">הוסף את האסטרטגיה הראשונה שלך או בחר תבנית</p>
        </div>
      )}

      {strategies.map((s) => (
        <div key={s.id} className="rounded-xl p-3 border"
          style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)' }}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-tg-text">{s.name}</p>
                <span className="text-[10px] px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)' }}>
                  {DIRECTION_LABELS[s.direction]}
                </span>
              </div>
              <p className="text-xs text-tg-text-2 mt-1 leading-relaxed line-clamp-2">{s.description}</p>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {s.stop_loss_points && (
                  <span className="text-[10px] text-tg-danger">SL: {s.stop_loss_points}נק׳</span>
                )}
                {s.take_profit_points && (
                  <span className="text-[10px] text-tg-success">TP: {s.take_profit_points}נק׳</span>
                )}
                {s.preferred_hours && (
                  <span className="text-[10px] text-tg-muted">⏰ {s.preferred_hours}</span>
                )}
                {s.markets.length > 0 && (
                  <span className="text-[10px] text-tg-muted">{s.markets.join(', ')}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => openEdit(s)}
                className="p-1.5 rounded-lg text-tg-muted hover:text-tg-text transition-colors"
                style={{ background: 'var(--color-tg-surface)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button onClick={() => handleDelete(s.id)}
                disabled={deletingId === s.id}
                className="p-1.5 rounded-lg transition-colors"
                style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" /><path d="M9 6V4h6v2" />
                </svg>
              </button>
            </div>
          </div>
          {s.risk_rules && (
            <div className="mt-2 px-2 py-1.5 rounded-lg text-xs text-tg-muted"
              style={{ background: 'var(--color-tg-surface)', borderRight: '2px solid var(--color-tg-warning)' }}>
              {s.risk_rules}
            </div>
          )}
        </div>
      ))}

      {/* Add button */}
      {!showForm && (
        <Button variant="secondary" onClick={openAdd} fullWidth>
          + הוסף אסטרטגיה
        </Button>
      )}

      {/* Built-in templates */}
      {!showForm && strategies.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-tg-muted">אסטרטגיות מובנות — לחץ להוסיף</p>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_TEMPLATES.map((t) => (
              <button key={t.name} onClick={() => useTemplate(t)}
                className="px-3 py-1.5 rounded-full text-xs border transition-all"
                style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text-2)' }}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <div className="rounded-2xl border border-tg-border p-4 flex flex-col gap-3"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          <h3 className="text-sm font-semibold text-tg-text">
            {editId ? 'עריכת אסטרטגיה' : 'אסטרטגיה חדשה'}
          </h3>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">שם האסטרטגיה *</label>
            <input
              type="text"
              placeholder="למשל: London Breakout"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-10 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary"
              style={{ background: 'var(--color-tg-surface)' }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">תיאור מלא *</label>
            <textarea
              rows={3}
              placeholder="תאר את הלוגיקה של האסטרטגיה בפירוט..."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2.5 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary resize-none"
              style={{ background: 'var(--color-tg-surface)' }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">כיוון</label>
            <div className="flex gap-2">
              {(['long', 'short', 'both'] as const).map((d) => (
                <button key={d} onClick={() => setForm({ ...form, direction: d })}
                  className="flex-1 py-1.5 rounded-xl text-xs font-medium border transition-all"
                  style={{
                    background: form.direction === d ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface)',
                    borderColor: form.direction === d ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                    color: form.direction === d ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
                  }}>
                  {DIRECTION_LABELS[d]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-tg-muted">Stop Loss (נקודות)</label>
              <input type="number" step="any" placeholder="0"
                value={form.stop_loss_points}
                onChange={(e) => setForm({ ...form, stop_loss_points: e.target.value })}
                className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
                style={{ background: 'var(--color-tg-surface)' }} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-tg-muted">Take Profit (נקודות)</label>
              <input type="number" step="any" placeholder="0"
                value={form.take_profit_points}
                onChange={(e) => setForm({ ...form, take_profit_points: e.target.value })}
                className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
                style={{ background: 'var(--color-tg-surface)' }} />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">חוקי ניהול סיכונים</label>
            <textarea rows={2}
              placeholder='למשל: "אחרי 50 נקודות רווח — הזז סטופ לכניסה"'
              value={form.risk_rules}
              onChange={(e) => setForm({ ...form, risk_rules: e.target.value })}
              className="w-full px-3 py-2 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none resize-none"
              style={{ background: 'var(--color-tg-surface)' }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">שעות מסחר מועדפות</label>
            <input type="text" placeholder='למשל: "02:00–04:00 EST, 08:00–10:00 EST"'
              value={form.preferred_hours}
              onChange={(e) => setForm({ ...form, preferred_hours: e.target.value })}
              className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
              style={{ background: 'var(--color-tg-surface)' }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">שווקים רלוונטיים</label>
            <div className="flex flex-wrap gap-1.5">
              {MARKET_OPTIONS.map((m) => (
                <button key={m} onClick={() => toggleMarket(m)}
                  className="px-2.5 py-1 rounded-full text-xs border transition-all"
                  style={{
                    background: form.markets.includes(m) ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface)',
                    borderColor: form.markets.includes(m) ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                    color: form.markets.includes(m) ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
                  }}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowForm(false)} className="flex-1">
              ביטול
            </Button>
            <Button onClick={handleSave} loading={saving}
              disabled={!form.name.trim() || !form.description.trim()}
              className="flex-1">
              {editId ? 'שמור שינויים' : 'הוסף אסטרטגיה'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
