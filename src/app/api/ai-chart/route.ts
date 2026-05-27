import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function resolveMediaType(type: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  if (VALID_TYPES.includes(type)) return type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  if (type.includes('jpg') || type.includes('jpeg')) return 'image/jpeg';
  if (type.includes('png')) return 'image/png';
  if (type.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

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
  const mediaType = resolveMediaType(imageFile.type);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `אתה מנתח גרפים. החזר בדיוק 4 סקשנים בלבד בפורמט הזה — ללא שינויים בכותרות, ללא טקסט נוסף:${context ? `\nהקשר: ${context}` : ''}

**מגמה כללית**
[משפט אחד: עולה/יורדת/צדדית וחוזק המגמה]

**רמות מפתח**
• תמיכה: [מחיר]
• תמיכה: [מחיר אם יש עוד]
• התנגדות: [מחיר]
• התנגדות: [מחיר אם יש עוד]

**המלצה**
Buy / Sell / Wait
כניסה: [מחיר]
Stop Loss: [מחיר]
Take Profit: [מחיר]

**רמת סיכון**
Low / Medium / High — [משפט אחד עם הסבר]

כללים: עברית בלבד, ללא פסקאות, ללא מונחים טכניים מורכבים.`,
          },
        ],
      }],
    });

    const analysis = message.content[0].type === 'text' ? message.content[0].text : 'לא ניתן לנתח';
    return NextResponse.json({ analysis });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'שגיאה לא ידועה';
    console.error('ai-chart error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
