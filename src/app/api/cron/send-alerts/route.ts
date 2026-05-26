import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect Trading <alerts@reflekt-fawn.vercel.app>';
const WINDOW_MINUTES = 5;

// ── Email sender ────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Resend error');
  }
}

// ── Motivational message ─────────────────────────────────────────────────────

function motivation(trades: number, winRate: number, totalPL: number): string {
  if (trades === 0)
    return '🌙 יום ללא עסקאות — לפעמים ההמתנה לסטאפ הנכון היא ההחלטה הנכונה ביותר.';
  if (totalPL > 0 && winRate >= 60)
    return '🔥 יום מצוין! Win Rate גבוה ורווחי — המשך לשמור על הגישה הזאת.';
  if (totalPL > 0 && winRate >= 50)
    return '✅ יום רווחי — שמור על המשמעת ותן לרווחים לרוץ.';
  if (totalPL > 0)
    return '💚 יום בצד החיובי — בדוק אם ה-R:R תומך בגדילה לטווח ארוך.';
  if (totalPL < 0 && winRate >= 50)
    return '📊 Win Rate טוב למרות ההפסד — שפר את ה-R:R כדי שהרווחים יכסו את ההפסדים.';
  if (totalPL < 0 && trades <= 2)
    return '💡 יום קשה, אבל רק ' + trades + ' עסקאות — שמור על הסבלנות למחר.';
  if (totalPL < 0)
    return '🛡️ יום קשה. הכי חשוב: האם שמרת על חוקי המסחר? מחר מתחילים מחדש.';
  return '📈 ממשיך לנסוע — כל יום הוא הזדמנות ללמוד.';
}

// ── Email builders ───────────────────────────────────────────────────────────

function dailySummaryHtml(
  name: string,
  stats: { trades: number; winRate: number; avgRR: number; totalPL: number },
  dateLabel: string
) {
  const plColor     = stats.totalPL >= 0 ? '#00C853' : '#FF3B30';
  const plFormatted = (stats.totalPL >= 0 ? '+$' : '-$') + Math.abs(stats.totalPL).toFixed(2);
  const wrColor     = stats.winRate >= 50 ? '#00C853' : '#FF3B30';
  const rrColor     = stats.avgRR  >= 2   ? '#00C853' : '#F59E0B';
  const msg         = motivation(stats.trades, stats.winRate, stats.totalPL);

  return `<!DOCTYPE html><html dir="rtl" lang="he">
<body style="font-family:sans-serif;background:#0a0a0f;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#0d1117;border:1px solid #1a2535;border-radius:16px;padding:24px">

  <div style="border-bottom:1px solid #1a2535;padding-bottom:16px;margin-bottom:20px">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="width:26px;height:26px;background:linear-gradient(135deg,#F5C518,#D4A017);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px">📈</div>
      <span style="font-weight:bold;color:#F5C518;font-size:15px">Reflect</span>
    </div>
    <h2 style="color:#e8edf5;margin:0;font-size:20px">📊 סיכום יומי</h2>
    <p style="color:#7b8fa8;margin:6px 0 0;font-size:13px">${dateLabel}</p>
  </div>

  <p style="color:#7b8fa8;margin:0 0 20px;font-size:14px">שלום ${name},</p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${plColor}">${plFormatted}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">P&L היום</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:#F5C518">${stats.trades}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">עסקאות</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${wrColor}">${stats.winRate}%</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">Win Rate</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${rrColor}">1:${stats.avgRR}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">R:R ממוצע</div>
    </div>
  </div>

  <div style="background:#111827;border:1px solid rgba(245,197,24,0.2);border-right:3px solid #F5C518;border-radius:12px;padding:16px">
    <p style="color:#e8edf5;margin:0;font-size:14px;line-height:1.65">${msg}</p>
  </div>

  <p style="margin-top:20px;font-size:11px;color:#3d5068;text-align:center">
    Reflect Trading Journal &bull; <a href="#" style="color:#3d5068">ביטול הרשמה</a>
  </p>
</div>
</body></html>`;
}

function preMarketHtml(name: string) {
  return `<!DOCTYPE html><html dir="rtl" lang="he">
<body style="font-family:sans-serif;background:#0a0a0f;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#0d1117;border:1px solid #1a2535;border-radius:16px;padding:24px">
  <div style="border-bottom:1px solid #1a2535;padding-bottom:16px;margin-bottom:20px">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="width:26px;height:26px;background:linear-gradient(135deg,#F5C518,#D4A017);border-radius:7px;font-size:14px;display:flex;align-items:center;justify-content:center">📈</div>
      <span style="font-weight:bold;color:#F5C518;font-size:15px">Reflect</span>
    </div>
    <h2 style="color:#e8edf5;margin:0;font-size:20px">☀️ תזכורת לפני פתיחת השוק</h2>
  </div>
  <p style="color:#7b8fa8;margin:0 0 16px;font-size:14px">שלום ${name}, הבוקר מתחיל ביומן.</p>
  <p style="color:#e8edf5;margin:0 0 12px;font-size:14px">לפני שנכנסים לעסקה — 3 שאלות:</p>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
    <div style="background:#111827;border:1px solid #1a2535;border-radius:10px;padding:14px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">📋</span>
      <span style="color:#e8edf5;font-size:14px">מה התוכנית שלי להיום?</span>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:10px;padding:14px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">🧠</span>
      <span style="color:#e8edf5;font-size:14px">האם אני במצב רגשי מתאים למסחר?</span>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:10px;padding:14px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">🛡️</span>
      <span style="color:#e8edf5;font-size:14px">מה גבולות הסיכון שלי היום?</span>
    </div>
  </div>
  <div style="background:#111827;border:1px solid rgba(245,197,24,0.2);border-right:3px solid #F5C518;border-radius:12px;padding:14px">
    <p style="color:#F5C518;margin:0;font-size:13px">💡 לעולם לא להסתכן ביותר מ-1–2% מההון בעסקה אחת</p>
  </div>
  <p style="margin-top:20px;font-size:11px;color:#3d5068;text-align:center">Reflect Trading Journal</p>
</div>
</body></html>`;
}

function weeklySummaryHtml(
  name: string,
  stats: { trades: number; winRate: number; avgRR: number; totalPL: number }
) {
  const plColor     = stats.totalPL >= 0 ? '#00C853' : '#FF3B30';
  const plFormatted = (stats.totalPL >= 0 ? '+$' : '-$') + Math.abs(stats.totalPL).toFixed(2);
  const tip =
    stats.winRate < 40  ? 'Win Rate נמוך — בדוק את תנאי הכניסה שלך ואת ה-R:R' :
    stats.avgRR  < 1.5  ? 'שפר את יחס ה-R:R — חפש סטאפים עם לפחות 1:2' :
                          'כל הכבוד — המשך לפי התוכנית!';

  return `<!DOCTYPE html><html dir="rtl" lang="he">
<body style="font-family:sans-serif;background:#0a0a0f;color:#fff;padding:24px;max-width:600px;margin:0 auto">
<div style="background:#0d1117;border:1px solid #1a2535;border-radius:16px;padding:24px">
  <div style="border-bottom:1px solid #1a2535;padding-bottom:16px;margin-bottom:20px">
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="width:26px;height:26px;background:linear-gradient(135deg,#F5C518,#D4A017);border-radius:7px;font-size:14px;display:flex;align-items:center;justify-content:center">📈</div>
      <span style="font-weight:bold;color:#F5C518;font-size:15px">Reflect</span>
    </div>
    <h2 style="color:#e8edf5;margin:0;font-size:20px">📅 סיכום שבועי</h2>
  </div>
  <p style="color:#7b8fa8;margin:0 0 20px;font-size:14px">שלום ${name}, הנה השפעת Reflect על הארנק שלך השבוע:</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px">
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:#F5C518">${stats.trades}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">עסקאות השבוע</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${stats.winRate >= 50 ? '#00C853' : '#FF3B30'}">${stats.winRate}%</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">Win Rate</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${stats.avgRR >= 2 ? '#00C853' : '#F59E0B'}">1:${stats.avgRR}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">R:R ממוצע</div>
    </div>
    <div style="background:#111827;border:1px solid #1a2535;border-radius:12px;padding:16px;text-align:center">
      <div style="font-size:26px;font-weight:bold;color:${plColor}">${plFormatted}</div>
      <div style="font-size:12px;color:#7b8fa8;margin-top:5px">P&L השבוע</div>
    </div>
  </div>
  <div style="background:#111827;border:1px solid rgba(245,197,24,0.2);border-right:3px solid #F5C518;border-radius:12px;padding:16px">
    <p style="color:#F5C518;font-weight:bold;margin:0 0 6px;font-size:13px">💡 טיפ לשבוע הבא</p>
    <p style="color:#e8edf5;margin:0;font-size:14px">${tip}</p>
  </div>
  <p style="margin-top:20px;font-size:11px;color:#3d5068;text-align:center">Reflect Trading Journal</p>
</div>
</body></html>`;
}

// ── Per-user email dispatch ──────────────────────────────────────────────────

type AlertType = 'pre_market' | 'end_of_day' | 'weekly_summary';

async function dispatchAlert(
  supabase: ReturnType<typeof createAdminClient>,
  userId: string,
  type: AlertType
) {
  // Profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', userId)
    .single();

  const name  = (profile?.display_name as string | null)?.split(' ')[0] ?? 'סוחר';
  const email = (profile?.email as string | null) ?? '';
  if (!email) return;

  // Fetch trades
  const now        = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const rangeStart = type === 'pre_market'
    ? todayStart.toISOString()
    : type === 'end_of_day'
    ? todayStart.toISOString()
    : sevenDaysAgo.toISOString();

  const { data: trades } = await supabase
    .from('trade_plans')
    .select('status, entry_price, exit_price, rr_ratio, emotional_state')
    .eq('user_id', userId)
    .gte('submitted_at', rangeStart);

  const allTrades = trades ?? [];
  const closed    = allTrades.filter((t) => t.status === 'closed' && t.exit_price !== null);
  const wins      = closed.filter((t) => Number(t.exit_price) > Number(t.entry_price));
  const winRate   = closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0;
  const avgRR     = allTrades.length > 0
    ? parseFloat((allTrades.reduce((s: number, t) => s + Number(t.rr_ratio ?? 0), 0) / allTrades.length).toFixed(1))
    : 0;
  const totalPL   = closed.reduce(
    (s: number, t) => s + (Number(t.exit_price) - Number(t.entry_price)),
    0
  );

  const dateLabel = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  if (type === 'pre_market') {
    await sendEmail(email, '☀️ תזכורת לפני פתיחת השוק — Reflect', preMarketHtml(name));
  } else if (type === 'end_of_day') {
    await sendEmail(
      email,
      `📊 סיכום יומי — Reflect`,
      dailySummaryHtml(name, { trades: allTrades.length, winRate, avgRR, totalPL }, dateLabel)
    );
  } else {
    await sendEmail(
      email,
      '📅 סיכום שבועי — Reflect',
      weeklySummaryHtml(name, { trades: allTrades.length, winRate, avgRR, totalPL })
    );
  }
}

// ── Cron handler ─────────────────────────────────────────────────────────────

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Verify Vercel cron secret
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Current time in Israel (handles IST/IDT automatically)
  const now = new Date();
  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const getPart = (type: string) => ilParts.find((p) => p.type === type)?.value ?? '';
  const hh = getPart('hour').padStart(2, '0');
  const mm = getPart('minute').padStart(2, '0');
  const nowMinutes  = parseInt(hh) * 60 + parseInt(mm);
  const dayOfWeek   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(getPart('weekday'));
  const currentTime = `${hh}:${mm}`;

  // Fetch all alert settings
  const { data: settings, error } = await supabase
    .from('alert_settings')
    .select(
      'user_id, pre_market_enabled, pre_market_time, end_of_day_enabled, end_of_day_time, weekly_summary_enabled, weekly_summary_time'
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!settings || settings.length === 0) return NextResponse.json({ sent: 0, time: currentTime });

  function inWindow(alertTime: string | null): boolean {
    if (!alertTime) return false;
    const [ah, am] = alertTime.split(':').map(Number);
    const diff = ((nowMinutes - (ah * 60 + am)) % 1440 + 1440) % 1440;
    return diff <= WINDOW_MINUTES;
  }

  const results = await Promise.allSettled(
    settings.flatMap((s) => {
      const jobs: Promise<void>[] = [];

      if (s.pre_market_enabled && inWindow(s.pre_market_time))
        jobs.push(dispatchAlert(supabase, s.user_id, 'pre_market'));

      if (s.end_of_day_enabled && inWindow(s.end_of_day_time))
        jobs.push(dispatchAlert(supabase, s.user_id, 'end_of_day'));

      // Weekly summary only on Sundays (dayOfWeek === 0)
      if (s.weekly_summary_enabled && inWindow(s.weekly_summary_time) && dayOfWeek === 0)
        jobs.push(dispatchAlert(supabase, s.user_id, 'weekly_summary'));

      return jobs;
    })
  );

  const sent   = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results
    .filter((r) => r.status === 'rejected')
    .map((r) => (r as PromiseRejectedResult).reason?.message ?? 'unknown');

  return NextResponse.json({ sent, failed, time: currentTime, day: dayOfWeek });
}
