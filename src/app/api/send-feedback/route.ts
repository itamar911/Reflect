import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = 'Reflect App <onboarding@resend.dev>';
const TO_EMAIL     = 'seince33@gmail.com';

const TYPE_META = {
  bug:      { label: 'דיווח על באג',   icon: '🐛', color: '#f87171' },
  feature:  { label: 'הצעה לשיפור',    icon: '💡', color: '#D4AF37' },
  question: { label: 'שאלה',           icon: '❓', color: '#60A5FA' },
} as const;

function buildHtml(
  type: keyof typeof TYPE_META,
  title: string,
  description: string,
  userName: string,
  userEmail: string,
) {
  const { label, icon, color } = TYPE_META[type];
  const date = new Date().toLocaleString('he-IL', {
    dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jerusalem',
  });
  const descEscaped = description.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<body style="font-family:Arial,sans-serif;background:#0a0a1a;color:#eee;padding:24px;max-width:640px;margin:0 auto">
  <div style="background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px">

    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
      <span style="font-size:28px">${icon}</span>
      <div>
        <h1 style="margin:0;font-size:18px;color:${color}">${label}</h1>
        <p style="margin:4px 0 0;font-size:12px;color:#6b7280">Reflect Trading Journal — פנייה למפתח</p>
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr><td style="color:#9ca3af;padding:5px 0;width:90px;font-size:13px">שולח</td>
          <td style="color:#e5e7eb;font-size:13px">${userName} &lt;${userEmail}&gt;</td></tr>
      <tr><td style="color:#9ca3af;padding:5px 0;font-size:13px">תאריך</td>
          <td style="color:#e5e7eb;font-size:13px">${date}</td></tr>
      <tr><td style="color:#9ca3af;padding:5px 0;font-size:13px">כותרת</td>
          <td style="color:#fff;font-size:14px;font-weight:bold">${title}</td></tr>
    </table>

    <div style="background:#1f2937;border-radius:12px;padding:16px;border-right:3px solid ${color}">
      <p style="margin:0 0 8px;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px">תיאור</p>
      <p style="margin:0;white-space:pre-wrap;line-height:1.7;color:#d1d5db;font-size:14px">${descEscaped}</p>
    </div>

    <p style="margin-top:20px;font-size:11px;color:#374151;text-align:center">
      נשלח מ-Reflect Trading Journal · ${date}
    </p>
  </div>
</body>
</html>`;
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

  const html    = buildHtml(type, title.trim(), description.trim(), userName, userEmail);
  const subject = `${TYPE_META[type].icon} [Reflect] ${TYPE_META[type].label}: ${title.trim()}`;

  // Build Resend payload
  const payload: Record<string, unknown> = { from: FROM_EMAIL, to: TO_EMAIL, subject, html };

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
