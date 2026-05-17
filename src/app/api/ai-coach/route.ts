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
      content: `You are an AI trading coach. Analyze the following trading data and provide 4-6 personal insights in Hebrew.

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

Insight types: time (trading hours), emotional (emotional state), performance (performance), pattern (patterns), revenge (revenge trading), discipline (discipline).
Each insight: one direct, specific, data-based sentence. For example: "You trade worse after 2 consecutive losses" or "Hours 9:30-11:00 are your most profitable".
Write all insight text in Hebrew.`,
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
  const wins = closed.filter((t) => Number(t.exit_price) > Number(t.entry_price));
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;

  const avgEmotional = total > 0
    ? (trades.reduce((s, t) => s + Number(t.emotional_state || 3), 0) / total).toFixed(1) : '3';
  const avgRR = total > 0
    ? (trades.reduce((s, t) => s + Number(t.rr_ratio || 0), 0) / total).toFixed(2) : '0';

  const byHour: Record<number, { count: number; wins: number }> = {};
  for (const t of trades) {
    const h = new Date(t.submitted_at as string).getHours();
    if (!byHour[h]) byHour[h] = { count: 0, wins: 0 };
    byHour[h].count++;
    if (t.status === 'closed' && Number(t.exit_price) > Number(t.entry_price)) byHour[h].wins++;
  }

  const lowEmotional = trades.filter((t) => Number(t.emotional_state) <= 2).length;
  const strategies = trades.reduce<Record<string, number>>((acc, t) => {
    const s = String(t.strategy || 'Unknown');
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  return `Total trades: ${total}
Closed trades: ${closed.length}
Win rate: ${winRate}%
Average R:R: ${avgRR}
Average emotional state: ${avgEmotional}/5
Trades with low emotional state (1-2): ${lowEmotional}
Strategies used: ${JSON.stringify(strategies)}
Hourly distribution: ${JSON.stringify(byHour)}`;
}
