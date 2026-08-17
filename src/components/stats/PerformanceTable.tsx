import type { ReactNode } from 'react';
import { MUTED, TEXT, fmt, pnlColor, Section } from './shared';

export interface PerfRow {
  name: string;
  trades: number;
  winRate: number | null;
  avgRR?: number;
  pnl: number;
}

interface Props {
  title: string;
  icon: ReactNode;
  unitLabel: string;
  rows: PerfRow[];
  showRR?: boolean;
}

export default function PerformanceTable({ title, icon, unitLabel, rows, showRR }: Props) {
  const sorted = [...rows].sort((a, b) => b.pnl - a.pnl);
  const maxAbs = Math.max(...sorted.map(r => Math.abs(r.pnl)), 1);

  return (
    <Section title={title} icon={icon} count={`${rows.length} ${unitLabel}`}>
      <div className="stats-card overflow-x-auto">
        <table className="stats-table">
          {/* Visually hidden: <Section> already renders `title` as a visible
              heading directly above the table, so a visible caption would
              duplicate it and push the card's first row out of alignment. */}
          <caption className="sr-only">{`${title} — ${rows.length} ${unitLabel}`}</caption>
          <thead>
            <tr>
              {/* All five head cells label columns; this table has no row
                  headers — the name cell is a <td> carrying a micro-bar. */}
              <th scope="col">שם</th>
              <th scope="col">עסקאות</th>
              <th scope="col">הצלחה %</th>
              {showRR && <th scope="col">R:R</th>}
              <th scope="col">רווח/הפסד</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name}>
                <td className="stats-name-cell" style={{ width: '38%', whiteSpace: 'normal' }}>
                  <div className="flex flex-col gap-1.5">
                    <span className="truncate" style={{ fontSize: 13, fontWeight: 700, color: TEXT, maxWidth: 180 }}>
                      {r.name}
                    </span>
                    {/* Micro-bar: relative PnL magnitude */}
                    <div className="h-[3px] rounded-full w-full" style={{ background: 'rgba(128,128,128,0.15)', maxWidth: 150 }}>
                      <div className="h-full rounded-full" style={{
                        width: `${Math.max((Math.abs(r.pnl) / maxAbs) * 100, r.pnl === 0 ? 0 : 4)}%`,
                        background: pnlColor(r.pnl),
                        opacity: 0.9,
                      }} />
                    </div>
                  </div>
                </td>
                <td><span className="stats-num" style={{ fontSize: 12, color: MUTED }}>{r.trades}</span></td>
                <td><span className="stats-num" style={{ fontSize: 12, color: TEXT }}>
                  {r.winRate !== null ? `${r.winRate}%` : '—'}
                </span></td>
                {showRR && (
                  <td><span className="stats-num" style={{ fontSize: 12, color: MUTED }}>
                    {r.avgRR !== undefined ? r.avgRR.toFixed(1) : '—'}
                  </span></td>
                )}
                <td><span className="stats-num" style={{ fontSize: 13, fontWeight: 700, color: r.pnl === 0 ? MUTED : pnlColor(r.pnl) }}>
                  {fmt(r.pnl)}
                </span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
