// Canonical trade P&L helpers — single source of truth for money vs. points P&L.
//
// Money P&L prefers actual_pnl (the trader's real/broker figure, possibly a manual
// override) over pnl_amount (calculated as points × units × point_value, which can
// be inflated by a misconfigured point value and is stale on rows closed before the
// actual_pnl backfill fix). Same precedence as fetchActiveRuleViolation.

interface MoneyPnlTrade {
  status: string;
  exit_price: number | string | null;
  pnl_amount: number | string | null;
  actual_pnl?: number | string | null;
}

interface PointsPnlTrade {
  status: string;
  entry_price: number | string;
  exit_price: number | string | null;
  take_profit: number | string;
  direction?: 'long' | 'short' | null;
}

export function tradeDirection(t: PointsPnlTrade): 'long' | 'short' {
  return t.direction ?? (Number(t.take_profit) >= Number(t.entry_price) ? 'long' : 'short');
}

/** Direction-aware price-points P&L. Null while the trade is still open. */
export function tradePointsPnl(t: PointsPnlTrade): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  const diff = Number(t.exit_price) - Number(t.entry_price);
  return tradeDirection(t) === 'long' ? diff : -diff;
}

/** Whether the trade carries any monetary (₪/$) P&L value. */
export function hasMoneyPnl(t: MoneyPnlTrade): boolean {
  return t.status === 'closed' && t.exit_price != null && (t.actual_pnl ?? t.pnl_amount) != null;
}

/** Monetary (₪/$) P&L: actual_pnl if present, else pnl_amount, else 0. */
export function tradeMoneyPnl(t: MoneyPnlTrade): number {
  if (t.status !== 'closed' || t.exit_price == null) return 0;
  const v = t.actual_pnl ?? t.pnl_amount;
  return v != null ? Number(v) : 0;
}
