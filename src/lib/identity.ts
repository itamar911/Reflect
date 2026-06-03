import type { TraderIdentity } from './types';

export type { TraderIdentity };

export interface TraderProfile {
  identity: TraderIdentity;
  icon: string;
  color: string;
  tagline: string;
  strengths: string[];
  weaknesses: string[];
  totalTrades: number;
}

interface TradeStat {
  emotional_state: number;
  rr_ratio: number;
  status: string;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number;
  submitted_at: string;
  strategy: string;
}

const IDENTITY_CONFIG: Record<TraderIdentity, { icon: string; color: string; tagline: string }> = {
  'Disciplined Sniper': {
    icon: '🎯',
    color: '#00d2d2',
    tagline: 'מחכה לסטאפ המושלם — מכה ברגע הנכון',
  },
  'Emotional Trader': {
    icon: '😤',
    color: '#FF3B30',
    tagline: 'רגשות קובעים את הכניסות — הגיע הזמן לשנות',
  },
  'Risk Taker': {
    icon: '🚀',
    color: '#A78BFA',
    tagline: 'שואף לרווחים גדולים — סיכון גבוה, תגמול גבוה',
  },
  'Aggressive Scalper': {
    icon: '⚡',
    color: '#F59E0B',
    tagline: 'הרבה עסקאות, מהיר — קונסיסטנטיות היא האתגר',
  },
  'Developing Trader': {
    icon: '🌱',
    color: '#60A5FA',
    tagline: 'בונה בסיס ומפתח גישה — ממשיך קדימה',
  },
};

export function computeTraderProfile(trades: TradeStat[]): TraderProfile {
  const total = trades.length;

  if (total < 5) {
    return {
      identity: 'Developing Trader',
      ...IDENTITY_CONFIG['Developing Trader'],
      strengths: [`${total} עסקאות מתועדות — בדרך הנכונה`, 'לומד מכל עסקה'],
      weaknesses: ['נדרשות לפחות 5 עסקאות לניתוח מלא'],
      totalTrades: total,
    };
  }

  // ── Core metrics ───────────────────────────────────────────────
  const avgEmotional = trades.reduce((s, t) => s + t.emotional_state, 0) / total;
  const avgRR = trades.reduce((s, t) => s + t.rr_ratio, 0) / total;

  const closed = trades.filter((t) => t.status === 'closed' && t.exit_price !== null);
  const wins = closed.filter((t) => Number(t.exit_price) > t.entry_price);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;

  const revengeClosed = closed.filter(
    (t) => t.emotional_state <= 2 && Number(t.exit_price) < t.entry_price
  );
  const revengePct = total > 0 ? revengeClosed.length / total : 0;

  const highRRCount = trades.filter((t) => t.rr_ratio >= 2.5).length;
  const highRRPct = highRRCount / total;

  const sortedByDate = [...trades].sort(
    (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
  );
  const weeksActive = Math.max(
    1,
    (new Date(sortedByDate[sortedByDate.length - 1].submitted_at).getTime() -
      new Date(sortedByDate[0].submitted_at).getTime()) /
      (7 * 24 * 60 * 60 * 1000)
  );
  const tradesPerWeek = total / weeksActive;

  const highEmotionalCount = trades.filter((t) => t.emotional_state >= 4).length;
  const emotionalConsistency = highEmotionalCount / total;

  // Strategy stats
  const stratStats: Record<string, { w: number; n: number }> = {};
  for (const t of closed) {
    const s = t.strategy || 'אחר';
    if (!stratStats[s]) stratStats[s] = { w: 0, n: 0 };
    stratStats[s].n++;
    if (Number(t.exit_price) > t.entry_price) stratStats[s].w++;
  }
  const bestStrat = Object.entries(stratStats)
    .filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)[0];

  // Hour stats
  const hourStats: Record<number, { w: number; n: number }> = {};
  for (const t of closed) {
    const h = new Date(t.submitted_at).getHours();
    if (!hourStats[h]) hourStats[h] = { w: 0, n: 0 };
    hourStats[h].n++;
    if (Number(t.exit_price) > t.entry_price) hourStats[h].w++;
  }
  const hourEntries = Object.entries(hourStats).filter(([, v]) => v.n >= 2);
  const bestHour = [...hourEntries].sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)[0];
  const worstHour = [...hourEntries].sort((a, b) => a[1].w / a[1].n - b[1].w / b[1].n)[0];

  // ── Identity determination ─────────────────────────────────────
  let identity: TraderIdentity;
  if (avgEmotional <= 2.5 || revengePct > 0.25) {
    identity = 'Emotional Trader';
  } else if (avgEmotional >= 3.8 && winRate >= 0.52 && avgRR >= 1.8 && tradesPerWeek <= 5) {
    identity = 'Disciplined Sniper';
  } else if (highRRPct >= 0.35 && avgRR >= 2.2) {
    identity = 'Risk Taker';
  } else if (tradesPerWeek >= 4 && avgRR < 1.8) {
    identity = 'Aggressive Scalper';
  } else {
    identity = 'Developing Trader';
  }

  // ── Strengths ──────────────────────────────────────────────────
  const strengths: string[] = [];
  const wr = Math.round(winRate * 100);
  const rr = avgRR.toFixed(1);
  const em = avgEmotional.toFixed(1);

  if (winRate >= 0.55) strengths.push(`אחוז הצלחה ${wr}% — מעל הממוצע`);
  if (avgRR >= 2.0) strengths.push(`R:R ממוצע 1:${rr} — יחס סיכוי/סיכון מצוין`);
  if (avgEmotional >= 4.0) strengths.push(`מצב רגשי ${em}/5 — מסחר קר ומחושב`);
  if (revengePct === 0 && closed.length >= 5) strengths.push('0% עסקאות Revenge — שליטה עצמית מלאה');
  else if (revengePct < 0.05 && closed.length >= 5) strengths.push('פחות מ-5% Revenge — שליטה עצמית גבוהה');
  if (bestStrat && bestStrat[1].w / bestStrat[1].n >= 0.6)
    strengths.push(`${bestStrat[0]}: ${Math.round((bestStrat[1].w / bestStrat[1].n) * 100)}% הצלחה`);
  if (bestHour && bestHour[1].w / bestHour[1].n >= 0.65)
    strengths.push(`שעה ${bestHour[0]}:00 — ${Math.round((bestHour[1].w / bestHour[1].n) * 100)}% הצלחה`);
  if (highRRPct >= 0.4) strengths.push(`${Math.round(highRRPct * 100)}% עסקאות עם R:R מעל 1:2.5`);
  if (emotionalConsistency >= 0.7)
    strengths.push(`${Math.round(emotionalConsistency * 100)}% עסקאות עם מצב רגשי גבוה`);

  // ── Weaknesses ─────────────────────────────────────────────────
  const weaknesses: string[] = [];

  if (winRate < 0.45) weaknesses.push(`אחוז הצלחה ${wr}% — בדוק תנאי כניסה`);
  if (avgRR < 1.5) weaknesses.push(`R:R ממוצע 1:${rr} — מוותר מהר מדי על רווחים`);
  if (avgEmotional < 3.0) weaknesses.push(`מצב רגשי ${em}/5 — רגשות משפיעים על ההחלטות`);
  if (revengePct > 0.1) weaknesses.push(`${Math.round(revengePct * 100)}% עסקאות Revenge — עלות גבוהה`);
  if (revengeClosed.length >= 2) {
    const loss = revengeClosed.reduce((s, t) => s + (t.entry_price - Number(t.exit_price)), 0);
    weaknesses.push(`${revengeClosed.length} עסקאות Revenge הפסידו $${loss.toFixed(1)}`);
  }
  if (worstHour && worstHour[1].w / worstHour[1].n < 0.35 && worstHour[1].n >= 2)
    weaknesses.push(`שעה ${worstHour[0]}:00 — ${Math.round((worstHour[1].w / worstHour[1].n) * 100)}% הצלחה בלבד`);
  if (tradesPerWeek > 6) weaknesses.push(`${tradesPerWeek.toFixed(1)} עסקאות/שבוע — Over-trading`);
  if (emotionalConsistency < 0.4)
    weaknesses.push(`רק ${Math.round(emotionalConsistency * 100)}% עסקאות עם מצב רגשי גבוה`);
  if (highRRPct < 0.2 && closed.length >= 10)
    weaknesses.push(`רק ${Math.round(highRRPct * 100)}% עסקאות מעל R:R 1:2.5`);

  if (strengths.length === 0) strengths.push(`${total} עסקאות מתועדות — בדרך הנכונה`);
  if (weaknesses.length === 0) weaknesses.push('ביצועים טובים — נסה לזהות אזורי שיפור');

  return {
    identity,
    ...IDENTITY_CONFIG[identity],
    strengths: strengths.slice(0, 3),
    weaknesses: weaknesses.slice(0, 3),
    totalTrades: total,
  };
}
