/**
 * The security-assertions report email.
 *
 * One mail per run, listing every finding. Never one mail per finding: a run
 * that reports twenty objects should arrive as one thing to read, not twenty
 * notifications to dismiss.
 *
 * Nothing is sent on a clean run. Mail that arrives every day stops being read
 * on about the fourth day, and a security report nobody opens is worse than no
 * security report, because it is also a reason not to build a better one.
 *
 *
 * WHAT GOES IN THE BODY
 * ---------------------
 *
 * Object names and rule names. Never a policy expression, never a privilege
 * list, never a bucket column beyond the name. The mail is a map of where the
 * weaknesses are; with the expressions and grants filled in it would be a
 * working guide to exploiting them, sitting in an inbox and in whatever
 * archives that inbox syncs to.
 *
 * Object identifiers are Latin inside Hebrew prose, so each one is wrapped in a
 * dir="ltr" span — left to the bidi algorithm, `public.trade_plans` next to a
 * Hebrew clause renders in an order that is not the order it should be read in.
 */

import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  callout,
  escapeHtml,
  paragraph,
  renderEmail,
  renderPlainText,
  spacer,
} from './template';
import type { AlertEmail } from './alerts';

export interface SecurityReportGroup {
  rule: string;
  label: string;
  objects: string[];
}

export interface SecurityReportInput {
  groups: SecurityReportGroup[];
  /** Check groups that could not be evaluated, with the reason. */
  unavailable: Array<{ group: string; reason: string }>;
  /** When the run happened, already formatted for display. */
  ranAt: string;
}

/** An identifier inside Hebrew prose, pinned to LTR so it reads in order. */
function ltr(value: string): string {
  return `<span dir="ltr" style="unicode-bidi:isolate;font-family:Consolas,Menlo,monospace;">${escapeHtml(
    value
  )}</span>`;
}

function ruleBlock(group: SecurityReportGroup): string {
  const objects = group.objects
    .map(
      (object) =>
        `<li style="margin:0 0 4px;font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:1.6;color:${EMAIL_COLORS.text};">${ltr(
          object
        )}</li>`
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.panelBg};border:1px solid ${EMAIL_COLORS.border};border-radius:10px;">
      <tr><td style="padding:16px 18px;font-family:${EMAIL_FONT_STACK};">
        <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:${EMAIL_COLORS.text};">${escapeHtml(
          group.label
        )}</p>
        <p style="margin:0 0 10px;font-size:12px;color:${EMAIL_COLORS.muted};">${ltr(group.rule)}</p>
        <ul style="margin:0;padding-right:18px;padding-left:0;">${objects}</ul>
      </td></tr>
    </table>`;
}

export function securityAssertionsEmail(input: SecurityReportInput): AlertEmail {
  const { groups, unavailable, ranAt } = input;

  const totalObjects = groups.reduce((sum, g) => sum + g.objects.length, 0);

  const subject =
    unavailable.length > 0 && groups.length === 0
      ? 'בדיקות האבטחה לא הצליחו לרוץ'
      : `בדיקות אבטחה: ${groups.length} כללים, ${totalObjects} אובייקטים`;

  // The unavailable notice goes FIRST, above the findings. A reader who skims
  // the findings and stops has to have already passed the line saying that part
  // of the sweep did not run — otherwise the mail reads as a complete picture
  // when it is a partial one.
  const unavailableHtml =
    unavailable.length > 0
      ? callout(
          `<p style="margin:0 0 6px;font-family:${EMAIL_FONT_STACK};font-size:15px;font-weight:700;color:${EMAIL_COLORS.text};">חלק מהבדיקות לא רצו</p>` +
            unavailable
              .map(
                (u) =>
                  `<p style="margin:0 0 4px;font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:1.6;color:${EMAIL_COLORS.textSecondary};">${ltr(
                    u.group
                  )} — ${escapeHtml(u.reason)}</p>`
              )
              .join('') +
            `<p style="margin:8px 0 0;font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:1.6;color:${EMAIL_COLORS.muted};">רשימת הממצאים למטה חלקית. בדיקה שלא רצה אינה בדיקה שעברה.</p>`,
          EMAIL_COLORS.warning
        ) + spacer(20)
      : '';

  const findingsHtml =
    groups.length > 0
      ? groups
          .map((g) => `<table role="presentation" width="100%"><tr><td style="padding:0 0 10px;">${ruleBlock(g)}</td></tr></table>`)
          .join('')
      : paragraph('לא נמצאו ממצאים בבדיקות שרצו.');

  const bodyHtml =
    unavailableHtml +
    paragraph(
      'הדוח מפרט את שם האובייקט ואת הכלל שהופר בלבד. הגדרות המדיניות, רשימות ההרשאות וערכי ההגדרה אינם נכללים בכוונה — ' +
        'כדי לראות אותם יש להריץ את supabase/queries/security_assertions.sql ישירות.'
    ) +
    spacer(20) +
    findingsHtml;

  const textLines: string[] = [];

  if (unavailable.length > 0) {
    textLines.push('-- חלק מהבדיקות לא רצו --');
    for (const u of unavailable) textLines.push(`${u.group} — ${u.reason}`);
    textLines.push('רשימת הממצאים חלקית. בדיקה שלא רצה אינה בדיקה שעברה.', '');
  }

  if (groups.length === 0) {
    textLines.push('לא נמצאו ממצאים בבדיקות שרצו.');
  } else {
    for (const g of groups) {
      textLines.push(`${g.label} (${g.rule})`);
      for (const object of g.objects) textLines.push(`  - ${object}`);
      textLines.push('');
    }
  }

  return {
    subject,
    html: renderEmail({
      title: 'בדיקות אבטחה של מסד הנתונים',
      titleColor: EMAIL_COLORS.warning,
      subtitle: ranAt,
      bodyHtml,
      footerText: 'Reflect — בדיקה אוטומטית יומית',
    }),
    text: renderPlainText({
      title: 'בדיקות אבטחה של מסד הנתונים',
      subtitle: ranAt,
      lines: textLines,
      footerText: 'Reflect — בדיקה אוטומטית יומית',
    }),
  };
}
