'use client';

import { Download } from 'lucide-react';

import { buildCsv, type ExportTrade } from '@/lib/journal/csv';

export default function JournalExport({ trades, accountLabel = null }: {
  trades: ExportTrade[];
  /**
   * The portfolio the page is filtered to, when it is (REF-110 Stage 5).
   *
   * THE EXPORT INHERITS THE FILTER, because it is built from the rows the
   * page is already showing — a trader who filtered to one portfolio and
   * pressed export means that portfolio. That is almost certainly right, and
   * the other reading ("export is always everything") is defensible enough
   * that picking one silently is how a support ticket starts. So the button
   * says which one it is, in its own tooltip, on the control that does it.
   */
  accountLabel?: string | null;
}) {
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
      title={accountLabel === null ? 'ייצוא לקובץ CSV' : `ייצוא לקובץ CSV — ${accountLabel} בלבד`}
    >
      <Download aria-hidden="true" size={13} />
      CSV
    </button>
  );
}
