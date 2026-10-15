/**
 * The journal's CSV export, as data rather than as a click handler.
 *
 * Extracted from JournalExport so the shape of an exported row can be asserted
 * without a browser (scripts/features-null-safety-check.ts). The component
 * keeps the parts that need one: the Blob, the BOM and the anchor click.
 *
 * The rule this file exists to hold: a trade that reaches the journal with no
 * plan behind it carries no `strategy`, `stop_loss`, `take_profit`, `rr_ratio`,
 * `trade_reason` or `emotional_state` (REF-107 §B6), and each of those must
 * leave as an *empty cell*. "null" is a leaked implementation detail; "0" is
 * worse, because it is a number the trader never planned and a spreadsheet
 * will average it.
 */
import { tradeStatusLabel } from '@/lib/trades/status';

export interface ExportTrade {
  submitted_at: string;
  strategy: string | null;
  entry_price: number;
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number | null;
  emotional_state: number | null;
  trade_reason: string | null;
  status: string;
  debrief_answer?: string | null;
}

export const CSV_HEADERS = [
  'תאריך', 'שעה', 'אסטרטגיה', 'כניסה', 'Stop Loss', 'Take Profit',
  'R:R', 'מצב רגשי', 'סיבת כניסה', 'תחקיר', 'סטטוס',
];

/**
 * A numeric cell. Empty when the row carries no value.
 *
 * Numbers arrive as strings over PostgREST (Postgres NUMERIC), which the
 * `typeof v === 'number'` test this replaces silently dropped — blanking the
 * R:R of rows that had one.
 */
function cell(v: number | string | null | undefined, decimals?: number): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return decimals !== undefined ? n.toFixed(decimals) : String(n);
}

/** A free-text cell, CSV-quoted. Null exports as an empty quoted field. */
function textCell(v: string | null | undefined): string {
  return `"${(v ?? '').replace(/"/g, '""')}"`;
}

export function exportRow(t: ExportTrade): string[] {
  const d = new Date(t.submitted_at);
  return [
    d.toLocaleDateString('he-IL'),
    d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }),
    // Quoted: a strategy name is free text and may hold a comma, which would
    // otherwise shift every column after it by one.
    textCell(t.strategy),
    cell(t.entry_price),
    cell(t.stop_loss),
    cell(t.take_profit),
    cell(t.rr_ratio, 2),
    cell(t.emotional_state),
    textCell(t.trade_reason),
    textCell(t.debrief_answer),
    // Via the shared label — the ternary this replaced exported a
    // 'not_entered' plan as "סגור", which is the one thing it is not
    // (REF-82 §5.2).
    tradeStatusLabel(t.status),
  ];
}

export function buildCsv(trades: ExportTrade[]): string {
  return [CSV_HEADERS, ...trades.map(exportRow)].map((r) => r.join(',')).join('\n');
}
