'use client';

import { useState, useMemo, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase/client';

// ── Design tokens ─────────────────────────────────────────────────────────────
const GOLD   = '#D4AF37';
const SURF   = 'var(--color-tg-surface)';
const SURF2  = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';
const MUTED  = 'var(--color-tg-muted)';
const GREEN  = '#4ade80';
const RED    = '#f87171';

// ── Types ─────────────────────────────────────────────────────────────────────
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

export interface TradeSummary {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number;
  exit_price: number | null;
  take_profit: number;
  rr_ratio: number;
  status: string;
  submitted_at: string;
  closed_at: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function inferDir(t: TradeSummary) { return t.take_profit >= t.entry_price ? 'long' : 'short'; }
function calcPnl(t: TradeSummary): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return inferDir(t) === 'long' ? t.exit_price - t.entry_price : t.entry_price - t.exit_price;
}
function fmtPnl(v: number) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function computeStats(strategyName: string, trades: TradeSummary[]) {
  const linked  = trades.filter(t => t.strategy === strategyName);
  const closed  = linked.filter(t => t.status === 'closed' && t.exit_price != null);
  const pnls    = closed.map(t => calcPnl(t)!);
  const wins    = pnls.filter(p => p > 0);
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  return {
    tradeCount:  linked.length,
    closedCount: closed.length,
    winRate:  closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0,
    totalPnl,
    avgPnl:   closed.length > 0 ? totalPnl / closed.length : 0,
    avgRR:    linked.length > 0
      ? Number((linked.reduce((s, t) => s + t.rr_ratio, 0) / linked.length).toFixed(1))
      : 0,
  };
}

const DIR_LABELS: Record<string, string> = { long: 'Long', short: 'Short', both: 'שניהם' };
const BUILTIN_TEMPLATES = [
  { name: 'Asia Range Breakout', description: 'כניסה על פריצת טווח אסיה בתחילת סשן לונדון. מחפש Break of Structure מעל/מתחת לגבולות הטווח.' },
  { name: 'London Breakout',     description: 'כניסה בפתיחת סשן לונדון על פריצת high/low של 30 הדקות הראשונות.' },
  { name: 'ICT — Order Blocks',  description: 'כניסה על Order Blocks עם Liquidity Grab, מגמת Higher Timeframe, FVG לאישור.' },
  { name: 'SMC — BOS/CHoCH',     description: 'Smart Money Concepts. כניסה על Break of Structure או Change of Character.' },
  { name: 'Scalping',            description: 'עסקאות מהירות על 1M-5M עם Stop Tight, יחס 1:1.5 מינימום.' },
  { name: 'Swing Trading',       description: 'עסקאות על 4H-Daily. מחכה לתיקון בטרנד ברור.' },
  { name: 'VWAP Reversion',      description: 'חזרה ל-VWAP אחרי סטייה גדולה על rejection עם momentum חלש.' },
  { name: 'Gap Fill',            description: 'מילוי פערים בפתיחת שוק. Gap מעל 0.5%.' },
];

const EMPTY_FORM = {
  name: '', description: '', direction: 'both' as 'long' | 'short' | 'both',
  stop_loss_points: '', take_profit_points: '', risk_rules: '',
};

// ── Root ──────────────────────────────────────────────────────────────────────
export default function StrategiesClient({
  userId,
  initialStrategies,
  allTrades,
}: {
  userId: string;
  initialStrategies: PersonalStrategy[];
  allTrades: TradeSummary[];
}) {
  const [strategies,  setStrategies]  = useState<PersonalStrategy[]>(initialStrategies);
  const [showForm,    setShowForm]    = useState(false);
  const [editId,      setEditId]      = useState<string | null>(null);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [deletingId,  setDeletingId]  = useState<string | null>(null);
  const [expandTrades, setExpandTrades] = useState<Record<string, boolean>>({});
  const [aiReviews,   setAiReviews]   = useState<Record<string, string | null>>({});
  const [aiLoading,   setAiLoading]   = useState<Record<string, boolean>>({});
  const supabase = createClient();

  // ── Form handlers ──────────────────────────────────────────────────────────
  function openAdd() {
    setEditId(null); setForm(EMPTY_FORM); setSaveError(null); setShowForm(true);
  }
  function openEdit(s: PersonalStrategy) {
    setEditId(s.id);
    setForm({
      name: s.name, description: s.description, direction: s.direction,
      stop_loss_points:  s.stop_loss_points  != null ? String(s.stop_loss_points)  : '',
      take_profit_points: s.take_profit_points != null ? String(s.take_profit_points) : '',
      risk_rules: s.risk_rules,
    });
    setSaveError(null); setShowForm(true);
  }
  function useTemplate(t: typeof BUILTIN_TEMPLATES[0]) {
    setForm({ ...EMPTY_FORM, name: t.name, description: t.description });
    setEditId(null); setSaveError(null); setShowForm(true);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.description.trim()) return;
    setSaving(true); setSaveError(null);
    const payload = {
      user_id: userId,
      name:    form.name.trim(),
      description: form.description.trim(),
      direction:   form.direction,
      stop_loss_points:   form.stop_loss_points   ? parseFloat(form.stop_loss_points)   : null,
      take_profit_points: form.take_profit_points ? parseFloat(form.take_profit_points) : null,
      risk_rules:  form.risk_rules.trim(),
      preferred_hours: '',
      markets: [],
    };
    const op = editId
      ? supabase.from('personal_strategies').update(payload).eq('id', editId)
      : supabase.from('personal_strategies').insert(payload);
    const { error } = await op;
    if (error) { setSaveError(error.message); setSaving(false); return; }
    const { data: fresh } = await supabase.from('personal_strategies').select('*').eq('user_id', userId).order('created_at');
    setStrategies((fresh ?? []) as PersonalStrategy[]);
    setSaving(false); setShowForm(false); setEditId(null);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    await supabase.from('personal_strategies').delete().eq('id', id);
    setStrategies(prev => prev.filter(s => s.id !== id));
    setDeletingId(null);
  }

  async function fetchAiReview(s: PersonalStrategy) {
    setAiLoading(prev => ({ ...prev, [s.id]: true }));
    const stats = computeStats(s.name, allTrades);
    try {
      const res = await fetch('/api/ai-strategy-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: s, stats }),
      });
      const { review } = await res.json();
      setAiReviews(prev => ({ ...prev, [s.id]: review || 'לא ניתן לטעון ניתוח.' }));
    } catch {
      setAiReviews(prev => ({ ...prev, [s.id]: 'שגיאה בטעינת ניתוח AI.' }));
    }
    setAiLoading(prev => ({ ...prev, [s.id]: false }));
  }

  function toggleTrades(id: string) {
    setExpandTrades(prev => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div dir="rtl" className="flex flex-col gap-4">

      {/* Empty state */}
      {strategies.length === 0 && !showForm && (
        <div className="text-center py-14 rounded-2xl flex flex-col items-center gap-3"
          style={{ background: SURF, border: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 48 }}>📐</div>
          <p className="text-base font-semibold" style={{ color: TEXT }}>אין אסטרטגיות עדיין</p>
          <p className="text-sm" style={{ color: MUTED }}>הוסף אסטרטגיה ראשונה או בחר תבנית</p>
        </div>
      )}

      {/* Strategy cards */}
      {strategies.map(s => {
        const stats   = computeStats(s.name, allTrades);
        const linked  = allTrades.filter(t => t.strategy === s.name);
        const isOpen  = expandTrades[s.id];
        const aiText  = aiReviews[s.id];
        const aiLoad  = aiLoading[s.id];
        const pnlColor = stats.totalPnl > 0 ? GREEN : stats.totalPnl < 0 ? RED : MUTED;

        return (
          <div key={s.id} className="rounded-2xl flex flex-col"
            style={{ background: SURF, border: `1px solid ${BORDER}` }}>

            {/* Card header */}
            <div className="p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-bold" style={{ color: TEXT }}>{s.name}</h2>
                    <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold"
                      style={{ background: 'rgba(212,175,55,0.12)', color: GOLD }}>
                      {DIR_LABELS[s.direction]}
                    </span>
                  </div>
                  <p className="text-xs leading-relaxed mt-1 line-clamp-2" style={{ color: TEXT2 }}>
                    {s.description}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => openEdit(s)}
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ background: SURF2, color: MUTED }}>
                    <PencilIcon />
                  </button>
                  <button onClick={() => handleDelete(s.id)} disabled={deletingId === s.id}
                    className="p-1.5 rounded-lg transition-colors disabled:opacity-40"
                    style={{ background: 'rgba(248,113,113,0.1)', color: RED }}>
                    <TrashIcon />
                  </button>
                </div>
              </div>

              {/* Risk rules */}
              {s.risk_rules && (
                <div className="px-3 py-2 rounded-xl text-xs leading-relaxed"
                  style={{ background: SURF2, borderRight: `2px solid ${GOLD}`, color: TEXT2 }}>
                  {s.risk_rules}
                </div>
              )}

              {/* SL/TP badges */}
              {(s.stop_loss_points || s.take_profit_points) && (
                <div className="flex gap-2">
                  {s.stop_loss_points && (
                    <span className="text-xs px-2 py-0.5 rounded-md"
                      style={{ background: 'rgba(248,113,113,0.1)', color: RED }}>
                      SL {s.stop_loss_points}נק׳
                    </span>
                  )}
                  {s.take_profit_points && (
                    <span className="text-xs px-2 py-0.5 rounded-md"
                      style={{ background: 'rgba(74,222,128,0.1)', color: GREEN }}>
                      TP {s.take_profit_points}נק׳
                    </span>
                  )}
                </div>
              )}

              {/* Stats strip */}
              <div className="grid grid-cols-4 gap-2">
                <StatBox label="עסקאות"    value={String(stats.tradeCount)}                     />
                <StatBox label="הצלחה"     value={stats.closedCount > 0 ? `${stats.winRate}%` : '—'}
                  color={stats.winRate >= 60 ? GREEN : stats.winRate >= 40 ? GOLD : stats.closedCount > 0 ? RED : MUTED} />
                <StatBox label="ממוצע"     value={stats.closedCount > 0 ? fmtPnl(stats.avgPnl) : '—'}
                  color={stats.avgPnl > 0 ? GREEN : stats.avgPnl < 0 ? RED : MUTED} />
                <StatBox label="R:R"        value={stats.tradeCount > 0 ? `1:${stats.avgRR}` : '—'}
                  color={GOLD} />
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button onClick={() => toggleTrades(s.id)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium transition-all"
                  style={{
                    background: isOpen ? 'rgba(212,175,55,0.12)' : SURF2,
                    color:      isOpen ? GOLD : TEXT2,
                    border:     `1px solid ${isOpen ? 'rgba(212,175,55,0.3)' : BORDER}`,
                  }}>
                  <ListIcon />
                  עסקאות ({linked.length})
                </button>
                <button
                  onClick={() => !aiText && fetchAiReview(s)}
                  disabled={aiLoad}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                  style={{
                    background: aiText ? 'rgba(212,175,55,0.12)' : SURF2,
                    color:      aiText ? GOLD : TEXT2,
                    border:     `1px solid ${aiText ? 'rgba(212,175,55,0.3)' : BORDER}`,
                  }}>
                  <SparkIcon />
                  {aiLoad ? 'מנתח...' : aiText ? 'ניתוח AI ✓' : 'ניתוח AI'}
                </button>
              </div>
            </div>

            {/* Trades panel */}
            {isOpen && (
              <div style={{ borderTop: `1px solid ${BORDER}` }}>
                {linked.length === 0 ? (
                  <p className="text-sm text-center py-6" style={{ color: MUTED }}>
                    אין עסקאות עם האסטרטגיה הזו עדיין
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {linked.map((t, i) => {
                      const pnl = calcPnl(t);
                      return (
                        <div key={t.id}
                          className="flex items-center gap-3 px-4 py-2.5"
                          style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium" style={{ color: TEXT }}>
                                {t.symbol ?? '—'}
                              </span>
                              <span className="text-xs px-1.5 py-0.5 rounded-md"
                                style={{
                                  background: t.status === 'closed'
                                    ? (pnl != null && pnl > 0 ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)')
                                    : 'rgba(212,175,55,0.1)',
                                  color: t.status === 'closed'
                                    ? (pnl != null && pnl > 0 ? GREEN : RED)
                                    : GOLD,
                                }}>
                                {t.status === 'closed' ? (pnl != null && pnl > 0 ? 'רווח' : 'הפסד') : 'פתוח'}
                              </span>
                            </div>
                            <p className="text-[10px] mt-0.5" style={{ color: MUTED }}>
                              {fmtDate(t.submitted_at)}
                              {t.closed_at ? ` → ${fmtDate(t.closed_at)}` : ''}
                            </p>
                          </div>
                          <div className="text-left shrink-0">
                            {pnl !== null && (
                              <p className="text-sm font-semibold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                                {fmtPnl(pnl)}
                              </p>
                            )}
                            <p className="text-[10px]" style={{ color: MUTED }}>
                              R:R 1:{t.rr_ratio.toFixed(1)}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* AI review panel */}
            {(aiText || aiLoad) && (
              <div className="px-4 pb-4" style={{ borderTop: `1px solid ${BORDER}` }}>
                <p className="text-xs font-semibold mt-3 mb-2" style={{ color: MUTED }}>ניתוח AI</p>
                {aiLoad ? (
                  <div className="flex flex-col gap-2">
                    {[80, 65, 75].map((w, i) => (
                      <div key={i} className="h-3 rounded animate-pulse" style={{ background: SURF2, width: `${w}%` }} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: TEXT2 }}>
                    {aiText}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Add button */}
      {!showForm && (
        <button onClick={openAdd}
          className="w-full py-3 rounded-2xl text-sm font-semibold transition-all hover:opacity-80"
          style={{ background: SURF, border: `2px dashed ${BORDER}`, color: TEXT2 }}>
          + הוסף אסטרטגיה
        </button>
      )}

      {/* Templates (only when no strategies yet) */}
      {!showForm && strategies.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold" style={{ color: MUTED }}>תבניות מובנות — לחץ להוסיף</p>
          <div className="flex flex-wrap gap-1.5">
            {BUILTIN_TEMPLATES.map(t => (
              <button key={t.name} onClick={() => useTemplate(t)}
                className="px-3 py-1.5 rounded-full text-xs border transition-all hover:opacity-80"
                style={{ background: SURF2, borderColor: BORDER, color: TEXT2 }}>
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <div className="rounded-2xl p-4 flex flex-col gap-3"
          style={{ background: SURF, border: `1px solid ${BORDER}` }}>
          <h3 className="text-sm font-semibold" style={{ color: TEXT }}>
            {editId ? 'עריכת אסטרטגיה' : 'אסטרטגיה חדשה'}
          </h3>

          <Field label="שם האסטרטגיה *">
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder='למשל: London Breakout'
              style={{ ...inputSt }} />
          </Field>

          <Field label="תיאור מלא *">
            <textarea rows={3} value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="תאר את הלוגיקה של האסטרטגיה בפירוט..."
              style={{ ...inputSt, resize: 'vertical', lineHeight: 1.7 }} />
          </Field>

          <Field label="כיוון">
            <div className="flex gap-2">
              {(['long', 'short', 'both'] as const).map(d => (
                <button key={d} onClick={() => setForm({ ...form, direction: d })}
                  className="flex-1 py-1.5 rounded-xl text-xs font-medium border transition-all"
                  style={{
                    background:   form.direction === d ? 'rgba(212,175,55,0.12)' : SURF2,
                    borderColor:  form.direction === d ? GOLD : BORDER,
                    color:        form.direction === d ? GOLD : TEXT2,
                  }}>
                  {DIR_LABELS[d]}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="Stop Loss (נקודות)">
              <input type="number" step="any" placeholder="0"
                value={form.stop_loss_points}
                onChange={e => setForm({ ...form, stop_loss_points: e.target.value })}
                style={{ ...inputSt }} />
            </Field>
            <Field label="Take Profit (נקודות)">
              <input type="number" step="any" placeholder="0"
                value={form.take_profit_points}
                onChange={e => setForm({ ...form, take_profit_points: e.target.value })}
                style={{ ...inputSt }} />
            </Field>
          </div>

          <Field label="חוקי ניהול סיכונים">
            <textarea rows={2}
              placeholder='למשל: "אחרי 50 נקודות רווח — הזז סטופ לכניסה"'
              value={form.risk_rules}
              onChange={e => setForm({ ...form, risk_rules: e.target.value })}
              style={{ ...inputSt, resize: 'vertical', lineHeight: 1.7 }} />
          </Field>

          {saveError && (
            <p className="text-xs px-3 py-2 rounded-xl"
              style={{ background: 'rgba(248,113,113,0.1)', color: RED }}>
              שגיאה: {saveError}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={() => { setShowForm(false); setSaveError(null); }}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
              style={{ background: SURF2, color: TEXT2 }}>
              ביטול
            </button>
            <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.description.trim()}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
              style={{ background: GOLD, color: '#0a0a0f' }}>
              {saving ? 'שומר...' : editId ? 'שמור שינויים' : 'הוסף אסטרטגיה'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function StatBox({ label, value, color = TEXT }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl p-2 text-center" style={{ background: SURF2 }}>
      <p className="text-[10px]" style={{ color: MUTED }}>{label}</p>
      <p className="text-sm font-bold mt-0.5" style={{ color }}>{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" style={{ color: MUTED }}>{label}</label>
      {children}
    </div>
  );
}

const inputSt: CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 10,
  background: SURF2, border: `1px solid ${BORDER}`,
  color: TEXT, fontSize: 14, outline: 'none',
  boxSizing: 'border-box', direction: 'rtl',
};

// ── Icons ─────────────────────────────────────────────────────────────────────
function PencilIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>;
}
function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
  </svg>;
}
function ListIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
    <circle cx="3" cy="6" r="1" fill="currentColor" stroke="none"/>
    <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none"/>
    <circle cx="3" cy="18" r="1" fill="currentColor" stroke="none"/>
  </svg>;
}
function SparkIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l2.4 5.2 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8L12 2z"/>
  </svg>;
}
