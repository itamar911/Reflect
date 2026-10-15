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
  /** Nullable: `take_profit` is an intent column, and a trade that reaches the
   *  journal with no plan behind it carries none. See `tradeDirection`. */
  take_profit?: number | string | null;
  direction?: 'long' | 'short' | null;
}

/**
 * Which way the trade was taken.
 *
 * The `direction` column answers this. The take_profit-vs-entry comparison is
 * only a fallback for rows written before that column existed — reading it
 * first, as several features did until REF-107 stage 4, calls every profitable
 * short a loss.
 *
 * A row with neither is direction-unknowable. It resolves to 'long', which
 * makes `tradePointsPnl` report the raw `exit − entry` move; the alternative,
 * `Number(null) >= Number(entry)` being false, would silently invert the sign
 * of every such row.
 */
export function tradeDirection(t: PointsPnlTrade): 'long' | 'short' {
  if (t.direction) return t.direction;
  if (t.take_profit == null) return 'long';
  return Number(t.take_profit) >= Number(t.entry_price) ? 'long' : 'short';
}

/**
 * Adapts a loosely-typed row — what `select('*')` hands the AI routes — to the
 * shape the helpers here read.
 *
 * Those routes each grew their own `Number(exit_price) > Number(entry_price)`
 * win test, which is the REF-107 §0ד bug three more times: it calls every
 * profitable short a loss, and it ignores the real money figure in favour of
 * price points.
 */
export function pnlRow(t: Record<string, unknown>): MoneyPnlTrade & PointsPnlTrade {
  return {
    status: String(t.status ?? ''),
    entry_price: t.entry_price as number | string,
    exit_price: (t.exit_price ?? null) as number | string | null,
    take_profit: (t.take_profit ?? null) as number | string | null,
    direction: (t.direction ?? null) as 'long' | 'short' | null,
    pnl_amount: (t.pnl_amount ?? null) as number | string | null,
    actual_pnl: (t.actual_pnl ?? null) as number | string | null,
  };
}

/** Direction-aware price-points P&L. Null while the trade is still open. */
export function tradePointsPnl(t: PointsPnlTrade): number | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  const diff = Number(t.exit_price) - Number(t.entry_price);
  return tradeDirection(t) === 'long' ? diff : -diff;
}

/** Whether the trade carries any monetary (dollar) P&L value. */
export function hasMoneyPnl(t: MoneyPnlTrade): boolean {
  return t.status === 'closed' && t.exit_price != null && (t.actual_pnl ?? t.pnl_amount) != null;
}

/** Monetary (dollar) P&L: actual_pnl if present, else pnl_amount, else 0. */
export function tradeMoneyPnl(t: MoneyPnlTrade): number {
  if (t.status !== 'closed' || t.exit_price == null) return 0;
  const v = t.actual_pnl ?? t.pnl_amount;
  return v != null ? Number(v) : 0;
}

/**
 * Canonical win test — the single definition shared by the stats page, the
 * journal (All Trades), and the dashboard so every page shows the same win
 * rate. A trade is a win when its effective money P&L is positive; a trade
 * with no money data at all falls back to points. Null while still open.
 */
export function isWinningTrade(t: MoneyPnlTrade & PointsPnlTrade): boolean | null {
  if (t.status !== 'closed' || t.exit_price == null) return null;
  if (hasMoneyPnl(t)) return tradeMoneyPnl(t) > 0;
  const pts = tradePointsPnl(t);
  return pts != null && pts > 0;
}
