import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  dailySummaryEmail,
  preMarketEmail,
  weeklySummaryEmail,
  type AlertEmail,
} from '@/lib/email/alerts';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect <hello@reflecttrading.app>';

// ── Email sender ────────────────────────────────────────────────────────────

// Each builder carries its own subject — the summaries put live figures in it.
async function sendEmail(to: string, mail: AlertEmail) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Resend error');
  }
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

  const stats = { trades: allTrades.length, winRate, avgRR, totalPL };

  if (type === 'pre_market') {
    await sendEmail(email, preMarketEmail(name));
  } else if (type === 'end_of_day') {
    await sendEmail(email, dailySummaryEmail(name, stats, dateLabel));
  } else {
    await sendEmail(email, weeklySummaryEmail(name, stats));
  }
}

// ── Cron handler ─────────────────────────────────────────────────────────────

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Parses a saved "HH:MM" setting into just the hour, matched against the
// Israel wall-clock hour of the current cron invocation. Falls back to the
// column's own default when the value is missing/malformed.
function parseHour(time: string | null | undefined, fallback: string): number {
  const raw = time || fallback;
  const hour = Number(raw.split(':')[0]);
  return Number.isFinite(hour) ? hour : Number(fallback.split(':')[0]);
}

export async function GET(request: Request) {
  // Verify Vercel cron secret. Rejects when CRON_SECRET is missing rather than
  // skipping the check — this route uses the service-role client and mails
  // every user, so an unset/renamed env var must fail closed, not open.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();

  // vercel.json defines 24 cron entries (one per UTC hour, each still firing
  // only once/day — required on Vercel's Hobby plan) so this route runs every
  // Israel wall-clock hour. Deriving the Israel hour/weekday directly from
  // `now` handles DST automatically instead of hardcoding a UTC offset. Each
  // user's saved *_time is matched at hour granularity — the finest
  // resolution available without a per-user timezone/minute scheduling system.
  const ilParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const ilHour   = Number(ilParts.find((p) => p.type === 'hour')?.value ?? '0');
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']
    .indexOf(ilParts.find((p) => p.type === 'weekday')?.value ?? '');
  const isSunday = dayOfWeek === 0;

  // Fetch all alert settings, including the per-user send times
  const { data: settings, error } = await supabase
    .from('alert_settings')
    .select(
      'user_id, pre_market_enabled, pre_market_time, end_of_day_enabled, end_of_day_time, weekly_summary_enabled, weekly_summary_time'
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!settings || settings.length === 0) return NextResponse.json({ sent: 0, ilHour });

  const results = await Promise.allSettled(
    settings.flatMap((s) => {
      const jobs: Promise<void>[] = [];

      if (s.pre_market_enabled && parseHour(s.pre_market_time, '08:30') === ilHour)
        jobs.push(dispatchAlert(supabase, s.user_id, 'pre_market'));

      if (s.end_of_day_enabled && parseHour(s.end_of_day_time, '21:00') === ilHour)
        jobs.push(dispatchAlert(supabase, s.user_id, 'end_of_day'));

      if (s.weekly_summary_enabled && isSunday && parseHour(s.weekly_summary_time, '09:00') === ilHour)
        jobs.push(dispatchAlert(supabase, s.user_id, 'weekly_summary'));

      return jobs;
    })
  );

  const sent   = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results
    .filter((r) => r.status === 'rejected')
    .map((r) => (r as PromiseRejectedResult).reason?.message ?? 'unknown');

  return NextResponse.json({ sent, failed, ilHour, isSunday });
}
