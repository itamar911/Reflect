/**
 * The three scheduled alert emails, built on the shared shell in `template.ts`.
 *
 * Pure functions — no Supabase, no request context — so `cron/send-alerts`
 * stays a thin dispatcher and the templates can be rendered standalone for
 * preview without booting the app.
 *
 * **Tone.** Reflect is a discipline tool, not a coach. Copy states what the
 * numbers are and what deserves attention, then stops. No encouragement, no
 * consolation, no exclamation marks, no telling the reader what they feel. A
 * trader who lost money gets the figures and the thing worth looking at.
 *
 * Each builder owns its subject line, because the summaries put live figures in
 * it — every daily send used to arrive as "סיכום יומי — Reflect", which Gmail
 * collapses into one thread.
 */
import {
  EMAIL_COLORS,
  callout,
  cardRows,
  divider,
  escapeHtml,
  heroStat,
  paragraph,
  renderEmail,
  renderPlainText,
  spacer,
  statGrid,
  type EmailLink,
} from './template';

export interface EmailContent {
  html: string;
  text: string;
}

export interface AlertEmail extends EmailContent {
  subject: string;
}

export interface AlertStats {
  trades: number;
  winRate: number;
  avgRR: number;
  totalPL: number;
}

const FOOTER_TEXT = 'Reflect Trading Journal';

/**
 * Points at the settings page that hosts AlertsPanel. Behind auth, and there is
 * no List-Unsubscribe header alongside it — both are open items, not oversights
 * of this pass.
 */
const UNSUBSCRIBE: EmailLink = {
  label: 'ביטול הרשמה',
  url: 'https://reflecttrading.app/settings',
};

/**
 * The daily read on the numbers.
 *
 * The seven conditions are unchanged from the original — only the returned copy
 * moved from encouragement to statement of fact.
 */
function readout(trades: number, winRate: number, totalPL: number): string {
  if (trades === 0)
    return 'לא נפתחו עסקאות היום.';
  if (totalPL > 0 && winRate >= 60)
    return 'יום חיובי. אחוז ההצלחה גבוה והתוצאה תואמת לו.';
  if (totalPL > 0 && winRate >= 50)
    return 'יום חיובי. אחוז ההצלחה מעל מחצית העסקאות.';
  if (totalPL > 0)
    return 'יום חיובי למרות אחוז הצלחה מתחת ל-50%. התוצאה נשענת על יחס ה-R:R.';
  if (totalPL < 0 && winRate >= 50)
    return 'הפסד למרות אחוז הצלחה מעל 50%. ההפסדים גדולים מהרווחים — יחס ה-R:R דורש בדיקה.';
  if (totalPL < 0 && trades <= 2)
    return 'הפסד ב-' + trades + ' עסקאות. מדגם קטן מכדי להסיק ממנו דפוס.';
  if (totalPL < 0)
    return 'יום הפסד. בדוק כמה מהעסקאות עמדו בחוקים שהגדרת.';
  return 'המאזן היומי אפס.';
}

function formatPL(totalPL: number): string {
  return (totalPL >= 0 ? '+$' : '-$') + Math.abs(totalPL).toFixed(2);
}

function plColorFor(totalPL: number): string {
  return totalPL >= 0 ? EMAIL_COLORS.success : EMAIL_COLORS.danger;
}

export function dailySummaryEmail(
  name: string,
  stats: AlertStats,
  dateLabel: string
): AlertEmail {
  const plFormatted = formatPL(stats.totalPL);
  const note = readout(stats.trades, stats.winRate, stats.totalPL);
  const title = 'סיכום יומי';

  const secondary = [
    { value: String(stats.trades), label: 'עסקאות', color: EMAIL_COLORS.text },
    {
      value: `${stats.winRate}%`,
      label: 'אחוז הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: `1:${stats.avgRR}`,
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.textSecondary,
    },
  ];

  const html = renderEmail({
    title,
    subtitle: dateLabel,
    footerText: FOOTER_TEXT,
    footerLink: UNSUBSCRIBE,
    bodyHtml:
      paragraph(`${escapeHtml(name)}, המספרים של היום.`) +
      spacer(22) +
      heroStat({ value: plFormatted, label: 'P&amp;L היום', color: plColorFor(stats.totalPL) }) +
      statGrid(secondary, 3) +
      divider(26) +
      spacer(26) +
      callout(paragraph(escapeHtml(note), { color: EMAIL_COLORS.text })),
  });

  const text = renderPlainText({
    title,
    subtitle: dateLabel,
    footerText: FOOTER_TEXT,
    footerLink: UNSUBSCRIBE,
    lines: [
      `${name}, המספרים של היום.`,
      '',
      `P&L היום: ${plFormatted}`,
      `עסקאות: ${stats.trades}`,
      `אחוז הצלחה: ${stats.winRate}%`,
      `R:R ממוצע: 1:${stats.avgRR}`,
      '',
      note,
    ],
  });

  return {
    subject: `סיכום ${dateLabel} — ${stats.trades} עסקאות, ${plFormatted}`,
    html,
    text,
  };
}

export function preMarketEmail(name: string): AlertEmail {
  const title = 'לפני פתיחת השוק';
  const checks = [
    'הגדר את התוכנית להיום.',
    'בדוק את המצב הרגשי שלך לפני הכניסה הראשונה.',
    'קבע את גבולות הסיכון להיום.',
  ];
  const rule = 'סיכון מרבי לעסקה: 1–2% מההון.';

  const html = renderEmail({
    title,
    footerText: FOOTER_TEXT,
    bodyHtml:
      paragraph(`${escapeHtml(name)}, שלוש בדיקות לפני הכניסה הראשונה.`) +
      spacer(22) +
      cardRows(checks) +
      divider(26) +
      spacer(26) +
      callout(paragraph(rule, { color: EMAIL_COLORS.text })),
  });

  const text = renderPlainText({
    title,
    footerText: FOOTER_TEXT,
    lines: [
      `${name}, שלוש בדיקות לפני הכניסה הראשונה.`,
      '',
      ...checks.map((c, i) => `${i + 1}. ${c}`),
      '',
      rule,
    ],
  });

  return { subject: 'לפני פתיחת השוק — שלוש בדיקות', html, text };
}

export function weeklySummaryEmail(name: string, stats: AlertStats): AlertEmail {
  const plFormatted = formatPL(stats.totalPL);
  const note =
    stats.winRate < 40 ? 'אחוז הצלחה מתחת ל-40%. תנאי הכניסה הם החוליה לבדיקה.' :
    stats.avgRR < 1.5  ? 'יחס R:R ממוצע מתחת ל-1.5. הרווח הממוצע קטן מדי ביחס לסיכון.' :
                         'המספרים תואמים לתוכנית. אין חריגה שדורשת התייחסות.';
  const title = 'סיכום שבועי';
  const noteHeading = 'מה דורש תשומת לב';

  const secondary = [
    { value: String(stats.trades), label: 'עסקאות השבוע', color: EMAIL_COLORS.text },
    {
      value: `${stats.winRate}%`,
      label: 'אחוז הצלחה',
      color: stats.winRate >= 50 ? EMAIL_COLORS.success : EMAIL_COLORS.danger,
    },
    {
      value: `1:${stats.avgRR}`,
      label: 'R:R ממוצע',
      color: stats.avgRR >= 2 ? EMAIL_COLORS.success : EMAIL_COLORS.textSecondary,
    },
  ];

  const html = renderEmail({
    title,
    footerText: FOOTER_TEXT,
    bodyHtml:
      paragraph(`${escapeHtml(name)}, שבעת הימים האחרונים במספרים.`) +
      spacer(22) +
      heroStat({ value: plFormatted, label: 'P&amp;L השבוע', color: plColorFor(stats.totalPL) }) +
      statGrid(secondary, 3) +
      divider(26) +
      spacer(26) +
      callout(
        paragraph(noteHeading, { color: EMAIL_COLORS.muted, size: 12, bold: true, bottom: 8 }) +
          paragraph(note, { color: EMAIL_COLORS.text })
      ),
  });

  const text = renderPlainText({
    title,
    footerText: FOOTER_TEXT,
    lines: [
      `${name}, שבעת הימים האחרונים במספרים.`,
      '',
      `P&L השבוע: ${plFormatted}`,
      `עסקאות השבוע: ${stats.trades}`,
      `אחוז הצלחה: ${stats.winRate}%`,
      `R:R ממוצע: 1:${stats.avgRR}`,
      '',
      `${noteHeading}: ${note}`,
    ],
  });

  return {
    subject: `סיכום שבועי — ${stats.trades} עסקאות, ${plFormatted}`,
    html,
    text,
  };
}
