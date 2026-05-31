import { createClient } from '@/lib/supabase/server';
import ProgressRing from '@/components/ui/ProgressRing';
import StreakTracker from '@/components/streaks/StreakTracker';
import DangerMode from '@/components/danger/DangerMode';
import EmptyStateButton from '@/components/dashboard/EmptyStateButton';
import Badge from '@/components/ui/Badge';

export const metadata = { title: 'דשבורד — Reflect' };

// ── Helpers ────────────────────────────────────────────────────────────────────

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

function formatPnl(v: number, decimals = 1) {
  if (v === 0) return '$0';
  return `${v > 0 ? '+' : '−'}$${Math.abs(v).toFixed(decimals)}`;
}

function pnlColor(v: number) {
  return v > 0 ? '#4ade80' : v < 0 ? '#f87171' : 'var(--color-tg-text-2)';
}

function computeStreak(
  trades: Record<string, unknown>[],
  type: 'discipline' | 'no_revenge' | 'stop_loss',
): number {
  if (!trades.length) return 0;
  const s = [...trades].sort(
    (a, b) =>
      new Date(b.submitted_at as string).getTime() -
      new Date(a.submitted_at as string).getTime(),
  );
  let streak = 0;
  for (const t of s) {
    let ok = false;
    if (type === 'discipline')  ok = Number(t.emotional_state) >= 3 && Number(t.rr_ratio) >= 1.5;
    if (type === 'no_revenge')  ok = Number(t.emotional_state) >= 3;
    if (type === 'stop_loss')   ok = t.stop_loss != null;
    if (ok) streak++;
    else break;
  }
  return streak;
}

// ── Equity curve SVG ──────────────────────────────────────────────────────────

function EquityChart({
  points,
  isUp,
}: {
  points: number[];
  isUp: boolean;
}) {
  if (points.length < 2) return null;

  const W = 300;
  const H = 64;
  const pad = 3;

  const min  = Math.min(...points);
  const max  = Math.max(...points);
  const span = Math.max(max - min, 0.001);

  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - pad - ((v - min) / span) * (H - pad * 2);
    return [x, y] as [number, number];
  });

  const lineD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${W},${H} L0,${H} Z`;

  const stroke  = isUp ? '#4ade80' : '#f87171';
  const fillTop = isUp ? 'rgba(74,222,128,0.22)' : 'rgba(248,113,113,0.22)';
  const fillBot = isUp ? 'rgba(74,222,128,0)'     : 'rgba(248,113,113,0)';

  const gradId = 'eq-g';

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: H, display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={fillTop} />
          <stop offset="100%" stopColor={fillBot} />
        </linearGradient>
      </defs>
      <path d={areaD}  fill={`url(#${gradId})`} />
      <path d={lineD}  fill="none" stroke={stroke} strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color: string;
  sub?: string;
}) {
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-1"
      style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
    >
      <p className="text-[11px] font-medium" style={{ color: 'var(--color-tg-muted)' }}>{label}</p>
      <p className="text-xl font-bold leading-none" style={{ color }}>{value}</p>
      {sub && <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>{sub}</p>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [profileRes, todayRes, allRes, rulesRes] = await Promise.all([
    supabase.from('profiles').select('display_name, subscription_tier').eq('id', user.id).single(),
    supabase.from('trade_plans').select('*').eq('user_id', user.id).gte('submitted_at', todayStart.toISOString()),
    supabase.from('trade_plans').select('*').eq('user_id', user.id).order('submitted_at', { ascending: false }).limit(200),
    supabase.from('preset_rules').select('cooldown_after_losses, max_daily_loss').eq('user_id', user.id).single(),
  ]);

  const profile    = profileRes.data;
  const todayTrades = todayRes.data ?? [];
  const allTrades   = allRes.data  ?? [];
  const rules       = rulesRes.data;

  // ── Core computations ─────────────────────────────────────────────────────

  const closed        = allTrades.filter((t) => t.status === 'closed');
  const closedWithExit = closed.filter((t) => t.exit_price != null);

  const totalPnl    = closedWithExit.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const winCount    = closedWithExit.filter((t) => Number(t.exit_price) > Number(t.entry_price)).length;
  const winRatePct  = closedWithExit.length > 0 ? Math.round((winCount / closedWithExit.length) * 100) : 0;
  const avgRR       = allTrades.length > 0
    ? allTrades.reduce((s, t) => s + (Number(t.rr_ratio) || 0), 0) / allTrades.length
    : 0;

  const todayClosed   = todayTrades.filter((t) => t.status === 'closed' && t.exit_price != null);
  const todayPnl      = todayClosed.reduce((s, t) => s + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const todayOpen     = todayTrades.filter((t) => t.status === 'open').length;

  // Discipline score
  const totalCount = allTrades.length;
  const disciplineScore = totalCount === 0 ? 0 : Math.min(100, Math.round(
    (closed.filter((t) => t.plan_score != null).length / Math.max(closed.length, 1)) * 30 +
    (allTrades.filter((t) => Number(t.emotional_state) >= 3).length / totalCount) * 30 +
    (allTrades.filter((t) => (Number(t.rr_ratio) || 0) >= 2).length / totalCount) * 40,
  ));

  // Streaks
  const disciplineStreak     = computeStreak(allTrades, 'discipline');
  const noRevengeStreak      = computeStreak(allTrades, 'no_revenge');
  const stopLossStreak       = computeStreak(allTrades, 'stop_loss');
  const fullDisciplineStreak = Math.min(disciplineStreak, noRevengeStreak, stopLossStreak);

  // Danger mode
  let consecutiveLosses = 0;
  for (const t of allTrades) {
    if (t.status === 'closed' && t.exit_price && Number(t.exit_price) <= Number(t.stop_loss)) {
      consecutiveLosses++;
    } else if (t.status === 'closed') break;
  }
  const todayLoss = todayTrades
    .filter((t) => t.status === 'closed' && Number(t.exit_price) < Number(t.entry_price))
    .reduce((s, t) => s + Math.abs(Number(t.entry_price) - Number(t.exit_price)), 0);
  const dailyLossExceeded = rules?.max_daily_loss ? todayLoss >= rules.max_daily_loss : false;

  // Equity curve — last 30 days
  const equityPoints: number[] = (() => {
    const daily: Record<string, number> = {};
    for (const t of closedWithExit) {
      const k = dayKey(String(t.submitted_at));
      daily[k] = (daily[k] ?? 0) + (Number(t.exit_price) - Number(t.entry_price));
    }
    const days: number[] = [];
    let cum = 0;
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0, 10);
      cum += daily[k] ?? 0;
      days.push(cum);
    }
    return days;
  })();
  const equityIsUp = equityPoints[equityPoints.length - 1] >= equityPoints[0];

  // Recent trades (last 7)
  const recentTrades = allTrades.slice(0, 7);

  // Greeting
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'לילה טוב' : hour < 12 ? 'בוקר טוב' : hour < 17 ? 'צהריים טובים' : 'ערב טוב';
  const name     = profile?.display_name?.split(' ')[0] ?? 'סוחר';

  // Dynamic message
  let dynamicMsg = '';
  if (consecutiveLosses >= 2)        dynamicMsg = `${consecutiveLosses} הפסדים רצופים — שקול הפסקה`;
  else if (totalPnl > 0 && winCount >= 3) dynamicMsg = `רווח כולל ${formatPnl(totalPnl, 1)} — המשך לפי התוכנית`;
  else if (disciplineStreak >= 3)    dynamicMsg = `${disciplineStreak} עסקאות לפי החוקים ברצף 🔥`;
  else if (todayTrades.length === 0) dynamicMsg = 'כלי המסחר שלך מוכן — תכנן לפני שתיכנס';

  const dateStr = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-4">

      {/* ── Hero header ─────────────────────────────────────────── */}
      <div
        className="rounded-2xl p-5"
        style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium mb-1" style={{ color: '#D4AF37' }}>{dateStr}</p>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--color-tg-text)' }}>
              {greeting}, {name}
            </h1>
            {dynamicMsg && (
              <p className="text-sm mt-1 leading-snug" style={{ color: 'var(--color-tg-text-2)' }}>
                {dynamicMsg}
              </p>
            )}
          </div>

          {/* Today's summary bubble */}
          <div
            className="shrink-0 rounded-xl px-3 py-2.5 text-center"
            style={{ background: 'var(--color-tg-surface-2)' }}
          >
            <p className="text-[10px] font-medium mb-0.5" style={{ color: 'var(--color-tg-muted)' }}>היום</p>
            {todayTrades.length > 0 ? (
              <>
                <p className="text-lg font-bold leading-none" style={{ color: pnlColor(todayPnl) }}>
                  {formatPnl(todayPnl)}
                </p>
                <p className="text-[10px] mt-1" style={{ color: 'var(--color-tg-muted)' }}>
                  {todayClosed.length} סגורות{todayOpen > 0 ? ` · ${todayOpen} פתוחות` : ''}
                </p>
              </>
            ) : (
              <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>אין עסקאות</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Danger mode ──────────────────────────────────────────── */}
      <DangerMode
        consecutiveLosses={consecutiveLosses}
        emotionalState={
          totalCount > 0
            ? Math.round(allTrades.reduce((s, t) => s + Number(t.emotional_state || 3), 0) / totalCount)
            : 3
        }
        dailyLossExceeded={dailyLossExceeded}
        maxDailyLoss={rules?.max_daily_loss ?? null}
        currentLoss={todayLoss}
      />

      {/* ── Empty state ───────────────────────────────────────────── */}
      {totalCount === 0 && (
        <div
          className="rounded-2xl p-8 text-center flex flex-col items-center gap-4"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
        >
          <div className="text-5xl">📈</div>
          <div>
            <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--color-tg-text)' }}>ברוך הבא ל-Reflect</h3>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
              תעד את העסקה הראשונה שלך כדי להתחיל לעקוב אחרי הביצועים
            </p>
          </div>
          <EmptyStateButton />
        </div>
      )}

      {/* ── Core metrics (2×2) ───────────────────────────────────── */}
      {totalCount > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            label="רווח/הפסד כולל"
            value={closedWithExit.length > 0 ? formatPnl(totalPnl) : '—'}
            color={pnlColor(totalPnl)}
            sub={`${closedWithExit.length} עסקאות סגורות`}
          />
          <MetricCard
            label="אחוז הצלחה"
            value={closedWithExit.length > 0 ? `${winRatePct}%` : '—'}
            color="#60A5FA"
            sub={`${winCount} מתוך ${closedWithExit.length}`}
          />
          <MetricCard
            label="ממוצע R:R"
            value={totalCount > 0 ? `1:${avgRR.toFixed(1)}` : '—'}
            color="#D4AF37"
          />
          <MetricCard
            label="סה״כ עסקאות"
            value={String(totalCount)}
            color="var(--color-tg-text)"
            sub={`${closed.length} סגורות · ${totalCount - closed.length} פתוחות`}
          />
        </div>
      )}

      {/* ── Equity curve ────────────────────────────────────────── */}
      {closedWithExit.length >= 5 && (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
        >
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <div>
              <p className="text-xs font-medium" style={{ color: 'var(--color-tg-muted)' }}>עקומת הון — 30 יום</p>
              <p className="text-lg font-bold mt-0.5" style={{ color: pnlColor(totalPnl) }}>
                {formatPnl(equityPoints[equityPoints.length - 1])}
              </p>
            </div>
            <span
              className="text-xs font-semibold px-2 py-1 rounded-full"
              style={{
                background: equityIsUp ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)',
                color:      equityIsUp ? '#4ade80' : '#f87171',
              }}
            >
              {equityIsUp ? '▲' : '▼'} {Math.abs(equityPoints[equityPoints.length - 1] - equityPoints[0]).toFixed(1)}
            </span>
          </div>
          <div className="px-1 pb-1">
            <EquityChart points={equityPoints} isUp={equityIsUp} />
          </div>
        </div>
      )}

      {/* ── Discipline ─────────────────────────────────────────── */}
      {totalCount > 0 && (
        <div
          className="rounded-2xl p-4 flex flex-col gap-4"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
        >
          <div className="flex items-center gap-4">
            <ProgressRing
              value={disciplineScore}
              max={100}
              size={72}
              strokeWidth={6}
              color={disciplineScore >= 70 ? '#D4AF37' : disciplineScore >= 40 ? '#f59e0b' : '#f87171'}
              label={String(disciplineScore)}
              sublabel="ציון"
            />
            <div>
              <p className="text-base font-bold" style={{ color: 'var(--color-tg-text)' }}>משמעת מסחר</p>
              <p className="text-sm mt-0.5" style={{ color: 'var(--color-tg-muted)' }}>
                {disciplineScore >= 80 ? '🏆 מצוין' :
                 disciplineScore >= 60 ? '✅ טוב' :
                 disciplineScore >= 40 ? '⚠️ בינוני' : '❌ דרוש שיפור'}
              </p>
            </div>
          </div>
          <StreakTracker
            disciplineStreak={disciplineStreak}
            noRevengeStreak={noRevengeStreak}
            stopLossStreak={stopLossStreak}
            fullDisciplineStreak={fullDisciplineStreak}
          />
        </div>
      )}

      {/* ── Today's trades ───────────────────────────────────────── */}
      {todayTrades.length > 0 && (
        <div
          className="rounded-2xl p-4"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--color-tg-text)' }}>עסקאות היום</h2>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'rgba(212,175,55,0.12)', color: '#D4AF37' }}>
              {todayTrades.length}
            </span>
          </div>
          <div className="flex flex-col gap-0">
            {todayTrades.map((t, i) => {
              const rrVal  = Number(t.rr_ratio);
              const rrCol  = rrVal >= 2 ? '#4ade80' : rrVal >= 1 ? '#facc15' : '#f87171';
              const pnl    = t.status === 'closed' && t.exit_price != null
                ? Number(t.exit_price) - Number(t.entry_price)
                : null;
              return (
                <div
                  key={t.id}
                  className="flex items-center justify-between py-2.5"
                  style={{ borderTop: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--color-tg-text)' }}>
                      {t.strategy}
                    </p>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-tg-muted)' }}>
                      כניסה {Number(t.entry_price).toFixed(2)} · SL {Number(t.stop_loss).toFixed(2)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={t.status === 'open' ? 'primary' : 'default'}>
                      {t.status === 'open' ? 'פתוח' : 'סגור'}
                    </Badge>
                    {pnl !== null ? (
                      <span className="text-xs font-bold w-14 text-left" style={{ color: pnlColor(pnl) }}>
                        {formatPnl(pnl, 1)}
                      </span>
                    ) : (
                      <span className="text-xs font-bold w-10 text-left" style={{ color: rrCol }}>
                        1:{rrVal.toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Recent trades ────────────────────────────────────────── */}
      {recentTrades.length > 0 && (
        <div
          className="rounded-2xl p-4"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
        >
          <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--color-tg-text)' }}>
            עסקאות אחרונות
          </h2>
          <div className="flex flex-col gap-0">
            {recentTrades.map((t, i) => {
              const pnl = t.status === 'closed' && t.exit_price != null
                ? Number(t.exit_price) - Number(t.entry_price)
                : null;
              const dateLabel = new Date(String(t.submitted_at)).toLocaleDateString('he-IL', {
                day: 'numeric', month: 'short',
              });
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-3 py-2.5"
                  style={{ borderTop: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}
                >
                  {/* Status dot */}
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      background: pnl == null
                        ? '#D4AF37'
                        : pnl > 0 ? '#4ade80' : '#f87171',
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: 'var(--color-tg-text)' }}>
                      {t.strategy}
                    </p>
                    <p className="text-[11px]" style={{ color: 'var(--color-tg-muted)' }}>{dateLabel}</p>
                  </div>
                  <div className="text-left shrink-0">
                    {pnl !== null ? (
                      <p className="text-sm font-bold" style={{ color: pnlColor(pnl) }}>
                        {formatPnl(pnl, 1)}
                      </p>
                    ) : (
                      <p className="text-xs font-semibold" style={{ color: '#D4AF37' }}>פתוח</p>
                    )}
                    <p className="text-[10px]" style={{ color: 'var(--color-tg-muted)' }}>
                      1:{Number(t.rr_ratio).toFixed(1)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}
