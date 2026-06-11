import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface ScoreBreakdown {
  potential: number;
  riskReward: number;
  discipline: number;
  emotional: number;
  documentation: number;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const EMOTIONAL_POINTS: Record<number, number> = { 1: 0, 2: 5, 3: 9, 4: 12, 5: 15 };
const DOCUMENTATION_POINTS = [0, 3, 6, 10];

function computeQuantScores(trade: Record<string, unknown>, description: string | null) {
  const entry = Number(trade.entry_price);
  const sl = Number(trade.stop_loss);
  const tp = Number(trade.take_profit);
  const exit = trade.exit_price != null ? Number(trade.exit_price) : null;
  const direction: 'long' | 'short' = tp >= entry ? 'long' : 'short';

  let potential = 0;
  let riskReward = 0;
  if (exit != null) {
    const rewardSpan = direction === 'long' ? tp - entry : entry - tp;
    const moveAchieved = direction === 'long' ? exit - entry : entry - exit;
    if (rewardSpan > 0) potential = clamp((moveAchieved / rewardSpan) * 30, 0, 30);

    const risk = Math.abs(entry - sl);
    if (risk > 0 && rewardSpan > 0) {
      const actualRR = moveAchieved / risk;
      const plannedRR = rewardSpan / risk;
      riskReward = clamp((actualRR / plannedRR) * 25, 0, 25);
    }
  }

  const emotional = EMOTIONAL_POINTS[Number(trade.emotional_state)] ?? 0;

  const filledFields = [trade.trade_reason, description, trade.exit_reason]
    .filter((v) => typeof v === 'string' && v.trim().length > 0).length;
  const documentation = DOCUMENTATION_POINTS[filledFields];

  return {
    direction,
    potential: Math.round(potential),
    riskReward: Math.round(riskReward),
    emotional,
    documentation,
  };
}

function disciplineSuggestion(exitReason: unknown): number {
  const r = typeof exitReason === 'string' ? exitReason : '';
  if (/take profit/i.test(r)) return 20;
  if (/הפסד|סגירה מוקדמת/.test(r)) return 5;
  if (/רווח/.test(r)) return 10;
  return 12;
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

  const quant = computeQuantScores(trade, description);
  const suggestedDiscipline = disciplineSuggestion(trade.exit_reason);

  content.push({ type: 'text', text: buildDebriefPrompt(trade, description, quant, suggestedDiscipline) });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content }],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { analysis: 'Unable to analyze' };

  // The score is recomputed here from the deterministic categories plus Claude's
  // (clamped) discipline judgement, so the returned score can never drift from
  // the breakdown shown to the user.
  const discipline = clamp(Math.round(Number(parsed?.breakdown?.discipline ?? suggestedDiscipline)), 0, 20);
  const breakdown: ScoreBreakdown = {
    potential: quant.potential,
    riskReward: quant.riskReward,
    discipline,
    emotional: quant.emotional,
    documentation: quant.documentation,
  };
  const score = breakdown.potential + breakdown.riskReward + breakdown.discipline
    + breakdown.emotional + breakdown.documentation;

  return NextResponse.json({ ...parsed, score, breakdown });
}

function buildDebriefPrompt(
  trade: Record<string, unknown>,
  description: string | null,
  quant: ReturnType<typeof computeQuantScores>,
  suggestedDiscipline: number,
): string {
  const entry = Number(trade.entry_price);
  const sl = Number(trade.stop_loss);
  const tp = Number(trade.take_profit);
  const exit = trade.exit_price != null ? Number(trade.exit_price) : null;

  const exitContext = (() => {
    if (exit == null) return null;
    const potentialRisk = Math.abs(entry - sl);
    const potentialReward = Math.abs(tp - entry);
    const actualMove = Math.abs(exit - entry);
    const capturedPct = potentialReward > 0 ? Math.round((actualMove / potentialReward) * 100) : 0;
    const hitSL = Math.abs(exit - sl) < Math.abs(entry - sl) * 0.05;
    const hitTP = Math.abs(exit - tp) < Math.abs(tp - entry) * 0.05;
    const exitedEarly = !hitTP && !hitSL && exit > entry;
    return { capturedPct, hitSL, hitTP, exitedEarly, potentialRisk, potentialReward };
  })();

  const fixedTotal = quant.potential + quant.riskReward + quant.emotional + quant.documentation;

  return `You are a professional trade analyst. Analyze the following completed trade and respond entirely in Hebrew.

Trade data:
- Strategy: ${trade.strategy}
- Direction: ${quant.direction === 'long' ? 'LONG' : 'SHORT'}
- Entry: ${entry}
- Stop Loss: ${sl}
- Take Profit: ${tp}
- R:R ratio: ${trade.rr_ratio}
- Entry reason: ${trade.trade_reason}
- Status: ${trade.status}
${exit != null ? `- Exit price: ${exit}` : ''}
${exitContext ? `- Hit stop loss: ${exitContext.hitSL}` : ''}
${exitContext ? `- Hit take profit: ${exitContext.hitTP}` : ''}
${exitContext ? `- Exited early (before TP, in profit): ${exitContext.exitedEarly}` : ''}
${exitContext ? `- Captured ~${exitContext.capturedPct}% of potential reward` : ''}
- Exit reason: ${trade.exit_reason ?? '—'}
- Emotional state (self-reported, 1-5): ${trade.emotional_state}
${description ? `- Trader notes: ${description}` : '- Trader notes: (none)'}

A quantitative score has already been calculated for this trade out of 100. You may ONLY adjust category 3 (discipline) — categories 1, 2, 4 and 5 are fixed and must be used exactly as given:
1. Potential realization (out of 30): ${quant.potential} — how much of the planned move to TP was captured
2. R:R actual vs. planned (out of 25): ${quant.riskReward} — actual reward/risk achieved vs. the planned R:R
3. Discipline / followed plan (out of 20): suggested ${suggestedDiscipline}, based on the exit reason. Review the exit reason and trader notes and confirm or adjust this value (0-20):
   - Exited at Take Profit as planned → 20
   - Manual exit while in profit, reasonable management → ~10
   - Impulsive / fear-based exit (panic, premature close, loss-driven override of the plan) → ~5
   - Use the trader notes to move up or down within this scale
4. Emotional state (out of 15): ${quant.emotional} — derived from the self-reported emotional state ${trade.emotional_state}/5
5. Documentation quality (out of 10): ${quant.documentation} — based on whether entry reason, notes and exit reason were filled in

Categories 1, 2, 4 and 5 sum to ${fixedTotal}/90. The final score = ${fixedTotal} + your discipline score (0-20), out of 100.

Instructions:
1. Analyze each field honestly based on the actual trade data above.
2. In "execution", explain and justify the discipline score (item 3) — whether the trade was closed according to the plan or impulsively, citing the exit reason and trader notes.
3. For "emotional", evaluate behavioral/emotional quality from the trade execution itself (not just the self-reported number): did they exit early and leave gains on the table, override their stop, etc.
4. Your written analysis (overall, entry_quality, risk_management, execution, emotional, lessons) MUST be consistent with and explain the final numeric score — do not write a critical analysis alongside a high score, or a glowing analysis alongside a low score. Reference the actual point values from the breakdown where relevant.

Return JSON exactly in this format (no additional text):
{
  "overall": "2-3 sentence overall assessment, mentioning the final score",
  "entry_quality": "Entry quality and timing analysis",
  "risk_management": "SL, TP, and R:R evaluation — reference the potential realization and R:R scores",
  "execution": "Execution and trade management quality — reference and justify the discipline score",
  "emotional": "Behavioral/emotional quality inferred from trade execution",
  "lessons": "Key takeaways from this trade",
  "score": <integer, ${fixedTotal} + your discipline score>,
  "breakdown": {
    "potential": ${quant.potential},
    "riskReward": ${quant.riskReward},
    "discipline": <integer 0-20>,
    "emotional": ${quant.emotional},
    "documentation": ${quant.documentation}
  }
}

Write all text values in Hebrew.`;
}
