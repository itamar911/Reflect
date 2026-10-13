import { createClient } from '@/lib/supabase/client';
import { hasMoneyPnl, tradeMoneyPnl } from '@/lib/pnl';
import type { PnlCurrency, RuleContextSource } from '@/lib/types';
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
  /** Selected only by the closed-today query, for the panel's display totals. */
  pnl_currency?: string | null;
}

/**
 * Today's money in ONE currency.
 *
 * Per currency, and never summed across them, because `pnl_amount` is a bare
 * number with its unit in a second column: a ₪ figure and a $ figure added
 * together produce a number that is in no currency at all. The rule thresholds
 * do exactly that (see `todayLossAmount` below) and that is a known defect, not
 * a pattern to copy — REF-99 settles it by making the product dollar-only.
 * Until then the panel shows each currency on its own.
 */
export interface TodayMoneyInCurrency {
  currency: PnlCurrency;
  /** Wins and losses netted, signed. Negative means the day is down. */
  net: number;
  /** Money lost, as a positive number. Gross: winners are not deducted. */
  lost: number;
}

/**
 * What the user's day looks like, for the form's context panel to describe.
 *
 * DISPLAY ONLY. No rule reads any of this, and it must stay that way: these
 * figures are scoped and split for a sentence a human reads, while the rule
 * thresholds below are deliberately the cruder numbers the gate has always
 * compared against. Two shapes of the same day, for two different jobs.
 *
 * Derived from the same closed-today query the loss threshold uses, via the
 * same tradeMoneyPnl() — so the panel cannot tell the user one thing while the
 * rules act on another (REF-82 §4.5).
 */
export interface TodayClosedSummary {
  /** Plans closed today, whether or not they carry a money figure. */
  count: number;
  /** How many of those lost money. */
  losingCount: number;
  /**
   * One entry per currency appearing among today's money-bearing closes, in a
   * fixed order so the panel does not reshuffle between loads. Empty when
   * nothing closed today carries a money figure.
   */
  money: readonly TodayMoneyInCurrency[];
}

/** Everything the preset and custom rule checks need from trade history. */
export interface TradeRuleContext {
  /** Trades TAKEN today, counted by submitted_at. No close required — but a
   *  plan the user marked 'not_entered' is not a trade taken, and is excluded. */
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

  // ── Not rule inputs: what the day looked like, for the form to say so ──────

  /**
   * Where this view of the user's day came from (REF-82 §6).
   *
   * ALWAYS 'reflect_only' TODAY, and hardcoded rather than derived, because it
   * is the truth: the broker pull layer does not exist. The form can only judge
   * what the user recorded in Reflect, so that is what it declares.
   *
   * >>> THIS IS WHERE REF-90 CONNECTS THE BROKER DATA. <<<
   *
   * REF-90 fetches today's executed trades from Tradovate when the form opens
   * (§2.4 — one REST call, on demand, no cron and no socket) and merges them
   * into the figures above. It sets this field to what actually happened:
   * 'broker_verified' when the fetch returned, 'broker_expired' when the
   * connection had lapsed, 'broker_unavailable' when the fetch failed. It must
   * set it HERE, on this one object, so that the gate in AppShell and the form
   * can never disagree about whose day they are looking at — the divergence
   * this module exists to have ended (see the header).
   *
   * The context panel already renders all four states; nothing else needs
   * writing on the display side. What it must not do is write this to
   * trade_plans.rule_context_source before migration 032 has run — see the
   * submit path in components/trade/TradePlanForm.tsx.
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
 * The order currencies appear in on screen.
 *
 * Fixed, so two loads of the same day cannot list them in two orders — the
 * query guarantees no ordering of its own. Dollars first: REF-99 makes the
 * product dollar-only, so that is the column the product is moving toward.
 */
const CURRENCY_ORDER: readonly PnlCurrency[] = ['$', '₪'];

/** The currency a closed row's money is in. `?? '₪'` app-wide — see JournalClient. */
function currencyOf(row: ClosedTradeRow): PnlCurrency {
  return row.pnl_currency === '$' ? '$' : '₪';
}

/**
 * Today's closes, split by currency, for the panel.
 *
 * Only rows that carry a money figure reach the `money` array — hasMoneyPnl(),
 * the same filter the journal and the calendar use when they collect which
 * currencies a set of trades spans. Without it a close with no exit price (so
 * tradeMoneyPnl() returns 0) would add its currency with a zero total, and the
 * panel would announce two currencies because of a row that holds no money.
 */
function summariseTodayCloses(rows: readonly ClosedTradeRow[]): TodayClosedSummary {
  const byCurrency = new Map<PnlCurrency, { net: number; lost: number }>();
  let losingCount = 0;

  for (const row of rows) {
    if (!hasMoneyPnl(row)) continue;
    const pnl = tradeMoneyPnl(row);
    if (pnl < 0) losingCount++;

    const currency = currencyOf(row);
    const entry = byCurrency.get(currency) ?? { net: 0, lost: 0 };
    entry.net += pnl;
    if (pnl < 0) entry.lost += Math.abs(pnl);
    byCurrency.set(currency, entry);
  }

  return {
    count: rows.length,
    losingCount,
    money: CURRENCY_ORDER.flatMap((currency) => {
      const entry = byCurrency.get(currency);
      return entry ? [{ currency, net: entry.net, lost: entry.lost }] : [];
    }),
  };
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
 */
export async function loadTradeRuleContext(
  userId: string,
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
    // pnl_currency rides along for the panel's per-currency totals. One extra
    // column on the query that already fetches exactly these rows, rather than
    // a second query asking the same question — the panel and the loss
    // threshold must be reading the same closes (§4.5).
    client
      .from('trade_plans')
      .select(`${MONEY_FIELDS}, pnl_currency`)
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
    // 'reflect_only' until REF-90 — see the field's own note, which is where
    // that work connects.
    source: 'reflect_only',
    todayClosed: summariseTodayCloses(closedToday),
  };
}
