import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getUserPlan } from '@/lib/plans/getUserPlan';
import {
  computeWeeklyStats,
  TRADE_SELECT_FIELDS,
  type TradeRow,
  type WeeklyStats,
} from '@/lib/weekly/stats';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withHidden } from '@/lib/trades/visible';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// The most recently completed Sunday→Saturday week.
function getLastCompletedWeek(now: Date = new Date()): { weekStart: Date; weekEnd: Date } {
  const weekEnd = new Date(now);
  weekEnd.setHours(0, 0, 0, 0);
  weekEnd.setDate(weekEnd.getDate() - weekEnd.getDay() - 1);
  const weekStart = new Date(weekEnd);
  weekStart.setDate(weekEnd.getDate() - 6);
  return { weekStart, weekEnd };
}

// The Sunday that begins the current, still-in-progress week.
function getCurrentWeekStart(now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

// Resolves the requested week_start to a valid YYYY-MM-DD string. The current,
// in-progress week is only navigable on Sundays — any other day, the most
// recently navigable week is the last completed one, and requests for a later
// week are clamped back to it.
function resolveWeekStart(now: Date, requested: string | null): {
  weekStartStr: string;
  latestWeekStartStr: string;
  currentWeekStartStr: string;
} {
  const lastCompletedWeekStartStr = dateStr(getLastCompletedWeek(now).weekStart);
  const currentWeekStartStr = dateStr(getCurrentWeekStart(now));
  const latestWeekStartStr = now.getDay() === 0 ? currentWeekStartStr : lastCompletedWeekStartStr;

  let weekStartStr = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : lastCompletedWeekStartStr;
  if (weekStartStr > latestWeekStartStr) weekStartStr = latestWeekStartStr;

  return { weekStartStr, latestWeekStartStr, currentWeekStartStr };
}

// Trades with a long, reflective note are worth quoting back to the user.
function collectInsightfulNotes(trades: TradeRow[]): string[] {
  const notes: string[] = [];
  for (const t of trades) {
    for (const text of [t.post_trade_notes, t.exit_reason]) {
      const trimmed = text?.trim();
      if (trimmed && trimmed.split(/\s+/).length > 10) notes.push(trimmed);
    }
  }
  return notes;
}

function buildPrompt(stats: WeeklyStats, firstName: string, insightfulNotes: string[], isCurrentWeek: boolean): string {
  const period = isCurrentWeek ? 'מתחילת השבוע הנוכחי ועד היום' : 'לשבוע שעבר';
  const whatWorked = isCurrentWeek ? 'עד כה השבוע' : 'השבוע';
  const nextPeriod = isCurrentWeek ? 'בהמשך השבוע' : 'השבוע הבא';

  let prompt = `אתה מאמן מסחר מקצועי. להלן נתוני המסחר של ${firstName} ${period}: ${JSON.stringify(stats)}.

כתוב סיכום שבועי בעברית שממוקד אך ורק בתהליך ובמשמעת — לא בתוצאות הכספיות. אסור להזכיר בטקסט סכומי כסף, רווח/הפסד, P&L או אחוזי הצלחה בשום מקום — נתונים אלה כבר מוצגים למשתמש בנפרד בכרטיסים ובגרף. התמקד אך ורק במשמעת, באיכות הכניסות לעסקאות, במצב הרגשי ובדפוסי התנהגות חוזרים.

מבנה הסיכום: כתוב 'שלום ${firstName},' כפתיחה, ולאחריה ארבע כותרות ברמה ## בדיוק כפי שמופיעות כאן (אל תשנה את הניסוח שלהן):

## מה עבד טוב
תאר 2-3 דברים חיוביים מבחינת תהליך ומשמעת ${whatWorked} (למשל: עמידה בתוכנית, ניהול סיכונים נכון, סבלנות בכניסה לעסקה).

## דפוסים שחוזרים לרעה
זהה דפוס התנהגות אחד או שניים שחוזרים על עצמם ופוגעים בתהליך (למשל: כניסה מוקדמת מדי, סטייה מהתוכנית, מסחר יתר).

## מצב רגשי
נתח את המצב הרגשי של ${firstName} ${whatWorked} ואת ההשפעה שלו על קבלת ההחלטות.

## המלצה
כתוב המלצה אחת ל${nextPeriod} שהיא פעולה קונקרטית, ספציפית וניתנת למעקב — לא עצה כללית.
דוגמה לא טובה: "כדאי לבדוק את האסטרטגיה."
דוגמה טובה: "${nextPeriod}: אל תכנס ל-Asia Range Breakout אלא אם כן יש confirmation של 3 נרות."

חשוב מאוד לגבי פורמט: כל כותרת סעיף חייבת להתחיל בדיוק ב-## (שני סימני סולמית) ואחריהם רווח, בדיוק כפי שמופיע למעלה — לדוגמה: "## מה עבד טוב". אסור להשתמש ב-** (כוכביות) לכותרות סעיפים בשום אופן. ניתן להשתמש ב-** רק להדגשת מילה או ביטוי בודד בתוך פסקה, ולא לכותרות.

כתוב בגוף שני ישיר, אל תשתמש באימוג'ים, היה ישיר, תמציתי ומעשי.`;

  if (insightfulNotes.length > 0) {
    prompt += `

הנה ציטוטים מתוך ההערות שכתב ${firstName} על העסקאות שלו ${isCurrentWeek ? 'השבוע עד כה' : 'השבוע'}: ${JSON.stringify(insightfulNotes)}. אם מצאת ביניהם משפט מעניין ומשמעותי, הוסף בסוף הסיכום כותרת חמישית ברמה ## (לא **) בנוסח "## מה שאמרת לעצמך השבוע" וצטט אותו שם.`;
  }

  return prompt;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { limits } = await getUserPlan(supabase, user.id);
  if (!limits.weeklySummary) return NextResponse.json({ error: 'PLAN_LIMIT', feature: 'weekly_summary' }, { status: 403 });

  const now = new Date();
  const requestedWeekStart = new URL(request.url).searchParams.get('week_start');
  const { weekStartStr, latestWeekStartStr, currentWeekStartStr } = resolveWeekStart(now, requestedWeekStart);

  const weekStart = new Date(`${weekStartStr}T00:00:00.000Z`);
  const isCurrentWeek = weekStartStr === currentWeekStartStr;
  // The current week isn't over yet, so it only spans Sunday through today.
  const weekEndStr = isCurrentWeek ? dateStr(now) : dateStr(addDays(weekStart, 6));
  const prevWeekStartStr = dateStr(addDays(weekStart, -7));

  console.log(`[weekly-summary] GET user=${user.id} week=${weekStartStr}${isCurrentWeek ? ' (current week)' : ''}`);

  const { data: previous, error: prevError } = await supabase
    .from('weekly_summaries')
    .select('stats')
    .eq('user_id', user.id)
    .eq('week_start', prevWeekStartStr)
    .maybeSingle();

  if (prevError) {
    console.error('[weekly-summary] GET: previous-week query failed:', prevError);
  }
  const previousStats = (previous?.stats as WeeklyStats | null | undefined) ?? null;

  if (isCurrentWeek) {
    // Stats for an in-progress week are always computed live (Sunday through
    // today), but an AI summary may already have been generated for it.
    const { data: stored, error: storedError } = await supabase
      .from('weekly_summaries')
      .select('summary_text,created_at')
      .eq('user_id', user.id)
      .eq('week_start', weekStartStr)
      .maybeSingle();

    if (storedError) {
      console.error('[weekly-summary] GET: current-week summary lookup failed:', storedError);
    }

    const { data: trades, error: tradesError } = await supabase
      .from('trade_plans')
      // `hidden` only where the column exists (lib/trades/visible.ts).
      .select(withHidden(TRADE_SELECT_FIELDS, isImportEnabled()))
      .eq('user_id', user.id)
      .eq('status', 'closed')
      .gte('closed_at', `${weekStartStr}T00:00:00.000Z`)
      .lte('closed_at', `${weekEndStr}T23:59:59.999Z`);

    if (tradesError) {
      console.error('[weekly-summary] GET: current-week trade_plans query failed:', tradesError);
      return NextResponse.json({ error: `שגיאה בטעינת עסקאות: ${tradesError.message}` }, { status: 500 });
    }

    return NextResponse.json({
      summary: {
        week_start: weekStartStr,
        week_end: weekEndStr,
        summary_text: stored?.summary_text ?? null,
        stats: computeWeeklyStats(visibleTrades((trades ?? []) as unknown as TradeRow[]), weekStart),
        created_at: stored?.created_at ?? now.toISOString(),
      },
      week_start: weekStartStr,
      week_end: weekEndStr,
      is_current_week: true,
      previous_stats: previousStats,
      latest_week_start: latestWeekStartStr,
    });
  }

  const { data, error } = await supabase
    .from('weekly_summaries')
    .select('week_start,week_end,summary_text,stats,created_at')
    .eq('user_id', user.id)
    .eq('week_start', weekStartStr)
    .maybeSingle();

  if (error) {
    console.error('[weekly-summary] GET: weekly_summaries query failed:', error);
    return NextResponse.json({ error: `שגיאה בטעינת הסיכום: ${error.message}` }, { status: 500 });
  }

  let summary = data ?? null;
  if (summary) {
    // The stored stats are a snapshot from when the summary was generated —
    // debriefs (and thus plan_score) may have been filled in afterwards, so
    // recompute the process score live from trade_plans.
    const { data: scoreRows, error: scoreError } = await supabase
      .from('trade_plans')
      .select('plan_score')
      .eq('user_id', user.id)
      .eq('status', 'closed')
      .gte('closed_at', `${weekStartStr}T00:00:00.000Z`)
      .lte('closed_at', `${weekEndStr}T23:59:59.999Z`)
      .not('plan_score', 'is', null);

    if (scoreError) {
      console.error('[weekly-summary] GET: plan_score query failed:', scoreError);
    } else if ((scoreRows ?? []).length > 0) {
      const rows = scoreRows ?? [];
      const avgProcessScore = Math.round(rows.reduce((s, r) => s + Number(r.plan_score), 0) / rows.length);
      summary = { ...summary, stats: { ...(summary.stats as WeeklyStats), avg_process_score: avgProcessScore } };
    }
  }

  return NextResponse.json({
    summary,
    week_start: weekStartStr,
    week_end: weekEndStr,
    is_current_week: false,
    previous_stats: previousStats,
    latest_week_start: latestWeekStartStr,
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { limits } = await getUserPlan(supabase, user.id);
  if (!limits.weeklySummary) return NextResponse.json({ error: 'PLAN_LIMIT', feature: 'weekly_summary' }, { status: 403 });

  const now = new Date();
  const requestedWeekStart = new URL(request.url).searchParams.get('week_start');
  const { weekStartStr, currentWeekStartStr } = resolveWeekStart(now, requestedWeekStart);

  const weekStart = new Date(`${weekStartStr}T00:00:00.000Z`);
  const isCurrentWeek = weekStartStr === currentWeekStartStr;
  // The current week isn't over yet, so it only spans Sunday through today.
  const weekEndStr = isCurrentWeek ? dateStr(now) : dateStr(addDays(weekStart, 6));

  console.log(`[weekly-summary] POST start user=${user.id} week=${weekStartStr}..${weekEndStr}${isCurrentWeek ? ' (current week)' : ''}`);

  try {
    const { data: trades, error: tradesError } = await supabase
      .from('trade_plans')
      // `hidden` only where the column exists (lib/trades/visible.ts).
      .select(withHidden(TRADE_SELECT_FIELDS, isImportEnabled()))
      .eq('user_id', user.id)
      .eq('status', 'closed')
      .gte('closed_at', `${weekStartStr}T00:00:00.000Z`)
      .lte('closed_at', `${weekEndStr}T23:59:59.999Z`);

    if (tradesError) {
      console.error('[weekly-summary] POST: trade_plans query failed:', tradesError);
      return NextResponse.json({ error: `שגיאה בטעינת עסקאות: ${tradesError.message}` }, { status: 500 });
    }
    console.log(`[weekly-summary] POST: loaded ${trades?.length ?? 0} closed trades for the week`);

    const stats = computeWeeklyStats(visibleTrades((trades ?? []) as unknown as TradeRow[]), weekStart);

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) {
      console.error('[weekly-summary] POST: profile query failed:', profileError);
    }
    const firstName = profile?.display_name?.split(' ')[0] ?? 'סוחר';

    const insightfulNotes = collectInsightfulNotes(
      visibleTrades((trades ?? []) as unknown as TradeRow[])
    );

    let summaryText: string;
    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: buildPrompt(stats, firstName, insightfulNotes, isCurrentWeek) }],
      });
      summaryText = message.content[0].type === 'text' ? message.content[0].text : '';
      console.log(`[weekly-summary] POST: Claude returned ${summaryText.length} chars`);
    } catch (err) {
      console.error('[weekly-summary] POST: Claude API call failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `קריאה ל-AI נכשלה: ${detail}` }, { status: 502 });
    }

    const { data: existing, error: existingError } = await supabase
      .from('weekly_summaries')
      .select('id')
      .eq('user_id', user.id)
      .eq('week_start', weekStartStr)
      .maybeSingle();

    if (existingError) {
      console.error('[weekly-summary] POST: existing-summary lookup failed:', existingError);
      return NextResponse.json({ error: `שגיאה בבדיקת סיכום קיים: ${existingError.message}` }, { status: 500 });
    }

    const createdAt = now.toISOString();

    if (existing) {
      const { error: updateError } = await supabase.from('weekly_summaries')
        .update({ week_end: weekEndStr, summary_text: summaryText, stats, created_at: createdAt })
        .eq('id', existing.id);
      if (updateError) {
        console.error('[weekly-summary] POST: update failed:', updateError);
        return NextResponse.json({ error: `שגיאה בשמירת הסיכום: ${updateError.message}` }, { status: 500 });
      }
    } else {
      const { error: insertError } = await supabase.from('weekly_summaries')
        .insert({ user_id: user.id, week_start: weekStartStr, week_end: weekEndStr, summary_text: summaryText, stats });
      if (insertError) {
        console.error('[weekly-summary] POST: insert failed:', insertError);
        return NextResponse.json({ error: `שגיאה בשמירת הסיכום: ${insertError.message}` }, { status: 500 });
      }
    }

    console.log('[weekly-summary] POST: summary saved successfully');

    return NextResponse.json({
      summary: { week_start: weekStartStr, week_end: weekEndStr, summary_text: summaryText, stats, created_at: createdAt },
    });
  } catch (err) {
    console.error('[weekly-summary] POST: unexpected error:', err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `שגיאה לא צפויה: ${detail}` }, { status: 500 });
  }
}
