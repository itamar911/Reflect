/**
 * Trading money, formatted. One currency, one module.
 *
 * REF-99: every trading amount in this product is in US dollars. Not "the
 * currency on the row", not "the currency the user picked" — there is no
 * choice to make, and the `pnl_currency` column is a label on a number the
 * user already entered in dollars, not a unit the app converts between.
 *
 * WHY THIS FILE EXISTS. Before REF-99 the dollar sign was reached eight
 * different ways: `formatPnlIls()` in lib/utils with a `currency` parameter
 * defaulting to ₪, `fmt()` in components/stats/shared, `pnlLabel()` in
 * TradeCalendar, `compactCurrency()` in PnlChart, a local `formatMoney()` in
 * TodayContextPanel, two `fmt()` helpers in SetupsClient and lib/identity that
 * hardcoded `$`, and bare template strings in RulesetValidator. The stats page
 * said ₪ and the setups page said $ about the same trades. Every symbol the
 * user sees on a trading amount now comes from TRADING_CURRENCY below, so
 * there is exactly one line to change if that ever stops being true.
 *
 * NOT FOR SUBSCRIPTION BILLING. Our own pricing is in shekels and is not a
 * trading amount; it does not come through here. See components/landing/
 * MarketingPricing.tsx, which REF-99 deliberately leaves alone.
 *
 * Amounts are grouped with `en-US` separators and rendered LTR. In an RTL page
 * that is only correct inside a `dir="ltr"` run — a bare "-$2,000.00" dropped
 * into Hebrew flow has its sign carried to the wrong end. Callers are
 * responsible for the isolation; TodayContextPanel's `Ltr` wrapper and the
 * `dir="ltr"` chart containers are the pattern.
 */

import type { PnlCurrency } from '@/lib/types';

/**
 * The only currency a trading amount is ever displayed in.
 *
 * Also the value written to `trade_plans.pnl_currency`, because that column
 * stores the symbol itself rather than a code — the display symbol and the
 * stored label are the same string, so they are the same constant. Writing it
 * from here is what makes requirement 3 hold: a row created before migration
 * 033 runs still gets '$', so deploy order does not matter.
 */
export const TRADING_CURRENCY: PnlCurrency = '$';

/**
 * How the sign is drawn.
 *
 * - `auto` — `+` on a gain, minus on a loss, nothing on zero. The default,
 *   because a P&L figure's direction is the point of it.
 * - `negative` — minus on a loss, nothing otherwise. For axis ticks and chart
 *   labels, where a column of `+` signs is noise.
 * - `none` — magnitude only, unsigned. For amounts whose direction is already
 *   in the words beside them ("סך ההפסדים היום: $300") and for thresholds,
 *   which are limits rather than outcomes.
 */
export type MoneySign = 'auto' | 'negative' | 'none';

export interface MoneyFormat {
  /** Fraction digits. Default 2. */
  decimals?: number;
  /** Default `auto`. */
  sign?: MoneySign;
  /**
   * Which minus glyph a loss gets. Default `-` (ASCII).
   *
   * `−` is U+2212 MINUS SIGN, which the stats page, the calendar and the P&L
   * chart have always used — it is the typographically correct one and it
   * aligns with digits in a tabular-numeral column. The journal and dashboard
   * have always used the ASCII hyphen. REF-99 preserves both rather than
   * unifying them: this ticket is about the currency, and swapping a glyph
   * changes the width of every negative number on three pages.
   */
  minus?: '-' | '−';
  /**
   * Drop the fraction once the magnitude reaches 1000, so a wide amount does
   * not overflow a fixed-width cell. TradeCalendar's day cells need it.
   */
  dropFractionAtThousand?: boolean;
}

/**
 * A trading amount with its currency symbol.
 *
 * The symbol sits between the sign and the digits — `-$2,000.00`, not
 * `$-2,000.00` — which is how every call site in the app has always written it.
 */
export function formatMoney(value: number, format: MoneyFormat = {}): string {
  const {
    decimals = 2,
    sign = 'auto',
    minus = '-',
    dropFractionAtThousand = false,
  } = format;

  // NaN and ±Infinity have no honest rendering here, and a stray "NaN" in a
  // P&L cell reads as a number the user lost. An em dash says "no figure".
  if (!Number.isFinite(value)) return '—';

  const abs = Math.abs(value);
  const fractionDigits = dropFractionAtThousand && abs >= 1000 ? 0 : decimals;

  // Fixed digits both ways, so a column of amounts has its decimal points in
  // line and "$1,250.5" never appears next to "$1,250.50".
  const digits = abs.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });

  const prefix =
    sign === 'none' ? ''
    : value < 0 ? minus
    : sign === 'auto' && value > 0 ? '+'
    : '';

  return `${prefix}${TRADING_CURRENCY}${digits}`;
}

/**
 * Magnitude only, two decimals — `$2,000.00`.
 *
 * For an amount whose direction is already stated in the Hebrew beside it, and
 * for a threshold, which is a limit the user set rather than money they lost.
 */
export function formatMoneyAbs(value: number): string {
  return formatMoney(value, { sign: 'none' });
}

/**
 * Compact, for chart axis ticks — `−$1.2k`, `−$250`.
 *
 * Thousands collapse to `k` with one decimal below 10k and none above it; a
 * tick is read at a glance and at 10k the extra digit costs more width than it
 * carries meaning. Unsigned on gains, because an axis of `+` signs is noise.
 */
export function formatMoneyCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';

  const abs = Math.abs(value);
  const prefix = value < 0 ? '−' : '';

  if (abs >= 1000) {
    return `${prefix}${TRADING_CURRENCY}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  }
  return `${prefix}${TRADING_CURRENCY}${Math.round(abs)}`;
}
