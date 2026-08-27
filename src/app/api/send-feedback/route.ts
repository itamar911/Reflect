import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  EMAIL_COLORS,
  EMAIL_FONT_STACK,
  callout,
  detailRows,
  escapeHtml,
  renderEmail,
  renderPlainText,
} from '@/lib/email/template';
import type { EmailContent } from '@/lib/email/alerts';

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = 'Reflect <feedback@reflecttrading.app>';
const TO_EMAIL     = 'seince33@gmail.com';

// `icon` is still carried here because it is part of the subject line, which is
// out of scope for this pass. It is no longer rendered in the body — the type
// now reads through `color` and heading weight instead.
const TYPE_META = {
  bug:      { label: 'דיווח על באג',   icon: '🐛', color: EMAIL_COLORS.danger },
  feature:  { label: 'הצעה לשיפור',    icon: '💡', color: EMAIL_COLORS.warning },
  question: { label: 'שאלה',           icon: '❓', color: EMAIL_COLORS.primary },
} as const;

function buildEmail(
  type: keyof typeof TYPE_META,
  title: string,
  description: string,
  userName: string,
  userEmail: string,
): EmailContent {
  const { label, color } = TYPE_META[type];
  const date = new Date().toLocaleString('he-IL', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jerusalem',
  });
  const sender = `${userName} <${userEmail}>`;
  const footerText = `נשלח מ-Reflect Trading Journal · ${date}`;

  const descriptionBlock = callout(
    `<p style="margin:0 0 8px;font-family:${EMAIL_FONT_STACK};font-size:11px;color:${EMAIL_COLORS.muted};text-transform:uppercase;letter-spacing:1px;">תיאור</p>
     <p style="margin:0;font-family:${EMAIL_FONT_STACK};white-space:pre-wrap;line-height:1.7;color:${EMAIL_COLORS.text};font-size:14px;">${escapeHtml(description)}</p>`,
    color,
    EMAIL_COLORS.border,
  );

  return {
    html: renderEmail({
      title: label,
      titleColor: color,
      subtitle: 'Reflect Trading Journal — פנייה למפתח',
      footerText,
      bodyHtml:
        detailRows([
          { label: 'שולח', value: escapeHtml(sender) },
          { label: 'תאריך', value: escapeHtml(date) },
          { label: 'כותרת', value: escapeHtml(title), bold: true },
        ]) + descriptionBlock,
    }),
    text: renderPlainText({
      title: label,
      subtitle: 'Reflect Trading Journal — פנייה למפתח',
      footerText,
      lines: [
        `שולח: ${sender}`,
        `תאריך: ${date}`,
        `כותרת: ${title}`,
        '',
        'תיאור',
        description,
      ],
    }),
  };
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!RESEND_KEY) return NextResponse.json({ error: 'Email service not configured' }, { status: 500 });

  const body = await request.json() as {
    type: keyof typeof TYPE_META;
    title: string;
    description: string;
    screenshot?: string;   // base64 data URL, e.g. "data:image/png;base64,..."
    screenshotName?: string;
  };

  const { type, title, description, screenshot, screenshotName } = body;
  if (!type || !title?.trim() || !description?.trim())
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });

  const { data: profile } = await supabase
    .from('profiles').select('display_name, email').eq('id', user.id).single();

  const userName  = profile?.display_name ?? 'משתמש Reflect';
  const userEmail = profile?.email ?? user.email ?? '';

  const content = buildEmail(type, title.trim(), description.trim(), userName, userEmail);
  const subject = `${TYPE_META[type].icon} [Reflect] ${TYPE_META[type].label}: ${title.trim()}`;

  // Build Resend payload
  const payload: Record<string, unknown> = {
    from: FROM_EMAIL,
    to: TO_EMAIL,
    reply_to: userEmail,
    subject,
    html: content.html,
    text: content.text,
  };

  // Attach screenshot if provided
  if (screenshot && screenshotName) {
    const base64 = screenshot.split(',')[1];   // strip data URL prefix
    if (base64) {
      payload.attachments = [{ filename: screenshotName, content: base64 }];
    }
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return NextResponse.json({ error: (err as { message?: string }).message ?? 'Send failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
