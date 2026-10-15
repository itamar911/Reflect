import type { TraderIdentity } from './types';
import { formatMoney } from '@/lib/money';
import { isWinningTrade, tradeMoneyPnl, hasMoneyPnl } from '@/lib/pnl';
import { averageOf, rrValue, scaleValue, intentText, type RawValue } from '@/lib/intent';

export type { TraderIdentity };

/**
 * Which Lucide glyph represents each identity.
 *
 * A key, not a component reference: TraderProfile crosses a server/client
 * boundary as props, and a component is not serialisable. The card maps this
 * to the icon (see TraderIdentityCard).
 *
 * These were emoji until the no-emoji rule in CLAUDE.md was applied across the
 * app — icons are Lucide only, including here.
 */
export type IdentityIcon = 'target' | 'flame' | 'rocket' | 'zap' | 'sprout';

export interface TraderProfile {
  identity: TraderIdentity;
  icon: IdentityIcon;
  color: string;
  tagline: string;
  strengths: string[];
  weaknesses: string[];
  totalTrades: number;
}

/**
 * A row as this module reads it.
 *
 * Every intent column is nullable here, and that is the ticket (REF-107 §0ג):
 * `emotional_state` and `rr_ratio` were typed `number`, averaged over
 * `trades.length`, and fed straight into the identity verdict — so a row
 * without them did not merely fail to contribute, it voted zero. `direction`
 * and the money columns are present so win/loss is read rather than guessed
 * from `exit_price > entry_price`, which calls every profitable short a loss
 * (§0ד). `take_profit` is here only as `tradeDirection`'s legacy fallback for
 * rows written before `direction` existed; a row with neither is left to the
 * shared helper to resolve.
 */
interface TradeStat {
  emotional_state: RawValue;
  rr_ratio: RawValue;
  status: string;
  entry_price: number | string;
  exit_price: number | string | null;
  stop_loss?: RawValue;
  submitted_at: string;
  strategy: string | null;
  take_profit?: number | string | null;
  direction?: 'long' | 'short' | null;
  pnl_amount?: number | string | null;
  actual_pnl?: number | string | null;
}

function pnlShape(t: TradeStat) {
  return {
    status: t.status,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    take_profit: t.take_profit ?? null,
    direction: t.direction ?? null,
    pnl_amount: t.pnl_amount ?? null,
    actual_pnl: t.actual_pnl ?? null,
  };
}

/** Canonical win test — money first, points second. A profitable short wins. */
function isWin(t: TradeStat): boolean {
  return isWinningTrade(pnlShape(t)) === true;
}

/**
 * What a trade lost in money, as a positive number — or null when the row
 * carries no money figure at all.
 *
 * Null rather than a points value on purpose: the sentence this feeds renders
 * through `formatMoney`, and the code it replaces summed *price points* into
 * that dollar label while also reading a profitable short as a loss. A sum
 * that mixes points and dollars is wrong in a way no reader can see, so a row
 * with no money P&L is left out and the sentence is dropped when none remain.
 */
function moneyLoss(t: TradeStat): number | null {
  const shape = pnlShape(t);
  if (!hasMoneyPnl(shape)) return null;
  const v = tradeMoneyPnl(shape);
  return v < 0 ? -v : 0;
}

const IDENTITY_CONFIG: Record<TraderIdentity, { icon: IdentityIcon; color: string; tagline: string }> = {
  'Disciplined Sniper': {
    icon: 'target',
    color: '#00d2d2',
    tagline: 'מחכה לסטאפ המושלם — מכה ברגע הנכון',
  },
  'Emotional Trader': {
    icon: 'flame',
    color: '#FF3B30',
    tagline: 'רגשות קובעים את הכניסות — הגיע הזמן לשנות',
  },
  'Risk Taker': {
    icon: 'rocket',
    color: '#A78BFA',
    tagline: 'שואף לרווחים גדולים — סיכון גבוה, תגמול גבוה',
  },
  'Aggressive Scalper': {
    icon: 'zap',
    color: '#F59E0B',
    tagline: 'הרבה עסקאות, מהיר — קונסיסטנטיות היא האתגר',
  },
  'Developing Trader': {
    icon: 'sprout',
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
  // Averaged over the rows that carry a value, never over `total`. Null means
  // "no row recorded one", which is a different statement from "the average is
  // zero" and has to stay distinguishable all the way to the verdict below.
  const avgEmotional = averageOf(trades, (t) => scaleValue(t.emotional_state));
  const avgRR = averageOf(trades, (t) => rrValue(t.rr_ratio));

  const closed = trades.filter((t) => t.status === 'closed' && t.exit_price !== null);
  const wins = closed.filter(isWin);
  const winRate = closed.length > 0 ? wins.length / closed.length : 0;

  // Revenge needs both halves: a low self-reported state AND a losing result.
  // A row with no emotional_state cannot be a revenge trade — it can only be
  // an unknown one — so it is excluded rather than read as state 0.
  const revengeClosed = closed.filter((t) => {
    const emo = scaleValue(t.emotional_state);
    return emo !== null && emo <= 2 && !isWin(t);
  });
  // Denominator is the rows that could have qualified, not every row: with
  // broker rows in the journal, dividing by `total` would shrink the rate
  // purely because trades without a self-report exist.
  const revengeEligible = closed.filter((t) => scaleValue(t.emotional_state) !== null);
  const revengePct = revengeEligible.length > 0 ? revengeClosed.length / revengeEligible.length : 0;

  const rrRows = trades.map((t) => rrValue(t.rr_ratio)).filter((v): v is number => v !== null);
  const highRRPct = rrRows.length > 0 ? rrRows.filter((v) => v >= 2.5).length / rrRows.length : 0;

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

  const emoRows = trades.map((t) => scaleValue(t.emotional_state)).filter((v): v is number => v !== null);
  const emotionalConsistency = emoRows.length > 0
    ? emoRows.filter((v) => v >= 4).length / emoRows.length : null;

  // Strategy stats. A row with no strategy gets no bucket — it used to be
  // filed under 'אחר', which reads as a strategy the trader chose.
  const stratStats: Record<string, { w: number; n: number }> = {};
  for (const t of closed) {
    const s = intentText(t.strategy);
    if (s === null) continue;
    if (!stratStats[s]) stratStats[s] = { w: 0, n: 0 };
    stratStats[s].n++;
    if (isWin(t)) stratStats[s].w++;
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
    if (isWin(t)) hourStats[h].w++;
  }
  const hourEntries = Object.entries(hourStats).filter(([, v]) => v.n >= 2);
  const bestHour = [...hourEntries].sort((a, b) => b[1].w / b[1].n - a[1].w / a[1].n)[0];
  const worstHour = [...hourEntries].sort((a, b) => a[1].w / a[1].n - b[1].w / b[1].n)[0];

  // ── Identity determination ─────────────────────────────────────
  //
  // Each branch may only fire when the numbers it reads actually exist. The
  // two that mattered were the first and the last: `avgEmotional <= 2.5` and
  // `avgRR < 1.8` both held trivially when the average was a null coerced to
  // 0, so a trader whose rows carried no self-report was labelled 'Emotional
  // Trader' — or, failing that, 'Aggressive Scalper' — by arithmetic rather
  // than by behaviour. Unknown inputs now fall through to the neutral
  // 'Developing Trader', which is the honest verdict on a trader we have not
  // measured.
  let identity: TraderIdentity;
  if ((avgEmotional !== null && avgEmotional <= 2.5) || revengePct > 0.25) {
    identity = 'Emotional Trader';
  } else if (
    avgEmotional !== null && avgEmotional >= 3.8 &&
    avgRR !== null && avgRR >= 1.8 &&
    winRate >= 0.52 && tradesPerWeek <= 5
  ) {
    identity = 'Disciplined Sniper';
  } else if (avgRR !== null && avgRR >= 2.2 && highRRPct >= 0.35) {
    identity = 'Risk Taker';
  } else if (avgRR !== null && avgRR < 1.8 && tradesPerWeek >= 4) {
    identity = 'Aggressive Scalper';
  } else {
    identity = 'Developing Trader';
  }

  // ── Strengths ──────────────────────────────────────────────────
  // Every line that names a number is gated on that number existing: a
  // sentence reading "R:R ממוצע 1:0.0" is not a weakness the trader has, it is
  // a column they never filled.
  const strengths: string[] = [];
  const wr = Math.round(winRate * 100);
  const rr = avgRR?.toFixed(1);
  const em = avgEmotional?.toFixed(1);
  const hasRevengeData = revengeEligible.length >= 5;

  if (winRate >= 0.55) strengths.push(`אחוז הצלחה ${wr}% — מעל הממוצע`);
  if (avgRR !== null && avgRR >= 2.0) strengths.push(`R:R ממוצע 1:${rr} — יחס סיכוי/סיכון מצוין`);
  if (avgEmotional !== null && avgEmotional >= 4.0) strengths.push(`מצב רגשי ${em}/5 — מסחר קר ומחושב`);
  if (hasRevengeData && revengePct === 0) strengths.push('0% עסקאות Revenge — שליטה עצמית מלאה');
  else if (hasRevengeData && revengePct < 0.05) strengths.push('פחות מ-5% Revenge — שליטה עצמית גבוהה');
  if (bestStrat && bestStrat[1].w / bestStrat[1].n >= 0.6)
    strengths.push(`${bestStrat[0]}: ${Math.round((bestStrat[1].w / bestStrat[1].n) * 100)}% הצלחה`);
  if (bestHour && bestHour[1].w / bestHour[1].n >= 0.65)
    strengths.push(`שעה ${bestHour[0]}:00 — ${Math.round((bestHour[1].w / bestHour[1].n) * 100)}% הצלחה`);
  if (rrRows.length > 0 && highRRPct >= 0.4) strengths.push(`${Math.round(highRRPct * 100)}% עסקאות עם R:R מעל 1:2.5`);
  if (emotionalConsistency !== null && emotionalConsistency >= 0.7)
    strengths.push(`${Math.round(emotionalConsistency * 100)}% עסקאות עם מצב רגשי גבוה`);

  // ── Weaknesses ─────────────────────────────────────────────────
  const weaknesses: string[] = [];

  if (closed.length > 0 && winRate < 0.45) weaknesses.push(`אחוז הצלחה ${wr}% — בדוק תנאי כניסה`);
  if (avgRR !== null && avgRR < 1.5) weaknesses.push(`R:R ממוצע 1:${rr} — מוותר מהר מדי על רווחים`);
  if (avgEmotional !== null && avgEmotional < 3.0) weaknesses.push(`מצב רגשי ${em}/5 — רגשות משפיעים על ההחלטות`);
  if (revengeEligible.length > 0 && revengePct > 0.1) weaknesses.push(`${Math.round(revengePct * 100)}% עסקאות Revenge — עלות גבוהה`);
  if (revengeClosed.length >= 2) {
    const losses = revengeClosed.map(moneyLoss).filter((v): v is number => v !== null);
    if (losses.length > 0) {
      const loss = losses.reduce((s, v) => s + v, 0);
      weaknesses.push(`${losses.length} עסקאות Revenge הפסידו ${formatMoney(loss, { decimals: 1, sign: 'none' })}`);
    }
  }
  if (worstHour && worstHour[1].w / worstHour[1].n < 0.35 && worstHour[1].n >= 2)
    weaknesses.push(`שעה ${worstHour[0]}:00 — ${Math.round((worstHour[1].w / worstHour[1].n) * 100)}% הצלחה בלבד`);
  if (tradesPerWeek > 6) weaknesses.push(`${tradesPerWeek.toFixed(1)} עסקאות/שבוע — Over-trading`);
  if (emotionalConsistency !== null && emoRows.length >= 5 && emotionalConsistency < 0.4)
    weaknesses.push(`רק ${Math.round(emotionalConsistency * 100)}% עסקאות עם מצב רגשי גבוה`);
  if (rrRows.length >= 10 && highRRPct < 0.2)
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
