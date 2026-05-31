import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { setup, stats } = await request.json();

  const hasStats = stats.tradeCount > 0;

  const prompt = `אתה מנתח מסחר מקצועי המתמחה בבניית סטאפים. נתח את הסטאפ הבא ותן ביקורת מקצועית בעברית.

שם הסטאפ: ${setup.name}
${setup.symbol ? `סמל/מדד: ${setup.symbol}` : ''}

תיאור הסטאפ:
${setup.description || 'לא סופק תיאור'}

${hasStats ? `
סטטיסטיקות ביצועים (${stats.tradeCount} עסקאות):
• אחוז הצלחה: ${stats.winRate}%
• ממוצע R:R: 1:${stats.avgRR}
• רווח/הפסד כולל: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(1)}
• ממוצע לעסקה: ${stats.avgPnl >= 0 ? '+' : ''}$${stats.avgPnl.toFixed(1)}
` : 'אין עסקאות מקושרות לסטאפ זה עדיין.'}

ספק ביקורת מובנית הכוללת:

**חוזקות הסטאפ** — מה עובד טוב (אם יש עסקאות: מה מוכיח את עצמו)

**חולשות וסיכונים** — מה יכול לכשל, תנאים שעלולים לשבש

**תנאי הכניסה** — האם תנאי הכניסה המתוארים ברורים ומדויקים מספיק?

**ניהול הסיכון** — האם יש SL/TP ברורים? האם ה-R:R מוצדק?

**המלצות לשיפור** — 3-4 הצעות קונקרטיות

כתוב בעברית, ישיר ומעשי. אל תחזור על הנתונים — נתח אותם.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  const review = message.content[0].type === 'text' ? message.content[0].text : '';
  return NextResponse.json({ review });
}
