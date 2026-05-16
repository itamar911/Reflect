'use client';

interface ExportTrade {
  submitted_at: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  debrief_answer?: string | null;
}

export default function JournalExport({ trades }: { trades: ExportTrade[] }) {
  function handleExport() {
    const headers = ['תאריך', 'שעה', 'אסטרטגיה', 'כניסה', 'Stop Loss', 'Take Profit', 'R:R', 'מצב רגשי', 'סיבת כניסה', 'תחקיר', 'סטטוס'];

    const rows = trades.map((t) => {
      const d = new Date(t.submitted_at);
      return [
        d.toLocaleDateString('he-IL'),
        d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
        t.strategy ?? '',
        t.entry_price ?? '',
        t.stop_loss ?? '',
        t.take_profit ?? '',
        typeof t.rr_ratio === 'number' ? t.rr_ratio.toFixed(2) : '',
        t.emotional_state ?? '',
        `"${(t.trade_reason ?? '').replace(/"/g, '""')}"`,
        `"${(t.debrief_answer ?? '').replace(/"/g, '""')}"`,
        t.status === 'open' ? 'פתוח' : 'סגור',
      ];
    });

    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
    // BOM for Hebrew support in Excel
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reflekt-trades-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button
      onClick={handleExport}
      disabled={trades.length === 0}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all duration-150 disabled:opacity-40"
      style={{
        background: 'var(--color-tg-surface)',
        borderColor: 'var(--color-tg-border)',
        color: 'var(--color-tg-text-2)',
      }}
      title="ייצוא לקובץ CSV"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      CSV
    </button>
  );
}
