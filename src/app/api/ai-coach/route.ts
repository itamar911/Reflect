import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

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
Write all insight text in Hebrew. Be specific with numbers.`,
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
  const wins = closedWithExit.filter((t) => Number(t.exit_price) > Number(t.entry_price));
  const losses = closedWithExit.filter((t) => Number(t.exit_price) <= Number(t.entry_price));
  const winRate = closedWithExit.length > 0 ? Math.round((wins.length / closedWithExit.length) * 100) : 0;

  const totalPL = closedWithExit.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const winPL = wins.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const lossPL = losses.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);

  const avgEmotional = total > 0
    ? (trades.reduce((s, t) => s + Number(t.emotional_state || 3), 0) / total).toFixed(1) : '3';
  const avgRR = total > 0
    ? (trades.reduce((s, t) => s + Number(t.rr_ratio || 0), 0) / total).toFixed(2) : '0';

  // Revenge trades: low emotional state + closed loss
  const revengeTrades = closedWithExit.filter((t) =>
    Number(t.emotional_state) <= 2 && Number(t.exit_price) < Number(t.entry_price)
  );
  const revengeLoss = revengeTrades.reduce((s, t) => s + (Number(t.entry_price) - Number(t.exit_price)), 0);

  // Quality trades: emotional state >= 4
  const qualityTrades = closedWithExit.filter((t) => Number(t.emotional_state) >= 4);
  const qualityPL = qualityTrades.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const qualityWinRate = qualityTrades.length > 0
    ? Math.round(qualityTrades.filter((t) => Number(t.exit_price) > Number(t.entry_price)).length / qualityTrades.length * 100) : 0;

  // By hour with P&L
  const byHour: Record<number, { count: number; wins: number; pl: number }> = {};
  for (const t of closedWithExit) {
    const h = new Date(t.submitted_at as string).getHours();
    if (!byHour[h]) byHour[h] = { count: 0, wins: 0, pl: 0 };
    byHour[h].count++;
    const pl = Number(t.exit_price) - Number(t.entry_price);
    byHour[h].pl += pl;
    if (pl > 0) byHour[h].wins++;
  }

  // By strategy with P&L
  const strategyPL: Record<string, { count: number; pl: number; wins: number }> = {};
  for (const t of closedWithExit) {
    const s = String(t.strategy || 'Unknown');
    if (!strategyPL[s]) strategyPL[s] = { count: 0, pl: 0, wins: 0 };
    strategyPL[s].count++;
    const pl = Number(t.exit_price) - Number(t.entry_price);
    strategyPL[s].pl += pl;
    if (pl > 0) strategyPL[s].wins++;
  }

  const lowEmotional = trades.filter((t) => Number(t.emotional_state) <= 2).length;

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
