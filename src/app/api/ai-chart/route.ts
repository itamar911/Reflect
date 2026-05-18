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

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `You are a senior technical analyst. Analyze this trading chart thoroughly and respond entirely in Hebrew.
${context ? `הקשר: ${context}` : ''}

Return ONLY a JSON object with no extra text:
{
  "timeframe": "טווח זמן משוער (לדוגמה: 1H, 4H, Daily)",
  "trend": "מגמה נוכחית (עלייה / ירידה / צד)",
  "pattern": "דפוס גרפי שזוהה אם קיים (או null)",
  "support_levels": ["רמת תמיכה 1", "רמת תמיכה 2"],
  "resistance_levels": ["רמת התנגדות 1", "רמת התנגדות 2"],
  "key_observations": [
    "תצפית טכנית 1",
    "תצפית טכנית 2",
    "תצפית טכנית 3",
    "תצפית טכנית 4"
  ],
  "entry_suggestion": "הצעת כניסה — מחיר ותנאים",
  "stop_loss_suggestion": "הצעת Stop Loss — מחיר ונימוק",
  "take_profit_suggestion": "הצעת Take Profit — מחיר ונימוק",
  "bias": "Bullish / Bearish / Neutral",
  "recommendation": "המלצה מפורטת — האם לסחור, מה לחפש, מה להימנע ממנו",
  "risk_notes": "הערות סיכון חשובות"
}`,
          },
        ],
      }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return NextResponse.json({ error: 'parse_error', recommendation: 'לא ניתן לנתח את הגרף' }, { status: 500 });
    const parsed = JSON.parse(jsonMatch[0]);
    return NextResponse.json(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
    return NextResponse.json({ error: msg, recommendation: 'שגיאה בניתוח הגרף — נסה שוב' }, { status: 500 });
  }
}
