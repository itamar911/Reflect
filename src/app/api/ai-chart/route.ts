import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await request.formData();
  const imageFile = formData.get('image') as File | null;
  const context = formData.get('context') as string | null;

  if (!imageFile) return NextResponse.json({ error: 'No image provided' }, { status: 400 });

  const buffer = await imageFile.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mediaType = imageFile.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        {
          type: 'text',
          text: `You are a professional technical analyst. Analyze the chart in the image and respond entirely in Hebrew.
${context ? `Context: ${context}` : ''}

Return JSON exactly in this format (no additional text):
{
  "timeframe": "estimated timeframe",
  "trend": "current trend (uptrend/downtrend/sideways)",
  "pattern": "chart pattern identified if any",
  "support_levels": ["support level 1", "support level 2"],
  "resistance_levels": ["resistance level 1", "resistance level 2"],
  "key_observations": ["observation 1", "observation 2", "observation 3"],
  "bias": "Bullish / Bearish / Neutral",
  "recommendation": "brief recommendation - whether to trade and why",
  "risk_notes": "important risk notes"
}

Write all text values in Hebrew.`,
        },
      ],
    }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { recommendation: 'Unable to analyze' };

  return NextResponse.json(parsed);
}
