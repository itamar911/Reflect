// Trade fetch — shared between server-side initial load and client refetch.
// Plain module (no 'use client') so Server Components can use these directly.

export interface DashTrade {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number;
  exit_price: number | null;
  /**
   * THE TRADER'S INTENT, AND NULL ON EVERY IMPORTED ROW.
   *
   * Typed `number` until REF-130's follow-up, which was wrong and not merely
   * imprecise: migration 034 dropped `NOT NULL` from both, and
   * lib/tradovate/import.ts refuses to write them ON PURPOSE — at length, in
   * two places — because a broker's protective order is not a plan the trader
   * made, and writing one would hand `computeTradeScore` thirty points for
   * planning that never happened. The broker's numbers go to
   * `broker_stop_loss` / `broker_take_profit`.
   *
   * SO `Number(null)` WAS REACHING THE APP AS A PRICE OF 0. The modal printed a
   * planned stop of `0.00` on every imported trade, and `patienceInputOf` would
   * have been worse: `intentNumber(0)` is 0, not null, so a zero target WINS
   * the precedence in lib/journal/patience.ts and shuts the broker's real
   * target out — which turns a trade that reached its target into
   * `יצאת לפני היעד`, the one accusation that module is written to never make.
   */
  stop_loss: number | null;
  take_profit: number | null;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  // Added by REF-107 stage 4. The dashboard derived direction from
  // `take_profit >= entry_price`, which reads every profitable short as a
  // loss; the column that answers the question was simply never selected.
  direction: 'long' | 'short' | null;
  exit_reason: string | null;
  submitted_at: string;
  closed_at: string | null;
  quantity: number | null;
  pnl_amount: number | null;
  actual_pnl: number | null;
  pnl_currency: string | null;
  plan_score: number | null;
  followed_plan: boolean | null;
  strategy_conditions_checked: { condition: string; checked: boolean }[] | null;
  moved_sl: boolean | null;
  exited_early: boolean | null;
  fomo_entry: boolean | null;
  revenge_trade: boolean | null;
  /**
   * The broker's target and the stop the position opened under (migration 038).
   *
   * NULL ON EVERY MANUAL ROW AND ON EVERY DEPLOYMENT WITHOUT THE GATE below,
   * which is why both are nullable rather than optional: `mapDashTrade` resolves
   * a missing key to null once, so the radar's single reader never has to ask
   * which of the two absences it is looking at. `patienceFromPrices` answers
   * UNKNOWN for either, and that is the same answer.
   */
  broker_take_profit: number | null;
  broker_stop_loss: number | null;
}

export const DASH_TRADE_SELECT =
  'id,strategy,symbol,entry_price,exit_price,stop_loss,take_profit,rr_ratio,emotional_state,trade_reason,status,direction,exit_reason,submitted_at,closed_at,quantity,pnl_amount,actual_pnl,pnl_currency,plan_score,followed_plan,strategy_conditions_checked,moved_sl,exited_early,fomo_entry,revenge_trade';

/**
 * Add the two migration-038 price columns, but only where they exist.
 *
 * `withHidden`'S ARGUMENT, FOR A SECOND MIGRATION. The dashboard NAMES its
 * columns, so asking for a column before its migration has run is a PostgREST
 * 42703 that takes the whole page down — the hazard migration 038's own header
 * warns about and the reason app/(app)/trades and /stats read `select('*')` and
 * need nothing from this. `סבלנות` on the radar is the dashboard's first reader
 * of those columns, so it is the first that has to ask.
 *
 * THE GATE IS THE SAME FLAG, and deliberately not a second one. Both readers
 * pass what they already pass to {@link withHidden} — `isImportEnabled()` on the
 * server, the prop it travels down as in the browser. It is the broker import's
 * single switch, the owner sets it after running that feature's migrations, and
 * 038 is one of them; a flag per migration would be a flag nobody remembers to
 * set. The cost of being wrong is bounded in one direction only: with the flag
 * off the radar reads exactly as it read before this shipped, because
 * `broker_take_profit` is the fallback and `take_profit` is still selected.
 *
 * When false the caller gets back its own constant, unchanged — the property
 * {@link withHidden} is written for.
 */
export function withBrokerPrices(columns: string, brokerPricesExist: boolean): string {
  return brokerPricesExist ? `${columns},broker_take_profit,broker_stop_loss` : columns;
}

/**
 * The wire shape of DASH_TRADE_SELECT.
 *
 * Exported since REF-107 Stage 2: the two readers now choose their column
 * list at runtime (`withHidden`), and supabase-js can only infer a row shape
 * from a select string it can parse at the TYPE level. So both readers assert
 * this instead, and asserting it needs it to have a name.
 */
export interface RawTradeRow {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number | string;
  exit_price: number | string | null;
  stop_loss: number | string | null;
  take_profit: number | string | null;
  rr_ratio: number | string;
  emotional_state: number | string;
  trade_reason: string;
  status: string;
  direction: 'long' | 'short' | null;
  exit_reason: string | null;
  submitted_at: string;
  closed_at: string | null;
  quantity: number | string | null;
  pnl_amount: number | string | null;
  actual_pnl: number | string | null;
  pnl_currency: string | null;
  plan_score: number | string | null;
  followed_plan: boolean | null;
  strategy_conditions_checked: unknown;
  moved_sl: boolean | null;
  exited_early: boolean | null;
  fomo_entry: boolean | null;
  revenge_trade: boolean | null;
  /**
   * OPTIONAL, unlike every field above it, because {@link withBrokerPrices} can
   * leave them out of the statement — and `NUMERIC` arrives as a STRING over
   * PostgREST, which is the hazard lib/journal/patience.ts names for its own
   * inputs. `mapDashTrade` runs both through `Number()` like the other prices.
   */
  broker_take_profit?: number | string | null;
  broker_stop_loss?: number | string | null;
}

export function mapDashTrade(t: RawTradeRow): DashTrade {
  return {
    id:               t.id,
    strategy:         t.strategy,
    symbol:           t.symbol ?? null,
    entry_price:      Number(t.entry_price),
    exit_price:       t.exit_price != null ? Number(t.exit_price) : null,
    // NULL-PRESERVING, unlike `entry_price` beside them: those two are the
    // trader's intent and are absent on every imported row. See `DashTrade`.
    stop_loss:        t.stop_loss   != null ? Number(t.stop_loss)   : null,
    take_profit:      t.take_profit != null ? Number(t.take_profit) : null,
    rr_ratio:         Number(t.rr_ratio),
    emotional_state:  Number(t.emotional_state),
    trade_reason:     t.trade_reason,
    status:           t.status,
    direction:        t.direction ?? null,
    exit_reason:      t.exit_reason ?? null,
    submitted_at:     t.submitted_at,
    closed_at:        t.closed_at ?? null,
    quantity:         t.quantity != null ? Number(t.quantity) : null,
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
    actual_pnl:       t.actual_pnl != null ? Number(t.actual_pnl) : null,
    pnl_currency:     t.pnl_currency ?? null,
    plan_score:       t.plan_score != null ? Number(t.plan_score) : null,
    followed_plan:    t.followed_plan ?? null,
    strategy_conditions_checked: Array.isArray(t.strategy_conditions_checked)
      ? (t.strategy_conditions_checked as { condition: string; checked: boolean }[])
      : null,
    moved_sl:         t.moved_sl ?? null,
    exited_early:     t.exited_early ?? null,
    fomo_entry:       t.fomo_entry ?? null,
    revenge_trade:    t.revenge_trade ?? null,
    broker_take_profit: t.broker_take_profit != null ? Number(t.broker_take_profit) : null,
    broker_stop_loss:   t.broker_stop_loss   != null ? Number(t.broker_stop_loss)   : null,
  };
}
