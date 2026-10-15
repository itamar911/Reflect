'use client';

import { buildCsv, type ExportTrade } from '@/lib/journal/csv';

export default function JournalExport({ trades }: { trades: ExportTrade[] }) {
  function handleExport() {
    // Row shape lives in lib/journal/csv.ts so it can be asserted without a
    // browser; this function keeps only what needs one.
    const csv = buildCsv(trades);
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
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      CSV
    </button>
  );
}
