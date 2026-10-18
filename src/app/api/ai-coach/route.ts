import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PLAIN_HEBREW_PROSE_CLAUSE } from '@/lib/ai/prompts';
import { hasMoneyPnl, isWinningTrade, tradeMoneyPnl, pnlRow } from '@/lib/pnl';
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

Every P&L figure above is REAL MONEY in US dollars. Where a figure reads "ללא סכום" the trades behind it carry no recorded amount — say so, or leave that angle out, and never substitute a number for it.

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

/**
 * What the coach is told, as a string (REF-115 site 2).
 *
 * Exported so `scripts/money-format-check.ts` can drive the real function:
 * six of the figures below are labelled `($)` and the system prompt above
 * instructs Claude to quote them back to the trader as dollars, so "is this
 * actually money" is the one property worth asserting rather than reading.
 */
export function buildTradeSummary(trades: Record<string, unknown>[]): string {
  const total = trades.length;
  const closed = trades.filter((t) => t.status === 'closed');
  const closedWithExit = closed.filter((t) => t.exit_price !== null);

  // ── MONEY, UNDER A `$` LABEL THAT IS NOW TRUE (REF-115 site 2) ──────────
  //
  // `pl` was `tradePointsPnl`, so every figure below was a sum of PRICE
  // POINTS — and six of them are labelled `($)` while the system prompt
  // instructs Claude to quote them back as "חסכת $X". A 5-point winner on a
  // $50 contract reached the coach as 5, and the coach told the trader they
  // had made five dollars.
  //
  // Direction-awareness was already fixed here (REF-107 §0ד); the unit was
  // not. `tradeMoneyPnl` is the figure the journal, the stats page, the
  // dashboard and the daily mail all use, so the coach now reasons about the
  // same numbers the trader can see.
  const pl = (t: Record<string, unknown>) => tradeMoneyPnl(pnlRow(t));
  const isWin = (t: Record<string, unknown>) => isWinningTrade(pnlRow(t)) === true;

  // WHETHER A FIGURE IS MONEY AT ALL, which is a different question from
  // whether it is zero. `tradeMoneyPnl` answers 0 for a row that carries
  // neither money column — correctly, since there is nothing to add — but a
  // bucket where NO row carried one is not a bucket that made nothing. It is
  // a bucket we cannot price, and "$0.00" is a measurement where "ללא סכום"
  // is the truth.
  //
  // The distinction matters most on exactly the rows this product is
  // acquiring: a trade closed by hand with an exit price and no money columns
  // is a win by `isWinningTrade` (it falls back to points) that contributes
  // $0.00 — so without this, a day of them reports 100% success and $0.00 and
  // the coach is asked to explain it.
  const hasMoney = (t: Record<string, unknown>) => hasMoneyPnl(pnlRow(t));
  const money = (rows: Record<string, unknown>[], sum: number, decimals = 2): string =>
    rows.some(hasMoney) ? `$${sum.toFixed(decimals)}` : 'ללא סכום';

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

  // By hour. `pl` is a dollar string or 'ללא סכום' — the breakdowns are
  // JSON-stringified straight into the prompt, so a bare 0 in one of them
  // would be read as a measured zero exactly as `$0.00` would.
  const hourBuckets: Record<number, { count: number; wins: number; pl: number; priced: boolean }> = {};
  for (const t of closedWithExit) {
    const h = new Date(t.submitted_at as string).getHours();
    if (!hourBuckets[h]) hourBuckets[h] = { count: 0, wins: 0, pl: 0, priced: false };
    hourBuckets[h].count++;
    hourBuckets[h].pl += pl(t);
    if (hasMoney(t)) hourBuckets[h].priced = true;
    if (isWin(t)) hourBuckets[h].wins++;
  }
  const byHour = Object.fromEntries(
    Object.entries(hourBuckets).map(([h, v]) => [
      h,
      { count: v.count, wins: v.wins, pl: v.priced ? Number(v.pl.toFixed(2)) : 'ללא סכום' },
    ])
  );

  // By strategy with P&L. A row with no strategy gets no bucket — it used to
  // land in one called 'Unknown' that the coach then discussed as a strategy.
  const strategyBuckets: Record<string, { count: number; pl: number; wins: number; priced: boolean }> = {};
  for (const t of closedWithExit) {
    const s = intentText(t.strategy as string | null);
    if (s === null) continue;
    if (!strategyBuckets[s]) strategyBuckets[s] = { count: 0, pl: 0, wins: 0, priced: false };
    strategyBuckets[s].count++;
    strategyBuckets[s].pl += pl(t);
    if (hasMoney(t)) strategyBuckets[s].priced = true;
    if (isWin(t)) strategyBuckets[s].wins++;
  }
  const strategyPL = Object.fromEntries(
    Object.entries(strategyBuckets).map(([name, v]) => [
      name,
      { count: v.count, wins: v.wins, pl: v.priced ? Number(v.pl.toFixed(2)) : 'ללא סכום' },
    ])
  );

  const lowEmotional = trades.filter((t) => { const e = emoOf(t); return e !== null && e <= 2; }).length;

  return `Total trades: ${total}
Closed trades with exit: ${closedWithExit.length}
Win rate: ${winRate}%
Average R:R: ${avgRR}
Average emotional state: ${avgEmotional}/5
Total P&L: ${money(closedWithExit, totalPL)}
P&L from winning trades: ${wins.some(hasMoney) ? `+$${winPL.toFixed(2)}` : 'ללא סכום'}
P&L from losing trades: ${money(losses, lossPL)}
Revenge trades (emotional state 1-2 + loss): ${revengeTrades.length} trades, total cost: ${money(revengeTrades, revengeLoss)}
Trades with any low emotional state (1-2): ${lowEmotional}
High-quality trades (emotional state 4-5): ${qualityTrades.length} trades, P&L: ${money(qualityTrades, qualityPL)}, win rate: ${qualityWinRate}%
Strategy P&L breakdown: ${JSON.stringify(strategyPL)}
Hourly P&L breakdown: ${JSON.stringify(byHour)}`;
}
