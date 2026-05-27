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
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `אתה מנתח גרפים מקצועי. החזר בדיוק 4 סקשנים בלבד בפורמט הזה — ללא שינויים בכותרות, ללא טקסט נוסף:${context ? `\nהקשר: ${context}` : ''}

**מגמה כללית**
[2-3 משפטים: כיוון המגמה (עולה/יורדת/צדדית), עוצמת המומנטום, וקונטקסט שוק רלוונטי]

**רמות מפתח**
• תמיכה: [מחיר] — [הסבר קצר מדוע רמה זו חשובה]
• תמיכה: [מחיר] — [הסבר קצר]
• התנגדות: [מחיר] — [הסבר קצר]
• התנגדות: [מחיר] — [הסבר קצר]

**המלצה**
Buy / Sell / Wait
כניסה: [מחיר]
Stop Loss: [מחיר]
Take Profit: [מחיר]
[2-3 משפטים: נימוק הכניסה — מה מצדיק את המהלך ומה צריך לקרות]

**רמת סיכון**
Low / Medium / High
[2-3 משפטים: מה עלול להשתבש ואילו תנאים מאשרים שהעסקה בכיוון הנכון]

כללים: עברית בלבד, ללא מונחים טכניים מורכבים, מחירים מדויקים בלבד.`,
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
