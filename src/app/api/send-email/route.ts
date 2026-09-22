import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  EMAIL_COLORS,
  callout,
  cardRows,
  escapeHtml,
  paragraph,
  renderEmail,
  renderPlainText,
  statGrid,
} from '@/lib/email/template';
import type { EmailContent } from '@/lib/email/alerts';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect <hello@reflecttrading.app>';

async function sendEmail({ to, subject, content }: { to: string; subject: string; content: EmailContent }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject,
      html: content.html,
      text: content.text,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? 'Failed to send email');
  }
  return res.json();
}

// The templates below share the shell in `@/lib/email/template` with the cron
// alerts, but keep their own copy: this route's wording and its stat set differ
// from `@/lib/email/alerts` (no P&L tile on the daily, no motivational line, no
// unsubscribe link, R:R shown bare rather than as `1:x`). They are deliberately
// not merged — folding them together would silently rewrite what this route
// sends.
const FOOTER_TEXT = 'Reflect Trading Journal';

function buildPreMarketEmail(name: string): EmailContent {
  const title = 'תזכורת לפני פתיחת השוק';
  const questions = [
    'מה התוכנית שלי להיום?',
    'האם אני במצב רגשי מתאים למסחר?',
    'מה גבולות הסיכון שלי היום?',
  ];
  // See the note in `@/lib/email/alerts` — a prescribed risk rule is advice.
  // Wording from 36cfbe9 on main.
  const rule = 'גבולות הסיכון שלך הם אלה שהגדרת בכללים — Reflect בודק כל תוכנית מולם.';

  return {
    html: renderEmail({
      title,
      footerText: FOOTER_TEXT,
      bodyHtml:
        paragraph(`שלום ${escapeHtml(name)},`, { color: EMAIL_COLORS.muted }) +
        paragraph('לפני שמתחיל יום המסחר — 3 שאלות לבדיקה עצמית:', { bottom: 12 }) +
        cardRows(questions) +
        callout(paragraph(rule, { color: EMAIL_COLORS.textSecondary, size: 14, bottom: 0 })),
    }),
    text: renderPlainText({
      title,
      footerText: FOOTER_TEXT,
      lines: [
        `שלום ${name},`,
        '',
        'לפני שמתחיל יום המסחר — 3 שאלות לבדיקה עצמית:',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        rule,
      ],
    }),
  };
}

function buildDailySummaryEmail(
  name: string,
  stats: { trades: number; winRate: number; avgRR: number }
): EmailContent {
  const title = 'סיכום יומי';
  const cells = [
    { value: String(stats.trades), label: 'עסקאות', color: EMAIL_COLORS.text },
    {
      value: `${stats.winRate}%`,
      label: 'הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: String(stats.avgRR),
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.textSecondary,
    },
  ];

  return {
    html: renderEmail({
      title,
      footerText: FOOTER_TEXT,
      bodyHtml:
        paragraph(`שלום ${escapeHtml(name)}, הנה סיכום יום המסחר שלך:`, {
          color: EMAIL_COLORS.muted,
          bottom: 20,
        }) + statGrid(cells, 3),
    }),
    text: renderPlainText({
      title,
      footerText: FOOTER_TEXT,
      lines: [
        `שלום ${name}, הנה סיכום יום המסחר שלך:`,
        '',
        `עסקאות: ${stats.trades}`,
        `הצלחה: ${stats.winRate}%`,
        `R:R ממוצע: ${stats.avgRR}`,
      ],
    }),
  };
}

function buildWeeklySummaryEmail(
  name: string,
  stats: { trades: number; winRate: number; avgRR: number; totalPL: number }
): EmailContent {
  const plColor = stats.totalPL >= 0 ? EMAIL_COLORS.success : EMAIL_COLORS.danger;
  const plFormatted = (stats.totalPL >= 0 ? '+$' : '-$') + Math.abs(stats.totalPL).toFixed(2);
  // Reports what the week's figures show; never what to do about them. "Improve
  // your R:R — look for setups of at least 1:2" is an instruction about how to
  // trade, which section 2.2 of the terms disclaims. Wording from 36cfbe9 on
  // main; see the note on readout() in `@/lib/email/alerts`.
  const observation =
    stats.winRate < 40 ? 'אחוז ההצלחה השבוע היה מתחת ל-40%. התחקירים ביומן מפרטים מה קרה בכל עסקה.' :
    stats.avgRR < 1.5  ? 'יחס הסיכון-סיכוי הממוצע השבוע היה מתחת ל-1.5.' :
                         'הנתונים של השבוע נרשמו במלואם ביומן.';
  const title = 'סיכום שבועי — Reflect';
  const observationHeading = 'מה היומן מראה';

  const cells = [
    { value: String(stats.trades), label: 'עסקאות השבוע', color: EMAIL_COLORS.text },
    {
      value: `${stats.winRate}%`,
      label: 'אחוז הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: String(stats.avgRR),
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.textSecondary,
    },
    { value: plFormatted, label: 'P&amp;L השבוע', color: plColor },
  ];

  return {
    html: renderEmail({
      title,
      footerText: FOOTER_TEXT,
      bodyHtml:
        paragraph(`שלום ${escapeHtml(name)}, הנה מה שהיומן שלך מראה על השבוע:`, {
          color: EMAIL_COLORS.muted,
          bottom: 20,
        }) +
        statGrid(cells, 2) +
        callout(
          paragraph(observationHeading, { color: EMAIL_COLORS.textSecondary, size: 14, bold: true, bottom: 8 }) +
            paragraph(observation, { bottom: 0 })
        ),
    }),
    text: renderPlainText({
      title,
      footerText: FOOTER_TEXT,
      lines: [
        `שלום ${name}, הנה מה שהיומן שלך מראה על השבוע:`,
        '',
        `עסקאות השבוע: ${stats.trades}`,
        `אחוז הצלחה: ${stats.winRate}%`,
        `R:R ממוצע: ${stats.avgRR}`,
        `P&L השבוע: ${plFormatted}`,
        '',
        `${observationHeading}: ${observation}`,
      ],
    }),
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { type } = await request.json() as { type: 'pre_market' | 'daily_summary' | 'weekly_summary' };

  const { data: profile } = await supabase.from('profiles')
    .select('display_name, email').eq('id', user.id).single();

  const name = profile?.display_name?.split(' ')[0] ?? 'סוחר';
  const email = profile?.email ?? user.email ?? '';
  if (!email) return NextResponse.json({ error: 'No email' }, { status: 400 });

  // Get trade stats
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: trades } = await supabase.from('trade_plans')
    .select('*').eq('user_id', user.id).gte('submitted_at', sevenDaysAgo);

  const allTrades = trades ?? [];
  const closed = allTrades.filter(t => t.status === 'closed');
  const closedWithExit = closed.filter(t => t.exit_price !== null);
  const wins = closedWithExit.filter(t => Number(t.exit_price) > Number(t.entry_price));
  const winRate = closedWithExit.length > 0 ? Math.round((wins.length / closedWithExit.length) * 100) : 0;
  const avgRR = allTrades.length > 0
    ? parseFloat((allTrades.reduce((s, t) => s + Number(t.rr_ratio || 0), 0) / allTrades.length).toFixed(1))
    : 0;
  const totalPL = closedWithExit.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);

  const emailMap = {
    pre_market: {
      subject: '📈 תזכורת לפני פתיחת השוק — Reflect',
      content: buildPreMarketEmail(name),
    },
    daily_summary: {
      subject: '📊 סיכום יומי — Reflect',
      content: buildDailySummaryEmail(name, { trades: allTrades.length, winRate, avgRR }),
    },
    weekly_summary: {
      subject: '📅 סיכום שבועי — Reflect',
      content: buildWeeklySummaryEmail(name, { trades: allTrades.length, winRate, avgRR, totalPL }),
    },
  };

  const { subject, content } = emailMap[type];

  try {
    await sendEmail({ to: email, subject, content });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
