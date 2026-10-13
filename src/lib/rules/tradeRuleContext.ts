import { createClient } from '@/lib/supabase/client';
import { hasMoneyPnl, tradeMoneyPnl } from '@/lib/pnl';
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
  /** Trades TAKEN today, counted by submitted_at. No close required — but a
   *  plan the user marked 'not_entered' is not a trade taken, and is excluded. */
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
   * STILL NOT WRITTEN TO trade_plans.rule_context_source. Migration 032 adds
   * that column and is run by hand; until the owner has run it, an insert
   * naming the column fails and takes the trade plan with it. The value is
   * live and on screen, and persisting it is a one-line follow-up once 032 is
   * confirmed applied — see the submit path in
   * components/trade/TradePlanForm.tsx.
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
 */
export async function loadTradeRuleContext(
  userId: string,
  broker: BrokerDayPull,
  client: SupabaseClient = createClient()
): Promise<TradeRuleContext> {
  const todayStart = startOfTodayIso();

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
      .select('id')
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
      .select(MONEY_FIELDS)
      .eq('user_id', userId)
      .eq('status', 'closed')
      .gte('closed_at', todayStart),
    client
      .from('trade_plans')
      .select(`${MONEY_FIELDS}, closed_at, fomo_entry, exited_early, moved_sl`)
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(10),
  ]);

  const closedToday = (closedTodayRes.data ?? []) as ClosedTradeRow[];
  const recent = (recentRes.data ?? []) as ClosedTradeRow[];
  const lastTrade = recent[0];

  const { lossStreak, minutesSinceLastClose } = measureLossStreak(recent);

  // Reflect's own answer, which is the whole answer in three of the four
  // source states — and the floor under the fourth, for the two figures no
  // broker can produce.
  const context: TradeRuleContext = {
    todayTradeCount: takenRes.data?.length ?? 0,
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
  // nothing to clear — the honest fallback is the data we already have.
  if (broker.source !== 'broker_verified') return context;

  const day = broker.day;

  return {
    ...context,
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
