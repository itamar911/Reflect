import type { TraderIdentity } from '@/lib/types';

const IDENTITY_CONFIG: Record<TraderIdentity, { icon: string; color: string; desc: string }> = {
  'Disciplined Trader': { icon: '🎯', color: '#F5C518', desc: 'פועל לפי התוכנית' },
  'Emotional Trader':   { icon: '😤', color: '#FF3B30', desc: 'מושפע מרגשות' },
  'Sniper Trader':      { icon: '🎯', color: '#00C853', desc: 'מחכה לסטאפים מושלמים' },
  'Aggressive Trader':  { icon: '⚡', color: '#F59E0B', desc: 'כניסות מרובות ומהירות' },
  'Developing Trader':  { icon: '🌱', color: '#60A5FA', desc: 'בתהליך פיתוח' },
};

function computeIdentity(
  disciplineScore: number,
  avgEmotional: number,
  totalTrades: number,
  revengeTrades: number
): TraderIdentity {
  if (totalTrades < 5) return 'Developing Trader';
  const revengeRate = revengeTrades / totalTrades;
  if (avgEmotional <= 2.5 || revengeRate > 0.3) return 'Emotional Trader';
  if (disciplineScore >= 80 && revengeRate < 0.05) {
    return totalTrades < 20 ? 'Sniper Trader' : 'Disciplined Trader';
  }
  if (totalTrades > 30) return 'Aggressive Trader';
  return 'Developing Trader';
}

interface TraderIdentityProps {
  disciplineScore: number;
  avgEmotional: number;
  totalTrades: number;
  revengeTrades?: number;
}

export default function TraderIdentityCard({
  disciplineScore,
  avgEmotional,
  totalTrades,
  revengeTrades = 0,
}: TraderIdentityProps) {
  const identity = computeIdentity(disciplineScore, avgEmotional, totalTrades, revengeTrades);
  const cfg = IDENTITY_CONFIG[identity];

  return (
    <div className="flex items-center gap-3 p-3 rounded-2xl"
      style={{ background: `${cfg.color}12`, border: `1px solid ${cfg.color}30` }}>
      <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0"
        style={{ background: `${cfg.color}20` }}>
        {cfg.icon}
      </div>
      <div>
        <p className="text-xs text-tg-text-2">זהות מסחר</p>
        <p className="text-sm font-bold" style={{ color: cfg.color }}>{identity}</p>
        <p className="text-[11px] text-tg-muted">{cfg.desc}</p>
      </div>
    </div>
  );
}
