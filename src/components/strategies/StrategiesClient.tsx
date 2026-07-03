'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { createClient } from '@/lib/supabase/client';
import { TrendingUp, Rocket, ArrowLeftRight, RefreshCw, Building2, Activity, Ruler } from 'lucide-react';
import { getPlanLimits, isPro, type PlanTier } from '@/lib/plans/config';
import UpgradeModal from '@/components/plans/UpgradeModal';

// ── Design tokens ─────────────────────────────────────────────────────────────
const GOLD   = '#00d2d2';
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
  min_rr: number | null;
  trading_hours_start: string | null;
  trading_hours_end: string | null;
  allowed_timeframes: string[];
  entry_conditions: string[];
  max_daily_trades: number | null;
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

const DIR_LABELS: Record<string, string> = { long: 'לונג', short: 'שורט', both: 'שניהם' };
const TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '30m', '1H', '4H', 'Daily', 'Weekly'];

// ── Builtin strategies (shown to all users, not editable) ─────────────────────
interface BuiltinDef {
  id: string;
  name: string;
  description: string;
  detail: string;
  icon: ReactNode;
  direction: 'long' | 'short' | 'both';
}

const BUILTIN_STRATEGIES: BuiltinDef[] = [
  {
    id: '__trend_following',
    name: 'Trend Following',
    description: 'מסחר בכיוון המגמה הראשית',
    detail: 'מזהה מגמה ברורה על Higher Timeframe ונכנס בכיוונה. מחפש Higher Highs / Higher Lows לעלייה ו-Lower Highs / Lower Lows לירידה. כניסה על תיקון לעבר EMA/אזור תמיכה.',
    icon: <TrendingUp size={22} />,
    direction: 'both',
  },
  {
    id: '__breakout',
    name: 'Breakout',
    description: 'פריצת רמות תמיכה/התנגדות',
    detail: 'כניסה על פריצה מעל התנגדות ידועה או מתחת לתמיכה, עם נר סגירה מחוץ לטווח. מחפש עלייה בנפח לאישור. SL מתחת/מעל לרמה הנפרצת.',
    icon: <Rocket size={22} />,
    direction: 'both',
  },
  {
    id: '__range_reversal',
    name: 'Range Reversal',
    description: 'היפוך בטווח מסחר',
    detail: 'מזהה שוק בטווח (Range) ברור עם תמיכה והתנגדות. כניסה בהיפוך מקצוות הטווח עם אישור rejection candle. TP בצד השני של הטווח.',
    icon: <ArrowLeftRight size={22} />,
    direction: 'both',
  },
  {
    id: '__pullback',
    name: 'Pullback Entry',
    description: 'כניסה בנסיגה בכיוון המגמה',
    detail: 'ממתין לנסיגה (Pullback) אל EMA, Fibonacci 50-61.8%, או אזור Supply/Demand קודם. כניסה עם אישור נר מגמה. Stop מתחת לנסיגה.',
    icon: <RefreshCw size={22} />,
    direction: 'both',
  },
  {
    id: '__smc',
    name: 'SMC / Order Blocks',
    description: 'Smart Money Concepts — Order Blocks',
    detail: 'כניסה על Order Blocks (OB) — הנר האחרון לפני תנועה חזקה. מחפש Liquidity Grab, Break of Structure (BOS) לאישור כיוון, ו-Fair Value Gap (FVG) לדיוק כניסה.',
    icon: <Building2 size={22} />,
    direction: 'both',
  },
  {
    id: '__vwap',
    name: 'VWAP Reversion',
    description: 'חזרה ל-VWAP אחרי סטייה',
    detail: 'מחפש סטייה גדולה מ-VWAP (מעל/מתחת ל-1-2 Standard Deviations). כניסה בהיפוך עם momentum חלש ו-Volume יורד. TP ב-VWAP, SL מעל/מתחת לנקודת הקיצון.',
    icon: <Activity size={22} />,
    direction: 'both',
  },
];

const FORM_TEMPLATES = [
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
  risk_rules: '',
  min_rr: '', trading_hours_start: '', trading_hours_end: '',
  allowed_timeframes: [] as string[], entry_conditions: [] as string[],
  max_daily_trades: '',
};

// ── Root ──────────────────────────────────────────────────────────────────────
export default function StrategiesClient({
  userId,
  initialStrategies,
  allTrades,
  plan,
}: {
  userId: string;
  initialStrategies: PersonalStrategy[];
  allTrades: TradeSummary[];
  plan: PlanTier;
}) {
  const limits = getPlanLimits(plan);
  const [strategies,  setStrategies]  = useState<PersonalStrategy[]>(initialStrategies);
  const [showForm,    setShowForm]    = useState(false);
  const [editId,      setEditId]      = useState<string | null>(null);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [deletingId,  setDeletingId]  = useState<string | null>(null);
  const [expandTrades,  setExpandTrades]  = useState<Record<string, boolean>>({});
  const [expandBuiltin, setExpandBuiltin] = useState<Record<string, boolean>>({});
  const [aiReviews,     setAiReviews]     = useState<Record<string, string | null>>({});
  const [aiLoading,     setAiLoading]     = useState<Record<string, boolean>>({});
  const [newCondition,  setNewCondition]  = useState('');
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const supabase = createClient();

  // ── Form handlers ──────────────────────────────────────────────────────────
  function openAdd() {
    setEditId(null); setForm(EMPTY_FORM); setSaveError(null); setShowForm(true);
  }
  function openEdit(s: PersonalStrategy) {
    setEditId(s.id);
    setForm({
      name: s.name, description: s.description, direction: s.direction,
      risk_rules: s.risk_rules,
      min_rr: s.min_rr != null ? String(s.min_rr) : '',
      trading_hours_start: s.trading_hours_start ?? '',
      trading_hours_end: s.trading_hours_end ?? '',
      allowed_timeframes: s.allowed_timeframes ?? [],
      entry_conditions: s.entry_conditions ?? [],
      max_daily_trades: s.max_daily_trades != null ? String(s.max_daily_trades) : '',
    });
    setSaveError(null); setShowForm(true);
  }
  function useTemplate(t: typeof FORM_TEMPLATES[0]) {
    setForm({ ...EMPTY_FORM, name: t.name, description: t.description });
    setEditId(null); setSaveError(null); setShowForm(true);
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

    if (!editId && !isPro(plan) && limits.maxStrategies !== null && strategies.length >= limits.maxStrategies) {
      setUpgradeModalOpen(true);
      return;
    }

    setSaving(true); setSaveError(null);

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

    const payload = {
      user_id: userId,
      name:    form.name.trim(),
      description: form.description.trim(),
      direction:   form.direction,
      risk_rules:  form.risk_rules.trim(),
      preferred_hours: '',
      markets: [],
      min_rr: form.min_rr ? parseFloat(form.min_rr) : null,
      trading_hours_start: form.trading_hours_start || null,
      trading_hours_end: form.trading_hours_end || null,
      allowed_timeframes: form.allowed_timeframes,
      entry_conditions: form.entry_conditions,
      max_daily_trades: form.max_daily_trades ? parseInt(form.max_daily_trades, 10) : null,
    };
    const op = editId
      ? supabase.from('personal_strategies').update(payload).eq('id', editId)
      : supabase.from('personal_strategies').insert(payload);
    const { error } = await op;
    if (error) {
      if (error.message.includes('PLAN_LIMIT:strategies')) {
        setUpgradeModalOpen(true);
      } else {
        setSaveError(error.message);
      }
      setSaving(false);
      return;
    }
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

  async function fetchAiReviewBuiltin(b: BuiltinDef) {
    setAiLoading(prev => ({ ...prev, [b.id]: true }));
    const stats = computeStats(b.name, allTrades);
    try {
      const res = await fetch('/api/ai-strategy-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy: { name: b.name, description: b.detail, direction: b.direction, risk_rules: '' },
          stats,
        }),
      });
      const { review } = await res.json();
      setAiReviews(prev => ({ ...prev, [b.id]: review || 'לא ניתן לטעון ניתוח.' }));
    } catch {
      setAiReviews(prev => ({ ...prev, [b.id]: 'שגיאה בטעינת ניתוח AI.' }));
    }
    setAiLoading(prev => ({ ...prev, [b.id]: false }));
  }

  return (
    <div dir="rtl" className="flex flex-col gap-5">

      {/* ── Builtin strategies ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
          אסטרטגיות מובנות
        </p>
        <div className="flex flex-col gap-2">
          {BUILTIN_STRATEGIES.map(b => {
            const stats      = computeStats(b.name, allTrades);
            const linked     = allTrades.filter(t => t.strategy === b.name);
            const isOpen     = expandBuiltin[b.id];
            const aiText     = aiReviews[b.id];
            const aiLoad     = aiLoading[b.id];

            return (
              <div key={b.id} className="rounded-2xl overflow-hidden"
                style={{ background: SURF, border: `1px solid ${BORDER}` }}>

                {/* Header row — click to expand */}
                <button
                  className="w-full text-right p-4 flex items-start gap-3 transition-opacity hover:opacity-90"
                  onClick={() => setExpandBuiltin(prev => ({ ...prev, [b.id]: !prev[b.id] }))}>
                  <span className="text-2xl leading-none mt-0.5 shrink-0">{b.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold" style={{ color: TEXT }}>{b.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold"
                        style={{ background: 'rgba(0,210,210,0.12)', color: GOLD }}>מובנית</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md"
                        style={{ background: SURF2, color: MUTED }}>{DIR_LABELS[b.direction]}</span>
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: TEXT2 }}>{b.description}</p>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-1"
                    style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {/* Expanded panel */}
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${BORDER}` }}>
                    {/* Detail text */}
                    <div className="px-4 pt-3 pb-2">
                      <p className="text-xs leading-relaxed" style={{ color: TEXT2 }}>{b.detail}</p>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-4 gap-2 px-4 pb-3">
                      <StatBox label="עסקאות"  value={String(stats.tradeCount)} />
                      <StatBox label="הצלחה"   value={stats.closedCount > 0 ? `${stats.winRate}%` : '—'}
                        color={stats.winRate >= 60 ? GREEN : stats.winRate >= 40 ? GOLD : stats.closedCount > 0 ? RED : MUTED} />
                      <StatBox label="ממוצע"   value={stats.closedCount > 0 ? fmtPnl(stats.avgPnl) : '—'}
                        color={stats.avgPnl > 0 ? GREEN : stats.avgPnl < 0 ? RED : MUTED} />
                      <StatBox label="R:R"      value={stats.tradeCount > 0 ? `1:${stats.avgRR}` : '—'} color={GOLD} />
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2 px-4 pb-4">
                      <button onClick={() => setExpandTrades(prev => ({ ...prev, [b.id]: !prev[b.id] }))}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium"
                        style={{
                          background: expandTrades[b.id] ? 'rgba(0,210,210,0.12)' : SURF2,
                          color:      expandTrades[b.id] ? GOLD : TEXT2,
                          border:     `1px solid ${expandTrades[b.id] ? 'rgba(0,210,210,0.3)' : BORDER}`,
                        }}>
                        <ListIcon /> עסקאות ({linked.length})
                      </button>
                      <button
                        onClick={() => !aiText && fetchAiReviewBuiltin(b)}
                        disabled={aiLoad}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium disabled:opacity-50"
                        style={{
                          background: aiText ? 'rgba(0,210,210,0.12)' : SURF2,
                          color:      aiText ? GOLD : TEXT2,
                          border:     `1px solid ${aiText ? 'rgba(0,210,210,0.3)' : BORDER}`,
                        }}>
                        <SparkIcon /> {aiLoad ? 'מנתח...' : aiText ? 'ניתוח AI' : 'ניתוח AI'}
                      </button>
                    </div>

                    {/* Trades list */}
                    {expandTrades[b.id] && (
                      <div style={{ borderTop: `1px solid ${BORDER}` }}>
                        {linked.length === 0 ? (
                          <p className="text-sm text-center py-5" style={{ color: MUTED }}>
                            אין עסקאות עם האסטרטגיה הזו עדיין
                          </p>
                        ) : linked.map((t, i) => {
                          const pnl = calcPnl(t);
                          return (
                            <div key={t.id} className="flex items-center gap-3 px-4 py-2.5"
                              style={{ borderTop: i > 0 ? `1px solid ${BORDER}` : undefined }}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm font-medium" style={{ color: TEXT }}>{t.symbol ?? '—'}</span>
                                  <span className="text-xs px-1.5 py-0.5 rounded-md"
                                    style={{
                                      background: t.status === 'closed'
                                        ? (pnl != null && pnl > 0 ? 'rgba(74,222,128,0.1)' : 'rgba(248,113,113,0.1)')
                                        : 'rgba(0,210,210,0.1)',
                                      color: t.status === 'closed'
                                        ? (pnl != null && pnl > 0 ? GREEN : RED) : GOLD,
                                    }}>
                                    {t.status === 'closed' ? (pnl != null && pnl > 0 ? 'רווח' : 'הפסד') : 'פתוח'}
                                  </span>
                                </div>
                                <p className="text-[10px] mt-0.5" style={{ color: MUTED }}>
                                  {fmtDate(t.submitted_at)}{t.closed_at ? ` → ${fmtDate(t.closed_at)}` : ''}
                                </p>
                              </div>
                              <div className="text-left shrink-0">
                                {pnl !== null && (
                                  <p className="text-sm font-semibold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                                    {fmtPnl(pnl)}
                                  </p>
                                )}
                                <p className="text-[10px]" style={{ color: MUTED }}>R:R 1:{t.rr_ratio.toFixed(1)}</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* AI review */}
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
                          <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: TEXT2 }}>{aiText}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── User strategies ──────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: MUTED }}>
          האסטרטגיות שלי
        </p>

      {/* Empty state */}
      {strategies.length === 0 && !showForm && (
        <div className="text-center py-14 rounded-2xl flex flex-col items-center gap-3"
          style={{ background: SURF, border: `1px solid ${BORDER}` }}>
          <Ruler size={48} />
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
                      style={{ background: 'rgba(0,210,210,0.12)', color: GOLD }}>
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
                    background: isOpen ? 'rgba(0,210,210,0.12)' : SURF2,
                    color:      isOpen ? GOLD : TEXT2,
                    border:     `1px solid ${isOpen ? 'rgba(0,210,210,0.3)' : BORDER}`,
                  }}>
                  <ListIcon />
                  עסקאות ({linked.length})
                </button>
                <button
                  onClick={() => !aiText && fetchAiReview(s)}
                  disabled={aiLoad}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
                  style={{
                    background: aiText ? 'rgba(0,210,210,0.12)' : SURF2,
                    color:      aiText ? GOLD : TEXT2,
                    border:     `1px solid ${aiText ? 'rgba(0,210,210,0.3)' : BORDER}`,
                  }}>
                  <SparkIcon />
                  {aiLoad ? 'מנתח...' : aiText ? 'ניתוח AI' : 'ניתוח AI'}
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
                                    : 'rgba(0,210,210,0.1)',
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
            {FORM_TEMPLATES.map(t => (
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
                    background:   form.direction === d ? 'rgba(0,210,210,0.12)' : SURF2,
                    borderColor:  form.direction === d ? GOLD : BORDER,
                    color:        form.direction === d ? GOLD : TEXT2,
                  }}>
                  {DIR_LABELS[d]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="R:R מינימלי">
            <input type="number" step="any" placeholder="למשל: 2"
              value={form.min_rr}
              onChange={e => setForm({ ...form, min_rr: e.target.value })}
              style={{ ...inputSt }} />
          </Field>

          <Field label="טווח שעות מסחר (אופציונלי)">
            <div className="grid grid-cols-2 gap-2">
              <input type="time"
                value={form.trading_hours_start}
                onChange={e => setForm({ ...form, trading_hours_start: e.target.value })}
                style={{ ...inputSt }} />
              <input type="time"
                value={form.trading_hours_end}
                onChange={e => setForm({ ...form, trading_hours_end: e.target.value })}
                style={{ ...inputSt }} />
            </div>
          </Field>

          <Field label="טיים-פריימים מותרים">
            <div className="flex flex-wrap gap-1.5">
              {TIMEFRAME_OPTIONS.map(t => (
                <button key={t} onClick={() => toggleTimeframe(t)}
                  className="px-2.5 py-1 rounded-full text-xs border transition-all"
                  style={{
                    background:  form.allowed_timeframes.includes(t) ? 'rgba(0,210,210,0.12)' : SURF2,
                    borderColor: form.allowed_timeframes.includes(t) ? GOLD : BORDER,
                    color:       form.allowed_timeframes.includes(t) ? GOLD : TEXT2,
                  }}>
                  {t}
                </button>
              ))}
            </div>
          </Field>

          <Field label="תנאי כניסה">
            <p className="text-[11px] mb-1.5" style={{ color: MUTED }}>
              פרק את האסטרטגיה לתנאים בדיקים — בפתיחת עסקה תסמן וי על כל תנאי שמתקיים
            </p>
            <div className="flex gap-2">
              <input type="text" placeholder="למשל: מגמה עולה ב-4H"
                value={newCondition}
                onChange={e => setNewCondition(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCondition(); } }}
                style={{ ...inputSt, flex: 1 }} />
              <button onClick={addCondition}
                className="px-3 py-2 rounded-xl text-sm font-semibold shrink-0"
                style={{ background: SURF2, color: TEXT2, border: `1px solid ${BORDER}` }}>
                הוסף תנאי
              </button>
            </div>
            {form.entry_conditions.length > 0 && (
              <div className="flex flex-col gap-1.5 mt-2">
                {form.entry_conditions.map((c, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-xs"
                    style={{ background: SURF2 }}>
                    <span style={{ color: TEXT }}>{c}</span>
                    <button onClick={() => removeCondition(i)} style={{ color: RED }} className="shrink-0">✕</button>
                  </div>
                ))}
              </div>
            )}
          </Field>

          <Field label="מקסימום עסקאות ביום (אופציונלי)">
            <input type="number" step="1" min="0" placeholder="0"
              value={form.max_daily_trades}
              onChange={e => setForm({ ...form, max_daily_trades: e.target.value })}
              style={{ ...inputSt }} />
          </Field>

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
      </div>{/* end user strategies */}

      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        limitType="strategies"
      />
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
