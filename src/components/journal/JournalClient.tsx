'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, DollarSign, Pencil, Trash2 } from 'lucide-react';
import CloseTrade, { AIDebriefView, type AIDebriefResult } from '@/components/journal/CloseTrade';
import EmotionalStateSlider from '@/components/trade/EmotionalStateSlider';
import { createClient } from '@/lib/supabase/client';
import { formatPnlIls, formatPnlPoints, calcRR } from '@/lib/utils';
import type { PnlCurrency } from '@/lib/types';

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

// ── Shared form field styling (edit modal) ─────────────────────────────────────
const FIELD_CLASS = 'w-full px-3 py-2 rounded-xl text-sm border outline-none focus:border-tg-primary transition-colors';
const fieldStyle = { background: SURF2, borderColor: BORDER, color: TEXT };

// ── Types ─────────────────────────────────────────────────────────────────────
interface Trade {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  exit_price: number | null;
  exit_reason: string | null;
  post_trade_notes: string | null;
  debrief_answer: string | null;
  submitted_at: string;
  closed_at: string | null;
  plan_score: number | null;
  quantity: number | null;
  pnl_amount: number | null;
  pnl_currency: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function inferDirection(t: Trade): 'long' | 'short' {
  return t.take_profit >= t.entry_price ? 'long' : 'short';
}

function calcPnl(t: Trade): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  return inferDirection(t) === 'long'
    ? t.exit_price - t.entry_price
    : t.entry_price - t.exit_price;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', {
    day: '2-digit', month: '2-digit', year: '2-digit',
  });
}

function fmtPnl(v: number) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}

const PAGE_SIZES = [15, 30, 50, 100];

// ── Mobile trade card (shown instead of table on small screens) ───────────────
function MobileTradeCard({ t, onView, onEdit, onDelete, onClose, onDebrief, hasDebrief }: {
  t: Trade;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
  onDebrief: () => void;
  hasDebrief: boolean;
}) {
  const pnl = calcPnl(t);
  const dir = inferDirection(t);
  const isWin = pnl !== null ? pnl > 0 : null;
  const isClosed = t.status === 'closed';

  return (
    <div
      onClick={onView}
      style={{ background: SURF, border: `1px solid ${BORDER}`, borderRadius: 14, cursor: 'pointer' }}
    >
      <div className="p-3 flex flex-col gap-2">
        {/* Row 1: asset + status */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <AssetDot symbol={t.symbol} />
            <span className="font-semibold truncate" style={{ fontSize: 14, color: TEXT }}>
              {t.symbol ?? t.strategy}
            </span>
            <Chip
              bg={dir === 'long' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)'}
              color={dir === 'long' ? GREEN : RED}>
              {dir === 'long' ? 'לונג' : 'שורט'}
            </Chip>
          </div>
          {isClosed ? <StatusBadge win={isWin} /> : <Chip bg="rgba(0,210,210,0.12)" color={GOLD}>פתוח</Chip>}
        </div>

        {/* Row 2: date + P&L */}
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 12, color: MUTED, fontWeight: 600 }}>{fmtDate(t.submitted_at)}</span>
          {pnl !== null ? (
            t.pnl_amount != null ? (
              <span style={{ fontSize: 14, fontWeight: 700, color: t.pnl_amount >= 0 ? GREEN : RED }}>
                {formatPnlIls(t.pnl_amount, t.pnl_currency ?? '₪')}
                <span style={{ fontSize: 11, opacity: 0.6 }}> ({formatPnlPoints(pnl)})</span>
              </span>
            ) : (
              <span style={{ fontSize: 14, fontWeight: 700, color: pnl >= 0 ? GREEN : RED }}>
                {fmtPnl(pnl)}
              </span>
            )
          ) : (
            <span style={{ fontSize: 12, color: GOLD, fontWeight: 600 }}>פתוח</span>
          )}
        </div>

        {/* Row 3: action buttons */}
        <div className="flex gap-2 pt-2" style={{ borderTop: `1px solid ${BORDER}` }}>
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="flex-1 flex items-center justify-center rounded-xl text-xs font-semibold h-11"
            style={{ background: SURF2, color: TEXT2 }}>
            ערוך
          </button>
          {t.status === 'open' && (
            <button
              onClick={e => { e.stopPropagation(); onClose(); }}
              className="flex-1 flex items-center justify-center rounded-xl text-xs font-semibold h-11"
              style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)', border: '1px solid rgba(239,68,68,0.3)' }}>
              סגור עסקה
            </button>
          )}
          {hasDebrief && (
            <button
              onClick={e => { e.stopPropagation(); onDebrief(); }}
              className="flex-1 flex items-center justify-center rounded-xl text-xs font-semibold h-11"
              style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)', border: '1px solid rgba(0,210,210,0.3)' }}>
              ניתוח AI
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="w-11 h-11 flex items-center justify-center rounded-xl shrink-0"
            style={{ background: 'rgba(248,113,113,0.1)', color: RED }}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function JournalClient({ trades: initialTrades }: { trades: Trade[] }) {
  const [trades,       setTrades]       = useState<Trade[]>(initialTrades);
  const [search,       setSearch]       = useState('');
  const [selected,     setSelected]     = useState<Set<string>>(new Set());
  const [sortDir,      setSortDir]      = useState<'asc' | 'desc'>('desc');
  const [pageSize,     setPageSize]     = useState(30);
  const [page,         setPage]         = useState(1);
  const [showActions,  setShowActions]  = useState(false);
  const [showFilter,   setShowFilter]   = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'closed'>('all');
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [viewTradeId, setViewTradeId] = useState<string | null>(null);
  const [debriefResults, setDebriefResults] = useState<Record<string, AIDebriefResult>>({});
  const [viewDebriefId, setViewDebriefId] = useState<string | null>(null);
  const [editingTradeId, setEditingTradeId] = useState<string | null>(null);
  const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const router = useRouter();
  const supabase = createClient();

  // ── Stats ──────────────────────────────────────────────────────────────────
  const closed = useMemo(() =>
    trades.filter(t => t.status === 'closed' && t.exit_price != null), [trades]);
  const pnls        = useMemo(() => closed.map(t => calcPnl(t)!), [closed]);
  const wins        = pnls.filter(p => p > 0);
  const losses      = pnls.filter(p => p < 0);
  const totalPnl    = pnls.reduce((s, p) => s + p, 0);
  const winRate     = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss   = Math.abs(losses.reduce((s, p) => s + p, 0));
  const pfNum       = grossLoss > 0 ? grossProfit / grossLoss : null;
  const pfStr       = pfNum !== null ? pfNum.toFixed(2) : grossProfit > 0 ? '∞' : '—';

  const closedWithAmount  = useMemo(() => closed.filter(t => t.pnl_amount != null), [closed]);
  const pnlCurrencies     = useMemo(() => Array.from(new Set(closedWithAmount.map(t => t.pnl_currency ?? '₪'))), [closedWithAmount]);
  const totalPnlAmount    = closedWithAmount.reduce((s, t) => s + (t.pnl_amount ?? 0), 0);
  const pnlAmountCurrency = pnlCurrencies.length === 1 ? pnlCurrencies[0] : '₪';
  const hasPnlAmount      = closedWithAmount.length > 0;

  // ── Filtered + sorted ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = trades;
    if (filterStatus !== 'all') r = r.filter(t => t.status === filterStatus);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(t =>
        t.symbol?.toLowerCase().includes(q) || t.strategy.toLowerCase().includes(q)
      );
    }
    return [...r].sort((a, b) => {
      const da = new Date(a.closed_at ?? a.submitted_at).getTime();
      const db = new Date(b.closed_at ?? b.submitted_at).getTime();
      return sortDir === 'desc' ? db - da : da - db;
    });
  }, [trades, search, filterStatus, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageStart  = (page - 1) * pageSize;
  const pageTrades = filtered.slice(pageStart, pageStart + pageSize);

  // ── Selection ─────────────────────────────────────────────────────────────
  const allOnPage = pageTrades.length > 0 && pageTrades.every(t => selected.has(t.id));
  function toggleAll() {
    setSelected(prev => {
      const n = new Set(prev);
      allOnPage ? pageTrades.forEach(t => n.delete(t.id)) : pageTrades.forEach(t => n.add(t.id));
      return n;
    });
  }
  function toggleOne(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // ── Delete / edit ─────────────────────────────────────────────────────────
  async function handleDeleteTrade(id: string) {
    setDeleteLoading(true);
    setDeleteError('');
    const { error } = await supabase.from('trade_plans').delete().eq('id', id);
    if (error) {
      setDeleteError('שגיאה במחיקה — נסה שוב');
      setDeleteLoading(false);
      return;
    }
    setTrades(prev => prev.filter(t => t.id !== id));
    setSelected(prev => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    setDeleteLoading(false);
    setDeletingTradeId(null);
    router.refresh();
  }

  function handleTradeUpdated(updated: Trade) {
    setTrades(prev => prev.map(t => t.id === updated.id ? updated : t));
    setEditingTradeId(null);
    router.refresh();
  }

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pageNums = useMemo(() => {
    const half  = 2;
    const start = Math.max(1, Math.min(page - half, totalPages - half * 2));
    const end   = Math.min(totalPages, start + half * 2);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }, [page, totalPages]);

  return (
    <div dir="rtl" className="flex flex-col gap-4">

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="סה״כ עסקאות"   value={String(trades.length)} icon={<BarChartIcon />} />
        <StatCard label="אחוז הצלחה"    value={`${winRate}%`}
          icon={<TrendUpIcon />}
          color={winRate >= 50 ? GREEN : RED} />
        <StatCard label="רווח / הפסד"
          value={hasPnlAmount ? formatPnlIls(totalPnlAmount, pnlAmountCurrency) : fmtPnl(totalPnl)}
          icon={<DollarSign size={14} color={GOLD} strokeWidth={2} />}
          color={(hasPnlAmount ? totalPnlAmount : totalPnl) >= 0 ? GREEN : RED}
          className="min-w-0"
          valueClassName="text-base sm:text-2xl font-bold break-all" />
        <StatCard label="פקטור רווח" value={pfStr}
          icon={<TargetIcon />}
          color={pfNum !== null ? (pfNum >= 1.5 ? GREEN : pfNum >= 1 ? GOLD : RED) : MUTED} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 justify-between flex-wrap gap-y-2">
        <div className="flex items-center gap-2">

          {/* Filter */}
          <div className="relative">
            <button
              onClick={() => { setShowFilter(v => !v); setShowActions(false); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium"
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
              <FilterIcon />
              סינון
              {filterStatus !== 'all' && (
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: GOLD }} />
              )}
            </button>
            {showFilter && (
              <div className="absolute top-full mt-1 right-0 z-30 rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[130px]"
                style={{ background: SURF, border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                {(['all', 'open', 'closed'] as const).map(s => (
                  <button key={s}
                    onClick={() => { setFilterStatus(s); setShowFilter(false); setPage(1); }}
                    className="px-3 py-1.5 rounded-lg text-sm text-right transition-all"
                    style={{
                      background: filterStatus === s ? 'rgba(0,210,210,0.12)' : 'transparent',
                      color: filterStatus === s ? GOLD : TEXT2,
                      fontWeight: 600,
                    }}>
                    {s === 'all' ? 'הכל' : s === 'open' ? 'פתוחות' : 'סגורות'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="relative">
            <button
              onClick={() => { setShowActions(v => !v); setShowFilter(false); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium"
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
              פעולות
              <ChevronIcon />
            </button>
            {showActions && (
              <div className="absolute top-full mt-1 right-0 z-30 rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[160px]"
                style={{ background: SURF, border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button
                  onClick={() => { router.refresh(); setShowActions(false); }}
                  className="px-3 py-1.5 rounded-lg text-sm text-right transition-all hover:opacity-80"
                  style={{ color: TEXT2, fontWeight: 600 }}>
                  רענן נתונים
                </button>
                {selected.size > 0 && (
                  <button
                    onClick={() => { setSelected(new Set()); setShowActions(false); }}
                    className="px-3 py-1.5 rounded-lg text-sm text-right transition-all hover:opacity-80"
                    style={{ color: RED }}>
                    בטל בחירה ({selected.size})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute right-3 top-1/2 -translate-y-1/2" width="13" height="13"
            viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="חפש לפי נכס..."
            className="w-full pr-8 pl-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT, direction: 'rtl' }}
          />
        </div>
      </div>

      {/* Mobile card list */}
      <div className="md:hidden flex flex-col gap-2">
        {pageTrades.length === 0 ? (
          <div className="text-center py-14 text-sm" style={{ color: MUTED, fontWeight: 600 }}>לא נמצאו עסקאות</div>
        ) : pageTrades.map(t => (
          <MobileTradeCard
            key={t.id}
            t={t}
            onView={() => setViewTradeId(t.id)}
            onEdit={() => setEditingTradeId(t.id)}
            onDelete={() => { setDeletingTradeId(t.id); setDeleteError(''); }}
            onClose={() => { setViewTradeId(null); setClosingTradeId(t.id); }}
            onDebrief={() => setViewDebriefId(t.id)}
            hasDebrief={!!debriefResults[t.id]}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: SURF, borderBottom: `1px solid ${BORDER}` }}>
                <TH>
                  <input type="checkbox" checked={allOnPage} onChange={toggleAll}
                    className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: GOLD }} />
                </TH>
                <TH sortable sortDir={sortDir} onSort={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}>
                  תאריך סגירה
                </TH>
                <TH>סטטוס</TH>
                <TH>נכס</TH>
                <TH>סוג</TH>
                <TH>תאריך פתיחה</TH>
                <TH>כמות</TH>
                <TH>תוצאה</TH>
                <TH>מחיר כניסה</TH>
                <TH>אסטרטגיה</TH>
                <TH>פעולות</TH>
              </tr>
            </thead>
            <tbody>
              {pageTrades.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center py-14 text-sm" style={{ color: MUTED, fontWeight: 600 }}>
                    לא נמצאו עסקאות
                  </td>
                </tr>
              ) : pageTrades.map((t, i) => {
                const pnl      = calcPnl(t);
                const dir      = inferDirection(t);
                const isWin    = pnl !== null ? pnl > 0 : null;
                const isClosed = t.status === 'closed';
                const isChecked = selected.has(t.id);

                return (
                  <tr key={t.id}
                    onClick={() => { setClosingTradeId(null); setViewTradeId(t.id); }}
                    style={{
                      background: isChecked
                        ? 'rgba(0,210,210,0.06)'
                        : i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      borderBottom: `1px solid ${BORDER}`,
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}>

                    {/* Checkbox */}
                    <TD>
                      <input type="checkbox" checked={isChecked}
                        onChange={() => toggleOne(t.id)}
                        onClick={e => e.stopPropagation()}
                        className="w-3.5 h-3.5 cursor-pointer" style={{ accentColor: GOLD }} />
                    </TD>

                    {/* Close date */}
                    <TD>
                      <span style={{ color: TEXT2, fontWeight: 600 }}>
                        {isClosed && t.closed_at ? fmtDate(t.closed_at) : '—'}
                      </span>
                    </TD>

                    {/* Status */}
                    <TD>
                      {isClosed
                        ? <StatusBadge win={isWin} />
                        : <Chip bg="rgba(0,210,210,0.12)" color={GOLD}>פתוח</Chip>
                      }
                    </TD>

                    {/* Asset */}
                    <TD>
                      <div className="flex items-center gap-2">
                        <AssetDot symbol={t.symbol} />
                        <span className="font-semibold text-sm" style={{ color: TEXT }}>
                          {t.symbol ?? '—'}
                        </span>
                      </div>
                    </TD>

                    {/* Direction */}
                    <TD>
                      <Chip
                        bg={dir === 'long' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)'}
                        color={dir === 'long' ? GREEN : RED}>
                        {dir === 'long' ? 'לונג' : 'שורט'}
                      </Chip>
                    </TD>

                    {/* Open date */}
                    <TD>
                      <span style={{ color: TEXT2, fontWeight: 600 }}>{fmtDate(t.submitted_at)}</span>
                    </TD>

                    {/* Quantity — not in schema */}
                    <TD><span style={{ color: MUTED, fontWeight: 600 }}>—</span></TD>

                    {/* P&L */}
                    <TD>
                      {pnl !== null ? (
                        t.pnl_amount != null ? (
                          <span style={{ color: t.pnl_amount >= 0 ? GREEN : RED }}>
                            <span className="font-semibold">{formatPnlIls(t.pnl_amount, t.pnl_currency ?? '₪')}</span>
                            <span className="text-xs" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnl)})</span>
                          </span>
                        ) : (
                          <span className="font-semibold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                            {fmtPnl(pnl)}
                          </span>
                        )
                      ) : (
                        <span style={{ color: MUTED, fontWeight: 600 }}>—</span>
                      )}
                    </TD>

                    {/* Entry price */}
                    <TD>
                      <span className="font-mono text-xs" style={{ color: TEXT }}>
                        {t.entry_price.toFixed(2)}
                      </span>
                    </TD>

                    {/* Strategy */}
                    <TD>
                      <span className="text-xs truncate max-w-[120px] block" style={{ color: TEXT2, fontWeight: 600 }}>
                        {t.strategy}
                      </span>
                    </TD>

                    {/* Actions */}
                    <TD>
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          onClick={e => { e.stopPropagation(); setEditingTradeId(t.id); }}
                          className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
                          style={{ background: SURF2, color: MUTED }}
                          title="ערוך עסקה">
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setDeletingTradeId(t.id); setDeleteError(''); }}
                          className="w-9 h-9 flex items-center justify-center rounded-lg transition-colors hover:opacity-80"
                          style={{ background: 'rgba(248,113,113,0.1)', color: RED }}
                          title="מחק עסקה">
                          <Trash2 size={14} />
                        </button>
                        {t.status === 'open' && (
                          <button
                            onClick={e => { e.stopPropagation(); setViewTradeId(null); setClosingTradeId(t.id); }}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                            style={{
                              background: 'var(--color-tg-danger-muted)',
                              color: 'var(--color-tg-danger)',
                              border: '1px solid rgba(239,68,68,0.3)',
                              whiteSpace: 'nowrap',
                            }}>
                            סגור עסקה
                          </button>
                        )}
                        {debriefResults[t.id] && (
                          <button
                            onClick={e => { e.stopPropagation(); setViewDebriefId(t.id); }}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                            style={{
                              background: 'var(--color-tg-primary-muted)',
                              color: 'var(--color-tg-primary)',
                              border: '1px solid rgba(0,210,210,0.3)',
                              whiteSpace: 'nowrap',
                            }}>
                            ניתוח AI
                          </button>
                        )}
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination bar */}
      <div className="flex items-center justify-between flex-col sm:flex-row gap-3 px-4 py-3 rounded-2xl"
        style={{ border: `1px solid ${BORDER}`, background: SURF }}>

        {/* Rows per page */}
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: MUTED, fontWeight: 600 }}>שורות בעמוד:</span>
          <select value={pageSize}
            onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="text-xs rounded-lg px-2 py-1 outline-none"
            style={{ background: SURF2, border: `1px solid ${BORDER}`, color: TEXT2, fontWeight: 600 }}>
            {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {/* Count */}
        <span className="text-xs" style={{ color: MUTED, fontWeight: 600 }}>
          {filtered.length === 0
            ? 'אין עסקאות'
            : `מציג ${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)} מתוך ${filtered.length} עסקאות`}
        </span>

        {/* Page buttons */}
        <div className="flex items-center gap-1">
          <PgBtn onClick={() => setPage(1)}             disabled={page === 1}>«</PgBtn>
          <PgBtn onClick={() => setPage(p => p - 1)}    disabled={page === 1}>‹</PgBtn>
          {pageNums.map(n => (
            <PgBtn key={n} onClick={() => setPage(n)} active={n === page}>{n}</PgBtn>
          ))}
          <PgBtn onClick={() => setPage(p => p + 1)}    disabled={page === totalPages}>›</PgBtn>
          <PgBtn onClick={() => setPage(totalPages)}     disabled={page === totalPages}>»</PgBtn>
        </div>
      </div>

      {closingTradeId && (() => {
        const t = trades.find(tr => tr.id === closingTradeId);
        if (!t) return null;
        return (
          <Modal onClose={() => setClosingTradeId(null)}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-base font-bold" style={{ color: TEXT }}>סגירת עסקה — {t.strategy}</p>
              <button onClick={() => setClosingTradeId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
            </div>
            <CloseTrade
              tradeId={t.id}
              entryPrice={t.entry_price}
              stopLoss={t.stop_loss}
              takeProfit={t.take_profit}
              rrRatio={t.rr_ratio}
              emotionalState={t.emotional_state}
              strategy={t.strategy}
              tradeReason={t.trade_reason}
              quantity={t.quantity}
              pnlCurrency={t.pnl_currency}
              onClosed={() => { setClosingTradeId(null); router.refresh(); }}
              onDebrief={result => setDebriefResults(prev => ({ ...prev, [t.id]: result }))}
            />
          </Modal>
        );
      })()}

      {viewDebriefId && debriefResults[viewDebriefId] && (
        <Modal onClose={() => setViewDebriefId(null)}>
          <div className="flex items-center justify-between mb-1">
            <p className="text-base font-bold" style={{ color: TEXT }}>ניתוח AI על העסקה</p>
            <button onClick={() => setViewDebriefId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
          </div>
          <AIDebriefView result={debriefResults[viewDebriefId]} />
        </Modal>
      )}

      {viewTradeId && (() => {
        const t = trades.find(tr => tr.id === viewTradeId);
        if (!t) return null;
        return (
          <TradeDetailModal
            trade={t}
            onClose={() => setViewTradeId(null)}
            debriefResult={debriefResults[t.id]}
            onDebrief={result => setDebriefResults(prev => ({ ...prev, [t.id]: result }))}
          />
        );
      })()}

      {deletingTradeId && (() => {
        const t = trades.find(tr => tr.id === deletingTradeId);
        if (!t) return null;
        return (
          <Modal onClose={() => { setDeletingTradeId(null); setDeleteError(''); }}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-base font-bold" style={{ color: TEXT }}>מחיקת עסקה</p>
              <button onClick={() => { setDeletingTradeId(null); setDeleteError(''); }}
                style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
            </div>
            <p className="text-sm" style={{ color: TEXT2 }}>
              האם אתה בטוח שברצונך למחוק עסקה זו?
            </p>
            {deleteError && <p className="text-xs" style={{ color: RED }}>{deleteError}</p>}
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { setDeletingTradeId(null); setDeleteError(''); }}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
                style={{ background: SURF2, color: TEXT2 }}>
                ביטול
              </button>
              <button
                onClick={() => handleDeleteTrade(t.id)}
                disabled={deleteLoading}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-50"
                style={{ background: RED, color: '#fff' }}>
                {deleteLoading ? 'מוחק...' : 'מחק עסקה'}
              </button>
            </div>
          </Modal>
        );
      })()}

      {editingTradeId && (() => {
        const t = trades.find(tr => tr.id === editingTradeId);
        if (!t) return null;
        return (
          <EditTradeModal
            trade={t}
            onClose={() => setEditingTradeId(null)}
            onSaved={handleTradeUpdated}
          />
        );
      })()}
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color = TEXT, className = '', valueClassName = 'text-2xl font-bold' }: {
  label: string; value: string; icon: React.ReactNode; color?: string; className?: string; valueClassName?: string;
}) {
  return (
    <div className={`rounded-2xl p-4 flex flex-col gap-2 ${className}`}
      style={{ background: SURF, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: MUTED, fontWeight: 600 }}>{label}</span>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(0,210,210,0.1)' }}>
          {icon}
        </div>
      </div>
      <span className={valueClassName} style={{ color }}>{value}</span>
    </div>
  );
}

function TH({ children, sortable, onSort, sortDir }: {
  children: React.ReactNode;
  sortable?: boolean;
  onSort?: () => void;
  sortDir?: 'asc' | 'desc';
}) {
  const inner = sortable ? (
    <button onClick={onSort}
      className="flex items-center gap-1 hover:opacity-80 transition-opacity"
      style={{ color: MUTED, fontWeight: 600 }}>
      {children}
      <span style={{ color: GOLD, fontSize: 11 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>
    </button>
  ) : children;
  return (
    <th className="px-3 py-3 text-right text-xs font-semibold whitespace-nowrap"
      style={{ color: MUTED, fontWeight: 600 }}>
      {inner}
    </th>
  );
}

function TD({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 text-right whitespace-nowrap">{children}</td>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold" style={{ color: MUTED }}>{label}</label>
      {children}
    </div>
  );
}

function Chip({ children, bg, color }: { children: React.ReactNode; bg: string; color: string }) {
  return (
    <span className="text-xs px-2 py-0.5 rounded-md font-semibold"
      style={{ background: bg, color }}>
      {children}
    </span>
  );
}

function StatusBadge({ win }: { win: boolean | null }) {
  if (win === null) return <Chip bg={SURF2} color={MUTED}>סגור</Chip>;
  return <Chip bg={win ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)'} color={win ? GREEN : RED}>
    {win ? 'רווח' : 'הפסד'}
  </Chip>;
}

function AssetDot({ symbol }: { symbol: string | null }) {
  const s = (symbol ?? '?').slice(0, 2).toUpperCase();
  return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
      style={{ background: 'rgba(0,210,210,0.12)', color: GOLD }}>
      {s}
    </div>
  );
}

function PgBtn({ children, onClick, disabled, active }: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-7 h-7 rounded-lg text-xs font-semibold flex items-center justify-center transition-all disabled:opacity-30"
      style={{
        background: active ? GOLD : SURF2,
        color:      active ? '#0a0a0f' : TEXT2,
        border:     `1px solid ${active ? GOLD : BORDER}`,
      }}>
      {children}
    </button>
  );
}

// ── Modals ────────────────────────────────────────────────────────────────────

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl p-5 flex flex-col gap-3"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function TradeDetailModal({ trade, onClose, debriefResult, onDebrief }: {
  trade: any;
  onClose: () => void;
  debriefResult?: AIDebriefResult;
  onDebrief?: (result: AIDebriefResult) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [localResult, setLocalResult] = useState<AIDebriefResult | null>(null);

  const dir = trade.take_profit >= trade.entry_price ? 'long' : 'short';
  const pnlPoints = trade.status === 'closed' && trade.exit_price != null
    ? (dir === 'long' ? trade.exit_price - trade.entry_price : trade.entry_price - trade.exit_price)
    : null;
  const result = debriefResult ?? localResult;

  async function runAnalysis() {
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append('trade', JSON.stringify({
        id: trade.id, strategy: trade.strategy, entry_price: trade.entry_price,
        stop_loss: trade.stop_loss, take_profit: trade.take_profit,
        rr_ratio: trade.rr_ratio, emotional_state: trade.emotional_state,
        trade_reason: trade.trade_reason, status: trade.status,
        exit_price: trade.exit_price, exit_reason: trade.exit_reason,
        post_trade_notes: trade.post_trade_notes,
      }));
      if (trade.post_trade_notes) fd.append('description', trade.post_trade_notes);
      const res = await fetch('/api/ai-debrief', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        setLocalResult(data);
        onDebrief?.(data);
      }
    } catch {
      // analysis failed — button stays so the user can retry
    } finally {
      setAnalyzing(false);
    }
  }

  const rows: [string, string | number | null][] = [
    ['אסטרטגיה', trade.strategy],
    ['נכס', trade.symbol ?? '—'],
    ['כיוון', dir === 'long' ? 'לונג ↑' : 'שורט ↓'],
    ['מחיר כניסה', trade.entry_price.toFixed(2)],
    ['Stop Loss', trade.stop_loss.toFixed(2)],
    ['Take Profit', trade.take_profit.toFixed(2)],
    ['יחס R:R', trade.rr_ratio],
    ['מצב רגשי', `${trade.emotional_state}/5`],
    ['סיבת כניסה', trade.trade_reason],
    ['סטטוס', trade.status === 'open' ? 'פתוח' : 'סגור'],
    ['מחיר יציאה', trade.exit_price != null ? trade.exit_price.toFixed(2) : '—'],
    ['סיבת יציאה', trade.exit_reason ?? '—'],
    ['הערות', trade.post_trade_notes ?? '—'],
    ['תחקיר עצמי', trade.debrief_answer ?? '—'],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl p-5 flex flex-col gap-4"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)', boxShadow: '0 24px 64px rgba(0,0,0,0.8)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--color-tg-text)' }}>
            {trade.symbol ?? trade.strategy}
            {pnlPoints !== null && (
              trade.pnl_amount != null ? (
                <span className="text-sm font-bold" style={{ color: trade.pnl_amount >= 0 ? '#22c55e' : '#ef4444' }}>
                  {formatPnlIls(trade.pnl_amount, trade.pnl_currency ?? '₪')}
                  <span className="text-xs font-semibold" style={{ opacity: 0.6 }}> ({formatPnlPoints(pnlPoints)})</span>
                </span>
              ) : (
                <span className="text-sm font-bold" style={{ color: pnlPoints >= 0 ? '#22c55e' : '#ef4444' }}>
                  {pnlPoints >= 0 ? '+' : ''}{pnlPoints.toFixed(2)} נק׳
                </span>
              )
            )}
          </p>
          <button onClick={onClose} style={{ color: 'var(--color-tg-muted)', fontSize: 20, lineHeight: 1, fontWeight: 600 }}>×</button>
        </div>

        <div className="flex flex-col gap-0">
          {rows.map(([label, value], i) => (
            <div key={label}
              className="flex items-start justify-between gap-4 py-2.5"
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--color-tg-border)' : 'none' }}>
              <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--color-tg-muted)', minWidth: 90 }}>{label}</span>
              <span className="text-xs text-right" style={{ color: 'var(--color-tg-text)', wordBreak: 'break-word' }}>{String(value ?? '—')}</span>
            </div>
          ))}
        </div>

        {trade.status === 'closed' && (
          <div className="pt-1 border-t" style={{ borderColor: 'var(--color-tg-border)' }}>
            {result ? (
              <div className="pt-3"><AIDebriefView result={result} /></div>
            ) : analyzing ? (
              <div className="pt-4 flex flex-col items-center gap-3">
                <div className="w-7 h-7 rounded-full border-2 border-t-transparent animate-spin"
                  style={{ borderColor: 'var(--color-tg-primary)', borderTopColor: 'transparent' }} />
                <p className="text-xs text-tg-text-2">מנתח את העסקה עם AI...</p>
              </div>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); runAnalysis(); }}
                className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-1.5"
                style={{ background: 'var(--color-tg-primary-muted)', color: 'var(--color-tg-primary)', border: '1px solid rgba(0,210,210,0.3)' }}>
                <Bot size={14} /> נתח עסקה עם AI
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EditTradeModal({ trade, onClose, onSaved }: {
  trade: Trade;
  onClose: () => void;
  onSaved: (updated: Trade) => void;
}) {
  const supabase = createClient();
  const [symbol, setSymbol] = useState(trade.symbol ?? '');
  const [direction, setDirection] = useState<'long' | 'short'>(inferDirection(trade));
  const [strategy, setStrategy] = useState(trade.strategy);
  const [entryPrice, setEntryPrice] = useState(String(trade.entry_price));
  const [stopLoss, setStopLoss] = useState(String(trade.stop_loss));
  const [takeProfit, setTakeProfit] = useState(String(trade.take_profit));
  const [quantity, setQuantity] = useState(trade.quantity != null ? String(trade.quantity) : '');
  const [currency, setCurrency] = useState<PnlCurrency>((trade.pnl_currency as PnlCurrency) ?? '₪');
  const [tradeReason, setTradeReason] = useState(trade.trade_reason);
  const [notes, setNotes] = useState(trade.post_trade_notes ?? '');
  const [emotionalState, setEmotionalState] = useState(trade.emotional_state);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toggleDirection(next: 'long' | 'short') {
    if (next === direction) return;
    setDirection(next);
    setStopLoss(takeProfit);
    setTakeProfit(stopLoss);
  }

  async function handleSave() {
    const entry = parseFloat(entryPrice);
    const sl = parseFloat(stopLoss);
    const tp = parseFloat(takeProfit);
    if (!strategy.trim() || !tradeReason.trim() || isNaN(entry) || isNaN(sl) || isNaN(tp)) {
      setError('יש למלא אסטרטגיה, סיבת כניסה, מחיר כניסה, SL ו-TP');
      return;
    }
    const qty = quantity.trim() === '' ? null : parseFloat(quantity);
    if (qty !== null && isNaN(qty)) {
      setError('כמות חייבת להיות מספר');
      return;
    }

    setSaving(true);
    setError('');

    const updates = {
      symbol: symbol.trim() || null,
      strategy: strategy.trim(),
      entry_price: entry,
      stop_loss: sl,
      take_profit: tp,
      rr_ratio: calcRR(entry, sl, tp),
      quantity: qty,
      pnl_currency: currency,
      trade_reason: tradeReason.trim(),
      post_trade_notes: notes.trim() || null,
      emotional_state: emotionalState,
    };

    const { error: err } = await supabase.from('trade_plans').update(updates).eq('id', trade.id);

    if (err) {
      setError('שגיאה בשמירה — נסה שוב');
      setSaving(false);
      return;
    }

    onSaved({ ...trade, ...updates });
  }

  return (
    <Modal onClose={onClose}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-base font-bold" style={{ color: TEXT }}>עריכת עסקה</p>
        <button onClick={onClose} style={{ color: MUTED, fontSize: 18, lineHeight: 1, fontWeight: 600 }}>×</button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="נכס">
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            className={FIELD_CLASS} style={fieldStyle} />
        </Field>
        <Field label="כיוון">
          <div className="flex rounded-xl overflow-hidden h-[38px]" style={{ border: `1px solid ${BORDER}` }}>
            <button type="button" onClick={() => toggleDirection('long')}
              className="flex-1 text-sm font-semibold transition-all"
              style={{
                background: direction === 'long' ? 'rgba(74,222,128,0.12)' : 'transparent',
                color: direction === 'long' ? GREEN : TEXT2,
              }}>
              לונג
            </button>
            <button type="button" onClick={() => toggleDirection('short')}
              className="flex-1 text-sm font-semibold transition-all"
              style={{
                background: direction === 'short' ? 'rgba(248,113,113,0.12)' : 'transparent',
                color: direction === 'short' ? RED : TEXT2,
              }}>
              שורט
            </button>
          </div>
        </Field>
      </div>

      <Field label="אסטרטגיה">
        <input value={strategy} onChange={e => setStrategy(e.target.value)}
          className={FIELD_CLASS} style={fieldStyle} />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="מחיר כניסה">
          <input type="number" step="any" value={entryPrice} onChange={e => setEntryPrice(e.target.value)}
            className={`${FIELD_CLASS} text-center`} style={fieldStyle} />
        </Field>
        <Field label="Stop Loss">
          <input type="number" step="any" value={stopLoss} onChange={e => setStopLoss(e.target.value)}
            className={`${FIELD_CLASS} text-center`} style={{ ...fieldStyle, borderColor: 'var(--color-tg-danger)' }} />
        </Field>
        <Field label="Take Profit">
          <input type="number" step="any" value={takeProfit} onChange={e => setTakeProfit(e.target.value)}
            className={`${FIELD_CLASS} text-center`} style={{ ...fieldStyle, borderColor: 'var(--color-tg-success)' }} />
        </Field>
      </div>

      <Field label="כמות ומטבע">
        <div className="flex items-center gap-1.5">
          <input type="number" step="any" value={quantity} onChange={e => setQuantity(e.target.value)}
            className={`${FIELD_CLASS} text-center flex-1`} style={fieldStyle} />
          <div className="flex rounded-lg overflow-hidden shrink-0 h-[38px]" style={{ border: `1px solid ${BORDER}` }}>
            <button type="button" onClick={() => setCurrency('₪')}
              className="px-2.5 text-xs font-semibold transition-all"
              style={{ background: currency === '₪' ? 'rgba(0,210,210,0.12)' : 'transparent', color: currency === '₪' ? GOLD : MUTED }}>
              ₪
            </button>
            <button type="button" onClick={() => setCurrency('$')}
              className="px-2.5 text-xs font-semibold transition-all"
              style={{ background: currency === '$' ? 'rgba(0,210,210,0.12)' : 'transparent', color: currency === '$' ? GOLD : MUTED }}>
              $
            </button>
          </div>
        </div>
      </Field>

      <Field label="סיבת כניסה">
        <textarea rows={2} value={tradeReason} onChange={e => setTradeReason(e.target.value)}
          className={`${FIELD_CLASS} resize-none`} style={fieldStyle} />
      </Field>

      <Field label="הערות">
        <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)}
          className={`${FIELD_CLASS} resize-none`} style={fieldStyle} />
      </Field>

      <EmotionalStateSlider value={emotionalState} onChange={setEmotionalState} />

      {error && <p className="text-xs" style={{ color: RED }}>{error}</p>}

      <div className="flex gap-2 pt-1">
        <button onClick={onClose}
          className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
          style={{ background: SURF2, color: TEXT2 }}>
          ביטול
        </button>
        <button onClick={handleSave} disabled={saving}
          className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-80 disabled:opacity-50"
          style={{ background: GOLD, color: '#0a0a0f' }}>
          {saving ? 'שומר...' : 'שמור שינויים'}
        </button>
      </div>
    </Modal>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function BarChartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6"  y1="20" x2="6"  y2="14"/>
    </svg>
  );
}

function TrendUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="6"/>
      <circle cx="12" cy="12" r="2"/>
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}
