'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Bot } from 'lucide-react';
import CloseTrade, { AIDebriefView, type AIDebriefResult } from '@/components/journal/CloseTrade';
import { formatPnlIls } from '@/lib/utils';

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
  value_per_unit: number | null;
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

// ── Root ──────────────────────────────────────────────────────────────────────
export default function JournalClient({ trades }: { trades: Trade[] }) {
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
  const router = useRouter();

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
        <StatCard label="רווח / הפסד"   value={fmtPnl(totalPnl)}
          icon={<DollarIcon />}
          color={totalPnl >= 0 ? GREEN : RED} />
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
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2 }}>
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
              style={{ background: SURF, border: `1px solid ${BORDER}`, color: TEXT2 }}>
              פעולות
              <ChevronIcon />
            </button>
            {showActions && (
              <div className="absolute top-full mt-1 right-0 z-30 rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[160px]"
                style={{ background: SURF, border: `1px solid ${BORDER}`, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
                <button
                  onClick={() => { router.refresh(); setShowActions(false); }}
                  className="px-3 py-1.5 rounded-lg text-sm text-right transition-all hover:opacity-80"
                  style={{ color: TEXT2 }}>
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

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
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
                  <td colSpan={11} className="text-center py-14 text-sm" style={{ color: MUTED }}>
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
                      <span style={{ color: TEXT2 }}>
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
                      <span style={{ color: TEXT2 }}>{fmtDate(t.submitted_at)}</span>
                    </TD>

                    {/* Quantity — not in schema */}
                    <TD><span style={{ color: MUTED }}>—</span></TD>

                    {/* P&L */}
                    <TD>
                      {pnl !== null
                        ? <span className="font-semibold" style={{ color: pnl >= 0 ? GREEN : RED }}>
                            {fmtPnl(pnl)}
                          </span>
                        : <span style={{ color: MUTED }}>—</span>
                      }
                    </TD>

                    {/* Entry price */}
                    <TD>
                      <span className="font-mono text-xs" style={{ color: TEXT }}>
                        {t.entry_price.toFixed(2)}
                      </span>
                    </TD>

                    {/* Strategy */}
                    <TD>
                      <span className="text-xs truncate max-w-[120px] block" style={{ color: TEXT2 }}>
                        {t.strategy}
                      </span>
                    </TD>

                    {/* Actions */}
                    <TD>
                      <div className="flex items-center gap-1.5 justify-end">
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
                        {t.status !== 'open' && !debriefResults[t.id] && (
                          <span style={{ color: MUTED, fontSize: 11 }}>—</span>
                        )}
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination bar */}
        <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3"
          style={{ borderTop: `1px solid ${BORDER}`, background: SURF }}>

          {/* Rows per page */}
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: MUTED }}>שורות בעמוד:</span>
            <select value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}
              className="text-xs rounded-lg px-2 py-1 outline-none"
              style={{ background: SURF2, border: `1px solid ${BORDER}`, color: TEXT2 }}>
              {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          {/* Count */}
          <span className="text-xs" style={{ color: MUTED }}>
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
      </div>

      {closingTradeId && (() => {
        const t = trades.find(tr => tr.id === closingTradeId);
        if (!t) return null;
        return (
          <Modal onClose={() => setClosingTradeId(null)}>
            <div className="flex items-center justify-between mb-1">
              <p className="text-base font-bold" style={{ color: TEXT }}>סגירת עסקה — {t.strategy}</p>
              <button onClick={() => setClosingTradeId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1 }}>×</button>
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
              valuePerUnit={t.value_per_unit}
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
            <button onClick={() => setViewDebriefId(null)} style={{ color: MUTED, fontSize: 18, lineHeight: 1 }}>×</button>
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
    </div>
  );
}

// ── Atoms ─────────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon, color = TEXT }: {
  label: string; value: string; icon: React.ReactNode; color?: string;
}) {
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-2"
      style={{ background: SURF, border: `1px solid ${BORDER}` }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: MUTED }}>{label}</span>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: 'rgba(0,210,210,0.1)' }}>
          {icon}
        </div>
      </div>
      <span className="text-xl font-bold" style={{ color }}>{value}</span>
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
      style={{ color: MUTED }}>
      {children}
      <span style={{ color: GOLD, fontSize: 11 }}>{sortDir === 'desc' ? '↓' : '↑'}</span>
    </button>
  ) : children;
  return (
    <th className="px-3 py-3 text-right text-xs font-semibold whitespace-nowrap"
      style={{ color: MUTED }}>
      {inner}
    </th>
  );
}

function TD({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-3 text-right whitespace-nowrap">{children}</td>;
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
      className="w-7 h-7 rounded-lg text-xs font-medium flex items-center justify-center transition-all disabled:opacity-30"
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
  const [pnlMode, setPnlMode] = useState<'points' | 'percent'>('points');
  const [analyzing, setAnalyzing] = useState(false);
  const [localResult, setLocalResult] = useState<AIDebriefResult | null>(null);

  const dir = trade.take_profit >= trade.entry_price ? 'long' : 'short';
  const pnlPoints = trade.status === 'closed' && trade.exit_price != null
    ? (dir === 'long' ? trade.exit_price - trade.entry_price : trade.entry_price - trade.exit_price)
    : null;
  const pnlPercent = pnlPoints !== null ? (pnlPoints / trade.entry_price) * 100 : null;
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
    ['מחיר כניסה', trade.entry_price],
    ['Stop Loss', trade.stop_loss],
    ['Take Profit', trade.take_profit],
    ['יחס R:R', trade.rr_ratio],
    ['מצב רגשי', `${trade.emotional_state}/5`],
    ['סיבת כניסה', trade.trade_reason],
    ['סטטוס', trade.status === 'open' ? 'פתוח' : 'סגור'],
    ['מחיר יציאה', trade.exit_price ?? '—'],
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
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-bold" style={{ color: pnlPoints >= 0 ? '#22c55e' : '#ef4444' }}>
                  {pnlPoints >= 0 ? '+' : ''}{pnlMode === 'points' ? pnlPoints.toFixed(2) + ' נק׳' : pnlPercent!.toFixed(2) + '%'}
                </span>
                <span className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-tg-border)' }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setPnlMode('points'); }}
                    className="px-1.5 py-0.5 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'points' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'points' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    נק׳
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setPnlMode('percent'); }}
                    className="px-1.5 py-0.5 text-[10px] font-semibold transition-all"
                    style={{
                      background: pnlMode === 'percent' ? 'var(--color-tg-primary-muted)' : 'transparent',
                      color: pnlMode === 'percent' ? 'var(--color-tg-primary)' : 'var(--color-tg-muted)',
                    }}>
                    %
                  </button>
                </span>
              </span>
            )}
            {trade.pnl_amount != null && (
              <span className="text-sm font-bold" style={{ color: trade.pnl_amount >= 0 ? '#22c55e' : '#ef4444' }}>
                {formatPnlIls(trade.pnl_amount, trade.pnl_currency ?? '₪')}
              </span>
            )}
          </p>
          <button onClick={onClose} style={{ color: 'var(--color-tg-muted)', fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div className="flex flex-col gap-0">
          {rows.map(([label, value], i) => (
            <div key={label}
              className="flex items-start justify-between gap-4 py-2.5"
              style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--color-tg-border)' : 'none' }}>
              <span className="text-xs shrink-0" style={{ color: 'var(--color-tg-muted)', minWidth: 90 }}>{label}</span>
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

function DollarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={GOLD} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23"/>
      <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
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
