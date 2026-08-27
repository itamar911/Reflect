/**
 * Shared shell for every outgoing Reflect email.
 *
 * Three hard constraints drive the shape of everything below, and none of them
 * are style preferences:
 *
 * 1. **Tables only.** Outlook on Windows renders through the Word engine, which
 *    ignores `display:flex` and `display:grid` outright — a flex/grid layout
 *    collapses to a vertical stack of unstyled blocks there. Every column,
 *    gutter and card in this file is a `<table>`, and every gap is cell
 *    padding: the Word engine drops `margin` on table cells too.
 * 2. **CSS inline on the element.** Gmail strips `<head><style>` on forwarded
 *    mail and in several mobile clients, so a `<style>` block can never be the
 *    only carrier of a rule.
 * 3. **System fonts.** `next/font/google` injects a `@font-face` that no mail
 *    client will fetch. Rubik/Poppins/Montserrat are unavailable by definition;
 *    the stack has to stand on fonts already installed on the reader's machine.
 *
 * The `font-size:…px` values are correct as px and must stay that way. This
 * HTML is rendered by mail clients, not by the app in a browser; rem is
 * unreliable across them and there is no root font-size to resolve against.
 * The app's own rem/accessibility rules do not apply here.
 */

/**
 * The app's design tokens, flattened to literal hex.
 *
 * CSS custom properties do not resolve in any mail client, so the values are
 * copied rather than referenced. Each entry names the token it came from.
 *
 * **These are the `html.light` values, not the dark ones.** The app ships dark
 * by default; email does not. A dark email arrives inside Gmail's white chrome
 * and reads as a heavy foreign block, so the mail surface is light even though
 * the product is not. `globals.css` already defines a full, contrast-audited
 * light palette (`html.light`, :57-91) — email borrows that rather than
 * inventing a second one.
 */
export const EMAIL_COLORS = {
  /** html.light --color-tg-surface — the page behind the card */
  pageBg: '#f4f6f8',
  /** html.light --color-tg-bg — the card, and the stat tiles on it */
  cardBg: '#ffffff',
  /**
   * html.light --color-tg-surface — callouts and checklist rows.
   *
   * Deliberately NOT used behind the stat numbers. Tinting that surface costs
   * ~0.25 of a contrast ratio, which drops `success` from 3.00:1 to 2.77:1 and
   * pushes it under the 3:1 large-text floor. Panels carry `text` (16.5:1 even
   * tinted), so the tint is free there and expensive on tiles.
   */
  panelBg: '#f4f6f8',
  /** html.light --color-tg-border */
  border: '#d1d8e0',
  /** html.light --color-tg-border-light — section rules */
  borderLight: '#dde3ea',
  /** html.light --color-tg-text — 17.9:1 on white */
  text: '#131722',
  /** html.light --color-tg-text-2 — 9.8:1 on white */
  textSecondary: '#3e4451',
  /** html.light --color-tg-muted — 6.1:1 on white */
  muted: '#5c6370',
  /**
   * --color-tg-primary (@theme — html.light does not override it).
   *
   * Accent only: rules, the callout bar, the CTA fill, the wordmark. It is
   * 1.9:1 on white, so it is never used for body copy or headings. On the CTA
   * it is a *background* with `text` on top, which measures 9.5:1.
   */
  primary: '#00d2d2',
  /** primary at 20% over white — the callout hairline */
  primarySoft: '#ccf6f6',
  /** html.light --color-tg-success — 3.00:1 on white; large text only, no margin */
  success: '#26a69a',
  /** html.light --color-tg-danger — 3.5:1 on white, large text only */
  danger: '#ef5350',
  /**
   * --color-tg-warning (@theme).
   *
   * NOTE: html.light does not override this one, and #f59e0b measures 2.15:1
   * on white — below the 3:1 floor even for large text. It is the one value in
   * this palette that does not pass on a light surface, so `alerts.ts` no
   * longer uses it: a sub-threshold R:R now reads in `textSecondary` rather
   * than amber. Kept here because `api/send-email` still references it.
   * Fixing it properly means adding a light-mode warning token to globals.css,
   * which is a change to the app's design system rather than to email.
   */
  warning: '#f59e0b',
} as const;

/** No webfont survives the trip — this stack has to be locally installed. */
export const EMAIL_FONT_STACK = "'Segoe UI', Tahoma, Arial, sans-serif";

export interface EmailCta {
  label: string;
  url: string;
}

export interface EmailLink {
  label: string;
  url: string;
}

export interface EmailShellOptions {
  /** Main heading, and the document `<title>`. */
  title: string;
  /** Heading colour. Defaults to primary text — override to signal a category. */
  titleColor?: string;
  /** Optional line under the heading — a date, a section label. */
  subtitle?: string;
  /** Pre-rendered body HTML, normally assembled from the helpers below. */
  bodyHtml: string;
  /** Optional action button, rendered above the footer. */
  cta?: EmailCta;
  /** Footer line, e.g. "Reflect Trading Journal". */
  footerText: string;
  /** Optional trailing link on the footer line. */
  footerLink?: EmailLink;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The wordmark, as text.
 *
 * `Logo.tsx` builds the R/mirrored-R mark with `background-clip:text` over a
 * gradient — a technique with no mail-client support and no raster fallback in
 * the repo (`public/` has icon.svg and nothing else). So the mark is dropped
 * and the wordmark carries the brand alone, at the letter-spacing Logo.tsx
 * uses (5px) and the weight Montserrat renders it at (600).
 *
 * Turquoise here is deliberate and is the one place it appears as text: WCAG
 * 1.4.3 exempts logotypes from contrast minimums, which is the same reasoning
 * Logo.tsx already documents for its own pinned sizing.
 *
 * `dir="ltr"` because the shell is RTL and REFLECT is latin.
 */
function wordmark(): string {
  return `<span dir="ltr" style="font-family:${EMAIL_FONT_STACK};font-size:17px;font-weight:600;letter-spacing:5px;color:${EMAIL_COLORS.primary};white-space:nowrap;">REFLECT</span>`;
}

/** A paragraph. `html` is inserted as-is — escape at the call site. */
export function paragraph(
  html: string,
  opts: { color?: string; size?: number; bold?: boolean; top?: number; bottom?: number } = {}
): string {
  const { color = EMAIL_COLORS.textSecondary, size = 15, bold = false, top = 0, bottom = 0 } = opts;
  return `<p style="margin:${top}px 0 ${bottom}px;font-family:${EMAIL_FONT_STACK};font-size:${size}px;font-weight:${bold ? 700 : 400};line-height:1.7;color:${color};">${html}</p>`;
}

/** A hairline rule between sections. */
export function divider(space = 24): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:${space}px 0 0;"><div style="height:1px;line-height:1px;font-size:0;background-color:${EMAIL_COLORS.borderLight};">&nbsp;</div></td></tr></table>`;
}

/** Vertical space between blocks. Padding, not margin — Outlook drops margin. */
export function spacer(height: number): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:${height}px;line-height:${height}px;font-size:0;">&nbsp;</td></tr></table>`;
}

export interface StatCell {
  value: string;
  label: string;
  /** Defaults to primary text. */
  color?: string;
}

function tile(cell: StatCell, valueSize: number, padding: string): string {
  const color = cell.color ?? EMAIL_COLORS.text;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.cardBg};border:1px solid ${EMAIL_COLORS.border};border-radius:12px;">
        <tr><td align="center" style="padding:${padding};font-family:${EMAIL_FONT_STACK};">
          <div style="font-size:${valueSize}px;font-weight:700;line-height:1.15;color:${color};">${cell.value}</div>
          <div style="font-size:12px;font-weight:600;line-height:1.4;color:${EMAIL_COLORS.muted};padding-top:7px;">${cell.label}</div>
        </td></tr>
      </table>`;
}

/**
 * The headline metric, full width and a size up from the rest.
 *
 * P&L is the number the reader opened the mail for, so it gets its own row
 * rather than competing with three siblings at equal weight.
 */
export function heroStat(cell: StatCell): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>${tile(cell, 36, '22px 16px')}</td></tr></table>`;
}

/**
 * Secondary metrics, side by side in one row of table cells.
 *
 * `columns` splits the cells into rows; a short trailing row is padded with
 * empty cells so the widths hold. The 4px side padding is the gutter.
 */
export function statGrid(cells: StatCell[], columns: 2 | 3 | 4): string {
  const width = (100 / columns).toFixed(4);
  const rows: string[] = [];

  for (let i = 0; i < cells.length; i += columns) {
    const slice = cells.slice(i, i + columns);
    const tds = slice.map(
      (cell, index) =>
        `<td width="${width}%" valign="top" style="padding:${i === 0 ? 0 : 8}px ${index === 0 ? 0 : 4}px 0 ${index === slice.length - 1 ? 0 : 4}px;">${tile(cell, 22, '16px 8px')}</td>`
    );

    while (tds.length < columns) tds.push(`<td width="${width}%">&nbsp;</td>`);
    rows.push(`<tr>${tds.join('')}</tr>`);
  }

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">${rows.join('')}</table>`;
}

/**
 * The accented note block. `border-right` is the leading edge under dir="rtl".
 */
export function callout(
  innerHtml: string,
  accent: string = EMAIL_COLORS.primary,
  hairline: string = EMAIL_COLORS.primarySoft
): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.panelBg};border:1px solid ${hairline};border-right:3px solid ${accent};border-radius:12px;">
      <tr><td style="padding:18px 20px;font-family:${EMAIL_FONT_STACK};">${innerHtml}</td></tr>
    </table>`;
}

/** A stack of full-width cards — one per string, in order. */
export function cardRows(items: string[]): string {
  const rows = items
    .map(
      (item, index) => `<tr><td style="padding:${index === 0 ? 0 : 10}px 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.panelBg};border:1px solid ${EMAIL_COLORS.border};border-radius:10px;">
            <tr><td style="padding:16px 18px;font-family:${EMAIL_FONT_STACK};font-size:15px;line-height:1.6;color:${EMAIL_COLORS.text};">${item}</td></tr>
          </table>
        </td></tr>`
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

/** A label/value table — two columns, no card chrome. */
export function detailRows(rows: Array<{ label: string; value: string; valueColor?: string; bold?: boolean }>): string {
  const body = rows
    .map(
      (row) => `<tr>
          <td valign="top" width="90" style="padding:7px 0;font-family:${EMAIL_FONT_STACK};font-size:13px;line-height:1.6;color:${EMAIL_COLORS.muted};">${row.label}</td>
          <td valign="top" style="padding:7px 0;font-family:${EMAIL_FONT_STACK};font-size:${row.bold ? 15 : 14}px;font-weight:${row.bold ? 700 : 400};line-height:1.6;color:${row.valueColor ?? EMAIL_COLORS.text};">${row.value}</td>
        </tr>`
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${body}</table>`;
}

function ctaButton(cta: EmailCta): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
      <tr><td align="center" bgcolor="${EMAIL_COLORS.primary}" style="border-radius:10px;">
        <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:14px 32px;font-family:${EMAIL_FONT_STACK};font-size:15px;font-weight:700;line-height:1;color:${EMAIL_COLORS.text};text-decoration:none;border-radius:10px;">${escapeHtml(cta.label)}</a>
      </td></tr>
    </table>`;
}

/** Wraps body HTML in the branded shell and returns a complete document. */
export function renderEmail(options: EmailShellOptions): string {
  const { title, titleColor = EMAIL_COLORS.text, subtitle, bodyHtml, cta, footerText, footerLink } = options;

  const subtitleHtml = subtitle
    ? `<p style="margin:10px 0 0;font-family:${EMAIL_FONT_STACK};font-size:14px;line-height:1.6;color:${EMAIL_COLORS.muted};">${escapeHtml(subtitle)}</p>`
    : '';

  const ctaHtml = cta ? `<tr><td style="padding:28px 32px 0;">${ctaButton(cta)}</td></tr>` : '';

  const footerLinkHtml = footerLink
    ? ` &bull; <a href="${escapeHtml(footerLink.url)}" style="color:${EMAIL_COLORS.muted};text-decoration:underline;">${escapeHtml(footerLink.label)}</a>`
    : '';

  return `<!DOCTYPE html>
<html dir="rtl" lang="he" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${EMAIL_COLORS.pageBg};color:${EMAIL_COLORS.text};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.pageBg};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${EMAIL_COLORS.cardBg};border:1px solid ${EMAIL_COLORS.border};border-radius:16px;">

        <tr>
          <td style="padding:32px 32px 0;">
            <div style="padding:0 0 18px;">${wordmark()}</div>
            <div style="height:2px;line-height:2px;font-size:0;width:44px;background-color:${EMAIL_COLORS.primary};">&nbsp;</div>
            <h1 style="margin:18px 0 0;font-family:${EMAIL_FONT_STACK};font-size:28px;font-weight:700;line-height:1.3;color:${titleColor};">${escapeHtml(title)}</h1>
            ${subtitleHtml}
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px;">${divider(26)}</td>
        </tr>

        <tr>
          <td style="padding:26px 32px 0;">${bodyHtml}</td>
        </tr>
${ctaHtml}
        <tr>
          <td style="padding:0 32px;">${divider(30)}</td>
        </tr>

        <tr>
          <td align="center" style="padding:18px 32px 32px;font-family:${EMAIL_FONT_STACK};font-size:12px;line-height:1.7;color:${EMAIL_COLORS.muted};">
            ${escapeHtml(footerText)}${footerLinkHtml}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export interface PlainTextOptions {
  title: string;
  subtitle?: string;
  /** Body lines. An empty string emits a blank line. */
  lines: string[];
  cta?: EmailCta;
  footerText: string;
  footerLink?: EmailLink;
}

/**
 * The `text` half of every send.
 *
 * Resend takes `html` and `text` together and lets the client pick; without
 * `text`, a plain-text reader gets an empty message and spam filters score the
 * send worse. Callers build this from the same data as the HTML so the two
 * never drift.
 */
export function renderPlainText(options: PlainTextOptions): string {
  const { title, subtitle, lines, cta, footerText, footerLink } = options;

  const out: string[] = ['REFLECT', '', title];
  if (subtitle) out.push(subtitle);
  out.push('', ...lines);
  if (cta) out.push('', `${cta.label}: ${cta.url}`);
  out.push('', '—', footerText);
  if (footerLink) out.push(`${footerLink.label}: ${footerLink.url}`);

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
