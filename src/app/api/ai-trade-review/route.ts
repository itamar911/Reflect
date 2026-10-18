import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { PLAIN_HEBREW_PROSE_CLAUSE } from '@/lib/ai/prompts';
import { tradeDirection } from '@/lib/pnl';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // `pnl` is MONEY and the prompt labels it with a `$` (REF-115 site 5). It
  // used to be price points under no unit at all, which Claude read as a
  // result and reasoned about — "תוצאה: 5" on a trade that made $250.
  const { trade, pnl } = await request.json();
  // Direction from the column, through the shared helper. The tp-vs-entry
  // comparison that stood here told Claude every profitable short was a long
  // that lost (REF-107 §0ד).
  const longShort = tradeDirection({
    status: String(trade.status ?? ''),
    entry_price: trade.entry_price,
    exit_price: trade.exit_price ?? null,
    take_profit: trade.take_profit ?? null,
    direction: trade.direction ?? null,
  }) === 'long' ? 'Long' : 'Short';

  // An intent field the row does not carry is omitted rather than interpolated
  // as the string "null", which Claude would otherwise read and analyse as if
  // the trader had written it.
  const part = (label: string, v: unknown) => (v == null || v === '' ? '' : ` | ${label}: ${v}`);

  const prompt = `נתח עסקה זו בקצרה — 3-4 משפטים, עברית, ישיר:

אסטרטגיה: ${trade.strategy ?? '—'}${trade.symbol ? ` | נכס: ${trade.symbol}` : ''} | כיוון: ${longShort}
כניסה: ${trade.entry_price}${part('SL', trade.stop_loss)}${part('TP', trade.take_profit)}${part('יציאה', trade.exit_price)}
${pnl != null ? `תוצאה: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)}` : 'עסקה פתוחה'}${part('R:R', trade.rr_ratio != null ? `1:${trade.rr_ratio}` : null)}
${trade.emotional_state != null ? `מצב רגשי: ${trade.emotional_state}/5` : 'מצב רגשי: לא תועד'}${part('סיבה', trade.trade_reason)}
${trade.exit_reason ? `סיבת יציאה: ${trade.exit_reason}` : ''}

האם ניהול הסיכון היה נכון? מה ניתן ללמוד? אל תחזור על הנתונים.

${PLAIN_HEBREW_PROSE_CLAUSE}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 350,
    messages: [{ role: 'user', content: prompt }],
  });

  const review = message.content[0].type === 'text' ? message.content[0].text : '';
  return NextResponse.json({ review });
}
