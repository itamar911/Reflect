/**
 * Formatting an INSTANT for the screen, on the trader's clock (REF-125).
 *
 * THE BUG THIS EXISTS TO STOP. `new Date(iso).toLocaleDateString('he-IL', …)`
 * with no `timeZone` formats in whatever zone the RUNTIME is in. A client
 * component renders twice — once in Node on Vercel, which is UTC, and once in
 * the browser, which is the trader's own zone — so the same instant came out
 * as two different strings and React threw #418 (hydration mismatch) on
 * /dashboard, /trades and /notebook. The hour was always wrong by the offset;
 * the DATE was wrong too for anything stamped in the small hours, because
 * 23:00 UTC is already tomorrow in Israel.
 *
 * Pinning the zone fixes both halves at once: the server and the browser are
 * given the same zone rather than being asked to agree by luck.
 *
 * WHY THE TRADER'S ZONE AND NOT THE VIEWER'S. `Asia/Jerusalem` is already what
 * this product means by a wall clock — lib/tradingDay.ts calls it
 * {@link TRADER_TIME_ZONE} and {@link tradingDayWindowNote} prints "שעון
 * ישראל" into the day tooltip. For the audience the two are the same string
 * anyway. The alternative — deferring every date to a `useEffect` so the
 * browser's own zone could be used — would blank every date on first paint
 * across four screens to move an hour label for a trader abroad, and it would
 * still have to pick a zone for the server render.
 *
 * NOT FOR A TRADING DAY. A `TradingDay` is a civil date with no instant in it
 * and is named on the EXCHANGE's clock; `tradingDayLabel()` in
 * lib/tradingDay.ts formats those, pinned to UTC for its own reasons. This
 * module is only for columns that hold a real timestamp — `submitted_at`,
 * `closed_at`, `created_at`.
 */
import { TRADER_TIME_ZONE } from './tradingDay';

/**
 * `Intl.DateTimeFormat` is expensive to construct and these run per table row,
 * so the instances are built once and reused. Keyed by the option bag.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let cached = formatters.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('he-IL', { ...options, timeZone: TRADER_TIME_ZONE });
    formatters.set(key, cached);
  }
  return cached;
}

/**
 * The escape hatch, for a shape that only one caller needs.
 *
 * Returns '' for an unreadable timestamp rather than "Invalid Date": these
 * strings land in table cells and `aria-label`s, and a blank cell is a row
 * with a missing date while "Invalid Date" is a bug report from a user.
 */
export function formatInstant(
  iso: string | null | undefined,
  options: Intl.DateTimeFormatOptions
): string {
  if (typeof iso !== 'string' || iso === '') return '';
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return '';
  return formatter(options).format(at);
}

/** "27.10" — day and month, for a dense row that carries its year elsewhere. */
export function dayMonth(iso: string | null | undefined): string {
  return formatInstant(iso, { day: '2-digit', month: '2-digit' });
}

/**
 * "27.10.26" — the house short date.
 *
 * The journal's row date, the strategy list's and the open-plan prompt's: all
 * three had their own copy of this option bag and a note asking to be kept in
 * step with the others, which is the argument for one of them.
 */
export function shortDate(iso: string | null | undefined): string {
  return formatInstant(iso, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** "27 באוק׳" — a date with a named month, where there is room for one. */
export function mediumDate(iso: string | null | undefined): string {
  return formatInstant(iso, { day: 'numeric', month: 'short' });
}

/** "27 באוקטובר 2026" — the notebook's page heading. */
export function longDate(iso: string | null | undefined): string {
  return formatInstant(iso, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "18:00" — the time alone, for a row whose date is in its group header. */
export function timeOfDay(iso: string | null | undefined): string {
  return formatInstant(iso, { hour: '2-digit', minute: '2-digit' });
}

/**
 * "27.10.26 18:00" — short date and time.
 *
 * Built from the two formatters above rather than one `dateStyle`/`timeStyle`
 * pair, so the date half is byte-identical to {@link shortDate} elsewhere on
 * the same screen.
 */
export function shortDateTime(iso: string | null | undefined): string {
  const date = shortDate(iso);
  return date === '' ? '' : `${date} ${timeOfDay(iso)}`;
}

/** "27 באוקטובר, 18:00" — the notebook entry's stamp. */
export function longDateTime(iso: string | null | undefined): string {
  const date = formatInstant(iso, { day: 'numeric', month: 'long' });
  return date === '' ? '' : `${date}, ${timeOfDay(iso)}`;
}
