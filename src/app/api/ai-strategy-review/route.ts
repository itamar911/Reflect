import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { strategy, stats } = await request.json();
  const hasStats = stats.tradeCount > 0;

  const prompt = `אתה מנתח מסחר מקצועי. נתח את האסטרטגיה הבאה ותן ביקורת מפורטת בעברית.

שם האסטרטגיה: ${strategy.name}
כיוון: ${strategy.direction === 'long' ? 'Long בלבד' : strategy.direction === 'short' ? 'Short בלבד' : 'Long ו-Short'}
תיאור: ${strategy.description || 'לא סופק'}
${strategy.risk_rules ? `חוקי סיכון: ${strategy.risk_rules}` : ''}
${strategy.stop_loss_points ? `SL קבוע: ${strategy.stop_loss_points} נקודות` : ''}
${strategy.take_profit_points ? `TP קבוע: ${strategy.take_profit_points} נקודות` : ''}

${hasStats ? `
סטטיסטיקות מ-${stats.tradeCount} עסקאות (${stats.closedCount} סגורות):
• אחוז הצלחה: ${stats.winRate}%
• רווח/הפסד כולל: ${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
• ממוצע לעסקה: ${stats.avgPnl >= 0 ? '+' : ''}${stats.avgPnl.toFixed(2)}
• R:R ממוצע: 1:${stats.avgRR}
` : 'אין עסקאות עדיין לאסטרטגיה זו.'}

כתוב ביקורת מובנית עם הכותרות הבאות:

**חוזקות** — מה חזק באסטרטגיה${hasStats ? ' ומה מוכיח את עצמו בנתונים' : ''}

**חולשות וסיכונים** — נקודות תורפה ותנאים שיכולים לשבש

**ניהול סיכון** — הערכת ה-SL/TP, ה-R:R והחוקים הקיימים

**המלצות** — 3 הצעות קונקרטיות לשיפור

כתוב בעברית, ישיר ותמציתי. אל תחזור על הנתונים שנתנו לך.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  const review = message.content[0].type === 'text' ? message.content[0].text : '';
  return NextResponse.json({ review });
}
