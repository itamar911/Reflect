import type { TraderProfile } from '@/lib/identity';
import { AlertTriangle, Dumbbell, RefreshCw } from 'lucide-react';

export default function TraderIdentityCard({ profile }: { profile: TraderProfile }) {
  const { identity, icon, color, tagline, strengths, weaknesses, totalTrades } = profile;

  const updatedLabel = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });

  return (
    <div
      className="rounded-2xl p-4 border relative overflow-hidden"
      style={{
        background: `linear-gradient(135deg, ${color}0d 0%, var(--color-tg-surface-2) 100%)`,
        borderColor: `${color}30`,
        boxShadow: `0 0 32px ${color}10, 0 4px 24px rgba(0,0,0,0.3)`,
      }}
    >
      {/* Subtle glow behind icon */}
      <div
        className="absolute top-0 right-0 w-32 h-32 rounded-full pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${color}12 0%, transparent 70%)`,
          transform: 'translate(30%, -30%)',
        }}
      />

      {/* Header */}
      <div className="flex items-center gap-3 mb-4 relative">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shrink-0"
          style={{
            background: `${color}18`,
            border: `1.5px solid ${color}40`,
            boxShadow: `0 0 18px ${color}25`,
          }}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="text-[10px] font-bold uppercase tracking-widest mb-0.5"
            style={{ color }}
          >
            זהות מסחר
          </p>
          <h3 className="text-base font-bold text-tg-text leading-tight">{identity}</h3>
          <p className="text-[11px] text-tg-text-2 mt-0.5 leading-snug">{tagline}</p>
        </div>
      </div>

      {/* Divider */}
      <div className="h-px mb-3" style={{ background: `${color}18` }} />

      {/* Strengths + Weaknesses grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Strengths */}
        <div>
          <p className="text-[10px] font-semibold text-tg-text-2 mb-2 flex items-center gap-1" style={{ color: '#00C853' }}>
            <Dumbbell size={10} />
            חוזקות
          </p>
          <div className="flex flex-col gap-2">
            {strengths.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-[9px] font-bold mt-0.5 shrink-0" style={{ color: '#00C853' }}>✓</span>
                <p className="text-[11px] text-tg-text-2 leading-tight">{s}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Weaknesses */}
        <div>
          <p className="text-[10px] font-semibold text-tg-text-2 mb-2 flex items-center gap-1" style={{ color: '#FF3B30' }}>
            <AlertTriangle size={10} />
            לשיפור
          </p>
          <div className="flex flex-col gap-2">
            {weaknesses.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5">
                <span className="text-[9px] font-bold mt-0.5 shrink-0" style={{ color: '#FF3B30' }}>✗</span>
                <p className="text-[11px] text-tg-text-2 leading-tight">{w}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        className="mt-3 pt-2.5 border-t flex items-center justify-between"
        style={{ borderColor: `${color}15` }}
      >
        <p className="text-[10px] text-tg-muted">מבוסס על {totalTrades} עסקאות</p>
        <p className="text-[10px] text-tg-muted flex items-center gap-1"><RefreshCw size={9} /> עודכן {updatedLabel}</p>
      </div>
    </div>
  );
}
