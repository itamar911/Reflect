import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FROM_EMAIL = 'Reflect Trading <alerts@reflekt-fawn.vercel.app>';

function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isWithinWindow(alertTime: string, windowMinutes = 5): boolean {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const diff = ((nowMinutes - timeToMinutes(alertTime)) % 1440 + 1440) % 1440;
  return diff <= windowMinutes;
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message ?? 'Failed to send email');
  }
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

function buildWeeklySummaryEmail(name: string, stats: { trades: number; winRate: number; avgRR: number; disciplineScore: number }) {
  return `
<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:sans-serif;background:#0a0a1a;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#111;border:1px solid #222;border-radius:16px;padding:24px">
  <h2 style="color:#F5C518;margin:0 0 16px">📅 סיכום שבועי — Reflect</h2>
  <p style="color:#888;margin:0 0 16px">שלום ${name}, הנה סיכום השבוע שלך:</p>
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
      <div style="font-size:28px;font-weight:bold;color:#60A5FA">${stats.disciplineScore}</div>
      <div style="font-size:12px;color:#888">ציון משמעת</div>
    </div>
  </div>
  <div style="background:#1a1a1a;border-radius:12px;padding:16px">
    <p style="color:#F5C518;font-weight:bold;margin:0 0 8px">💡 טיפ לשבוע הבא</p>
    <p style="color:#ccc;margin:0;font-size:14px">
      ${stats.winRate < 40 ? 'Win Rate נמוך — בדוק את תנאי הכניסה שלך ואת ה-R:R' :
        stats.avgRR < 1.5 ? 'שפר את יחס ה-R:R — חפש סטאפים עם לפחות 1:2' :
        'כל הכבוד — המשך לפי התוכנית!'}
    </p>
  </div>
  <p style="margin-top:16px;font-size:12px;color:#555">Reflect Trading Journal</p>
</div></body></html>`;
}

type TradePlanRow = {
  status: string;
  exit_price: string | number | null;
  stop_loss: string | number | null;
  rr_ratio: string | number | null;
  emotional_state: string | number | null;
  plan_score: number | null;
};

function computeStats(trades: TradePlanRow[]) {
  const closed = trades.filter(t => t.status === 'closed');
  const wins = closed.filter(t => Number(t.exit_price) > Number(t.stop_loss));
  const winRate = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
  const avgRR = trades.length > 0
    ? parseFloat((trades.reduce((s, t) => s + Number(t.rr_ratio || 0), 0) / trades.length).toFixed(1))
    : 0;
  const disciplineScore = trades.length === 0 ? 0 : Math.min(100, Math.round(
    (closed.filter(t => t.plan_score != null).length / Math.max(closed.length, 1)) * 30 +
    (trades.filter(t => Number(t.emotional_state) >= 3).length / trades.length) * 30 +
    (trades.filter(t => Number(t.rr_ratio || 0) >= 2).length / trades.length) * 40
  ));
  return { trades: trades.length, winRate, avgRR, disciplineScore };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const isSunday = now.getDay() === 0;

  const { data: alertSettings, error } = await supabase
    .from('alert_settings')
    .select('*, profiles!inner(email, display_name)');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const sent: string[] = [];
  const failed: string[] = [];

  for (const settings of alertSettings ?? []) {
    const profile = settings.profiles as { email: string; display_name: string | null };
    const name = profile.display_name?.split(' ')[0] ?? 'סוחר';
    const email = profile.email;
    if (!email) continue;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    if (settings.pre_market_enabled && isWithinWindow(settings.pre_market_time)) {
      try {
        await sendEmail(email, '📈 תזכורת לפני פתיחת השוק — Reflect', buildPreMarketEmail(name));
        sent.push(`pre_market:${email}`);
      } catch {
        failed.push(`pre_market:${email}`);
      }
    }

    if (settings.end_of_day_enabled && isWithinWindow(settings.end_of_day_time)) {
      const { data: trades } = await supabase
        .from('trade_plans')
        .select('status,exit_price,stop_loss,rr_ratio,emotional_state,plan_score')
        .eq('user_id', settings.user_id)
        .gte('submitted_at', sevenDaysAgo);
      const stats = computeStats(trades ?? []);
      try {
        await sendEmail(email, '📊 סיכום יומי — Reflect', buildDailySummaryEmail(name, stats));
        sent.push(`end_of_day:${email}`);
      } catch {
        failed.push(`end_of_day:${email}`);
      }
    }

    if (settings.weekly_summary_enabled && isSunday && isWithinWindow(settings.weekly_summary_time)) {
      const { data: trades } = await supabase
        .from('trade_plans')
        .select('status,exit_price,stop_loss,rr_ratio,emotional_state,plan_score')
        .eq('user_id', settings.user_id)
        .gte('submitted_at', sevenDaysAgo);
      const stats = computeStats(trades ?? []);
      try {
        await sendEmail(email, '📅 סיכום שבועי — Reflect', buildWeeklySummaryEmail(name, stats));
        sent.push(`weekly_summary:${email}`);
      } catch {
        failed.push(`weekly_summary:${email}`);
      }
    }
  }

  return NextResponse.json({ sent, failed });
}
