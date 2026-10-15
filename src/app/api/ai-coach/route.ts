import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PLAIN_HEBREW_PROSE_CLAUSE } from '@/lib/ai/prompts';
import { isWinningTrade, tradePointsPnl, pnlRow } from '@/lib/pnl';
import { averageOf, scaleValue, rrValue, intentText, type RawValue } from '@/lib/intent';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { trades } = await request.json();
  if (!trades || trades.length === 0) return NextResponse.json({ insights: [] });

  const summary = buildTradeSummary(trades);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a financial performance analyst for a trading journal app. Analyze the following trading data and provide 4-6 concrete, dollar-impact insights in Hebrew.

${summary}

Return JSON exactly in this format (no additional text):
{
  "insights": [
    { "type": "time", "text": "short insight in Hebrew" },
    { "type": "emotional", "text": "short insight in Hebrew" },
    { "type": "performance", "text": "short insight in Hebrew" },
    { "type": "pattern", "text": "short insight in Hebrew" }
  ]
}

CRITICAL: Every insight must quantify financial impact using the actual numbers from the data. Use the P&L values, counts, and percentages provided. Examples of the style required:
- "עצרנו אותך מ-3 עסקאות Revenge החודש — חסכת $X לפי הממוצע של עסקאות דומות"
- "ה-אחוז ההצלחה שלך עם מצב רגשי גבוה (4-5) הוא X% לעומת X% כשאתה במצב נמוך — הפרש של $X בממוצע לעסקה"
- "שעות X-Y הכניסו לך X% מסך ה-P&L עם X% הצלחה"
- "האסטרטגיה הטובה ביותר שלך הרוויחה $X, הגרועה ביותר הפסידה $X"

Insight types: time (best/worst hours by P&L), emotional (emotional state vs P&L), performance (overall numbers), pattern (patterns), revenge (revenge trading cost in $), discipline (rules impact in $).
Write all insight text in Hebrew. Be specific with numbers.

${PLAIN_HEBREW_PROSE_CLAUSE}`,
    }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { insights: [] };

  return NextResponse.json(parsed);
}

function buildTradeSummary(trades: Record<string, unknown>[]): string {
  const total = trades.length;
  const closed = trades.filter((t) => t.status === 'closed');
  const closedWithExit = closed.filter((t) => t.exit_price !== null);

  // Every figure below used to come from `exit_price > entry_price`, which is
  // the REF-107 §0ד bug: a profitable short reached the coach as a loss, and
  // the coach then advised the trader on it. `pl` is direction-aware price
  // points and `isWinningTrade` is the canonical win test, so what the coach
  // is told now matches what the trader sees on every page.
  const pl = (t: Record<string, unknown>) => tradePointsPnl(pnlRow(t)) ?? 0;
  const isWin = (t: Record<string, unknown>) => isWinningTrade(pnlRow(t)) === true;

  const wins = closedWithExit.filter(isWin);
  const losses = closedWithExit.filter((t) => !isWin(t));
  const winRate = closedWithExit.length > 0 ? Math.round((wins.length / closedWithExit.length) * 100) : 0;

  const totalPL = closedWithExit.reduce((s, t) => s + pl(t), 0);
  const winPL = wins.reduce((s, t) => s + pl(t), 0);
  const lossPL = losses.reduce((s, t) => s + pl(t), 0);

  // Averaged over the rows that carry a value. `|| 3` and `|| 0` were defaults
  // dressed as data — they told the coach a trader with no self-reports felt
  // exactly neutral and planned exactly 1:0 on every trade (REF-107 §0ג).
  const avgEmotionalNum = averageOf(trades, (t) => scaleValue(t.emotional_state as RawValue));
  const avgRRNum = averageOf(trades, (t) => rrValue(t.rr_ratio as RawValue));
  const avgEmotional = avgEmotionalNum !== null ? avgEmotionalNum.toFixed(1) : 'not recorded';
  const avgRR = avgRRNum !== null ? avgRRNum.toFixed(2) : 'not recorded';

  // Revenge trades: low emotional state + closed loss. A row without a
  // self-report is unknown, not calm and not panicked, so it qualifies as
  // neither.
  const emoOf = (t: Record<string, unknown>) => scaleValue(t.emotional_state as RawValue);
  const revengeTrades = closedWithExit.filter((t) => {
    const emo = emoOf(t);
    return emo !== null && emo <= 2 && !isWin(t);
  });
  const revengeLoss = revengeTrades.reduce((s, t) => s - pl(t), 0);

  // Quality trades: emotional state >= 4
  const qualityTrades = closedWithExit.filter((t) => (emoOf(t) ?? 0) >= 4);
  const qualityPL = qualityTrades.reduce((s, t) => s + pl(t), 0);
  const qualityWinRate = qualityTrades.length > 0
    ? Math.round(qualityTrades.filter(isWin).length / qualityTrades.length * 100) : 0;

  // By hour with P&L
  const byHour: Record<number, { count: number; wins: number; pl: number }> = {};
  for (const t of closedWithExit) {
    const h = new Date(t.submitted_at as string).getHours();
    if (!byHour[h]) byHour[h] = { count: 0, wins: 0, pl: 0 };
    byHour[h].count++;
    byHour[h].pl += pl(t);
    if (isWin(t)) byHour[h].wins++;
  }

  // By strategy with P&L. A row with no strategy gets no bucket — it used to
  // land in one called 'Unknown' that the coach then discussed as a strategy.
  const strategyPL: Record<string, { count: number; pl: number; wins: number }> = {};
  for (const t of closedWithExit) {
    const s = intentText(t.strategy as string | null);
    if (s === null) continue;
    if (!strategyPL[s]) strategyPL[s] = { count: 0, pl: 0, wins: 0 };
    strategyPL[s].count++;
    strategyPL[s].pl += pl(t);
    if (isWin(t)) strategyPL[s].wins++;
  }

  const lowEmotional = trades.filter((t) => { const e = emoOf(t); return e !== null && e <= 2; }).length;

  return `Total trades: ${total}
Closed trades with exit: ${closedWithExit.length}
Win rate: ${winRate}%
Average R:R: ${avgRR}
Average emotional state: ${avgEmotional}/5
Total P&L ($): ${totalPL.toFixed(2)}
P&L from winning trades ($): +${winPL.toFixed(2)}
P&L from losing trades ($): ${lossPL.toFixed(2)}
Revenge trades (emotional state 1-2 + loss): ${revengeTrades.length} trades, total cost: $${revengeLoss.toFixed(2)}
Trades with any low emotional state (1-2): ${lowEmotional}
High-quality trades (emotional state 4-5): ${qualityTrades.length} trades, P&L: $${qualityPL.toFixed(2)}, win rate: ${qualityWinRate}%
Strategy P&L breakdown: ${JSON.stringify(strategyPL)}
Hourly P&L breakdown: ${JSON.stringify(byHour)}`;
}
