import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import { visibleTrades } from '@/lib/trades/visible';
import { describeCustomRule, ACTION_LABELS } from '@/lib/validators/RulesetValidator';
import { formatMoney } from '@/lib/money';
import type { CustomRule } from '@/lib/types';
import { PLAIN_HEBREW_PROSE_CLAUSE } from '@/lib/ai/prompts';
import { isWinningTrade, pnlRow } from '@/lib/pnl';
import { averageOf, scaleValue, rrValue, intentText, type RawValue } from '@/lib/intent';
import { readTradeFacts, tradeFactsLine, tradeFactsSummaryLine } from '@/lib/ai/tradeFacts';
import { averagePlanScore, behaviourDisciplineScore } from '@/lib/scoring/disciplineAggregate';

/**
 * How many trades reach the coach with every fact, and how many as one line.
 *
 * TWENTY IS THE SMALLEST NUMBER THAT ANSWERS THE QUESTIONS THIS SURFACE IS
 * ACTUALLY ASKED — "analyse my last trade", "how was today", "how was this
 * week" — and it covers roughly a week for an active futures trader. It replaces
 * FIVE, which could not answer the first of those three, because the five facts
 * it carried per trade did not include the symbol.
 *
 * `TODAY_LINE_CAP = 10` in lib/rules/todayLines.ts is the existing precedent for
 * capping a per-trade list with a stated reason, and the rationale transfers: a
 * trader who took thirty trades does not need thirty full rows, they need the
 * last few whole and the SHAPE of the rest. Hence the tail — the hundred rows
 * were already being loaded and thrown away.
 *
 * MEASURED COST, at ~2.2 chars/token for this mixed Hebrew/Latin text and ±30%:
 * the trade history goes from ~65 tokens to ~3,850, and the whole system prompt
 * from ~2,600 to ~6,400. The static trading-knowledge block above is ~2,300 of
 * that and is re-sent uncached on every message of every conversation, so if one
 * number has to move it is the TAIL (100 → 50) rather than the head — and prompt
 * caching on the knowledge block would save more than any trade cap will.
 */
const FULL_FACT_TRADES = 20;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(ctx: {
  totalTrades: number;
  winRate: number;
  avgRR: string;
  avgEmotional: string;
  disciplineScore: string;
  processScore: string;
  bestHours: string;
  worstHours: string;
  topStrategies: string;
  emotionalPatterns: string;
  recentTrades: string;
  customRules: string;
  presetRules: string;
  streaks: string;
}) {
  return `אתה יועץ מסחר מקצועי ומאמן פסיכולוגי למסחר. יש לך ידע מעמיק בכל אסטרטגיות המסחר המודרניות ובחוקי ניהול סיכונים מקצועיים.

## הידע המקצועי שלך

**אסטרטגיות מסחר:**
- ICT (Inner Circle Trader): Order Blocks, Fair Value Gaps, Liquidity Sweeps, Market Structure Shifts, Optimal Trade Entry
- SMC (Smart Money Concepts): Break of Structure, Change of Character, Premium/Discount Zones, Imbalances
- Asia Range: זיהוי וסימון High/Low של סשן אסיה, פריצה בסשן לונדון, False Breakout, חזרה לטווח
- London Breakout: פריצת high/low של 30 דקות ראשונות, False Break, Volume confirmation
- VWAP: סטיות ממחיר הוגן, חזרה ל-VWAP, VWAP bands, Anchored VWAP
- Scalping: מומנטום, Volume spikes, Price Action, tight Stop Loss
- Swing Trading: Higher Highs/Higher Lows, מגמות ימיות/שבועיות, Fibonacci retracement
- Gap Fill: מילוי פערים, Partial Fill vs Full Fill, Gap הגנה בפתיחה
- Breakout & Retest: פריצה מרמה מרכזית, Volume עם הפריצה, Retest לאישור

**ניתוח טכני:**

תבניות גרף קלאסיות:
- Head & Shoulders (ראש וכתפיים): תבנית היפוך מגמה עולה — Neckline היא רמת הפריצה לאישור
- Double Top / Double Bottom: שתי נגיעות ברמה זהה עם כישלון לפרוץ — מאותת היפוך לכיוון ההפוך
- דגלים ופנונות (Flags & Pennants): תבניות המשך מגמה — כניסה עם פריצת הדגל, Stop מתחת לבסיסו
- משולשים (Triangles): Ascending = בסיס עולה + מכסה ישר → בייאס עולה; Descending = ההיפך; Symmetrical = פריצה לכל כיוון
- טריזים (Wedges): Rising Wedge → לרוב ירידה; Falling Wedge → לרוב עלייה; שניהם מחיקת מומנטום

אינדיקטורים מרכזיים:
- RSI: מעל 70 = Overbought, מתחת ל-30 = Oversold; Divergence בין RSI למחיר = אות היפוך חזק
- MACD: חציית Signal Line = שינוי מומנטום; Histogram מתרחב = מומנטום מתחזק; Divergence = אות היפוך
- ממוצעים נעים (MA): EMA 9/21 לטווח קצר, EMA 50/200 לטווח ארוך; Golden Cross (50 מעל 200) = בייאס עולה; Death Cross = בייאס יורד
- Bollinger Bands: Squeeze = תנודתיות נמוכה לפני פריצה; פריצת הבנד = מגמה חזקה; חזרה לאמצע = Mean Reversion
- Volume Profile: POC (Point of Control) = המחיר עם הכי הרבה מסחר — רמת S&R חזקה; Value Area High/Low = גבולות טווח הערך

תמיכה והתנגדות (S&R):
- S&R קלאסי: Swing Highs/Lows היסטוריים, נקודות פריצה ישנות שהפכו לתמיכה
- Dynamic S&R: ממוצעים נעים, קווי מגמה, ערוצי מחיר
- S&R פסיכולוגי: מספרים עגולים (100, 500, 1000), ATH/ATL
- S&R הוא אזור, לא קו מדויק — תמיד תכנן כניסה עם מרווח של 0.5–1% סביב הרמה

ניתוח מולטי-טיים-פריים (MTF):
- Top-Down: זיהוי מגמה ב-Daily/Weekly, אישור ב-4H, כניסה ב-1H/15M
- מסחר לכיוון המגמה הגדולה בלבד — Trend Trade עדיף על Counter-Trend
- Confluence: כאשר מספר טיים-פריימים מראים את אותה רמה — חזקה משמעותית יותר

**ניתוח פונדמנטלי:**

דוחות רבעוניים (Earnings):
- EPS (Earnings Per Share): Beat → לרוב עלייה; Miss → לרוב ירידה; אבל Guidance משפיע יותר מהתוצאות עצמן
- Revenue: צמיחה עקבית של 10%+ שנתי = חברה בריאה; ירידה בהכנסות = דגל אדום גם אם EPS חיובי
- "Buy the rumor, sell the news": המניה לרוב עולה לפני הדוח ויורדת אחריו אפילו ב-Beat — זהירות
- Earnings Play: תנודתיות קיצונית סביב הדוח — סיכון גבוה, לא מתאים לכל מסחרן

מאקרו-כלכלה:
- CPI (אינפלציה): אינפלציה גבוהה → לחץ על הבנק המרכזי להעלות ריבית → שוק מניות בלחץ, במיוחד מניות צמיחה
- החלטות ריבית (Fed/FOMC): ריבית עולה → דולר מתחזק, מניות צמיחה יורדות, מניות ערך עדיפות; ריבית יורדת → ההיפך
- נתוני תעסוקה (NFP, Unemployment): תעסוקה חזקה = כלכלה בריאה, אבל גם לחץ על ריבית להישאר גבוהה
- GDP: שני רבעונים שליליים = מיתון טכני — Defensives עדיפים; צמיחה חזקה = Cyclicals ו-Tech מובילים
- PMI: מעל 50 = התרחבות תעשייתית; מתחת ל-50 = כיווץ — אינדיקטור מוביל לכלכלה

רוטציה סקטוריאלית:
- Cyclicals (תעשייה, אנרגיה, חומרי גלם): מובילים בשלב הצמיחה הכלכלית
- Defensives (תרופות, מוצרי צריכה בסיסיים, Utilities): מקלט בהאטה ובמיתון
- Tech/Growth: רגישים מאוד לריבית — מתרסקים בסביבת ריבית גבוהה, מובילים בסביבת ריבית נמוכה
- Financials: מרוויחים מריבית גבוהה (מרווח ריבית רחב יותר בין פיקדונות להלוואות)
- REITs (נדל"ן): רגישים לריבית כמו אג"ח — יורדים כשריבית עולה, עולים כשיורדת

חדשות וקטליסטורים:
- Gap Up/Down בפתיחה: לרוב מגיע מחדשות After-Hours — בדוק אם Fade (מתמלא) או Continuation (ממשיך)
- הצהרות FOMC: מהתנועות הגדולות ביותר בשוק — הימנע ממסחר ב-5–10 דקות סביב ההודעה
- Geopolitical Events: אנרגיה ומניות ביטחון רגישות מאוד; מקלטים — זהב, דולר, אג"ח
- קשר פונדמנטלי-טכני: קטליסטור חזק + פריצה טכנית = הסטאפ האמין ביותר; טכני בלבד ללא קטליסטור = פחות אמין

**ניהול סיכונים:**
- לעולם לא להסתכן ביותר מ-1-2% מההון בעסקה אחת
- R:R מינימלי מומלץ: 1:2, אידיאלי: 1:3+
- Position Sizing: חישוב גודל עסקה לפי המרחק ל-Stop Loss
- ירידת ערך יומית מקסימלית: הפסד של 3-5% מהחשבון — עצור למחרת
- Consecutive Losses: אחרי 3 הפסדים רצופים — הפסק מסחר ליום

**פסיכולוגיה:**
- FOMO: כניסה מאוחרת מרגש, לא מתוכנית — הסימן: לא בתכנית המקורית
- Revenge Trading: כניסה מיד אחרי הפסד, הגדלת גודל — מסוכן מאוד
- Overtrading: יותר עסקאות ממה שתוכנן — מוביל להפסד עקבי
- Fear: יציאה מוקדמת מרווח, Stop Loss לחיץ
- Greed: לא לקחת רווח, הזזת Take Profit — הורסת R:R

**מדדי ביצוע:**
- אחוז הצלחה טוב: 40-60% (עם R:R טוב ≥ 1:2)
- פקטור רווח > 1.5 = עקבי; > 2.0 = מצוין
- ירידת ערך מקסימלית < 10% = מנוהל היטב
- Expectancy = (Win% × Avg Win) - (Loss% × Avg Loss)

## נתוני המשתמש הספציפי

**סטטיסטיקות:**
- סה"כ עסקאות: ${ctx.totalTrades}
- אחוז הצלחה: ${ctx.winRate}%
- R:R ממוצע: ${ctx.avgRR}
- מצב רגשי ממוצע: ${ctx.avgEmotional}/5
- ציון משמעת: ${ctx.disciplineScore} — זהו בדיוק הציון שמוצג לסוחר בעמוד הסטטיסטיקות
- ציון תהליך ממוצע: ${ctx.processScore} — ממוצע ציוני העסקאות המחושבים בתחקיר

**שעות מסחר:**
- שעות טובות: ${ctx.bestHours || 'אין מספיק נתונים'}
- שעות חלשות: ${ctx.worstHours || 'אין מספיק נתונים'}

**אסטרטגיות נפוצות:** ${ctx.topStrategies || 'לא נקבעו'}

**דפוסים רגשיים:** ${ctx.emotionalPatterns}

**חוקים אישיים:**
${ctx.customRules || 'לא הוגדרו חוקים אישיים'}

**חוקי מסחר בסיסיים:**
${ctx.presetRules}

**רצפים נוכחיים:** ${ctx.streaks}

**עסקאות אחרונות:**
${ctx.recentTrades || 'אין עסקאות עדיין'}

## הנחיות תגובה

1. ${PLAIN_HEBREW_PROSE_CLAUSE}
2. **שלב תמיד** בין הידע המקצועי שלך לנתונים האישיים של המשתמש
3. **אל תגיד רק** מה המשתמש עשה — הסבר גם מה נכון לפי הידע המקצועי
4. **אם שואלים על אסטרטגיה** — הסבר אותה ואז השווה לביצועי המשתמש
5. **תמיד ציין** אם יש סטייה מחוקי ניהול סיכונים בסיסיים
6. **היה ישיר** — אל תהסס לומר אם המשתמש עושה טעות
7. **ענה בעברית** — קצר וברור
8. כשאין מספיק נתונים — אמור זאת ותן עצה כללית מקצועית`;
}

function buildUserContext(data: {
  trades: Record<string, unknown>[];
  presetRules: Record<string, unknown> | null;
  customRules: CustomRule[];
}) {
  const { trades, presetRules, customRules } = data;

  // Win/loss is the canonical test, not `exit_price > entry_price` — the
  // comparison this replaces reported every profitable short to the assistant
  // as a loss (REF-107 §0ד), and the assistant then answered questions about
  // it. Averages run over the rows that carry a value, not over every row:
  // `|| 0` and `|| 3` were defaults dressed as data (§0ג).
  const isWin = (t: Record<string, unknown>) => isWinningTrade(pnlRow(t)) === true;
  const emoOf = (t: Record<string, unknown>) => scaleValue(t.emotional_state as RawValue);
  const rrOf = (t: Record<string, unknown>) => rrValue(t.rr_ratio as RawValue);

  const closed = trades.filter(t => t.status === 'closed');
  const wins = closed.filter(isWin);
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
  const avgRRNum = averageOf(trades, rrOf);
  const avgEmotionalNum = averageOf(trades, emoOf);
  const avgRR = avgRRNum !== null ? avgRRNum.toFixed(2) : 'לא תועד';
  const avgEmotional = avgEmotionalNum !== null ? avgEmotionalNum.toFixed(1) : 'לא תועד';

  // ── The two discipline figures, both shared (REF-120 §2.4) ───────────────
  //
  // WHAT STOOD HERE WAS A NUMBER THAT EXISTED NOWHERE ELSE IN THE PRODUCT: 30
  // points for `plan_score` being present, 30 for an emotional state ≥ 3, 40 for
  // an R:R ≥ 2, capped at 100 — and it was handed to the coach as "ציון משמעת",
  // which is also the name of the figure on the statistics page. Different
  // inputs, same label, so a trader who asked the coach about their discipline
  // score and then opened /stats saw two different numbers and neither of them
  // was wrong about anything in particular.
  //
  // `behaviourDisciplineScore` IS the stats page's formula, now a shared
  // function rather than a copy of one. `averagePlanScore` is the mean of the
  // scores `computeTradeScore` actually produced — the same figure the weekly
  // mail quotes — and it is the one with a per-trade breakdown behind it, which
  // is why both are given rather than one: the coach can now name the score the
  // trader sees AND reason about the trades that made it, since every full facts
  // line below carries its own `ציון`.
  //
  // Null is "not recorded" and never 0, for lib/intent.ts' reason: a trader who
  // has run no debrief has no process score, and a zero reads as a measured
  // failure.
  const behaviour = behaviourDisciplineScore(closed);
  const process = averagePlanScore(closed);
  const disciplineScore = behaviour !== null ? `${behaviour}/100` : 'לא תועד';
  const processScore = process !== null ? `${process}/100` : 'לא תועד';

  // Strategy breakdown. A row with no strategy gets no bucket; it used to be
  // filed under 'אחר' and quoted back as one the trader chose.
  const stratMap: Record<string, number> = {};
  trades.forEach(t => { const s = intentText(t.strategy as string | null); if (s !== null) stratMap[s] = (stratMap[s] || 0) + 1; });
  const topStrategies = Object.entries(stratMap).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([s, c]) => `${s} (${c})`).join(', ');

  // Hour analysis
  const hourWins: Record<number, { w: number; l: number }> = {};
  closed.forEach(t => {
    const h = new Date(String(t.submitted_at)).getHours();
    if (!hourWins[h]) hourWins[h] = { w: 0, l: 0 };
    if (isWin(t)) hourWins[h].w++; else hourWins[h].l++;
  });
  const hourScores = Object.entries(hourWins)
    .map(([h, v]) => ({ h: Number(h), score: v.w - v.l, total: v.w + v.l }))
    .filter(x => x.total >= 2);
  const best = hourScores.sort((a, b) => b.score - a.score).slice(0, 2).map(x => `${x.h}:00`).join(', ');
  const worst = hourScores.sort((a, b) => a.score - b.score).slice(0, 2).map(x => `${x.h}:00`).join(', ');

  // Emotional patterns
  const lowEmotional = trades.filter(t => { const e = emoOf(t); return e !== null && e <= 2; }).length;
  const revengePotential = (() => {
    let r = 0;
    const sorted = [...trades].sort((a, b) => new Date(String(a.submitted_at)).getTime() - new Date(String(b.submitted_at)).getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const currEmo = emoOf(curr);
      if (isWinningTrade(pnlRow(prev)) === false && currEmo !== null && currEmo <= 2) r++;
    }
    return r;
  })();

  const emotionalPatterns = [
    lowEmotional > 0 ? `${lowEmotional} עסקאות במצב רגשי נמוך (1-2)` : null,
    revengePotential > 0 ? `${revengePotential} מקרי Revenge Trading אפשריים` : null,
  ].filter(Boolean).join(', ') || 'לא זוהו דפוסים בעייתיים';

  // Streaks
  let consecutive = 0;
  const sortedTrades = [...trades].sort((a, b) => new Date(String(b.submitted_at)).getTime() - new Date(String(a.submitted_at)).getTime());
  for (const t of sortedTrades) {
    if (isWinningTrade(pnlRow(t)) === false) consecutive++;
    else break;
  }

  // ── Recent trades (REF-120) ──────────────────────────────────────────────
  //
  // WHAT THIS REPLACES IS THE WHOLE REASON FOR THE TICKET. Five trades carrying
  // four facts each — a win/loss word, the strategy, the planned R:R and the
  // self-reported emotional state — so a trader who asked "analyse my last
  // trade" was told, correctly, that the coach had no symbol, no entry, no exit,
  // no stop and no R:R. Every one of those columns was already in memory: the
  // query below is `select('*')` and the loss was entirely here.
  //
  // THE SERIALISER IS A MODULE AND NOT A TEMPLATE, and lib/ai/tradeFacts.ts says
  // why at length: it is the one thing that can carry an explicit deny list for
  // the ids, the trade key, the host token and the prop firm's account name that
  // this row also holds, and being pure it is testable without exporting
  // anything from here.
  //
  // THE NOTES STAY IN THIS FILE, and deliberately. They are the trader's own
  // free prose — the one piece of this line that is not a fact — and keeping
  // them out of the shared serialiser keeps that surface where it already was
  // rather than handing it to every future caller. Truncated as before, to
  // protect the system prompt's token budget.
  const recentFull = trades.slice(0, FULL_FACT_TRADES).flatMap(t => {
    const facts = readTradeFacts(t);
    if (facts === null) return [];
    const line = tradeFactsLine(facts);
    if (line === '') return [];
    const notes = typeof t.post_trade_notes === 'string' ? t.post_trade_notes.trim() : '';
    return [notes
      ? `${line} | הערת הסוחר: ${notes.length > 200 ? notes.slice(0, 200) + '…' : notes}`
      : line];
  });

  // The tail: the shape of the record rather than the detail of any one trade.
  const recentTail = trades.slice(FULL_FACT_TRADES).flatMap(t => {
    const facts = readTradeFacts(t);
    if (facts === null) return [];
    const line = tradeFactsSummaryLine(facts);
    return line === '' ? [] : [line];
  });

  const recent = [
    ...recentFull,
    ...(recentTail.length > 0
      ? ['', `**עסקאות מוקדמות יותר (${recentTail.length}, בשורת סיכום):**`, ...recentTail]
      : []),
  ].join('\n');

  // Rules
  const rules = presetRules ? [
    `R:R מינימלי: ${presetRules.min_rr_ratio}`,
    `עסקאות מקסימום ביום: ${presetRules.max_daily_trades}`,
    `Cooldown אחרי ${presetRules.cooldown_after_losses} הפסדים`,
    // presetRules is an untyped row here, so the threshold is coerced before
    // formatting. REF-99 gave this line a currency symbol — it was the one
    // place a money threshold reached the model as a bare number.
    Number(presetRules.max_daily_loss) > 0
      ? `הפסד יומי מקסימלי: ${formatMoney(Number(presetRules.max_daily_loss), { decimals: 0, sign: 'none' })}`
      : null,
    `מצב רגשי מינימלי: ${presetRules.min_emotional_state}/5`,
  ].filter(Boolean).join(', ') : 'לא הוגדרו';

  const customRulesText = customRules.map(r => `- ${r.name}: ${describeCustomRule(r)} → ${ACTION_LABELS[r.action_type]}`).join('\n');

  return {
    totalTrades: trades.length,
    winRate, avgRR, avgEmotional, disciplineScore, processScore,
    bestHours: best, worstHours: worst,
    topStrategies, emotionalPatterns,
    recentTrades: recent,
    customRules: customRulesText,
    presetRules: rules,
    streaks: consecutive > 0 ? `${consecutive} הפסדים רצופים כרגע` : 'אין רצף הפסדים',
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { limits } = await getUserPlan(supabase, user.id);
  if (!limits.aiCoach) return NextResponse.json({ error: 'PLAN_LIMIT', feature: 'ai_coach' }, { status: 403 });

  const { messages } = await request.json() as { messages: { role: 'user' | 'assistant'; content: string }[] };

  // Load user context
  const [tradesRes, presetRes, customRes] = await Promise.all([
    // buildUserContext averages over every row and builds the coach's
    // discipline score, strategy mix and recent-trades list from them, so a
    // plan the user never entered would be described to the coach as a trade
    // (REF-82 §5.2).
    supabase.from('trade_plans').select('*').eq('user_id', user.id).neq('status', 'not_entered').order('submitted_at', { ascending: false }).limit(100),
    supabase.from('preset_rules').select('*').eq('user_id', user.id).single(),
    supabase.from('custom_rules').select('*').eq('user_id', user.id).eq('is_active', true),
  ]);

  const ctx = buildUserContext({
    // A row the trader deleted is not in the chat's context (REF-107 E12).
    trades: visibleTrades((tradesRes.data ?? []) as unknown as Record<string, unknown>[]),
    presetRules: presetRes.data as Record<string, unknown> | null,
    customRules: (customRes.data ?? []) as CustomRule[],
  });

  const systemPrompt = buildSystemPrompt(ctx);

  // Stream the response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const anthropicStream = await client.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: systemPrompt,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        });

        for await (const chunk of anthropicStream) {
          if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'שגיאה';
        controller.enqueue(encoder.encode(`\n\nשגיאה: ${msg}`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
  });
}
