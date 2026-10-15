import { createClient } from '@/lib/supabase/client';
import { hasMoneyPnl, tradeMoneyPnl } from '@/lib/pnl';
import { visibleTrades } from '@/lib/trades/visible';
import type { RuleContextSource } from '@/lib/types';
import type { SupabaseClient } from '@supabase/supabase-js';
// Type-only, so there is no runtime import cycle: that module imports
// startOfTodayIso() from this one to send the day boundary to the route.
import type { BrokerDayPull } from './brokerDayContext';

/**
 * The one answer to "what has happened to this user's trades that rules care
 * about".
 *
 * Both arms of the rule mechanism used to work this out for themselves, and
 * they disagreed:
 *
 *   - the gate (./fetchActiveRuleViolation.ts) counted money — actual_pnl
 *     falling back to pnl_amount — and treated any negative figure as a loss.
 *   - the trade form (components/trade/TradePlanForm.tsx) counted price
 *     distance, `abs(entry - exit)` for rows where `exit < entry`, and treated
 *     "the stop was hit" as the definition of a loss.
 *
 * Two consequences, both real. The form's figure ignored units and
 * point_value, so it was not currency at all while max_daily_loss and
 * daily_loss_dollar are thresholds in currency — the comparison was in the
 * wrong unit. And because it ignored direction, a PROFITABLE SHORT (exit below
 * entry) counted as a loss. The same user at the same instant could get two
 * different verdicts on the same two preset rules depending on whether the
 * rule was evaluated when the form opened or while it was being filled in.
 *
 * The gate's definition is the correct one, so this module is the gate's
 * arithmetic lifted out whole rather than reimplemented. Money comes from
 * tradeMoneyPnl() in @/lib/pnl, which is already the canonical money P&L for
 * the stats page, the journal, the dashboard and the weekly summary — its own
 * header notes that it shares the gate's precedence. A loss is money lost,
 * regardless of whether the stop was the thing that took it.
 *
 * THE DIVERGENCE WAS THE BUG, NOT THE ARITHMETIC. Nothing in the rule
 * mechanism should derive these numbers for itself again; call this.
 *
 * ONE UNIT LEFT TO FIX, AND REF-99 FIXED IT. The paragraph above says the two
 * sides of the comparison are both in currency, which was true and still not
 * enough: `sumLosses()` added every closed row's loss together while each
 * row's unit lived in its own `pnl_currency`, so a ₪200 loss and a $200 loss
 * both pushed `todayLossAmount` up by 200 and the thresholds they were
 * measured against carried no currency at all. Same family of defect as the
 * original, one level up — both sides money, not the same money. REF-99 made
 * the product dollar-only, so the sum is now in a unit: dollars.
 */

/** Minimal row shape for the money and streak maths. */
interface ClosedTradeRow {
  status: string;
  exit_price: number | string | null;
  pnl_amount: number | string | null;
  actual_pnl: number | string | null;
  closed_at?: string | null;
  fomo_entry?: boolean | null;
  exited_early?: boolean | null;
  moved_sl?: boolean | null;
  /**
   * Which source produced this row (REF-107 Stage 2).
   *
   * Selected only when the connection declares the broker a trade source, so
   * it is `undefined` on every row before migration 034 and the import flag —
   * which is why {@link fromBroker} tests for the value rather than its
   * absence.
   */
  source?: string | null;
}

/** Whether a row came from the broker import rather than from the form. */
function fromBroker(row: { source?: string | null }): boolean {
  return row.source === 'tradovate';
}

/**
 * Today's money.
 *
 * REF-82 shipped this as an array, one entry per currency, because
 * `pnl_amount` was a bare number with its unit in `pnl_currency` and a ₪
 * figure added to a $ figure is a number in no currency at all. REF-99 settled
 * that by making the product dollar-only, so there is one total again and the
 * split is gone — along with the ₪ fallback the panel used when a day spanned
 * both, and the suppressed daily-loss line that came with it.
 */
export interface TodayMoney {
  /** Wins and losses netted, signed. Negative means the day is down. */
  net: number;
  /** Money lost, as a positive number. Gross: winners are not deducted. */
  lost: number;
}

/**
 * What the user's day looks like, for the form's context panel to describe.
 *
 * DISPLAY ONLY. No rule reads any of this, and it must stay that way: these
 * figures are scoped for a sentence a human reads, while the rule thresholds
 * below are deliberately the cruder numbers the gate has always compared
 * against. Two shapes of the same day, for two different jobs.
 *
 * Derived from the same source as the loss threshold beside it — the
 * closed-today query via tradeMoneyPnl(), or the broker's priced round trips
 * when there are any — so the panel cannot tell the user one thing while the
 * rules act on another (REF-82 §4.5). The two move together by construction:
 * they are built in the same branch of loadTradeRuleContext().
 */
export interface TodayClosedSummary {
  /** Plans closed today, whether or not they carry a money figure. */
  count: number;
  /** How many of those lost money. */
  losingCount: number;
  /**
   * Today's money across the closes that carry a figure, or null when none of
   * them do — which is not the same as a day that netted zero.
   */
  money: TodayMoney | null;
}

/** Everything the preset and custom rule checks need from trade history. */
export interface TradeRuleContext {
  /**
   * Trades TAKEN today, counted by submitted_at. No close required — but a plan
   * the user marked 'not_entered' is not a trade taken, and is excluded.
   *
   * ONE TRADE COUNTS ONCE, even when it is in this table twice (REF-107 Stage
   * 2, E8). Once the broker import writes its own rows, a trade the trader also
   * planned is two rows, and adding them fires `max_daily_trades` at half the
   * limit they set. See {@link countDistinctTrades}.
   */
  todayTradeCount: number;
  /**
   * Money lost today, as a positive number, from trades CLOSED today.
   * Dollars, not points — see the header.
   */
  todayLossAmount: number;
  /** Consecutive money-losing trades counting back from the most recent close. */
  lossStreak: number;
  /**
   * Minutes since the most recent trade in that losing streak closed, or null
   * when there is no streak. Only preset_rules.cooldown_after_losses reads it;
   * a custom rule's cooldown_minutes is not enforced against anything.
   */
  minutesSinceLastClose: number | null;
  /** Self-reported flags from the most recently closed trade, for the three
   *  `*_last_trade` custom conditions. Written only by CloseTrade.tsx. */
  lastTradeFomo: boolean;
  lastTradeExitedEarly: boolean;
  lastTradeMovedSl: boolean;

  // ── Not rule inputs: what the day looked like, for the form to say so ──────

  /**
   * Where this view of the user's day came from (REF-82 §6, REF-90).
   *
   * Not derived here and not decidable here: it is the `source` of the
   * {@link BrokerDayPull} this function was handed, passed through unchanged.
   * The route decides it, because the route is the only thing that knows
   * whether Tradovate answered — see lib/rules/brokerDayContext.ts for the
   * mapping and lib/tradovate/errors.ts for why an expiry and a rate limit are
   * not the same claim.
   *
   * It is reported on this one object so that the gate in AppShell and the
   * form cannot disagree about whose day they are looking at, which is the
   * divergence this module exists to have ended (see the header).
   *
   * STILL NOT WRITTEN TO trade_plans.rule_context_source BY THE FORM, and that
   * is now a gap rather than a blocker. Migration 032 IS applied — confirmed in
   * production by Itamar on 13.10 (REF-107 E1) — so the one-line follow-up in
   * the submit path of components/trade/TradePlanForm.tsx is unblocked and has
   * not been done. The broker import does write the column, on the rows it
   * creates (lib/tradovate/import.ts).
   */
  source: RuleContextSource;

  /** Today's closes, shaped for the sentence the panel writes. Display only. */
  todayClosed: TodayClosedSummary;
}

/** Fields every query here needs for tradeMoneyPnl() to be usable. */
const MONEY_FIELDS = 'status, exit_price, pnl_amount, actual_pnl';

/**
 * Midnight this morning, local time, as an ISO timestamp.
 *
 * Exported because the trade form has to ask "which plans are still open from
 * BEFORE today" (REF-82 §5.2) and that question has to use the same seam as
 * "how many trades today", or a plan submitted at 00:30 could be counted
 * against today's limit and simultaneously be offered as yesterday's leftover.
 * One definition, the same reason the rest of this module exists.
 *
 * Local, not UTC: a trading day belongs to the trader's clock, and this runs in
 * their browser. Vercel's UTC would file an 01:00 Tel Aviv plan under yesterday.
 */
export function startOfTodayIso(): string {
  return new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
}

/**
 * Today's closes, totalled, for the panel.
 *
 * Only rows that carry a money figure are counted — hasMoneyPnl(), the same
 * filter the journal and the calendar use. Without it a close with no exit
 * price (so tradeMoneyPnl() returns 0) would drag `money` into existence with
 * a zero total, and the panel would report a balanced day on the strength of a
 * row that holds no money at all.
 */
function summariseTodayCloses(rows: readonly ClosedTradeRow[]): TodayClosedSummary {
  let money: TodayMoney | null = null;
  let losingCount = 0;

  for (const row of rows) {
    if (!hasMoneyPnl(row)) continue;
    const pnl = tradeMoneyPnl(row);
    if (pnl < 0) losingCount++;

    money ??= { net: 0, lost: 0 };
    money.net += pnl;
    if (pnl < 0) money.lost += Math.abs(pnl);
  }

  return { count: rows.length, losingCount, money };
}

/** Money lost today, positive, summed over closed rows. */
function sumLosses(rows: readonly ClosedTradeRow[]): number {
  let total = 0;
  for (const row of rows) {
    const pnl = tradeMoneyPnl(row);
    if (pnl < 0) total += Math.abs(pnl);
  }
  return total;
}

/**
 * How many DISTINCT trades the trader has taken today, when the broker is the
 * declared source (REF-107 Stage 2, §0ה, E8).
 *
 *     max(broker closes today, manual plans taken today)
 *
 * NEVER THE SUM, and that is the whole of this function. E8's decision was
 * "broker trades count, EXACTLY ONCE", and "once" is the operative word: the
 * same trade can appear twice in `trade_plans` — the plan the trader filled in
 * at 10:30 and the row the import wrote when it closed at 11:05 — and adding
 * them blocks a disciplined trader at half the limit they set for themselves.
 *
 * `max` is the right shape because the two numbers MEASURE THE SAME SET from
 * two ends, and neither end sees all of it:
 *
 *   - a plan with no broker close yet (still open, or at another broker) is in
 *     the manual count only;
 *   - an unplanned broker trade is in the broker count only;
 *   - a trade that is both is in both, and `max` counts it once.
 *
 * THIS IS INTERIM, AND THE GAP IS NAMED RATHER THAN PAPERED OVER. It is only
 * correct while the two sets OVERLAP. A trader who takes three trades at
 * Interactive Brokers by hand and two at Tradovate has taken five, and this
 * returns three — because nothing yet says which manual plan belongs to which
 * broker trade. STAGE 3 IS WHAT CLOSES IT: once a plan carries a link to the
 * broker trade it belongs to, the count is "linked pairs + unlinked plans +
 * unlinked broker rows" and is exact.
 *
 * The direction of the interim error is an UNDER-count, which is more permissive
 * — normally the direction this integration refuses. It is chosen here anyway,
 * and deliberately: an over-count locks a trader out of a trade they are
 * entitled to take, with a message that is simply wrong, and §0ה calls that out
 * as a block "on half the limit they defined". A limit that is occasionally too
 * generous for a two-broker trader is the lesser failure, and it is visible to
 * them in the panel rather than silent.
 */
function countDistinctTrades(brokerClosesToday: number, manualTakenToday: number): number {
  return Math.max(brokerClosesToday, manualTakenToday);
}

/**
 * Consecutive losing trades from the most recent close backwards, plus how
 * long ago the streak's latest trade closed.
 *
 * Rows must arrive newest-first. The first non-loss ends the streak, so a
 * winning trade resets it — which is what "רצף הפסדים" means to a trader.
 */
function measureLossStreak(rows: readonly ClosedTradeRow[]): {
  lossStreak: number;
  minutesSinceLastClose: number | null;
} {
  let lossStreak = 0;
  let minutesSinceLastClose: number | null = null;

  for (const row of rows) {
    if (tradeMoneyPnl(row) >= 0) break;
    if (minutesSinceLastClose === null && row.closed_at) {
      minutesSinceLastClose = (Date.now() - new Date(row.closed_at).getTime()) / 60000;
    }
    lossStreak++;
  }

  return { lossStreak, minutesSinceLastClose };
}

/**
 * Load the rule context for one user.
 *
 * Three queries, run together: trades taken today, trades closed today, and
 * the last ten closed trades. The third is capped at ten because a streak long
 * enough to matter is always shorter than that, and every rule that reads it
 * stops at the first non-loss anyway.
 *
 * `client` exists so a caller that already holds a browser client can pass it
 * rather than making a second one; the default is the ordinary browser client,
 * because both callers run in the browser under the user's own RLS.
 *
 *
 * `broker` IS MANDATORY, AND IT COMES SECOND (REF-90)
 * --------------------------------------------------
 *
 * Before the optional `client`, so that no call site can leave it out and
 * silently get Reflect-only enforcement while the other path gets the broker's
 * view. There are two enforcement paths and they must agree; the compiler is
 * the only reviewer that reads every call site. The same move as `apiUrl`
 * beside `accessToken` in lib/tradovate/client.ts, for the same reason.
 *
 * Fetch it with loadBrokerDayPull() from ./brokerDayContext.ts, which caches
 * briefly so that one form opening costs one pull. Pass REFLECT_ONLY from the
 * same module when there is deliberately no broker view to consult.
 *
 *
 * WHAT THE BROKER REPLACES, AND WHAT IT CANNOT
 * -------------------------------------------
 *
 * On `broker_verified` the broker is THE source for everything about closed
 * trades — today's loss total, the streak, the minutes since the streak's last
 * close, and the panel's closed-trade figures. Reflect's own closed rows are
 * not added to them and not compared against them (investigation §6, option
 * A): the same trade recorded in both places would otherwise be counted twice,
 * doubling a loss total and inflating a streak, and nothing links the two
 * records — matching a broker fill to a Reflect plan is REF-80 and is not this.
 *
 * Two figures stay Reflect's in every state, because the broker has no view of
 * them:
 *
 * - **`todayTradeCount`.** It counts trades TAKEN, by `submitted_at`, which is
 *   a plan the trader logged — including one still open and one they later
 *   marked never entered. The broker reports CLOSES. They are different sets
 *   and `max_daily_trades` is about the former, so taking a closed-trade count
 *   as a trades-taken count would under-report the limit the user set.
 *   REF-107 STAGE 2 CHANGES THIS — see below.
 * - **the three `*_last_trade` flags.** FOMO, exiting early and moving a stop
 *   are self-reported in CloseTrade.tsx. No broker knows them.
 *
 * THE RISK THIS ACCEPTS, STATED PLAINLY. A trade the trader closed in Reflect
 * that Tradovate has not paired yet — or closed at a broker Reflect is not
 * connected to — is not in the broker's figures, so a loss total can read lower
 * than what the trader recorded, and a block can lift. That is option A's known
 * cost, chosen over double counting and over `max(reflect, broker)`, whose
 * number is not a number anyone could explain in the panel. It applies ONLY to
 * `broker_verified`; the three other states fall through to Reflect's figures
 * below, so a broker that is expired or unreachable can never unblock anybody.
 *
 *
 * `isTradeSource` — WHAT BREAKS ONCE BROKER TRADES ARE ROWS (REF-107 Stage 2)
 * --------------------------------------------------------------------------
 *
 * Everything above rests on one assumption: THAT THE BROKER'S TRADES AND
 * `trade_plans` ARE TWO SEPARATE SETS. REF-107 Stage 2 ends that — the import
 * writes a broker trade into this very table — and the assumption's failure is
 * not academic. Two things go wrong the moment the first row lands:
 *
 *   1. The closed-today query starts returning the BROKER'S OWN ROWS. On
 *      `broker_verified` that is harmless, because the broker's live figures
 *      replace the query's. In the two failure states it is not: a manual row
 *      the trader also logged for the same trade is counted beside the imported
 *      one, and `todayLossAmount` reads double. Double-counting a loss blocks a
 *      trader over money they did not lose, which ./accounts.ts names as the
 *      worst failure available in this integration.
 *   2. `todayTradeCount` counts BOTH the imported row and the plan the trader
 *      filled in for the same trade — §0ה of the investigation — so
 *      `max_daily_trades` fires at HALF the limit the trader set. That is the
 *      sharpest consequence REF-107 has on existing behaviour, and the
 *      investigation is explicit that it cannot be deferred to a later stage
 *      than the writing itself.
 *
 * E7's answer is a PER-BROKER DECLARATION rather than a per-trade match (§C8
 * option ג): the trader says "Tradovate is the source of trades for this
 * account", and from there the broker's rows are canonical. That declaration
 * arrives here as `broker.isTradeSource`, and it does two things:
 *
 * - **Closed money and the streak count BROKER ROWS ONLY.** A manual row
 *   closed the same day stays in the journal, in the stats and in the
 *   calendar — it is the trader's record and nothing deletes it — but it is
 *   excluded from `todayLossAmount` and from the loss streak, because under the
 *   declaration it is either the same trade the broker already reported or a
 *   plan waiting to be linked to one (Stage 3). Option A is unchanged: on
 *   `broker_verified` the broker's live figures still replace the query's. What
 *   the filter fixes is the FALLBACK states, where the query is the answer.
 * - **`todayTradeCount` becomes `max(broker closes today, manual plans taken
 *   today)`** — see {@link countDistinctTrades}.
 *
 * WHAT THE THREE `*_last_trade` FLAGS DO NOT DO is get filtered. They are read
 * off the most recent closed row of ANY source, exactly as before. Filtering
 * them to broker rows would read `false` for every trader until Stage 3
 * collects those flags on an imported trade — and `false` is the PERMISSIVE
 * answer for a `fomo_last_trade` custom rule. A flag the trader self-reported
 * on a row they closed by hand is still the most recent thing they told us
 * about their own behaviour.
 */
export async function loadTradeRuleContext(
  userId: string,
  broker: BrokerDayPull,
  client: SupabaseClient = createClient()
): Promise<TradeRuleContext> {
  const todayStart = startOfTodayIso();

  // E7's declaration, from the route. See the header.
  //
  // IT IS ALSO WHAT KEEPS THE DEPLOY ORDER FREE. `source` is a column migration
  // 034 adds, and naming it in a select before that file has been run is a
  // PostgREST 42703 that takes the whole rule check down. The route only reports
  // `true` when TRADOVATE_IMPORT_ENABLED is '1', which the owner sets AFTER
  // running 034 — so when this is false, every query below is byte-identical to
  // the one that shipped before Stage 2, and when it is true the columns exist.
  //
  // IT ALSO GATES `hidden`, which is a slightly different question and is worth
  // naming. A row the trader deleted must not count toward a rule (E12), and
  // the only rows that can be hidden are imported ones — a manual row is still
  // a real DELETE. So in practice the two gates coincide. THE ONE CASE THEY DO
  // NOT: a trader who imported rows, hid some, and then turned the declaration
  // off would have those hidden rows counted again. There is no UI that can do
  // that yet (migration 034 grants SELECT on the column and no UPDATE policy),
  // and closing it properly means a second boolean on the pull for "the columns
  // exist" — which is worth adding the day the toggle ships, and not before.
  const brokerIsSource = broker.isTradeSource === true;

  const [takenRes, closedTodayRes, recentRes] = await Promise.all([
    // Taken today — by submitted_at, so a plan counts the moment it is logged
    // whether or not it has been closed.
    //
    // Except a plan the user has told us they never entered. Without the neq a
    // 'not_entered' row would be counted against max_daily_trades and
    // daily_trades_count: the user declares they stayed out, and the app spends
    // one of their day's trades on it. The other two queries below already
    // exclude it by asking for status = 'closed'; this one asked for every row.
    client
      .from('trade_plans')
      // `source` only when there can be imported rows to tell apart. Three
      // characters, and they are the difference between a query that works on
      // every database and one that needs migration 034 — see `brokerIsSource`.
      .select(brokerIsSource ? 'id, source, hidden' : 'id')
      .eq('user_id', userId)
      .neq('status', 'not_entered')
      .gte('submitted_at', todayStart),
    // Closed today — by closed_at, because the loss is realised on the close,
    // not on the entry. A trade opened yesterday and closed today counts today.
    //
    // REF-82 also selected pnl_currency here, to split the panel's totals per
    // currency. REF-99 made the product dollar-only, so there is nothing to
    // split on and the column is no longer read. The panel and the loss
    // threshold still come off this one query (§4.5).
    client
      .from('trade_plans')
      .select(brokerIsSource ? `${MONEY_FIELDS}, source, hidden` : MONEY_FIELDS)
      .eq('user_id', userId)
      .eq('status', 'closed')
      .gte('closed_at', todayStart),
    client
      .from('trade_plans')
      .select(
        brokerIsSource
          ? `${MONEY_FIELDS}, closed_at, fomo_entry, exited_early, moved_sl, source, hidden`
          : `${MONEY_FIELDS}, closed_at, fomo_entry, exited_early, moved_sl`
      )
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      // Ten is the streak window, and it is ten TRADES rather than ten rows
      // once the broker is the source: the filter below drops this user's
      // manual closes, so a window of ten could leave three broker rows to
      // measure a streak over. Doubled rather than widened further — a streak
      // long enough to matter is shorter than ten (the reason the cap is ten at
      // all), and twenty is enough slack for a day logged in both places. The
      // filter is applied AFTER the order, so the newest broker close is still
      // the newest broker close.
      .limit(brokerIsSource ? 20 : 10),
  ]);

  // Through `unknown`, and that is the price of the conditional select above.
  // supabase-js parses a select string AT THE TYPE LEVEL to infer the row
  // shape, and it cannot do that for a value chosen at runtime — both branches
  // come back as `ParserError`, so a direct cast is rejected. The shape is
  // asserted here instead, which is what the previous literal selects were
  // doing anyway: `ClosedTradeRow` was always a hand-written claim about these
  // three queries and never inferred from them.
  const closedTodayAll = visibleTrades((closedTodayRes.data ?? []) as unknown as ClosedTradeRow[]);
  const recentAll = visibleTrades((recentRes.data ?? []) as unknown as ClosedTradeRow[]);

  // THE DE-DUPLICATION, AND IT IS TWO LINES BECAUSE THE DECISION WAS MADE
  // PER-BROKER RATHER THAN PER-TRADE (E7). Under the declaration a manual close
  // on a day the broker also reported is either the same trade or a plan waiting
  // to be linked to one, so it is not a second close. It keeps its place in the
  // journal, the stats and the calendar; it leaves the money and the streak.
  const closedToday = brokerIsSource ? closedTodayAll.filter(fromBroker) : closedTodayAll;
  const recent = brokerIsSource ? recentAll.filter(fromBroker) : recentAll;

  // NOT FILTERED, on purpose. The three self-reported flags come off the most
  // recent closed row of any source — see the header. Filtering them would read
  // `false` until Stage 3 collects them on an imported trade, and `false` is
  // the permissive answer for a `*_last_trade` rule.
  const lastTrade = recentAll[0];

  const { lossStreak, minutesSinceLastClose } = measureLossStreak(recent);

  // Trades taken today. Without the declaration this is every row the query
  // returned, exactly as before. With it, the imported rows and the plans are
  // two views of one set and `countDistinctTrades` reconciles them — the plans
  // here, the broker's closes from `closedToday` just above, which is the
  // stored answer and is replaced by the live one in the verified branch below.
  const taken = visibleTrades((takenRes.data ?? []) as unknown as { source?: string | null }[]);
  const manualTakenToday = brokerIsSource
    ? taken.filter((row) => !fromBroker(row)).length
    : taken.length;

  // Reflect's own answer, which is the whole answer in three of the four
  // source states — and the floor under the fourth, for the two figures no
  // broker can produce.
  const context: TradeRuleContext = {
    todayTradeCount: brokerIsSource
      ? countDistinctTrades(closedToday.length, manualTakenToday)
      : manualTakenToday,
    todayLossAmount: sumLosses(closedToday),
    lossStreak,
    minutesSinceLastClose,
    lastTradeFomo: !!lastTrade?.fomo_entry,
    lastTradeExitedEarly: !!lastTrade?.exited_early,
    lastTradeMovedSl: !!lastTrade?.moved_sl,
    source: broker.source,
    todayClosed: summariseTodayCloses(closedToday),
  };

  // 'broker_expired', 'broker_unavailable' and 'reflect_only' all land here:
  // the figures are Reflect's and `source` says so, which is the failure policy
  // in one line. A broker we could not reach must not be able to lift a block
  // the user's own records put them under, so there is nothing to zero and
  // nothing to clear — the honest fallback is the data we already have. After
  // Stage 2 that data INCLUDES the broker's own imported rows, which is why the
  // filter above matters most on exactly this path.
  if (broker.source !== 'broker_verified') return context;

  const day = broker.day;

  return {
    ...context,
    // The live count replaces the stored one on the trades-taken side too: the
    // broker has just told us how many round trips closed today, which is a
    // better number than counting the rows the last import happened to write.
    // `max` against the plans is unchanged — see countDistinctTrades.
    todayTradeCount: brokerIsSource
      ? countDistinctTrades(day.closedCount, manualTakenToday)
      : context.todayTradeCount,
    todayLossAmount: day.lost,
    lossStreak: day.lossStreak,
    minutesSinceLastClose: day.minutesSinceLastClose,
    todayClosed: {
      count: day.closedCount,
      losingCount: day.losingCount,
      // Every priced round trip carries a figure, so `money` is absent exactly
      // when there were no closes — unlike the Reflect query, where a close
      // with no exit price is a row that carries no money at all.
      money: day.closedCount > 0 ? { net: day.net, lost: day.lost } : null,
    },
  };
}
