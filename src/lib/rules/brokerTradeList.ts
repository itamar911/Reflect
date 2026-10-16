/**
 * Ask the trades route for today's closes, for the context panel's list
 * (REF-107).
 *
 * The same shape as `requestBrokerDay` in ./brokerDayContext.ts — one fetch,
 * never throws, every failure degrades to "no list" — and deliberately
 * SMALLER: no module-level cache, because there is one caller and it asks once
 * per form open.
 *
 *
 * IT IS NOT ASKED FOR UNLESS THERE IS SOMETHING TO LIST
 * ----------------------------------------------------
 *
 * `/api/tradovate/trades` makes a full broker pull: eight to ten upstream
 * reads plus one contract chain per distinct contract (§A2). The trade form
 * already pays for one of those through `/api/tradovate/today`, and nothing is
 * shared between the two routes — so asking for the list unconditionally would
 * DOUBLE the upstream cost of opening the trade form, against a rate-limited
 * third party, on the most-used surface in the product.
 *
 * So the caller asks only when the day pull has already reported
 * `broker_verified` WITH closes. On a day the trader has not closed anything —
 * which is most form opens, including every one before the first trade of the
 * day — the second request is never made and the panel reads exactly as it did
 * before. The extra pull happens only when there is a list to draw, which is
 * the only time it buys anything.
 *
 * The consequence to know about: opening the form after three closes costs two
 * pulls rather than one. That is the price of the privacy split — the scalar
 * route will not carry rows, by design — and it is bounded to one extra pull
 * per form open, not per trade.
 */

import { readTodayTradeLines, type TodayTradeLine } from './todayLines';
import { DAY_START_PARAM } from '@/lib/tradovate/trading-day';
import { startOfTodayIso } from './tradeRuleContext';

/** The route. One place, so the component and the tests cannot drift. */
const BROKER_TRADES_PATH = '/api/tradovate/trades';

/**
 * Today's closed round trips, or null when there is no list to show.
 *
 * NULL FOR EVERY FAILURE, and the caller renders the panel it always rendered.
 * A list is an enrichment of figures that are already on screen and already
 * correct: a broker we could not reach a second time must not be able to blank
 * a sentence the first read earned, and it must certainly not be able to throw
 * into the form's own load.
 */
export async function loadTodayTradeLines(): Promise<TodayTradeLine[] | null> {
  try {
    // The day boundary travels with the request for the same reason it does on
    // /today: the route runs in UTC on Vercel and cannot work out the trader's
    // local midnight. No `since` — this panel is about TODAY, and the wider
    // window would price contracts nothing here will show.
    const url = `${BROKER_TRADES_PATH}?${DAY_START_PARAM}=${encodeURIComponent(startOfTodayIso())}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return readTodayTradeLines(await res.json());
  } catch {
    // Offline, aborted, or a body that is not JSON.
    return null;
  }
}
