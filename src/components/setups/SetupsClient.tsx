'use client';

import { useState, useRef, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Sparkles } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Setup {
  id: string;
  user_id: string;
  name: string;
  symbol: string | null;
  description: string;
  entry_conditions: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  market_context: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface LinkedTrade {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number;
  exit_price: number | null;
  status: string;
  setup_id: string | null;
  submitted_at: string;
  rr_ratio: number;
}

type View = 'list' | 'create' | 'detail';

// ── Design tokens ─────────────────────────────────────────────────────────────
const GOLD   = '#00d2d2';
const BG     = 'var(--color-tg-bg)';
const SURF   = 'var(--color-tg-surface)';
const SURF2  = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';
const MUTED  = 'var(--color-tg-muted)';

// ── Helpers ───────────────────────────────────────────────────────────────────

function pnl(t: LinkedTrade) {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return Number(t.exit_price) - Number(t.entry_price);
}

function fmt(v: number, d = 1) {
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(d)}`;
}

function computeStats(setupId: string, trades: LinkedTrade[]) {
  const linked  = trades.filter(t => t.setup_id === setupId);
  const closed  = linked.filter(t => t.status === 'closed' && t.exit_price != null);
  const pnls    = closed.map(t => pnl(t)!);
  const wins    = pnls.filter(p => p > 0);
  const total   = pnls.reduce((s, p) => s + p, 0);
  return {
    tradeCount: linked.length,
    closedCount: closed.length,
    winRate:  closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0,
    totalPnl: total,
    avgPnl:   closed.length > 0 ? total / closed.length : 0,
    avgRR:    linked.length > 0
      ? Number((linked.reduce((s, t) => s + Number(t.rr_ratio), 0) / linked.length).toFixed(1))
      : 0,
  };
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function SetupsClient({
  initialSetups,
  initialTrades,
  userId,
}: {
  initialSetups: Setup[];
  initialTrades: LinkedTrade[];
  userId: string;
}) {
  const [setups,   setSetups]   = useState<Setup[]>(initialSetups);
  const [trades,   setTrades]   = useState<LinkedTrade[]>(initialTrades);
  const [view,     setView]     = useState<View>('list');
  const [selected, setSelected] = useState<Setup | null>(null);
  const [aiReview, setAiReview] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const supabase = createClient();

  function openDetail(s: Setup) {
    setSelected(s);
    setAiReview(null);
    setView('detail');
  }

  async function fetchAiReview(s: Setup) {
    setAiLoading(true);
    const stats = computeStats(s.id, trades);
    try {
      const res = await fetch('/api/ai-setup-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup: s, stats }),
      });
      const { review } = await res.json();
      setAiReview(review || 'לא ניתן לטעון ביקורת.');
    } catch {
      setAiReview('שגיאה בטעינת ביקורת AI.');
    }
    setAiLoading(false);
  }

  async function deleteSetup(id: string) {
    await supabase.from('setups').delete().eq('id', id);
    setSetups(prev => prev.filter(s => s.id !== id));
    setView('list');
  }

  async function toggleTradeLink(tradeId: string, currentSetupId: string | null) {
    if (!selected) return;
    const newId = currentSetupId === selected.id ? null : selected.id;
    await supabase.from('trade_plans').update({ setup_id: newId }).eq('id', tradeId);
    setTrades(prev => prev.map(t => t.id === tradeId ? { ...t, setup_id: newId } : t));
  }

  if (view === 'create') {
    return (
      <CreateForm
        userId={userId}
        supabase={supabase}
        onSave={(s) => { setSetups(prev => [s, ...prev]); openDetail(s); }}
        onCancel={() => setView('list')}
      />
    );
  }

  if (view === 'detail' && selected) {
    const stats = computeStats(selected.id, trades);
    const linked   = trades.filter(t => t.setup_id === selected.id);
    const unlinked = trades.filter(t => t.setup_id !== selected.id && t.setup_id == null);

    return (
      <DetailView
        setup={selected}
        stats={stats}
        linked={linked}
        unlinked={unlinked}
        aiReview={aiReview}
        aiLoading={aiLoading}
        onBack={() => setView('list')}
        onDelete={() => deleteSetup(selected.id)}
        onAiReview={() => fetchAiReview(selected)}
        onToggleTrade={toggleTradeLink}
      />
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(0,210,210,0.12)', border: `1px solid rgba(0,210,210,0.22)` }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
              <line x1="7" y1="7" x2="7.01" y2="7"/>
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold" style={{ color: TEXT }}>סטאפים ותגיות</h1>
            <p className="text-xs" style={{ color: MUTED }}>הגדר ועקוב אחרי הסטאפים שלך</p>
          </div>
        </div>
        <button onClick={() => setView('create')} style={goldBtn}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          סטאפ חדש
        </button>
      </div>

      {/* Empty state */}
      {setups.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 gap-4">
          <div style={{ fontSize: 52 }}>🎯</div>
          <p className="text-base font-semibold" style={{ color: TEXT }}>אין סטאפים עדיין</p>
          <p className="text-sm text-center" style={{ color: MUTED }}>
            הגדר סטאפ, קשר אליו עסקאות<br/>וקבל ניתוח AI מפורט
          </p>
          <button onClick={() => setView('create')} style={goldBtn}>+ סטאפ חדש</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {setups.map(s => {
            const st = computeStats(s.id, trades);
            return (
              <SetupCard key={s.id} setup={s} stats={st} onClick={() => openDetail(s)} />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Setup card ────────────────────────────────────────────────────────────────

function SetupCard({ setup, stats, onClick }: {
  setup: Setup;
  stats: ReturnType<typeof computeStats>;
  onClick: () => void;
}) {
  const profitColor = stats.totalPnl > 0 ? '#4ade80' : stats.totalPnl < 0 ? '#f87171' : 'var(--color-tg-text-2)';

  return (
    <button onClick={onClick} className="text-right w-full rounded-2xl p-4 flex flex-col gap-3 transition-all hover:opacity-80 active:scale-[0.98]"
      style={{ background: SURF, border: `1px solid ${BORDER}`, direction: 'rtl' }}>

      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-base font-bold truncate" style={{ color: TEXT }}>{setup.name}</p>
          {setup.symbol && (
            <span className="text-xs px-2 py-0.5 rounded-md font-semibold mt-0.5 inline-block"
              style={{ background: `rgba(0,210,210,0.12)`, color: GOLD }}>
              {setup.symbol}
            </span>
          )}
        </div>
        {setup.image_url && (
          <img src={setup.image_url} alt="" className="w-14 h-10 rounded-lg object-cover shrink-0" />
        )}
      </div>

      {(setup.entry_conditions || setup.description) && (
        <p className="text-xs leading-relaxed line-clamp-2" style={{ color: TEXT2 }}>
          {setup.entry_conditions || setup.description}
        </p>
      )}

      <div className="flex gap-3">
        <StatBadge label="עסקאות" value={String(stats.tradeCount)} />
        {stats.closedCount > 0 && <>
          <StatBadge label="הצלחה" value={`${stats.winRate}%`}
            color={stats.winRate >= 60 ? '#4ade80' : stats.winRate >= 40 ? '#facc15' : '#f87171'} />
          <StatBadge label="P&L" value={stats.closedCount > 0 ? fmt(stats.totalPnl) : '—'} color={profitColor} />
          <StatBadge label="R:R" value={`1:${stats.avgRR}`} color={GOLD} />
        </>}
      </div>
    </button>
  );
}

function StatBadge({ label, value, color = 'var(--color-tg-text)' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5" style={{ background: SURF2 }}>
      <span className="text-[10px]" style={{ color: MUTED }}>{label}</span>
      <span className="text-xs font-bold" style={{ color }}>{value}</span>
    </div>
  );
}

// ── Detail view ───────────────────────────────────────────────────────────────

function DetailView({ setup, stats, linked, unlinked, aiReview, aiLoading, onBack, onDelete, onAiReview, onToggleTrade }: {
  setup: Setup;
  stats: ReturnType<typeof computeStats>;
  linked: LinkedTrade[];
  unlinked: LinkedTrade[];
  aiReview: string | null;
  aiLoading: boolean;
  onBack: () => void;
  onDelete: () => void;
  onAiReview: () => void;
  onToggleTrade: (id: string, currentSetupId: string | null) => void;
}) {
  const [showLinkPanel, setShowLinkPanel] = useState(false);

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-4">

      {/* Nav */}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-sm" style={{ color: TEXT2 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          כל הסטאפים
        </button>
        <button onClick={onDelete} className="text-xs px-3 py-1.5 rounded-lg"
          style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>
          מחק סטאפ
        </button>
      </div>

      {/* Header */}
      <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: SURF, border: `1px solid ${BORDER}` }}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-bold" style={{ color: TEXT }}>{setup.name}</h1>
            {setup.symbol && (
              <span className="text-xs px-2 py-0.5 rounded-md font-semibold mt-1 inline-block"
                style={{ background: `rgba(0,210,210,0.12)`, color: GOLD }}>
                {setup.symbol}
              </span>
            )}
          </div>
          {setup.image_url && (
            <img src={setup.image_url} alt="" className="w-24 h-16 rounded-xl object-cover shrink-0" />
          )}
        </div>
        {(setup.entry_conditions || setup.stop_loss || setup.take_profit || setup.market_context)
          ? (
            <div className="flex flex-col gap-3 mt-1">
              {([
                { label: 'תנאי כניסה',  value: setup.entry_conditions },
                { label: 'Stop Loss',    value: setup.stop_loss },
                { label: 'Take Profit',  value: setup.take_profit },
                { label: 'הקשר שוק',    value: setup.market_context },
              ] as { label: string; value: string | null }[]).filter(f => f.value).map(f => (
                <div key={f.label}>
                  <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: MUTED }}>{f.label}</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: TEXT2 }}>{f.value}</p>
                </div>
              ))}
            </div>
          )
          : setup.description
            ? <p className="text-sm leading-relaxed" style={{ color: TEXT2 }}>{setup.description}</p>
            : null
        }
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'עסקאות', value: String(stats.tradeCount), color: TEXT },
          { label: 'הצלחה', value: stats.closedCount > 0 ? `${stats.winRate}%` : '—',
            color: stats.winRate >= 60 ? '#4ade80' : stats.winRate >= 40 ? '#facc15' : stats.closedCount > 0 ? '#f87171' : MUTED },
          { label: 'P&L', value: stats.closedCount > 0 ? fmt(stats.totalPnl) : '—',
            color: stats.totalPnl > 0 ? '#4ade80' : stats.totalPnl < 0 ? '#f87171' : MUTED },
          { label: 'ממוצע R:R', value: stats.tradeCount > 0 ? `1:${stats.avgRR}` : '—', color: GOLD },
        ].map(({ label, value, color }) => (
          <div key={label} className="rounded-xl p-2.5 text-center" style={{ background: SURF, border: `1px solid ${BORDER}` }}>
            <p className="text-[10px]" style={{ color: MUTED }}>{label}</p>
            <p className="text-sm font-bold mt-0.5" style={{ color }}>{value}</p>
          </div>
        ))}
      </div>

      {/* AI Review */}
      <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: SURF, border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: TEXT }}>ביקורת AI</h2>
          {!aiReview && (
            <button onClick={onAiReview} disabled={aiLoading}
              className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
              style={{ background: `rgba(0,210,210,0.12)`, color: GOLD }}>
              {aiLoading ? '⟳ מנתח...' : <><Sparkles size={12} /> קבל ביקורת AI</>}
            </button>
          )}
        </div>

        {aiReview ? (
          <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: TEXT2 }}>
            {aiReview}
          </div>
        ) : !aiLoading ? (
          <p className="text-xs py-4 text-center" style={{ color: MUTED }}>
            לחץ כדי לקבל ניתוח AI על הסטאפ
          </p>
        ) : (
          <div className="flex flex-col gap-2 py-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-3 rounded animate-pulse" style={{ background: SURF2, width: `${70 + i * 10}%` }} />
            ))}
          </div>
        )}
      </div>

      {/* Linked trades */}
      <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: SURF, border: `1px solid ${BORDER}` }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: TEXT }}>
            עסקאות מקושרות ({linked.length})
          </h2>
          <button onClick={() => setShowLinkPanel(v => !v)}
            className="text-xs px-3 py-1.5 rounded-lg" style={{ background: SURF2, color: TEXT2 }}>
            {showLinkPanel ? 'סגור' : '+ קשר עסקאות'}
          </button>
        </div>

        {linked.length > 0 ? (
          <div className="flex flex-col gap-0">
            {linked.map((t, i) => <TradeRow key={t.id} trade={t} isLinked onToggle={onToggleTrade} borderTop={i > 0} />)}
          </div>
        ) : (
          <p className="text-xs text-center py-3" style={{ color: MUTED }}>אין עסקאות מקושרות עדיין</p>
        )}

        {/* Link panel */}
        {showLinkPanel && unlinked.length > 0 && (
          <div className="mt-1">
            <p className="text-xs mb-2 font-medium" style={{ color: MUTED }}>עסקאות לא מקושרות — לחץ לקישור:</p>
            <div className="flex flex-col gap-0 rounded-xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
              {unlinked.slice(0, 15).map((t, i) => (
                <TradeRow key={t.id} trade={t} isLinked={false} onToggle={onToggleTrade} borderTop={i > 0} />
              ))}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function TradeRow({ trade, isLinked, onToggle, borderTop }: {
  trade: LinkedTrade;
  isLinked: boolean;
  onToggle: (id: string, setupId: string | null) => void;
  borderTop: boolean;
}) {
  const p = pnl(trade);
  return (
    <div className="flex items-center gap-3 py-2.5 px-1"
      style={{ borderTop: borderTop ? `1px solid ${BORDER}` : undefined }}>
      <button
        onClick={() => onToggle(trade.id, trade.setup_id)}
        className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-colors"
        style={{
          background: isLinked ? GOLD : SURF2,
          border: `1px solid ${isLinked ? GOLD : BORDER}`,
        }}>
        {isLinked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0a0a0f" strokeWidth="3">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" style={{ color: TEXT }}>{trade.strategy}</p>
        <p className="text-[10px]" style={{ color: MUTED }}>
          {new Date(trade.submitted_at).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}
          {trade.symbol && ` · ${trade.symbol}`}
        </p>
      </div>
      {p !== null && (
        <span className="text-xs font-bold shrink-0" style={{ color: p > 0 ? '#4ade80' : '#f87171' }}>
          {fmt(p, 1)}
        </span>
      )}
    </div>
  );
}

// ── Create form ───────────────────────────────────────────────────────────────

function CreateForm({ userId, supabase, onSave, onCancel }: {
  userId: string;
  supabase: ReturnType<typeof createClient>;
  onSave: (s: Setup) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: '', symbol: '',
    entryConditions: '', stopLoss: '', takeProfit: '', marketContext: '',
  });
  const [imgFile, setImgFile] = useState<File | null>(null);
  const [imgPreview, setImgPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImgFile(f);
    setImgPreview(URL.createObjectURL(f));
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('שם הסטאפ חובה'); return; }
    setSaving(true);
    setError('');

    let image_url: string | null = null;

    if (imgFile) {
      const path = `${userId}/${Date.now()}-${imgFile.name}`;
      const { error: uploadErr } = await supabase.storage
        .from('setup-images').upload(path, imgFile, { upsert: true });
      if (!uploadErr) {
        const { data } = supabase.storage.from('setup-images').getPublicUrl(path);
        image_url = data.publicUrl;
      }
    }

    const { data, error: dbErr } = await supabase
      .from('setups')
      .insert({
        user_id: userId,
        name: form.name.trim(),
        symbol: form.symbol.trim() || null,
        description: '',
        entry_conditions: form.entryConditions.trim() || null,
        stop_loss:        form.stopLoss.trim()        || null,
        take_profit:      form.takeProfit.trim()      || null,
        market_context:   form.marketContext.trim()   || null,
        image_url,
      })
      .select().single();

    if (dbErr || !data) {
      setError('שגיאה בשמירה. נסה שוב.');
    } else {
      onSave(data as Setup);
    }
    setSaving(false);
  }

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-4">

      <div className="flex items-center gap-3">
        <button onClick={onCancel} style={{ color: TEXT2 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
        <h1 className="text-xl font-bold" style={{ color: TEXT }}>סטאפ חדש</h1>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl p-4" style={{ background: SURF, border: `1px solid ${BORDER}` }}>

        {/* Name */}
        <FormField label="שם הסטאפ *">
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder='לדוגמה: "פריצת פרנג׳ בפתיחה"'
            style={{ ...inputStyle }} />
        </FormField>

        {/* Symbol */}
        <FormField label="סמל / מדד">
          <input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value })}
            placeholder="NQ, ES, AAPL, BTC..."
            style={{ ...inputStyle }} />
        </FormField>

        {/* Structured setup fields */}
        <FormField label="תנאי כניסה" hint="מה צריך לקרות כדי להיכנס לעסקה">
          <textarea value={form.entryConditions}
            onChange={e => setForm({ ...form, entryConditions: e.target.value })}
            rows={3} placeholder="לדוגמה: מחיר שובר סיסטנס, נר סגירה מעל, RSI > 50..."
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.7' }} />
        </FormField>

        <FormField label="Stop Loss" hint="איפה שמים את הסטופ">
          <textarea value={form.stopLoss}
            onChange={e => setForm({ ...form, stopLoss: e.target.value })}
            rows={2} placeholder="לדוגמה: מתחת לנר הקודם, מתחת לסאפורט..."
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.7' }} />
        </FormField>

        <FormField label="Take Profit" hint="היעד">
          <textarea value={form.takeProfit}
            onChange={e => setForm({ ...form, takeProfit: e.target.value })}
            rows={2} placeholder="לדוגמה: R:R 1:2, יעד קודם, סיסטנס הבא..."
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.7' }} />
        </FormField>

        <FormField label="הקשר שוק" hint="טיימפריים, סשן, תנאים כלליים">
          <textarea value={form.marketContext}
            onChange={e => setForm({ ...form, marketContext: e.target.value })}
            rows={2} placeholder="לדוגמה: טיימפריים H1+M15, סשן לונדון, טרנד עולה ב-D1..."
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.7' }} />
        </FormField>

        {/* Image upload */}
        <FormField label="צילום מסך / תמונה (אופציונלי)">
          <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" />
          {imgPreview ? (
            <div className="relative">
              <img src={imgPreview} alt="Preview" className="w-full max-h-48 rounded-xl object-cover" />
              <button onClick={() => { setImgFile(null); setImgPreview(null); }}
                className="absolute top-2 left-2 w-7 h-7 rounded-full flex items-center justify-center"
                style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          ) : (
            <button onClick={() => fileRef.current?.click()}
              className="w-full py-8 rounded-xl flex flex-col items-center gap-2 transition-colors hover:opacity-80"
              style={{ border: `2px dashed ${BORDER}`, background: SURF2 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span className="text-xs" style={{ color: MUTED }}>לחץ להעלאת תמונה</span>
            </button>
          )}
        </FormField>

        {error && <p className="text-xs px-3 py-2 rounded-xl" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }}>{error}</p>}

        <div className="flex gap-2 pt-1">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
            style={{ background: SURF2, color: TEXT2 }}>ביטול</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
            style={{ background: GOLD, color: '#0a0a0f' }}>
            {saving ? 'שומר...' : 'שמור סטאפ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <label className="text-sm font-medium" style={{ color: TEXT2 }}>{label}</label>
        {hint && <p className="text-[10px] mt-0.5" style={{ color: MUTED }}>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const goldBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 12,
  background: GOLD, color: '#0a0a0f',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  border: 'none', flexShrink: 0,
};

const inputStyle: CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  background: SURF2, border: `1px solid ${BORDER}`,
  color: TEXT, fontSize: 14, outline: 'none',
  boxSizing: 'border-box', direction: 'rtl',
};
