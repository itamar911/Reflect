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
  const tip = 'תזכורת: לעולם לא להסתכן ביותר מ-1-2% מההון בעסקה אחת';

  return {
    html: renderEmail({
      title,
      footerText: FOOTER_TEXT,
      bodyHtml:
        paragraph(`שלום ${escapeHtml(name)},`, { color: EMAIL_COLORS.muted }) +
        paragraph('לפני שמתחיל יום המסחר — 3 שאלות לבדיקה עצמית:', { bottom: 12 }) +
        cardRows(questions) +
        callout(paragraph(tip, { color: EMAIL_COLORS.primary, size: 14, bottom: 0 })),
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
        tip,
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
    { value: String(stats.trades), label: 'עסקאות', color: EMAIL_COLORS.primary },
    {
      value: `${stats.winRate}%`,
      label: 'הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: String(stats.avgRR),
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.warning,
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
  const tip =
    stats.winRate < 40 ? 'אחוז הצלחה נמוך — בדוק את תנאי הכניסה שלך ואת ה-R:R' :
    stats.avgRR < 1.5  ? 'שפר את יחס ה-R:R — חפש סטאפים עם לפחות 1:2' :
                         'כל הכבוד — המשך לפי התוכנית!';
  const title = 'סיכום שבועי — Reflect';
  const tipHeading = 'טיפ לשבוע הבא';

  const cells = [
    { value: String(stats.trades), label: 'עסקאות השבוע', color: EMAIL_COLORS.primary },
    {
      value: `${stats.winRate}%`,
      label: 'אחוז הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: String(stats.avgRR),
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.warning,
    },
    { value: plFormatted, label: 'P&amp;L השבוע', color: plColor },
  ];

  return {
    html: renderEmail({
      title,
      footerText: FOOTER_TEXT,
      bodyHtml:
        paragraph(`שלום ${escapeHtml(name)}, הנה השפעת Reflect על הארנק שלך השבוע:`, {
          color: EMAIL_COLORS.muted,
          bottom: 20,
        }) +
        statGrid(cells, 2) +
        callout(
          paragraph(tipHeading, { color: EMAIL_COLORS.primary, size: 14, bold: true, bottom: 8 }) +
            paragraph(tip, { bottom: 0 })
        ),
    }),
    text: renderPlainText({
      title,
      footerText: FOOTER_TEXT,
      lines: [
        `שלום ${name}, הנה השפעת Reflect על הארנק שלך השבוע:`,
        '',
        `עסקאות השבוע: ${stats.trades}`,
        `אחוז הצלחה: ${stats.winRate}%`,
        `R:R ממוצע: ${stats.avgRR}`,
        `P&L השבוע: ${plFormatted}`,
        '',
        `${tipHeading}: ${tip}`,
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
