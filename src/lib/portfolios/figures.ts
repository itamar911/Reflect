/**
 * What a portfolio card says about a portfolio (REF-110 Stage 4).
 *
 * PURE. Takes rows, returns numbers, touches nothing. That is what lets the
 * "התיקים שלי" page compute every figure server-side in the same render that
 * reads the rows, and what lets `scripts/accounts-check.ts` assert the card
 * against `lib/pnl.ts` over the same input.
 *
 *
 * THE FIGURES COME FROM lib/pnl.ts AND ARE NEVER RE-DERIVED HERE
 * --------------------------------------------------------------
 *
 * `tradeMoneyPnl` and `isWinningTrade`, which that module's own header calls
 * "the single definition shared by the stats page, the journal and the
 * dashboard so every page shows the same win rate". An account card that
 * totalled its own way would be the fourth definition and the first one to
 * disagree — and it would disagree in the most visible way possible, because
 * the sum of the cards is a figure the trader can check against the stats page
 * in two clicks.
 *
 * There is no arithmetic below that `pnl.ts` could have done. The only
 * operations here are `+`, a count, and a `Math.max` over dates.
 *
 *
 * WHICH ROWS COUNT, AND THE TWO EXCLUSIONS
 * -----------------------------------------
 *
 *   - 'not_entered' is not a trade (REF-82 §5.2). The stats page excludes it
 *     at the query and the calendar excludes it entirely; a card that counted
 *     it would report more trades for a portfolio than the journal shows.
 *   - A hidden ROW — `trade_plans.hidden`, E12's delete — is not in any total
 *     anywhere, so it is not in these either. Note the asymmetry with a hidden
 *     PORTFOLIO, which keeps every one of its trades in every total: the two
 *     flags share a name and mean opposite things, which is exactly why
 *     `accounts.hidden`'s own column comment says so.
 *
 * Win rate's denominator is the CLOSED rows, not every row, because
 * `isWinningTrade` is null while a trade is open and an open trade is neither
 * a win nor a loss. Null when there are none — rendered "—", never 0%, which
 * would read as "you lost every trade".
 */

import { isWinningTrade, tradeMoneyPnl, type pnlRow } from '@/lib/pnl';
import { isHiddenTrade } from '@/lib/trades/visible';

/**
 * The columns a figure needs, plus the one that groups them.
 *
 * Structurally what `tradeMoneyPnl` and `isWinningTrade` read, so a row from
 * any of this product's readers satisfies it without a cast.
 */
export interface PortfolioTradeRow {
  account_id?: string | null;
  status: string;
  submitted_at: string;
  entry_price: number | string;
  exit_price: number | string | null;
  take_profit?: number | string | null;
  direction?: 'long' | 'short' | null;
  pnl_amount: number | string | null;
  actual_pnl?: number | string | null;
  hidden?: boolean | null;
}

/** One card's numbers. */
export interface PortfolioFigures {
  /** Rows filed under this portfolio, excluding 'not_entered' and hidden rows. */
  trades: number;
  /** Of those, the ones with an exit. The win-rate denominator. */
  closed: number;
  /** Sum of `tradeMoneyPnl` over the closed ones. */
  netPnl: number;
  /** Percent, rounded. Null when nothing has closed. */
  winRate: number | null;
  /** The newest `submitted_at` among the counted rows. Null when there are none. */
  lastTradeAt: string | null;
}

export const NO_FIGURES: PortfolioFigures = Object.freeze({
  trades: 0,
  closed: 0,
  netPnl: 0,
  winRate: null,
  lastTradeAt: null,
});

/** The rows a card is allowed to count. See the header on both exclusions. */
export function countableTrades<T extends PortfolioTradeRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status !== 'not_entered' && !isHiddenTrade(row));
}

/**
 * The figures for one already-filtered set of rows.
 *
 * Takes the rows rather than the portfolio, so the "ללא תיק" bucket — which
 * has no portfolio — gets its count from the same function and cannot drift
 * from the cards above it.
 */
export function figuresFor(rows: readonly PortfolioTradeRow[]): PortfolioFigures {
  const counted = countableTrades(rows);
  if (counted.length === 0) return NO_FIGURES;

  // `pnlRow`'s shape, which is what the two helpers read. Asserted rather than
  // mapped: every field they touch is already on PortfolioTradeRow, and a
  // second mapping would be a second place for `Number(null) === 0` to happen.
  const closed = counted.filter(
    (row) => row.status === 'closed' && row.exit_price != null,
  ) as ReturnType<typeof pnlRow>[];

  const netPnl = closed.reduce((sum, row) => sum + tradeMoneyPnl(row), 0);
  const wins = closed.filter((row) => isWinningTrade(row) === true).length;

  let lastTradeAt: string | null = null;
  for (const row of counted) {
    if (lastTradeAt === null || row.submitted_at > lastTradeAt) lastTradeAt = row.submitted_at;
  }

  return {
    trades: counted.length,
    closed: closed.length,
    netPnl,
    winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : null,
    lastTradeAt,
  };
}

/**
 * Every portfolio's figures in one pass, keyed by `accounts.id`.
 *
 * ONE PASS over the rows rather than one filter per portfolio: a trader with
 * six portfolios and two thousand trades would otherwise be twelve thousand
 * comparisons for a screen that is four numbers per card.
 *
 * The unassigned bucket is keyed by {@link UNASSIGNED_KEY} rather than being
 * returned separately, so the caller reads one map and the bucket cannot be
 * computed a second, slightly different way. A row whose `account_id` key is
 * ABSENT — a database without 037 — lands there too, which is the truth about
 * every row in such a database.
 */
export const UNASSIGNED_KEY = '__unassigned__';

export function figuresByPortfolio(
  rows: readonly PortfolioTradeRow[],
): Map<string, PortfolioFigures> {
  const grouped = new Map<string, PortfolioTradeRow[]>();
  for (const row of countableTrades(rows)) {
    const key = row.account_id ?? UNASSIGNED_KEY;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }

  const out = new Map<string, PortfolioFigures>();
  for (const [key, bucket] of grouped) out.set(key, figuresFor(bucket));
  return out;
}
