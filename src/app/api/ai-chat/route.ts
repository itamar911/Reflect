import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt(ctx: {
  totalTrades: number;
  winRate: number;
  avgRR: string;
  avgEmotional: string;
  disciplineScore: number;
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
- ציון משמעת: ${ctx.disciplineScore}/100

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

1. **שלב תמיד** בין הידע המקצועי שלך לנתונים האישיים של המשתמש
2. **אל תגיד רק** מה המשתמש עשה — הסבר גם מה נכון לפי הידע המקצועי
3. **אם שואלים על אסטרטגיה** — הסבר אותה ואז השווה לביצועי המשתמש
4. **תמיד ציין** אם יש סטייה מחוקי ניהול סיכונים בסיסיים
5. **היה ישיר** — אל תהסס לומר אם המשתמש עושה טעות
6. **ענה בעברית** — קצר וברור
7. כשאין מספיק נתונים — אמור זאת ותן עצה כללית מקצועית`;
}

function buildUserContext(data: {
  trades: Record<string, unknown>[];
  presetRules: Record<string, unknown> | null;
  customRules: Record<string, unknown>[];
}) {
  const { trades, presetRules, customRules } = data;

  const closed = trades.filter(t => t.status === 'closed');
  const wins = closed.filter(t => t.exit_price != null && Number(t.exit_price) > Number(t.stop_loss));
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
  const avgRR = trades.length > 0
    ? (trades.reduce((s, t) => s + Number(t.rr_ratio || 0), 0) / trades.length).toFixed(2)
    : '0';
  const avgEmotional = trades.length > 0
    ? (trades.reduce((s, t) => s + Number(t.emotional_state || 3), 0) / trades.length).toFixed(1)
    : '3';

  // Discipline score
  const disciplineScore = trades.length === 0 ? 0 : Math.min(100, Math.round(
    (closed.filter(t => t.plan_score != null).length / Math.max(closed.length, 1)) * 30 +
    (trades.filter(t => Number(t.emotional_state) >= 3).length / trades.length) * 30 +
    (trades.filter(t => Number(t.rr_ratio || 0) >= 2).length / trades.length) * 40
  ));

  // Strategy breakdown
  const stratMap: Record<string, number> = {};
  trades.forEach(t => { const s = String(t.strategy || 'אחר'); stratMap[s] = (stratMap[s] || 0) + 1; });
  const topStrategies = Object.entries(stratMap).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([s, c]) => `${s} (${c})`).join(', ');

  // Hour analysis
  const hourWins: Record<number, { w: number; l: number }> = {};
  closed.forEach(t => {
    const h = new Date(String(t.submitted_at)).getHours();
    if (!hourWins[h]) hourWins[h] = { w: 0, l: 0 };
    const win = t.exit_price != null && Number(t.exit_price) > Number(t.stop_loss);
    if (win) hourWins[h].w++; else hourWins[h].l++;
  });
  const hourScores = Object.entries(hourWins)
    .map(([h, v]) => ({ h: Number(h), score: v.w - v.l, total: v.w + v.l }))
    .filter(x => x.total >= 2);
  const best = hourScores.sort((a, b) => b.score - a.score).slice(0, 2).map(x => `${x.h}:00`).join(', ');
  const worst = hourScores.sort((a, b) => a.score - b.score).slice(0, 2).map(x => `${x.h}:00`).join(', ');

  // Emotional patterns
  const lowEmotional = trades.filter(t => Number(t.emotional_state) <= 2).length;
  const revengePotential = (() => {
    let r = 0;
    const sorted = [...trades].sort((a, b) => new Date(String(a.submitted_at)).getTime() - new Date(String(b.submitted_at)).getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (prev.status === 'closed' && Number(prev.exit_price) <= Number(prev.stop_loss) && Number(curr.emotional_state) <= 2) r++;
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
    if (t.status === 'closed' && Number(t.exit_price) <= Number(t.stop_loss)) consecutive++;
    else break;
  }

  // Recent trades summary
  const recent = trades.slice(0, 5).map(t => {
    const r = Number(t.rr_ratio || 0);
    const status = t.status === 'closed' ? (Number(t.exit_price) > Number(t.stop_loss) ? '✓' : '✗') : '⏳';
    return `${status} ${t.strategy} R:R ${r.toFixed(1)} מצב-רגשי:${t.emotional_state}`;
  }).join('\n');

  // Rules
  const rules = presetRules ? [
    `R:R מינימלי: ${presetRules.min_rr_ratio}`,
    `עסקאות מקסימום ביום: ${presetRules.max_daily_trades}`,
    `Cooldown אחרי ${presetRules.cooldown_after_losses} הפסדים`,
    presetRules.max_daily_loss ? `הפסד יומי מקסימלי: ${presetRules.max_daily_loss}` : null,
    `מצב רגשי מינימלי: ${presetRules.min_emotional_state}/5`,
  ].filter(Boolean).join(', ') : 'לא הוגדרו';

  const customRulesText = customRules.map(r => `- ${r.rule_name}: ${r.trigger_condition} → ${r.action_required}`).join('\n');

  return {
    totalTrades: trades.length,
    winRate, avgRR, avgEmotional, disciplineScore,
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

  const { messages } = await request.json() as { messages: { role: 'user' | 'assistant'; content: string }[] };

  // Load user context
  const [tradesRes, presetRes, customRes] = await Promise.all([
    supabase.from('trade_plans').select('*').eq('user_id', user.id).order('submitted_at', { ascending: false }).limit(100),
    supabase.from('preset_rules').select('*').eq('user_id', user.id).single(),
    supabase.from('custom_rules').select('*').eq('user_id', user.id).eq('is_active', true),
  ]);

  const ctx = buildUserContext({
    trades: (tradesRes.data ?? []) as Record<string, unknown>[],
    presetRules: presetRes.data as Record<string, unknown> | null,
    customRules: (customRes.data ?? []) as Record<string, unknown>[],
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
