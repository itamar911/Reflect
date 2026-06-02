import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect Trading <onboarding@resend.dev>';

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail({ to, subject, html }: EmailPayload) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? 'Failed to send email');
  }
  return res.json();
}

function buildPreMarketEmail(name: string) {
  return `
<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:sans-serif;background:#0a0a1a;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#111;border:1px solid #222;border-radius:16px;padding:24px">
  <h2 style="color:#F5C518;margin:0 0 16px">📈 תזכורת לפני פתיחת השוק</h2>
  <p style="color:#888;margin:0 0 16px">שלום ${name},</p>
  <p>לפני שמתחיל יום המסחר — 3 שאלות לבדיקה עצמית:</p>
  <ol style="color:#ccc;line-height:2">
    <li>מה התוכנית שלי להיום?</li>
    <li>האם אני במצב רגשי מתאים למסחר?</li>
    <li>מה גבולות הסיכון שלי היום?</li>
  </ol>
  <div style="background:#1a1a1a;border-radius:12px;padding:16px;margin-top:16px">
    <p style="color:#F5C518;margin:0;font-size:14px">💡 תזכורת: לעולם לא להסתכן ביותר מ-1-2% מההון בעסקה אחת</p>
  </div>
  <p style="margin-top:16px;font-size:12px;color:#555">Reflect Trading Journal</p>
</div></body></html>`;
}

function buildDailySummaryEmail(name: string, stats: { trades: number; winRate: number; avgRR: number }) {
  return `
<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:sans-serif;background:#0a0a1a;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#111;border:1px solid #222;border-radius:16px;padding:24px">
  <h2 style="color:#F5C518;margin:0 0 16px">📊 סיכום יומי</h2>
  <p style="color:#888;margin:0 0 16px">שלום ${name}, הנה סיכום יום המסחר שלך:</p>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#1a1a1a;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:bold;color:#F5C518">${stats.trades}</div>
      <div style="font-size:12px;color:#888">עסקאות</div>
    </div>
    <div style="background:#1a1a1a;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:bold;color:${stats.winRate >= 50 ? '#00C853' : '#FF3B30'}">${stats.winRate}%</div>
      <div style="font-size:12px;color:#888">הצלחה</div>
    </div>
    <div style="background:#1a1a1a;border-radius:12px;padding:12px;text-align:center">
      <div style="font-size:24px;font-weight:bold;color:${stats.avgRR >= 2 ? '#00C853' : '#F59E0B'}">${stats.avgRR}</div>
      <div style="font-size:12px;color:#888">R:R ממוצע</div>
    </div>
  </div>
  <p style="font-size:12px;color:#555">Reflect Trading Journal</p>
</div></body></html>`;
}

function buildWeeklySummaryEmail(name: string, stats: { trades: number; winRate: number; avgRR: number; totalPL: number }) {
  const plColor = stats.totalPL >= 0 ? '#00C853' : '#FF3B30';
  const plFormatted = (stats.totalPL >= 0 ? '+$' : '-$') + Math.abs(stats.totalPL).toFixed(2);
  return `
<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:sans-serif;background:#0a0a1a;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#111;border:1px solid #222;border-radius:16px;padding:24px">
  <h2 style="color:#F5C518;margin:0 0 16px">📅 סיכום שבועי — Reflect</h2>
  <p style="color:#888;margin:0 0 16px">שלום ${name}, הנה השפעת Reflect על הארנק שלך השבוע:</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
    <div style="background:#1a1a1a;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:28px;font-weight:bold;color:#F5C518">${stats.trades}</div>
      <div style="font-size:12px;color:#888">עסקאות השבוע</div>
    </div>
    <div style="background:#1a1a1a;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${stats.winRate >= 50 ? '#00C853' : '#FF3B30'}">${stats.winRate}%</div>
      <div style="font-size:12px;color:#888">אחוז הצלחה</div>
    </div>
    <div style="background:#1a1a1a;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${stats.avgRR >= 2 ? '#00C853' : '#F59E0B'}">${stats.avgRR}</div>
      <div style="font-size:12px;color:#888">R:R ממוצע</div>
    </div>
    <div style="background:#1a1a1a;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:28px;font-weight:bold;color:${plColor}">${plFormatted}</div>
      <div style="font-size:12px;color:#888">P&L השבוע</div>
    </div>
  </div>
  <div style="background:#1a1a1a;border-radius:12px;padding:16px">
    <p style="color:#F5C518;font-weight:bold;margin:0 0 8px">💡 טיפ לשבוע הבא</p>
    <p style="color:#ccc;margin:0;font-size:14px">
      ${stats.winRate < 40 ? 'אחוז הצלחה נמוך — בדוק את תנאי הכניסה שלך ואת ה-R:R' :
        stats.avgRR < 1.5 ? 'שפר את יחס ה-R:R — חפש סטאפים עם לפחות 1:2' :
        'כל הכבוד — המשך לפי התוכנית!'}
    </p>
  </div>
  <p style="margin-top:16px;font-size:12px;color:#555">Reflect Trading Journal</p>
</div></body></html>`;
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
      html: buildPreMarketEmail(name),
    },
    daily_summary: {
      subject: '📊 סיכום יומי — Reflect',
      html: buildDailySummaryEmail(name, { trades: allTrades.length, winRate, avgRR }),
    },
    weekly_summary: {
      subject: '📅 סיכום שבועי — Reflect',
      html: buildWeeklySummaryEmail(name, { trades: allTrades.length, winRate, avgRR, totalPL }),
    },
  };

  const { subject, html } = emailMap[type];

  try {
    await sendEmail({ to: email, subject, html });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
