import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ScoreBreakdown {
  planning: number;
  followedPlan: number;
  keptSl: number;
  properSize: number;
  learning: number;
}

interface Outcome {
  points: number;
  amount: number | null;
  currency: string | null;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function isFilled(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

function planningScore(trade: Record<string, unknown>): number {
  const fields = [trade.entry_price, trade.stop_loss, trade.take_profit, trade.trade_reason, trade.strategy];
  return Math.round((fields.filter(isFilled).length / fields.length) * 20);
}

function computeOutcome(trade: Record<string, unknown>): Outcome | null {
  const entry = Number(trade.entry_price);
  const tp = Number(trade.take_profit);
  const exit = trade.exit_price != null ? Number(trade.exit_price) : null;
  if (exit == null || !Number.isFinite(entry) || !Number.isFinite(tp)) return null;

  const direction: 'long' | 'short' = tp >= entry ? 'long' : 'short';
  const points = direction === 'long' ? exit - entry : entry - exit;

  return {
    points: Math.round(points * 100) / 100,
    amount: trade.pnl_amount != null ? Number(trade.pnl_amount) : null,
    currency: typeof trade.pnl_currency === 'string' ? trade.pnl_currency : null,
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await request.formData();
  const tradeData = formData.get('trade') as string;
  const description = formData.get('description') as string | null;
  const imageFile = formData.get('image') as File | null;

  const trade = JSON.parse(tradeData);
  const content: Anthropic.MessageParam['content'] = [];

  if (imageFile) {
    const buffer = await imageFile.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mediaType = imageFile.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
  }

  const fixed = {
    planning: planningScore(trade),
    followedPlan: trade.followed_plan === true ? 25 : 0,
    keptSl: trade.kept_sl === true ? 25 : 0,
    properSize: trade.proper_size === true ? 15 : 0,
  };
  const outcome = computeOutcome(trade);

  content.push({ type: 'text', text: buildDebriefPrompt(trade, description, fixed) });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { analysis: 'Unable to analyze' };

  // The score is recomputed here from the fixed process categories plus Claude's
  // (clamped) learning judgement, so the returned score can never drift from the
  // breakdown shown to the user.
  const learning = clamp(Math.round(Number(parsed?.breakdown?.learning ?? 0)), 0, 15);
  const breakdown: ScoreBreakdown = { ...fixed, learning };
  const score = breakdown.planning + breakdown.followedPlan + breakdown.keptSl
    + breakdown.properSize + breakdown.learning;

  return NextResponse.json({ ...parsed, score, breakdown, outcome });
}

function buildDebriefPrompt(
  trade: Record<string, unknown>,
  description: string | null,
  fixed: { planning: number; followedPlan: number; keptSl: number; properSize: number },
): string {
  const fixedTotal = fixed.planning + fixed.followedPlan + fixed.keptSl + fixed.properSize;

  return `You are a professional trading-process coach. Analyze the following completed trade and respond entirely in Hebrew.

This review evaluates the trader's PROCESS and discipline ONLY — NOT the outcome. Do not discuss profit/loss, points gained or lost, or whether the trade was a win or a loss anywhere in your analysis.

Trade data:
- Strategy: ${trade.strategy}
- Entry: ${trade.entry_price}
- Stop Loss: ${trade.stop_loss}
- Take Profit: ${trade.take_profit}
- Entry reason (the plan): ${trade.trade_reason}
- Exit reason: ${trade.exit_reason ?? '—'}
${description ? `- Trader notes on the exit: ${description}` : '- Trader notes on the exit: (none)'}
- Followed the entry plan exactly: ${trade.followed_plan === true ? 'כן' : 'לא'}
- Kept the original stop loss without moving it: ${trade.kept_sl === true ? 'כן' : 'לא'}
- Position size matched the trader's risk rules: ${trade.proper_size === true ? 'כן' : 'לא'}

A quantitative process score out of 100 has already been calculated. You may ONLY determine category 5 (learning) — categories 1-4 are fixed and MUST be used exactly as given:
1. תכנון מוקדם — planning (out of 20): ${fixed.planning} — based on whether entry price, stop loss, take profit, entry reason and strategy were all documented
2. כניסה לפי תוכנית — followed the plan (out of 25): ${fixed.followedPlan} — from the trader's yes/no answer above
3. שמירה על SL — kept the stop loss (out of 25): ${fixed.keptSl} — from the trader's yes/no answer above
4. גודל פוזיציה — proper position size (out of 15): ${fixed.properSize} — from the trader's yes/no answer above
5. למידה — learning (out of 15): judge the depth and insight of the exit reason and trader notes:
   - Detailed, specific, insightful reflection → 15
   - Basic / generic reflection → 8
   - Empty or superficial → 0

Categories 1-4 sum to ${fixedTotal}/85. The final score = ${fixedTotal} + your learning score (0-15), out of 100.

Instructions:
1. Write analysis that explains and is fully consistent with this PROCESS score. Reference the actual breakdown values where relevant (e.g. "שמרת על ה-SL ולכן קיבלת 25/25 בקטגוריה זו").
2. Do NOT mention profitability, P&L amounts, points gained/lost, or whether the take-profit was reached — that information is shown to the trader separately and is out of scope here.
3. In "execution", focus on whether the trader followed their plan, kept their stop, and sized the position correctly.
4. In "emotional", focus on discipline/behavioral signals from the exit reason and notes (impulsiveness vs. composure) — not on emotional reaction to profit or loss.
5. In "lessons", give concrete process improvements for next time.

Return JSON exactly in this format (no additional text):
{
  "overall": "2-3 sentence overall assessment of the PROCESS, mentioning the final process score",
  "entry_quality": "Was the entry planned and documented well?",
  "risk_management": "Risk-management process — stop-loss handling and position sizing",
  "execution": "Execution discipline — followed the plan, kept the stop, sized correctly",
  "emotional": "Discipline/behavioral signals from the exit reason and notes",
  "lessons": "Concrete process improvements for next time",
  "score": <integer, ${fixedTotal} + your learning score>,
  "breakdown": {
    "planning": ${fixed.planning},
    "followedPlan": ${fixed.followedPlan},
    "keptSl": ${fixed.keptSl},
    "properSize": ${fixed.properSize},
    "learning": <integer 0-15>
  }
}

Write all text values in Hebrew.`;
}
