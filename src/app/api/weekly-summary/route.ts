import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface DailyPnl {
  date: string;
  pnl: number;
}

export interface BestWorstTrade {
  strategy: string;
  pnl: number;
  date: string;
}

export interface WeeklyStats {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_pnl: number;
  pnl_currency: string;
  avg_process_score: number | null;
  daily_pnl: DailyPnl[];
  avg_emotional_state: number | null;
  best_trade: BestWorstTrade | null;
  worst_trade: BestWorstTrade | null;
  most_used_strategy: string | null;
}

interface TradeRow {
  strategy: string;
  entry_price: number | string;
  exit_price: number | string | null;
  take_profit: number | string;
  stop_loss: number | string;
  emotional_state: number | string | null;
  plan_score: number | null;
  pnl_amount: number | string | null;
  pnl_currency: string | null;
  closed_at: string | null;
  submitted_at: string;
}

function tradePoints(t: TradeRow): number {
  const entry = Number(t.entry_price);
  const exit = Number(t.exit_price);
  const tp = Number(t.take_profit);
  const direction: 'long' | 'short' = tp >= entry ? 'long' : 'short';
  return direction === 'long' ? exit - entry : entry - exit;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The most recently completed Sunday→Saturday week.
function getLastCompletedWeek(now: Date = new Date()): { weekStart: Date; weekEnd: Date } {
  const weekEnd = new Date(now);
  weekEnd.setHours(0, 0, 0, 0);
  weekEnd.setDate(weekEnd.getDate() - weekEnd.getDay() - 1);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);
  return { weekStart, weekEnd };
}

function computeWeeklyStats(trades: TradeRow[], weekStart: Date): WeeklyStats {
  const rows = trades.map(t => ({ trade: t, pnl: t.pnl_amount != null ? Number(t.pnl_amount) : 0, points: tradePoints(t) }));

  const winning = rows.filter(r => r.points > 0);
  const losing = rows.filter(r => r.points < 0);
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);

  const scored = trades.filter(t => t.plan_score != null);
  const avgProcessScore = scored.length > 0
    ? Math.round(scored.reduce((s, t) => s + Number(t.plan_score), 0) / scored.length)
    : null;

  const dayMap: Record<string, number> = {};
  for (const r of rows) {
    const day = (r.trade.closed_at ?? r.trade.submitted_at).slice(0, 10);
    dayMap[day] = (dayMap[day] ?? 0) + r.pnl;
  }
  const dailyPnl: DailyPnl[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const key = dateStr(d);
    return { date: key, pnl: Math.round((dayMap[key] ?? 0) * 100) / 100 };
  });

  const emoVals = trades.map(t => Number(t.emotional_state)).filter(Number.isFinite);
  const avgEmotionalState = emoVals.length > 0
    ? Math.round((emoVals.reduce((s, v) => s + v, 0) / emoVals.length) * 10) / 10
    : null;

  let best: typeof rows[number] | null = null;
  let worst: typeof rows[number] | null = null;
  for (const r of rows) {
    if (!best || r.pnl > best.pnl) best = r;
    if (!worst || r.pnl < worst.pnl) worst = r;
  }
  const toBestWorst = (r: typeof rows[number]): BestWorstTrade => ({
    strategy: r.trade.strategy,
    pnl: Math.round(r.pnl * 100) / 100,
    date: (r.trade.closed_at ?? r.trade.submitted_at).slice(0, 10),
  });

  const strategyCounts: Record<string, number> = {};
  for (const t of trades) strategyCounts[t.strategy] = (strategyCounts[t.strategy] ?? 0) + 1;
  const mostUsedStrategy = Object.entries(strategyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const withCurrency = trades.find(t => t.pnl_amount != null && t.pnl_currency);

  return {
    total_trades: trades.length,
    winning_trades: winning.length,
    losing_trades: losing.length,
    total_pnl: Math.round(totalPnl * 100) / 100,
    pnl_currency: withCurrency?.pnl_currency ?? '₪',
    avg_process_score: avgProcessScore,
    daily_pnl: dailyPnl,
    avg_emotional_state: avgEmotionalState,
    best_trade: best ? toBestWorst(best) : null,
    worst_trade: worst ? toBestWorst(worst) : null,
    most_used_strategy: mostUsedStrategy,
  };
}

function buildPrompt(stats: WeeklyStats): string {
  return `אתה מאמן מסחר מקצועי. להלן נתוני המסחר של המשתמש לשבוע שעבר: ${JSON.stringify(stats)}. כתוב סיכום שבועי מקצועי הכולל: 1) מה עבד טוב השבוע, 2) דפוסים שחוזרים לרעה, 3) ניתוח מצב רגשי, 4) המלצה אחת קונקרטית לשבוע הבא. היה ישיר, תמציתי ומעשי.`;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { weekStart, weekEnd } = getLastCompletedWeek();
  const weekStartStr = dateStr(weekStart);
  const weekEndStr = dateStr(weekEnd);

  const { data } = await supabase
    .from('weekly_summaries')
    .select('week_start,week_end,summary_text,stats,created_at')
    .eq('user_id', user.id)
    .eq('week_start', weekStartStr)
    .maybeSingle();

  return NextResponse.json({ summary: data ?? null, week_start: weekStartStr, week_end: weekEndStr });
}

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { weekStart, weekEnd } = getLastCompletedWeek();
  const weekStartStr = dateStr(weekStart);
  const weekEndStr = dateStr(weekEnd);

  const { data: trades } = await supabase
    .from('trade_plans')
    .select('strategy,entry_price,exit_price,take_profit,stop_loss,emotional_state,plan_score,pnl_amount,pnl_currency,closed_at,submitted_at')
    .eq('user_id', user.id)
    .eq('status', 'closed')
    .gte('closed_at', `${weekStartStr}T00:00:00.000Z`)
    .lte('closed_at', `${weekEndStr}T23:59:59.999Z`);

  const stats = computeWeeklyStats(trades ?? [], weekStart);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: buildPrompt(stats) }],
  });
  const summaryText = message.content[0].type === 'text' ? message.content[0].text : '';

  const { data: existing } = await supabase
    .from('weekly_summaries')
    .select('id')
    .eq('user_id', user.id)
    .eq('week_start', weekStartStr)
    .maybeSingle();

  const createdAt = new Date().toISOString();

  if (existing) {
    await supabase.from('weekly_summaries')
      .update({ week_end: weekEndStr, summary_text: summaryText, stats, created_at: createdAt })
      .eq('id', existing.id);
  } else {
    await supabase.from('weekly_summaries')
      .insert({ user_id: user.id, week_start: weekStartStr, week_end: weekEndStr, summary_text: summaryText, stats });
  }

  return NextResponse.json({
    summary: { week_start: weekStartStr, week_end: weekEndStr, summary_text: summaryText, stats, created_at: createdAt },
  });
}
