// Trade fetch — shared between server-side initial load and client refetch.
// Plain module (no 'use client') so Server Components can use these directly.

export interface DashTrade {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  exit_reason: string | null;
  submitted_at: string;
  closed_at: string | null;
  quantity: number | null;
  pnl_amount: number | null;
  pnl_currency: string | null;
  plan_score: number | null;
  followed_plan: boolean | null;
  strategy_conditions_checked: { condition: string; checked: boolean }[] | null;
  moved_sl: boolean | null;
  exited_early: boolean | null;
  fomo_entry: boolean | null;
  revenge_trade: boolean | null;
}

export const DASH_TRADE_SELECT =
  'id,strategy,symbol,entry_price,exit_price,stop_loss,take_profit,rr_ratio,emotional_state,trade_reason,status,exit_reason,submitted_at,closed_at,quantity,pnl_amount,pnl_currency,plan_score,followed_plan,strategy_conditions_checked,moved_sl,exited_early,fomo_entry,revenge_trade';

interface RawTradeRow {
  id: string;
  strategy: string;
  symbol: string | null;
  entry_price: number | string;
  exit_price: number | string | null;
  stop_loss: number | string;
  take_profit: number | string;
  rr_ratio: number | string;
  emotional_state: number | string;
  trade_reason: string;
  status: string;
  exit_reason: string | null;
  submitted_at: string;
  closed_at: string | null;
  quantity: number | string | null;
  pnl_amount: number | string | null;
  pnl_currency: string | null;
  plan_score: number | string | null;
  followed_plan: boolean | null;
  strategy_conditions_checked: unknown;
  moved_sl: boolean | null;
  exited_early: boolean | null;
  fomo_entry: boolean | null;
  revenge_trade: boolean | null;
}

export function mapDashTrade(t: RawTradeRow): DashTrade {
  return {
    id:               t.id,
    strategy:         t.strategy,
    symbol:           t.symbol ?? null,
    entry_price:      Number(t.entry_price),
    exit_price:       t.exit_price != null ? Number(t.exit_price) : null,
    stop_loss:        Number(t.stop_loss),
    take_profit:      Number(t.take_profit),
    rr_ratio:         Number(t.rr_ratio),
    emotional_state:  Number(t.emotional_state),
    trade_reason:     t.trade_reason,
    status:           t.status,
    exit_reason:      t.exit_reason ?? null,
    submitted_at:     t.submitted_at,
    closed_at:        t.closed_at ?? null,
    quantity:         t.quantity != null ? Number(t.quantity) : null,
    pnl_amount:       t.pnl_amount != null ? Number(t.pnl_amount) : null,
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
  };
}
