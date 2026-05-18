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
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `אתה מנתח טכני מקצועי. נתח את הגרף הזה בפירוט מלא בעברית.
${context ? `הקשר: ${context}` : ''}

ספק ניתוח מסודר עם הסקשנים הבאים (השתמש בפורמט המדויק הזה):

**מגמה כללית**
[תאר עולה/יורדת/צדדית + חוזק המגמה]

**רמות תמיכה והתנגדות**
תמיכות: [רשום רמות]
התנגדויות: [רשום רמות]

**תבניות גרפיות**
[זהה תבניות: ראש וכתפיים, דגל, משולש, ערוץ, וכו' — אם אין, ציין "לא זוהתה תבנית ברורה"]

**אינדיקטורים**
[RSI, MACD, MA, Volume — תאר מה נראה בגרף]

**נקודות כניסה מומלצות**
[מחיר ותנאים לכניסה]

**Stop Loss ו-Take Profit**
Stop Loss: [מחיר + נימוק]
Take Profit: [מחיר + נימוק]

**סיכום והמלצה**
[המלצה מפורטת — האם לסחור, מה לחכות, מה להימנע ממנו]`,
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
