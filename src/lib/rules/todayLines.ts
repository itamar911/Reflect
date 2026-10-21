/**
 * Today's broker closes, one line each, and the copy around them (REF-107).
 *
 * PURE. A type, a defensive reader and four copy/decision functions — no
 * fetch, no client, no React — so the regression suite can drive every state
 * the panel can be in without a browser. components/trade/TodayContextPanel
 * renders these; lib/rules/brokerTradeList.ts fetches them.
 *
 *
 * WHERE THE ROWS COME FROM, AND WHY NOT FROM /today
 * ------------------------------------------------
 *
 * `GET /api/tradovate/today` DELIBERATELY DOES NOT SEND THEM. It builds the
 * rows, writes them, and drops them before responding; its own header states
 * the split ("the rule engine's route sends scalars") and
 * scripts/tradovate-today-check.ts asserts that the body carries no trade
 * field, with a comment saying that a change finding it convenient to return
 * `trades` from there has to delete the assertion on purpose.
 *
 * So the list comes from `GET /api/tradovate/trades`, which is the route built
 * to send a trader their own positions and whose header already records the
 * bounds of that decision: the session names the user, the window is capped,
 * the response is `no-store, private`, and nothing is logged. The scalar route
 * is left exactly as it was.
 *
 *
 * THE PANEL SHOWS THE LIST ONLY WHEN IT PROVABLY DESCRIBES THE SAME DAY
 * --------------------------------------------------------------------
 *
 * Every figure in the panel — the net, the loss against the limit, the closed
 * count — comes from the DAY PULL, which is the read the rule engine acted on.
 * The list is a second read, a moment later, and a trade that closed between
 * the two would make the lines and the figures disagree on screen: three rows
 * above a net that accounts for two.
 *
 * {@link showsLineList} is the whole answer: the list renders only when it has
 * exactly as many lines as the day pull counted closes. When the two reads saw
 * different days the panel shows the sentences it always showed and no list,
 * which is a smaller loss than a panel whose own numbers do not add up. It is
 * also why the net is NOT re-summed from the lines — one source of truth per
 * panel, and it is the one the rules used.
 */

import { readTradeStages, stageCounts } from '@/lib/journal/stages';

/**
 * One closed round trip, as the panel lists it. Four fields, nothing else.
 *
 * `closedAtMs` is read by {@link readTodayTradeLines} to order these and is
 * deliberately NOT kept: the panel renders no instant, so carrying one would
 * be a field crossing into the view for nothing. The order is the only thing
 * the timestamp is needed for, and it is applied before the field is dropped.
 */
export interface TodayTradeLine {
  direction: 'long' | 'short';
  /** The contract's name. Null when the contract body named nothing usable. */
  symbol: string | null;
  /** Net dollars for the round trip. Signed. Gross — see `GrossPnlNote`. */
  pnl: number;
  /**
   * How many pieces this position was entered and exited in, or null when
   * there is nothing to say (REF-117 Stage 6).
   *
   * JUST THE COUNTS, which is the ticket's own reduction for this surface —
   * "אותו דבר בקצרה, רק מספר השלבים". The trade card gets the quantity and
   * the price of every piece; a panel at the top of a form that lists up to
   * ten closes on one line each has room for two numerals.
   *
   * NULL ON A SIMPLE ROUND TRIP, not `{1, 1}`, so that `TradeLines` renders
   * exactly what it rendered before this stage on every ordinary day. The
   * threshold is `wasScaled` in lib/journal/stages.ts, which is the one place
   * "worth saying" is defined.
   *
   * SOURCED FROM `BrokerTrade.stages` OVER THE WIRE AND NOT FROM THE DATABASE,
   * which is why this surface works with no migration at all: the panel's list
   * comes from `GET /api/tradovate/trades`, which answers with the pull's own
   * rows. `trade_plans.broker_stages` (migration 040) is what the JOURNAL
   * needs, because the journal reads stored rows.
   */
  stages: { entries: number; exits: number } | null;
}

/**
 * How many lines the panel will draw before it stops counting out loud.
 *
 * Ten, and the eleventh onward become "ועוד N". A trader who took thirty
 * trades today does not need thirty rows at the top of the trade form — they
 * need the net and the fact that there were thirty — and the panel sits above
 * the form rather than being the page.
 */
export const TODAY_LINE_CAP = 10;

/**
 * Read the trades route's body into lines, trusting nothing.
 *
 * Returns null for every state that is not a successful pull, which the caller
 * must treat as "no list" rather than "no trades" — the same distinction
 * `readStoredDebrief` makes, and for the same reason: an empty list and an
 * unavailable broker are different sentences, and only one of them means the
 * trader had a quiet day.
 *
 * A row missing a usable `direction` or `pnlUsd` is DROPPED rather than
 * failing the whole read — but see {@link showsLineList}, which then declines
 * to render a list that has lost a row, because a list that silently omits a
 * trade is worse than no list.
 *
 *
 * CHRONOLOGICAL, OLDEST CLOSE FIRST — AND THE ROUTE SENDS THE OPPOSITE
 * -------------------------------------------------------------------
 *
 * `loadBrokerDay` sorts `(a, b) => b.closedAtMs - a.closedAtMs`, newest close
 * first, which is right for a journal: the thing that just happened belongs at
 * the top of a list you scroll. It is wrong here. This panel NUMBERS its rows,
 * and "1" next to the most recent trade tells the trader their last trade was
 * their first — so the numbering contradicts the only thing it is for.
 *
 * The sort happens HERE, where `closedAtMs` is still in hand, and the field is
 * then dropped: {@link TodayTradeLine} stays at three fields, so the view
 * carries no instant it does not render. Sorting by a column the line does not
 * have would have meant either widening the view type or reversing the array
 * and trusting the route's order to never change — and a silent re-ordering
 * upstream would then mis-number this list with nothing to catch it.
 *
 * A row whose `closedAtMs` cannot be read sorts LAST rather than first.
 * Position 1 is a claim — "this closed before the others" — and an unreadable
 * instant is not evidence for it. The sort is stable, so ties keep the order
 * the route sent them in.
 */
export function readTodayTradeLines(body: unknown): TodayTradeLine[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const pull = body as Record<string, unknown>;
  if (pull.source !== 'broker_verified') return null;
  if (!Array.isArray(pull.trades)) return null;

  const dated: { line: TodayTradeLine; closedAtMs: number }[] = [];
  for (const raw of pull.trades) {
    if (typeof raw !== 'object' || raw === null) continue;
    const trade = raw as Record<string, unknown>;

    const direction = trade.direction;
    if (direction !== 'long' && direction !== 'short') continue;

    const pnl = Number(trade.pnlUsd);
    if (!Number.isFinite(pnl)) continue;

    const closedAtMs = Number(trade.closedAtMs);

    dated.push({
      line: {
        direction,
        symbol: typeof trade.symbol === 'string' && trade.symbol !== '' ? trade.symbol : null,
        pnl,
        // THROUGH THE JOURNAL'S OWN READER, not a second parse. `stageCounts`
        // over `readTradeStages` is what the trade card uses, so the two
        // surfaces cannot disagree about what "scaled" means or about which
        // malformed documents are refused — and this body is as untrusted as a
        // stored column is: it has crossed a network either way.
        stages: stageCounts(readTradeStages(trade.stages)),
      },
      // See the header: unreadable sorts last, not first.
      closedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : Number.POSITIVE_INFINITY,
    });
  }

  dated.sort((a, b) => a.closedAtMs - b.closedAtMs);
  return dated.map((entry) => entry.line);
}

/**
 * Whether the list may be drawn beside the day's figures.
 *
 * ONE CONDITION, AND IT IS A CONSISTENCY CHECK RATHER THAN A FEATURE FLAG: the
 * lines must number exactly what the day pull counted. See the header — the
 * two come from two reads, and a panel showing three rows above a net that
 * accounts for two is a panel contradicting itself in the trader's own money.
 *
 * `null` lines means the second read did not happen or did not succeed, which
 * is the ordinary case on a quiet day: the caller only asks for the list when
 * the day pull says there were closes.
 */
export function showsLineList(lines: TodayTradeLine[] | null, closedCount: number): boolean {
  return lines !== null && lines.length > 0 && lines.length === closedCount;
}

/** The first {@link TODAY_LINE_CAP} lines, and how many were left out. */
export function visibleLines(lines: readonly TodayTradeLine[]): {
  shown: TodayTradeLine[];
  more: number;
} {
  return {
    shown: lines.slice(0, TODAY_LINE_CAP),
    more: Math.max(0, lines.length - TODAY_LINE_CAP),
  };
}

/** "ועוד 4" — what stands in for the rows past the cap. */
export function moreLinesText(more: number): string {
  return `ועוד ${more}`;
}

/**
 * The net line's label. The amount is rendered beside it, coloured and `ltr`.
 *
 * "נטו" and not "סה״כ", because the figure is a NET of wins and losses and the
 * line directly below it says that losses alone count toward the limit. Two
 * lines that both began "סה״כ" would read as two attempts at the same total.
 */
export const NET_LABEL = 'נטו היום';

/**
 * The loss-limit line, reworded (REF-107).
 *
 * THE TRAILING CLAUSE IS THE WHOLE CHANGE, and it answers the question the old
 * copy provoked: a trader who closed +$270 and −$125 saw "סך ההפסדים היום: $125
 * מתוך $500" directly under a net of +$145 and reasonably concluded one of the
 * two numbers was wrong. Neither was. `todayLossAmount` sums LOSSES ONLY —
 * `sumLosses` in lib/rules/tradeRuleContext.ts adds `Math.abs(pnl)` for the
 * negative rows and ignores the rest — because a daily loss limit that a
 * winning trade could buy back is not a loss limit. That is the rule the
 * engine enforces; this sentence is the first place it has ever been said.
 *
 * Returned in three pieces because the two amounts need their own `dir="ltr"`
 * spans and their own colours, and the Hebrew connectives have to stay outside
 * them — §9, and the failure it names has bitten this file twice.
 */
export const LOSS_LIMIT_LABEL = 'מגבלת הפסד';
export const LOSS_LIMIT_NOTE = 'רק הפסדים נספרים, רווחים לא מקזזים';

/**
 * "2→3" — the stage counts, for one line of the day's list (REF-117 Stage 6).
 *
 * AN ARROW AND NOT TWO WORDS, because this sits on a row that already carries
 * a direction glyph, a symbol and an amount, and "נכנסת בשני שלבים" is the
 * trade card's job. The arrow reads entry→exit in both directions of text: it
 * is inside a `dir="ltr"` span in the panel, like every other figure there
 * (§9), and the glyph is the same `→` the stop sentences use for a range.
 *
 * Null in, null out, so the caller renders nothing rather than an empty span.
 */
export function stagesLabel(stages: TodayTradeLine['stages']): string | null {
  return stages === null ? null : `${stages.entries}→${stages.exits}`;
}
