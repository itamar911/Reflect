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
  return `You are a professional trade analyst. Analyze the following trade and respond entirely in Hebrew.

Trade details:
- Strategy: ${trade.strategy}
- Entry: ${trade.entry_price}
- Stop Loss: ${trade.stop_loss}
- Take Profit: ${trade.take_profit}
- R:R: ${trade.rr_ratio}
- Emotional state: ${trade.emotional_state}/5
- Entry reason: ${trade.trade_reason}
- Status: ${trade.status}
${trade.exit_price ? `- Exit price: ${trade.exit_price}` : ''}
${description ? `- Trader notes: ${description}` : ''}
${trade.status === 'closed' && trade.exit_price ? `- Result: ${Number(trade.exit_price) > Number(trade.entry_price) ? 'Profit' : 'Loss'}` : ''}

Return JSON exactly in this format (no additional text):
{
  "overall": "Overall trade assessment in 2-3 sentences",
  "entry_quality": "Entry quality analysis",
  "risk_management": "Risk management - SL, TP, R:R",
  "execution": "Execution quality",
  "emotional": "Emotional state analysis and its impact",
  "lessons": "Key lessons from this trade",
  "score": 75
}

The score is a number 0-100 representing trade quality. Write all text in Hebrew.`;
}
