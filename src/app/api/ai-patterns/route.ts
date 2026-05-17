import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { trades } = await request.json();
  if (!trades || trades.length < 3) return NextResponse.json({ patterns: [] });

  const summary = buildPatternSummary(trades);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a trading pattern detector. Identify recurring patterns in the following trading data. Respond entirely in Hebrew.

${summary}

Return JSON exactly in this format (no additional text):
{
  "patterns": [
    {
      "type": "revenge|loss_hours|weak_setup|emotional|discipline|positive",
      "severity": "high|medium|low",
      "title": "pattern name in Hebrew",
      "description": "brief accurate description of the pattern in Hebrew",
      "occurrences": 3,
      "recommendation": "brief treatment recommendation in Hebrew"
    }
  ]
}

Identify up to 5 patterns. Include positive patterns if present. Focus on the most prominent patterns. Write all text in Hebrew.`,
    }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { patterns: [] };

  return NextResponse.json(parsed);
}

function buildPatternSummary(trades: Record<string, unknown>[]): string {
  const closed = trades.filter((t) => t.status === 'closed');

  let revengeTrades = 0;
  for (let i = 1; i < trades.length; i++) {
    const prev = trades[i - 1];
    const curr = trades[i];
    const prevLoss = prev.status === 'closed' && Number(prev.exit_price) < Number(prev.entry_price);
    const timeDiff = (new Date(curr.submitted_at as string).getTime() - new Date(prev.submitted_at as string).getTime()) / 60000;
    if (prevLoss && timeDiff < 30 && Number(curr.emotional_state) <= 2) revengeTrades++;
  }

  const lossByHour: Record<number, number> = {};
  const winByHour: Record<number, number> = {};
  for (const t of closed) {
    const h = new Date(t.submitted_at as string).getHours();
    if (Number(t.exit_price) < Number(t.entry_price)) lossByHour[h] = (lossByHour[h] || 0) + 1;
    else winByHour[h] = (winByHour[h] || 0) + 1;
  }

  const lowEmotionalLosses = closed.filter(
    (t) => Number(t.emotional_state) <= 2 && Number(t.exit_price) < Number(t.entry_price)
  ).length;

  const strategyResults: Record<string, { wins: number; losses: number }> = {};
  for (const t of closed) {
    const s = String(t.strategy || 'Unknown');
    if (!strategyResults[s]) strategyResults[s] = { wins: 0, losses: 0 };
    if (Number(t.exit_price) > Number(t.entry_price)) strategyResults[s].wins++;
    else strategyResults[s].losses++;
  }

  return `Total trades: ${trades.length}
Closed trades: ${closed.length}
Suspected revenge trading: ${revengeTrades}
Losses with low emotional state: ${lowEmotionalLosses}
Losses by hour: ${JSON.stringify(lossByHour)}
Wins by hour: ${JSON.stringify(winByHour)}
Results by strategy: ${JSON.stringify(strategyResults)}
Emotional state distribution: ${trades.map((t) => t.emotional_state).join(',')}`;
}
