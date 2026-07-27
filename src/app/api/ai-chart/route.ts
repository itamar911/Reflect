import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VALID_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Vercel Hobby plan allows a max configurable duration of 60s per function
// (Pro/Enterprise allow more) — 60 is the ceiling here, not an arbitrary choice.
export const maxDuration = 60;

// Keep the vision call's own timeout comfortably under maxDuration so we can
// return a clean, typed error instead of Vercel silently killing the function.
const REQUEST_TIMEOUT_MS = 55_000;

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
  if (!user) return NextResponse.json({ error: 'generic', message: 'Unauthorized' }, { status: 401 });

  const formData = await request.formData();
  const imageFile = formData.get('image') as File | null;
  const context = formData.get('context') as string | null;

  if (!imageFile) return NextResponse.json({ error: 'generic', message: 'No image provided' }, { status: 400 });

  const buffer = await imageFile.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const mediaType = resolveMediaType(imageFile.type);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    }, { signal: controller.signal });

    const analysis = message.content[0].type === 'text' ? message.content[0].text : 'לא ניתן לנתח';
    return NextResponse.json({ analysis });
  } catch (err: unknown) {
    if (controller.signal.aborted || err instanceof APIUserAbortError) {
      console.error(`ai-chart timeout: request exceeded ${REQUEST_TIMEOUT_MS}ms`);
      return NextResponse.json({ error: 'timeout', message: 'Chart analysis timed out' }, { status: 504 });
    }
    if (err instanceof APIError) {
      console.error('ai-chart Anthropic API error:', err.status, err.name, err.message, err);
      return NextResponse.json({ error: 'api_error', message: err.message }, { status: 502 });
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('ai-chart error:', err);
    return NextResponse.json({ error: 'generic', message: msg }, { status: 500 });
  } finally {
    clearTimeout(timeoutId);
  }
}
