import { createClient, getCachedUser } from '@/lib/supabase/server';
import JournalExport from '@/components/journal/JournalExport';
import JournalClient from '@/components/journal/JournalClient';
import BrokerSyncButton, { ReflectOnlyNote } from '@/components/tradovate/BrokerSyncButton';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades } from '@/lib/trades/visible';

export const metadata = { title: 'כל העסקאות — Reflect' };

export default async function TradesPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  // THE ONE PAGE THAT KEEPS 'not_entered' ROWS. Every other reader excludes
  // them at the query (REF-82 §5.2) because they are not trades; this page's
  // job is to show the user what they recorded, and deciding not to enter a
  // plan is something they recorded. JournalClient renders them under "הכל"
  // only, with their own label, and leaves them out of its own total.
  //
  // The two counts below need no filter: both are exact matches, so a
  // 'not_entered' plan is in neither "פתוחות" nor "סגורות", which is correct —
  // it is neither.
  const [{ data: trades }, { data: violations }] = await Promise.all([
    supabase
      .from('trade_plans')
      .select('*')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(1000),
    supabase
      .from('rule_violations')
      .select('trade_plan_id')
      .eq('user_id', user.id)
      .not('trade_plan_id', 'is', null),
  ]);

  const violatedIds = new Set((violations ?? []).map((v) => v.trade_plan_id as string));

  // A row the trader deleted is gone from the journal (REF-107 E12). This page
  // reads select('*'), so the column arrives for free and the filter is the
  // whole change — see lib/trades/visible.ts on why it is not a DELETE.
  const allTrades = visibleTrades(trades ?? []).map((t) => ({
    id:               t.id               as string,
    strategy:         t.strategy         as string,
    symbol:           (t.symbol          as string | null) ?? null,
    entry_price:      Number(t.entry_price),
    stop_loss:        Number(t.stop_loss),
    take_profit:      Number(t.take_profit),
    rr_ratio:         Number(t.rr_ratio),
    emotional_state:  Number(t.emotional_state),
    trade_reason:     t.trade_reason     as string,
    status:           t.status           as string,
    exit_price:       t.exit_price != null ? Number(t.exit_price) : null,
    exit_reason:      t.exit_reason      as string | null,
    post_trade_notes: t.post_trade_notes as string | null,
    debrief_answer:   t.debrief_answer   as string | null,
    submitted_at:     t.submitted_at     as string,
    closed_at:        t.closed_at        as string | null,
    plan_score:       t.plan_score       as number | null,
    quantity:         t.quantity != null ? Number(t.quantity) : null,
    units:            t.units != null ? Number(t.units) : null,
    point_value:      t.point_value != null ? Number(t.point_value) : null,
    direction:        (t.direction as 'long' | 'short' | null) ?? null,
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
    actual_pnl:       t.actual_pnl != null ? Number(t.actual_pnl) : null,
    pnl_currency:     (t.pnl_currency as string | null) ?? null,
    has_rule_violation: violatedIds.has(t.id as string),
    // ── Provenance, from migration 034 (REF-107 Stage 2) ──────────────────
    //
    // `?? null` and `=== true` rather than a cast, because `select('*')` above
    // returns NO KEY AT ALL on a database where 034 has not been run. The row
    // then reads as a manual, unplanned-false, not-hidden trade, which is
    // exactly what every row in such a database is.
    source:           (t.source as string | null) ?? null,
    unplanned:        t.unplanned === true,
    broker_host:      (t.broker_host as string | null) ?? null,
    hidden:           t.hidden === true,
    // ── The stored AI debrief, from migration 036 (REF-107 Stage 3a) ──────
    //
    // Same `?? null` rule and the same reason: `select('*')` returns no key
    // at all before 036 has been run, and a row without one has no debrief —
    // which is the truth about every row in such a database.
    debrief_ai:           t.debrief_ai ?? null,
    debrief_generated_at: (t.debrief_generated_at as string | null) ?? null,
  }));

  const exportTrades = allTrades.map((t) => ({
    submitted_at:    t.submitted_at,
    strategy:        t.strategy,
    entry_price:     t.entry_price,
    stop_loss:       t.stop_loss,
    take_profit:     t.take_profit,
    rr_ratio:        t.rr_ratio,
    emotional_state: t.emotional_state,
    trade_reason:    t.trade_reason,
    status:          t.status,
    debrief_answer:  t.debrief_answer,
  }));

  // Both halves are server-only — allowlist.ts reads an environment variable
  // and isImportEnabled() reads the flag — so this is the only place the
  // decision can be made, and the same precedent dashboard/page.tsx set with
  // `canConnectBroker`. A trader who fails either gets the E16 sentence where
  // the button would be, rather than a button that can only tell them no.
  const canSync = isUserAllowed(user.id) && isImportEnabled();

  // THE LIST DOES NOT TRACK ITS PROP. JournalClient seeds useState(trades) and
  // never syncs a new one, so router.refresh() after a sync re-renders this
  // file and changes nothing the trader can see — which is why "רענן נתונים"
  // in its own menu has been a no-op. Remounting on a `key` is the one-line
  // fix; the real one (deletions and edits as an overlay over the prop) is a
  // refactor and a separate ticket.
  //
  // DERIVED FROM WHAT THE SERVER SAW, which is the part that matters: a sync
  // that inserted rows moves both halves, so the list rebuilds. The rows are
  // ordered submitted_at desc above, so [0] is the newest.
  const listKey = `${allTrades.length}:${allTrades[0]?.submitted_at ?? 'empty'}`;

  return (
    <div dir="rtl" className="px-4 py-5 flex flex-col gap-4 md:max-w-none">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-tg-text">כל העסקאות</h1>
          <p className="text-xs text-tg-muted mt-0.5">
            {allTrades.filter((t) => t.status === 'open').length} פתוחות ·{' '}
            {allTrades.filter((t) => t.status === 'closed').length} סגורות
          </p>
        </div>
        <div className="flex items-start gap-2">
          {canSync ? <BrokerSyncButton userId={user.id} refreshOnChange /> : <ReflectOnlyNote />}
          <JournalExport trades={exportTrades} />
        </div>
      </div>
      <JournalClient key={listKey} trades={allTrades} />
    </div>
  );
}
