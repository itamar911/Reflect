import { createClient } from '@/lib/supabase/server';
import Card from '@/components/ui/Card';
import Badge from '@/components/ui/Badge';
import PerformanceSection from '@/components/dashboard/PerformanceSection';

export const metadata = { title: 'דשבורד — Reflekt' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [profileRes, todayTradesRes, allTradesRes] = await Promise.all([
    supabase.from('profiles').select('display_name, trading_type').eq('id', user.id).single(),
    supabase.from('trade_plans').select('*').eq('user_id', user.id).gte('submitted_at', today.toISOString()),
    supabase.from('trade_plans').select('id, status, emotional_state, rr_ratio, strategy, submitted_at').eq('user_id', user.id).order('submitted_at', { ascending: false }).limit(50),
  ]);

  const profile = profileRes.data;
  const todayTrades = todayTradesRes.data ?? [];
  const allTrades = allTradesRes.data ?? [];

  const totalTrades = allTrades.length;
  const avgRR = totalTrades > 0
    ? (allTrades.reduce((sum, t) => sum + (t.rr_ratio || 0), 0) / totalTrades).toFixed(2)
    : '—';
  const avgEmotional = totalTrades > 0
    ? (allTrades.reduce((sum, t) => sum + (t.emotional_state || 0), 0) / totalTrades).toFixed(1)
    : '—';

  const simpleTrades = allTrades.map((t) => ({
    strategy: (t.strategy as string) || '',
    emotional_state: (t.emotional_state as number) || 3,
    rr_ratio: (t.rr_ratio as number) || 0,
    submitted_at: t.submitted_at as string,
  }));

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'בוקר טוב' : hour < 17 ? 'אחה"צ טוב' : 'ערב טוב';
  const name = profile?.display_name?.split(' ')[0] ?? 'סוחר';

  return (
    <div className="px-4 py-5 flex flex-col gap-5 max-w-2xl mx-auto">
      {/* Greeting */}
      <div>
        <h1 className="text-xl font-bold text-tg-text">{greeting}, {name} 👋</h1>
        <p className="text-sm text-tg-text-2 mt-0.5">
          {todayTrades.length === 0
            ? 'לא הגשת תוכניות עסקה היום עדיין'
            : `הגשת ${todayTrades.length} תוכנית${todayTrades.length > 1 ? 'ות' : ''} היום`}
        </p>
      </div>

      {/* Discipline Score placeholder */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-tg-text">ציון משמעת</h2>
          <Badge variant="primary">בקרוב</Badge>
        </div>
        {totalTrades === 0 ? (
          <div className="text-center py-4">
            <div className="text-4xl mb-2">🎯</div>
            <p className="text-sm text-tg-text-2 mb-3">הציון שלך יחושב לאחר העסקה הראשונה</p>
          </div>
        ) : (
          <div className="flex items-center gap-4 mb-3">
            <div className="relative w-20 h-20">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--color-tg-surface-2)" strokeWidth="3" />
                <circle
                  cx="18" cy="18" r="15.9" fill="none"
                  stroke="var(--color-tg-primary)" strokeWidth="3"
                  strokeDasharray="75 100"
                  strokeLinecap="round"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-lg font-bold text-tg-text">75</span>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium text-tg-text">בדרך הנכונה!</p>
              <p className="text-xs text-tg-text-2">יש עוד מקום לשיפור</p>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5 pt-3 border-t border-tg-border">
          <p className="text-xs font-medium text-tg-text-2 mb-1">איך מחושב הציון:</p>
          {[
            ['הגשת תוכנית לפני כניסה', '25'],
            ['Stop Loss לא הוזז', '25'],
            ['R:R בוצע לפי התוכנית', '20'],
            ['לא חרגת ממקסימום עסקאות', '15'],
            ['יציאה לפי התוכנית המקורית', '15'],
          ].map(([label, pts]) => (
            <div key={label} className="flex items-center justify-between">
              <span className="text-xs text-tg-muted">{label}</span>
              <span className="text-xs font-semibold" style={{ color: 'var(--color-tg-primary)' }}>{pts} נק׳</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="עסקאות היום" value={String(todayTrades.length)} />
        <StatCard label="R:R ממוצע" value={avgRR} />
        <StatCard label="מצב רגשי" value={avgEmotional === '—' ? '—' : `${avgEmotional}/5`} />
      </div>

      {/* Today's trades */}
      {todayTrades.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-tg-text mb-3">עסקאות היום</h2>
          <div className="flex flex-col gap-2">
            {todayTrades.map((trade) => (
              <div key={trade.id}
                className="flex items-center justify-between py-2 border-b border-tg-border last:border-0">
                <div>
                  <p className="text-sm font-medium text-tg-text">{trade.strategy}</p>
                  <p className="text-xs text-tg-muted">
                    כניסה: {Number(trade.entry_price).toFixed(2)} | SL: {Number(trade.stop_loss).toFixed(2)} | TP: {Number(trade.take_profit).toFixed(2)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={trade.status === 'open' ? 'primary' : 'default'}>
                    {trade.status === 'open' ? 'פתוח' : 'סגור'}
                  </Badge>
                  <span className="text-xs font-medium"
                    style={{ color: trade.rr_ratio >= 2 ? 'var(--color-tg-success)' : 'var(--color-tg-warning)' }}>
                    R:R {Number(trade.rr_ratio).toFixed(1)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Call to action */}
      {totalTrades === 0 && (
        <Card className="text-center py-8">
          <div className="text-4xl mb-3">📊</div>
          <h3 className="text-base font-semibold text-tg-text mb-1">הגש את העסקה הראשונה שלך</h3>
          <p className="text-sm text-tg-text-2 mb-4">לחץ על כפתור + למטה כדי להתחיל</p>
        </Card>
      )}

      {/* Performance Dashboard */}
      {totalTrades > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-base font-bold text-tg-text">לוח ביצועים</h2>
          <PerformanceSection trades={simpleTrades} plan="free" />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-tg-border p-3 text-center"
      style={{ background: 'var(--color-tg-surface)' }}>
      <p className="text-lg font-bold text-tg-text">{value}</p>
      <p className="text-xs text-tg-muted mt-0.5">{label}</p>
    </div>
  );
}
