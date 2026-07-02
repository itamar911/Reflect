'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import { Ruler } from 'lucide-react';

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
  min_rr: number | null;
  trading_hours_start: string | null;
  trading_hours_end: string | null;
  allowed_timeframes: string[];
  entry_conditions: string[];
  max_daily_trades: number | null;
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
const TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '30m', '1H', '4H', 'Daily', 'Weekly'];

interface StrategyBuilderProps {
  userId: string;
  initialStrategies: PersonalStrategy[];
}

const EMPTY_FORM = {
  name: '',
  description: '',
  direction: 'both' as 'long' | 'short' | 'both',
  risk_rules: '',
  preferred_hours: '',
  markets: [] as string[],
  min_rr: '',
  trading_hours_start: '',
  trading_hours_end: '',
  allowed_timeframes: [] as string[],
  entry_conditions: [] as string[],
  max_daily_trades: '',
};

export default function StrategyBuilder({ userId, initialStrategies }: StrategyBuilderProps) {
  const [strategies, setStrategies] = useState<PersonalStrategy[]>(initialStrategies);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [newCondition, setNewCondition] = useState('');
  const supabase = createClient();


  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setShowForm(true);
  }

  function openEdit(s: PersonalStrategy) {
    setEditId(s.id);
    setForm({
      name: s.name,
      description: s.description,
      direction: s.direction,
      risk_rules: s.risk_rules,
      preferred_hours: s.preferred_hours,
      markets: s.markets,
      min_rr: s.min_rr != null ? String(s.min_rr) : '',
      trading_hours_start: s.trading_hours_start ?? '',
      trading_hours_end: s.trading_hours_end ?? '',
      allowed_timeframes: s.allowed_timeframes ?? [],
      entry_conditions: s.entry_conditions ?? [],
      max_daily_trades: s.max_daily_trades != null ? String(s.max_daily_trades) : '',
    });
    setSaveError(null);
    setShowForm(true);
  }

  function useTemplate(t: typeof BUILTIN_TEMPLATES[0]) {
    setForm({ ...EMPTY_FORM, name: t.name, description: t.description });
    setEditId(null);
    setSaveError(null);
    setShowForm(true);
  }

  function toggleMarket(m: string) {
    setForm((f) => ({
      ...f,
      markets: f.markets.includes(m) ? f.markets.filter((x) => x !== m) : [...f.markets, m],
    }));
  }

  function toggleTimeframe(t: string) {
    setForm((f) => ({
      ...f,
      allowed_timeframes: f.allowed_timeframes.includes(t)
        ? f.allowed_timeframes.filter((x) => x !== t)
        : [...f.allowed_timeframes, t],
    }));
  }

  function addCondition() {
    const c = newCondition.trim();
    if (!c) return;
    setForm((f) => ({ ...f, entry_conditions: [...f.entry_conditions, c] }));
    setNewCondition('');
  }

  function removeCondition(index: number) {
    setForm((f) => ({ ...f, entry_conditions: f.entry_conditions.filter((_, i) => i !== index) }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.description.trim()) return;
    setSaving(true);
    setSaveError(null);

    try {
      const res = await fetch('/api/validate-strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          entry_conditions: form.entry_conditions,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        if (result.valid === false) {
          setSaveError(result.feedback || 'האסטרטגיה לא תקינה');
          setSaving(false);
          return;
        }
      }
    } catch {
      // fail-open: allow save if validation call itself fails
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaveError('לא מחובר — יש להתחבר מחדש');
      setSaving(false);
      return;
    }

    const payload = {
      user_id: user.id,
      name: form.name.trim(),
      description: form.description.trim(),
      direction: form.direction,
      risk_rules: form.risk_rules.trim(),
      preferred_hours: form.preferred_hours.trim(),
      markets: form.markets,
      min_rr: form.min_rr ? parseFloat(form.min_rr) : null,
      trading_hours_start: form.trading_hours_start || null,
      trading_hours_end: form.trading_hours_end || null,
      allowed_timeframes: form.allowed_timeframes,
      entry_conditions: form.entry_conditions,
      max_daily_trades: form.max_daily_trades ? parseInt(form.max_daily_trades, 10) : null,
    };

    if (editId) {
      const { error } = await supabase.from('personal_strategies').update(payload).eq('id', editId);
      if (error) {
        setSaveError(`${error.message} (${error.code})`);
        setSaving(false);
        return;
      }
    } else {
      const { error } = await supabase.from('personal_strategies').insert(payload);
      if (error) {
        setSaveError(`${error.message} (${error.code})`);
        setSaving(false);
        return;
      }
    }

    const { data: fresh, error: fetchError } = await supabase
      .from('personal_strategies')
      .select('*')
      .order('created_at');
    if (fetchError) {
      setSaveError(`שגיאה בטעינת הרשימה: ${fetchError.message}`);
      setSaving(false);
      return;
    }
    setStrategies([...(fresh ?? [])] as PersonalStrategy[]);

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
          <div className="mb-2"><Ruler size={36} /></div>
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

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">R:R מינימלי</label>
            <input type="number" step="any" placeholder="למשל: 2"
              value={form.min_rr}
              onChange={(e) => setForm({ ...form, min_rr: e.target.value })}
              className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
              style={{ background: 'var(--color-tg-surface)' }} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">טווח שעות מסחר (אופציונלי)</label>
            <div className="grid grid-cols-2 gap-2">
              <input type="time"
                value={form.trading_hours_start}
                onChange={(e) => setForm({ ...form, trading_hours_start: e.target.value })}
                className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
                style={{ background: 'var(--color-tg-surface)' }} />
              <input type="time"
                value={form.trading_hours_end}
                onChange={(e) => setForm({ ...form, trading_hours_end: e.target.value })}
                className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
                style={{ background: 'var(--color-tg-surface)' }} />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">טיים-פריימים מותרים</label>
            <div className="flex flex-wrap gap-1.5">
              {TIMEFRAME_OPTIONS.map((t) => (
                <button key={t} onClick={() => toggleTimeframe(t)}
                  className="px-2.5 py-1 rounded-full text-xs border transition-all"
                  style={{
                    background: form.allowed_timeframes.includes(t) ? 'var(--color-tg-primary-muted)' : 'var(--color-tg-surface)',
                    borderColor: form.allowed_timeframes.includes(t) ? 'var(--color-tg-primary)' : 'var(--color-tg-border)',
                    color: form.allowed_timeframes.includes(t) ? 'var(--color-tg-primary)' : 'var(--color-tg-text-2)',
                  }}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">תנאי כניסה</label>
            <p className="text-[11px] text-tg-muted">
              פרק את האסטרטגיה לתנאים בדיקים — בפתיחת עסקה תסמן וי על כל תנאי שמתקיים
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="למשל: מגמה עולה ב-4H"
                value={newCondition}
                onChange={(e) => setNewCondition(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCondition(); } }}
                className="flex-1 h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
                style={{ background: 'var(--color-tg-surface)' }}
              />
              <Button variant="secondary" onClick={addCondition}>הוסף תנאי</Button>
            </div>
            {form.entry_conditions.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-1">
                {form.entry_conditions.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-xs"
                    style={{ background: 'var(--color-tg-surface)' }}>
                    <span className="text-tg-text">{c}</span>
                    <button onClick={() => removeCondition(i)} className="text-tg-danger shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-tg-muted">מקסימום עסקאות ביום (אופציונלי)</label>
            <input type="number" step="1" min="0" placeholder="0"
              value={form.max_daily_trades}
              onChange={(e) => setForm({ ...form, max_daily_trades: e.target.value })}
              className="h-9 px-3 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none"
              style={{ background: 'var(--color-tg-surface)' }} />
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

          {saveError && (
            <p className="text-xs rounded-lg px-3 py-2" style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
              שגיאה בשמירה: {saveError}
            </p>
          )}

          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => { setShowForm(false); setSaveError(null); }} className="flex-1">
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
