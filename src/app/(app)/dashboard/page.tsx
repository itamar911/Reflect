import { createClient } from '@/lib/supabase/server';
import { Suspense } from 'react';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import PerformanceSection from '@/components/dashboard/PerformanceSection';
import AICoachCard from '@/components/ai/AICoachCard';
import PatternDetection from '@/components/ai/PatternDetection';
import StreakTracker from '@/components/streaks/StreakTracker';
import TraderIdentityCard from '@/components/identity/TraderIdentity';
import DangerMode from '@/components/danger/DangerMode';
import { computeTraderProfile } from '@/lib/identity';
import TradeHeatmap from '@/components/dashboard/TradeHeatmap';

function SectionSkeleton({ h = 80 }: { h?: number }) {
  return <div className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: h }} />;
}

export const metadata = { title: 'דשבורד — Reflect' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [profileRes, todayTradesRes, allTradesRes, rulesRes] = await Promise.all([
    supabase.from('profiles').select('display_name, trading_type, subscription_tier').eq('id', user.id).single(),
    supabase.from('trade_plans').select('*').eq('user_id', user.id).gte('submitted_at', today.toISOString()),
    supabase.from('trade_plans').select('*').eq('user_id', user.id).order('submitted_at', { ascending: false }).limit(100),
    supabase.from('preset_rules').select('cooldown_after_losses, max_daily_loss').eq('user_id', user.id).single(),
  ]);

  const profile = profileRes.data;
  const todayTrades = todayTradesRes.data ?? [];
  const allTrades = allTradesRes.data ?? [];
  const rules = rulesRes.data;

  const totalTrades = allTrades.length;
  const closedTrades = allTrades.filter((t) => t.status === 'closed');
  const avgRR = totalTrades > 0
    ? (allTrades.reduce((s, t) => s + (t.rr_ratio || 0), 0) / totalTrades).toFixed(1)
    : '—';
  const avgEmotional = totalTrades > 0
    ? allTrades.reduce((s, t) => s + (t.emotional_state || 3), 0) / totalTrades
    : 3;

  const disciplineScore = totalTrades === 0 ? 0 : Math.min(100, Math.round(
    (closedTrades.filter((t) => t.plan_score !== null).length / Math.max(closedTrades.length, 1)) * 30 +
    (allTrades.filter((t) => t.emotional_state >= 3).length / totalTrades) * 30 +
    (allTrades.filter((t) => (t.rr_ratio || 0) >= 2).length / totalTrades) * 40
  ));

  // Dollar impact calculations
  const closedWithExit = closedTrades.filter((t) => t.exit_price !== null);
  const totalPL = closedWithExit.reduce((sum, t) => sum + (Number(t.exit_price) - Number(t.entry_price)), 0);
  const winCount = closedWithExit.filter((t) => Number(t.exit_price) > Number(t.entry_price)).length;
  const winRatePct = closedWithExit.length > 0 ? Math.round((winCount / closedWithExit.length) * 100) : 0;
  const revengeTrades = closedWithExit.filter((t) =>
    Number(t.emotional_state) <= 2 && Number(t.exit_price) < Number(t.entry_price)
  );
  const revengeLoss = revengeTrades.reduce((sum, t) => sum + (Number(t.entry_price) - Number(t.exit_price)), 0);

  let consecutiveLosses = 0;
  const sorted = [...allTrades].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
  for (const t of sorted) {
    if (t.status === 'closed' && t.exit_price && t.entry_price && Number(t.exit_price) <= Number(t.stop_loss)) {
      consecutiveLosses++;
    } else if (t.status === 'closed') break;
  }

  let todayLoss = 0;
  for (const t of todayTrades) {
    if (t.status === 'closed' && t.exit_price && t.entry_price && Number(t.exit_price) < Number(t.entry_price))
      todayLoss += Math.abs(Number(t.entry_price) - Number(t.exit_price));
  }
  const dailyLossExceeded = rules?.max_daily_loss ? todayLoss >= rules.max_daily_loss : false;

  const disciplineStreak = computeStreak(allTrades, 'discipline');
  const noRevengeStreak = computeStreak(allTrades, 'no_revenge');
  const stopLossStreak = computeStreak(allTrades, 'stop_loss');
  const fullDisciplineStreak = Math.min(disciplineStreak, noRevengeStreak, stopLossStreak);

  const simpleTrades = allTrades.map((t) => ({
    strategy: String(t.strategy || ''),
    emotional_state: Number(t.emotional_state || 3),
    rr_ratio: Number(t.rr_ratio || 0),
    submitted_at: String(t.submitted_at),
    status: String(t.status),
    entry_price: Number(t.entry_price || 0),
    exit_price: t.exit_price !== null ? Number(t.exit_price) : null,
    stop_loss: Number(t.stop_loss || 0),
  }));

  const traderProfile = computeTraderProfile(simpleTrades);

  const hour = new Date().getHours();
  const greeting = hour < 5
    ? 'לילה טוב'
    : hour < 12
    ? 'בוקר טוב'
    : hour < 17
    ? 'צהריים טובים'
    : 'ערב טוב';
  const name = profile?.display_name?.split(' ')[0] ?? 'סוחר';

  let dynamicMsg = '';
  if (consecutiveLosses >= 2)
    dynamicMsg = `⚠️ ${consecutiveLosses} הפסדים רצופים — שקול הפסקה`;
  else if (revengeTrades.length >= 2)
    dynamicMsg = `⚠️ ${revengeTrades.length} עסקאות Revenge עלו לך $${revengeLoss.toFixed(1)} — שים לב למצב רגשי`;
  else if (totalPL > 0 && closedWithExit.length >= 3)
    dynamicMsg = `💰 P&L מצטבר: +$${totalPL.toFixed(1)} — המשך לפי התוכנית`;
  else if (disciplineStreak >= 3)
    dynamicMsg = `🔥 ${disciplineStreak} ימים לפי החוקים ברצף`;
  else if (avgEmotional >= 4)
    dynamicMsg = '💚 מצב רגשי מצוין — יום מסחר אידיאלי';
  else if (todayTrades.length === 0)
    dynamicMsg = 'כלי המסחר שלך מוכן — תכנן לפני שתיכנס';

  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-2xl mx-auto">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-tg-text">{greeting}, {name}</h1>
          {dynamicMsg && <p className="text-sm text-tg-text-2 mt-0.5">{dynamicMsg}</p>}
        </div>
        <div className="text-right">
          <p className="text-xs text-tg-muted">
            {new Date().toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short' })}
          </p>
          {todayTrades.length > 0 && (
            <p className="text-xs font-medium" style={{ color: 'var(--color-tg-primary)' }}>
              {todayTrades.length} {todayTrades.length > 1 ? 'עסקאות' : 'עסקה'} {'היום'}
            </p>
          )}
        </div>
      </div>

      <DangerMode
        consecutiveLosses={consecutiveLosses}
        emotionalState={Math.round(avgEmotional)}
        dailyLossExceeded={dailyLossExceeded}
        maxDailyLoss={rules?.max_daily_loss ?? null}
        currentLoss={todayLoss}
      />

      {totalTrades > 0 ? (
        <div className="grid grid-cols-3 gap-3">
          <ImpactCard
            label="P&L"
            value={closedWithExit.length > 0 ? (totalPL >= 0 ? `+$${totalPL.toFixed(1)}` : `-$${Math.abs(totalPL).toFixed(1)}`) : '—'}
            color={totalPL >= 0 ? 'var(--color-tg-success)' : 'var(--color-tg-danger)'}
          />
          <ImpactCard
            label="Win Rate"
            value={closedWithExit.length > 0 ? `${winRatePct}%` : '—'}
            color="#60A5FA"
          />
          <ImpactCard
            label="Revenge Cost"
            value={revengeTrades.length === 0 ? '✅ $0' : `-$${revengeLoss.toFixed(1)}`}
            color={revengeTrades.length === 0 ? 'var(--color-tg-success)' : 'var(--color-tg-danger)'}
          />
        </div>
      ) : (
        <Card className="text-center py-8">
          <div className="text-4xl mb-3">📊</div>
          <h3 className="text-base font-semibold text-tg-text mb-1">
            {'הגש את העסקה הראשונה שלך'}
          </h3>
          <p className="text-sm text-tg-text-2">
            {'לחץ על + למטה כדי להתחיל'}
          </p>
        </Card>
      )}

      {totalTrades >= 3 && (
        <TraderIdentityCard profile={traderProfile} />
      )}

      {totalTrades > 0 && (
        <div className="grid grid-cols-3 gap-2">
          <StatChip label={'R:R ממוצע'} value={avgRR} />
          <StatChip label={'מצב רגשי'} value={avgEmotional >= 1 ? `${avgEmotional.toFixed(1)}/5` : '—'} />
          <StatChip label={'עסקאות היום'} value={String(todayTrades.length)} />
        </div>
      )}

      {totalTrades > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-tg-text mb-2">{'רצפים'}</h2>
          <Suspense fallback={<SectionSkeleton h={80} />}>
            <StreakTracker
              disciplineStreak={disciplineStreak}
              noRevengeStreak={noRevengeStreak}
              stopLossStreak={stopLossStreak}
              fullDisciplineStreak={fullDisciplineStreak}
            />
          </Suspense>
        </div>
      )}

      {todayTrades.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-tg-text mb-3">
            {'עסקאות היום'}
          </h2>
          <div className="flex flex-col gap-2">
            {todayTrades.map((trade) => {
              const rrVal = Number(trade.rr_ratio);
              const rrColor = rrVal >= 2 ? 'var(--color-tg-success)' : rrVal >= 1 ? 'var(--color-tg-warning)' : 'var(--color-tg-danger)';
              return (
                <div key={trade.id}
                  className="flex items-center justify-between py-2 border-b border-tg-border last:border-0">
                  <div>
                    <p className="text-sm font-medium text-tg-text">{trade.strategy}</p>
                    <p className="text-xs text-tg-muted">
                      {Number(trade.entry_price).toFixed(2)} → SL {Number(trade.stop_loss).toFixed(2)} → TP {Number(trade.take_profit).toFixed(2)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={trade.status === 'open' ? 'primary' : 'default'}>
                      {trade.status === 'open' ? 'פתוח' : 'סגור'}
                    </Badge>
                    <span className="text-xs font-bold" style={{ color: rrColor }}>
                      1:{rrVal.toFixed(1)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {totalTrades >= 3 && (
        <Suspense fallback={<SectionSkeleton h={120} />}>
          <AICoachCard trades={simpleTrades} />
        </Suspense>
      )}
      {totalTrades >= 5 && (
        <Suspense fallback={<SectionSkeleton h={100} />}>
          <PatternDetection trades={simpleTrades} />
        </Suspense>
      )}

      {closedWithExit.length >= 3 && (
        <div>
          <h2 className="text-sm font-semibold text-tg-text mb-2">{'אנליטיקס'}</h2>
          <TradeHeatmap trades={simpleTrades} />
        </div>
      )}

      {totalTrades > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-tg-text mb-2">{'ביצועים'}</h2>
          <Suspense fallback={<SectionSkeleton h={200} />}>
            <PerformanceSection trades={simpleTrades} plan={(profile?.subscription_tier ?? 'free') as 'free' | 'basic' | 'pro'} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function ImpactCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-2xl p-3 flex flex-col items-center justify-center gap-1 text-center"
      style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}>
      <p className="text-base font-bold leading-tight" style={{ color }}>{value}</p>
      <p className="text-[10px] text-tg-text-2">{label}</p>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl p-2.5 text-center"
      style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}>
      <p className="text-sm font-bold text-tg-text">{value}</p>
      <p className="text-[10px] text-tg-muted mt-0.5">{label}</p>
    </div>
  );
}

function computeStreak(trades: Record<string, unknown>[], type: 'discipline' | 'no_revenge' | 'stop_loss'): number {
  if (trades.length === 0) return 0;
  const s = [...trades].sort((a, b) => new Date(b.submitted_at as string).getTime() - new Date(a.submitted_at as string).getTime());
  let streak = 0;
  for (const t of s) {
    let ok = false;
    if (type === 'discipline') ok = Number(t.emotional_state) >= 3 && Number(t.rr_ratio) >= 1.5;
    if (type === 'no_revenge') ok = Number(t.emotional_state) >= 3;
    if (type === 'stop_loss') ok = t.stop_loss !== null && t.stop_loss !== undefined;
    if (ok) streak++;
    else break;
  }
  return streak;
}
