import { createClient, getCachedUser } from '@/lib/supabase/server';
import JournalExport from '@/components/journal/JournalExport';
import JournalClient from '@/components/journal/JournalClient';
import BrokerSyncButton, { ReflectOnlyNote } from '@/components/tradovate/BrokerSyncButton';
import AccountFilterChip from '@/components/accounts/AccountFilterChip';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { isImportEnabled } from '@/lib/tradovate/import';
import { visibleTrades, withAccount } from '@/lib/trades/visible';
import { resolveAccountParam, type RawSearchParams } from '@/lib/portfolios/filter';
import { readPortfolioLabel } from '@/lib/portfolios/read';
import { isQueuedBrokerRow } from '@/lib/journal/link';
import { intentNumber, intentText, rrValue, scaleValue } from '@/lib/intent';

export const metadata = { title: 'כל העסקאות — Reflect' };

export default async function TradesPage({ searchParams }: {
  /** A PROMISE on Next 16, and awaiting it is not optional — reading it
   *  synchronously is a build error, not a warning. It also opts this route
   *  out of static rendering, which it already was: it reads a session. */
  searchParams: Promise<RawSearchParams>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) return null;

  // ── ?account= — the opt-in portfolio view (REF-110 Stage 5) ──────────────
  //
  // SERVER-SIDE, and that is forced rather than chosen: the query below takes
  // .limit(1000) BEFORE anything filters, so an in-memory filter would show a
  // trader with 1,400 trades across three accounts whatever subset of one
  // account happened to fall inside the newest thousand rows — fewer trades
  // than the account holds, with nothing on the page saying so.
  const accountId = resolveAccountParam((await searchParams).account, isImportEnabled());
  const accountLabel = await readPortfolioLabel(supabase, user.id, accountId);

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
    withAccount(
      supabase
        .from('trade_plans')
        .select('*')
        .eq('user_id', user.id),
      accountId,
    )
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
    // ── THE INTENT COLUMNS GO THROUGH lib/intent.ts (REF-107 unlink fix) ───
    //
    // `Number(null)` IS 0, NOT NaN, and that is the whole bug. These five
    // read `Number(t.stop_loss)` and friends, so a broker row — which carries
    // none of them — arrived here as a plan with a stop of 0.00, a target of
    // 0.00, an R:R of 0 and an emotional state of 0/5. The detail modal then
    // rendered "Stop Loss 0.00" and "מצב רגשי 0/5": not a missing value, a
    // STATED one, and a wrong one.
    //
    // Every reader downstream was already correct — the modal tests
    // `!= null`, the edit form tests `!= null`, the CSV writes an empty cell
    // for null — so this one `.map()` was the only thing manufacturing the
    // zeroes, and it manufactured them before any of them could tell.
    //
    // lib/intent.ts is the module Stage 4 built for exactly this hazard, and
    // its header names this coercion as the thing it exists to prevent. This
    // mapping simply never used it. `rrValue` and `scaleValue` also drop a
    // value outside the column's own CHECK, which `Number()` would have
    // passed through.
    //
    // THE CSV WAS WRONG TOO, and nobody had reported that: `exportTrades`
    // below is built from these fields, so a broker row exported "0" in the
    // Stop Loss column where `numberCell(null)` would have written nothing.
    strategy:         intentText(t.strategy as string | null),
    symbol:           (t.symbol          as string | null) ?? null,
    entry_price:      Number(t.entry_price),
    stop_loss:        intentNumber(t.stop_loss as number | string | null),
    take_profit:      intentNumber(t.take_profit as number | string | null),
    rr_ratio:         rrValue(t.rr_ratio as number | string | null),
    emotional_state:  scaleValue(t.emotional_state as number | string | null),
    trade_reason:     intentText(t.trade_reason as string | null),
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
    // ── The link bookkeeping, from migration 035 (REF-107 Stage 3b) ───────
    //
    // Same `?? null` rule, third time, same reason. A row from before 035
    // has neither key, and `link_confirmed_at: null` on a `tradovate` row
    // with `unplanned: true` reads as "waiting to be assigned" — which is
    // the truth about every row the import has written since 15.10.
    link_confirmed_at: (t.link_confirmed_at as string | null) ?? null,
    link_method:       (t.link_method as string | null) ?? null,
    // ── The broker's stop, from migration 038 (REF-113 Stage 5) ───────────
    //
    // Same `?? null` rule, fourth time, same reason — and THIS MAP IS WHY THE
    // RULE HAS TO BE RESTATED RATHER THAN ASSUMED. `select('*')` above returns
    // every column the database has, but this object is built FIELD BY FIELD,
    // so a column nobody names here never reaches the component. The detail
    // modal's stop row and its sentence then read null and render nothing —
    // which looks exactly like a database where 038 has not been run, so it is
    // a feature silently missing rather than anything that fails. It cost a
    // Playwright run to notice, which is the only way it could have been
    // noticed: every unit assertion about those strings passes either way.
    //
    // `stop_history` IS PASSED THROUGH UNTYPED, deliberately. It is JSONB with
    // no CHECK, and `readStopHistory` in lib/journal/stopHistory.ts validates
    // every field it reads; a cast here would be a second, unchecked claim
    // about the same document.
    broker_stop_loss:   t.broker_stop_loss != null ? Number(t.broker_stop_loss) : null,
    broker_take_profit: t.broker_take_profit != null ? Number(t.broker_take_profit) : null,
    stop_history:       t.stop_history ?? null,
    // ── The pieces the position was taken in, from migration 040 ──────────
    //
    // Same `?? null` rule, fifth time, and named HERE for the fourth time's
    // reason: this object is built field by field, so a column nobody names
    // never reaches the component however wide the `select('*')` above is.
    // Untyped, like `stop_history` beside it — `readTradeStages` in
    // lib/journal/stages.ts validates every field it reads, and a cast here
    // would be a second, unchecked claim about the same document.
    broker_stages:      t.broker_stages ?? null,
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

  // THE QUEUE, COUNTED ON THE SERVER (REF-107 Stage 3b, §C). The rows are
  // already here — `select('*')` above — so this is a filter over an array and
  // not a query, which is what makes the banner free. `visibleTrades` has
  // already dropped the hidden ones; `isQueuedBrokerRow` checks the predicate
  // again anyway, because the queue's definition lives in one place and two
  // readers must not be able to disagree about it.
  //
  // It is derived here rather than inside JournalClient so that the count is a
  // fact about what the server saw, in the same render that produced the list
  // the banner points at.
  const queueCount = allTrades.filter(isQueuedBrokerRow).length;

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
          {/* The CSV inherits the filter, because it is built from the rows
              above (REF-110 §D.3). Stated in the button's own tooltip rather
              than left to be discovered: "export is always everything" is
              also a defensible reading, and silently picking one is how a
              support ticket is born. */}
          <JournalExport trades={exportTrades} accountLabel={accountLabel} />
        </div>
      </div>
      {accountLabel !== null && (
        <AccountFilterChip label={accountLabel} clearHref="/trades" />
      )}
      <JournalClient key={listKey} trades={allTrades} queueCount={queueCount} />
    </div>
  );
}
