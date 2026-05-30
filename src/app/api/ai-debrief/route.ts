import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await request.formData();
  const tradeData = formData.get('trade') as string;
  const description = formData.get('description') as string | null;
  const imageFile = formData.get('image') as File | null;

  const trade = JSON.parse(tradeData);
  const content: Anthropic.MessageParam['content'] = [];

  if (imageFile) {
    const buffer = await imageFile.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mediaType = imageFile.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
  }

  content.push({ type: 'text', text: buildDebriefPrompt(trade, description) });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { analysis: 'Unable to analyze' };

  return NextResponse.json(parsed);
}

function buildDebriefPrompt(trade: Record<string, unknown>, description: string | null): string {
  const entry = Number(trade.entry_price);
  const sl = Number(trade.stop_loss);
  const tp = Number(trade.take_profit);
  const exit = trade.exit_price != null ? Number(trade.exit_price) : null;

  const exitContext = (() => {
    if (exit == null) return null;
    const potentialRisk = Math.abs(entry - sl);
    const potentialReward = Math.abs(tp - entry);
    const actualMove = Math.abs(exit - entry);
    const capturedPct = potentialReward > 0 ? Math.round((actualMove / potentialReward) * 100) : 0;
    const hitSL = Math.abs(exit - sl) < Math.abs(entry - sl) * 0.05;
    const hitTP = Math.abs(exit - tp) < Math.abs(tp - entry) * 0.05;
    const exitedEarly = !hitTP && !hitSL && exit > entry;
    return { capturedPct, hitSL, hitTP, exitedEarly, potentialRisk, potentialReward };
  })();

  return `You are a professional trade analyst. Analyze the following completed trade and respond entirely in Hebrew.

Trade data:
- Strategy: ${trade.strategy}
- Entry: ${entry}
- Stop Loss: ${sl}
- Take Profit: ${tp}
- R:R ratio: ${trade.rr_ratio}
- Entry reason: ${trade.trade_reason}
- Status: ${trade.status}
${exit != null ? `- Exit price: ${exit}` : ''}
${exitContext ? `- Hit stop loss: ${exitContext.hitSL}` : ''}
${exitContext ? `- Hit take profit: ${exitContext.hitTP}` : ''}
${exitContext ? `- Exited early (before TP, in profit): ${exitContext.exitedEarly}` : ''}
${exitContext ? `- Captured ~${exitContext.capturedPct}% of potential reward` : ''}
${description ? `- Trader notes: ${description}` : ''}

Instructions:
1. Analyze each field honestly based on the actual trade data above.
2. For the "emotional" field — evaluate behavioral/emotional quality from the trade execution itself, NOT from any self-reported score. Ask: Did they exit early and leave gains on the table? Did they override their stop loss? Was the entry reason clear and structured or impulsive? Did they manage the trade rationally?
3. For "score" — derive it ONLY after completing all analysis fields. The score MUST match your verbal assessment:
   - Multiple serious problems identified → 0–45
   - Mediocre trade with notable issues → 45–65
   - Decent trade with minor issues → 65–80
   - Good to excellent trade → 80–100
   A high score with a critical verbal assessment, or a low score with a positive assessment, is a contradiction and not acceptable.

Return JSON exactly in this format (no additional text):
{
  "overall": "2-3 sentence overall assessment",
  "entry_quality": "Entry quality and timing analysis",
  "risk_management": "SL, TP, and R:R evaluation",
  "execution": "Execution and trade management quality",
  "emotional": "Behavioral/emotional quality inferred from trade execution",
  "lessons": "Key takeaways from this trade",
  "score": <integer 0-100 consistent with the analysis above>
}

Write all text values in Hebrew.`;
}
