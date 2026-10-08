import { createClient } from '@/lib/supabase/client';
import { tradeMoneyPnl } from '@/lib/pnl';
import type { SupabaseClient } from '@supabase/supabase-js';

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

/** Everything the preset and custom rule checks need from trade history. */
export interface TradeRuleContext {
  /** Trades TAKEN today, counted by submitted_at. No close required. */
  todayTradeCount: number;
  /**
   * Money lost today, as a positive number, from trades CLOSED today.
   * Currency, not points — see the header.
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
}

/** Fields every query here needs for tradeMoneyPnl() to be usable. */
const MONEY_FIELDS = 'status, exit_price, pnl_amount, actual_pnl';

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
 */
export async function loadTradeRuleContext(
  userId: string,
  client: SupabaseClient = createClient()
): Promise<TradeRuleContext> {
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

  const [takenRes, closedTodayRes, recentRes] = await Promise.all([
    // Taken today — by submitted_at, so a plan counts the moment it is logged
    // whether or not it has been closed.
    client.from('trade_plans').select('id').eq('user_id', userId).gte('submitted_at', todayStart),
    // Closed today — by closed_at, because the loss is realised on the close,
    // not on the entry. A trade opened yesterday and closed today counts today.
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

  return {
    todayTradeCount: takenRes.data?.length ?? 0,
    todayLossAmount: sumLosses(closedToday),
    lossStreak,
    minutesSinceLastClose,
    lastTradeFomo: !!lastTrade?.fomo_entry,
    lastTradeExitedEarly: !!lastTrade?.exited_early,
    lastTradeMovedSl: !!lastTrade?.moved_sl,
  };
}
