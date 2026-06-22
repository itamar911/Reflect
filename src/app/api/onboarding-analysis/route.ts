import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a professional trading psychology analyst. Based on the trader's profile, return ONLY a JSON object with these exact fields:
{
  traderType: string (e.g. 'The Revenge Trader', 'The Disciplined Sniper', 'The Overtrader', 'The Fearful Trader', 'The Impatient Trader'),
  traderTypeHebrew: string (Hebrew translation of the type),
  description: string (ONE punchy Hebrew sentence that feels personal and slightly uncomfortable - like it knows them),
  weaknesses: [string, string] (2 specific Hebrew weaknesses based on their profile combination),
  firstTip: string (ONE specific actionable Hebrew tip for their exact profile)
}
Return only valid JSON, no markdown, no explanation.`;

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const {
    displayName, tradingType, experienceLevel, defaultMarket,
    minRrRatio, maxDailyTrades, biggestChallenge, afterLossBehavior,
  } = await request.json();

  const profile = `שם: ${displayName}
סגנון מסחר: ${tradingType}
רמת ניסיון: ${experienceLevel}
שוק עיקרי: ${defaultMarket}
R:R מינימלי: 1:${minRrRatio}
מקסימום עסקאות ביום: ${maxDailyTrades}
האתגר הכי גדול: ${biggestChallenge}
מה קורה אחרי הפסד: ${afterLossBehavior}`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: profile }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in AI response');

    const analysis = JSON.parse(jsonMatch[0]);
    return NextResponse.json({ analysis });
  } catch (err) {
    console.error('[onboarding-analysis] failed', err);
    return NextResponse.json({ error: 'analysis_failed' }, { status: 500 });
  }
}
