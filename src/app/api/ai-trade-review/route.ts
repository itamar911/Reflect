import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { trade, pnl } = await request.json();
  const longShort = trade.take_profit >= trade.entry_price ? 'Long' : 'Short';

  const prompt = `נתח עסקה זו בקצרה — 3-4 משפטים, עברית, ישיר:

אסטרטגיה: ${trade.strategy}${trade.symbol ? ` | נכס: ${trade.symbol}` : ''} | כיוון: ${longShort}
כניסה: ${trade.entry_price} | SL: ${trade.stop_loss} | TP: ${trade.take_profit}${trade.exit_price ? ` | יציאה: ${trade.exit_price}` : ''}
${pnl != null ? `תוצאה: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}` : 'עסקה פתוחה'} | R:R: 1:${trade.rr_ratio}
מצב רגשי: ${trade.emotional_state}/5 | סיבה: ${trade.trade_reason}
${trade.exit_reason ? `סיבת יציאה: ${trade.exit_reason}` : ''}

האם ניהול הסיכון היה נכון? מה ניתן ללמוד? אל תחזור על הנתונים.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 350,
    messages: [{ role: 'user', content: prompt }],
  });

  const review = message.content[0].type === 'text' ? message.content[0].text : '';
  return NextResponse.json({ review });
}
