/**
 * What `trade_plans.stop_history` says, read defensively, and the one sentence
 * a trader is shown about it (REF-113 Stage 5).
 *
 * BROWSER-SAFE AND PURE. No client, no environment, no server-only import —
 * because five readers need it and three of them run in the browser: the trade
 * card's detail modal, the link-confirmation panel, the rule engine's context
 * loader, the debrief route's prompt, and the regression suite.
 *
 * IT DELIBERATELY DOES NOT IMPORT `StopHistory` FROM lib/tradovate/orders.ts.
 * That module is server-only — it reaches Tradovate — and the shape declared
 * there describes what the WRITER writes. This describes what a READER may
 * assume, and the two are not the same claim: `stop_history` is JSONB with no
 * CHECK (migration 038 says so and says why), and every row written before a
 * field existed carries neither it nor its siblings. There is no backfill and
 * there cannot be one — the import derives only rows where `stop_history IS
 * NULL`, and `/order/list` is `depthDays = 0`, so the orders those rows came
 * from are gone. A structural type validated at the boundary is the honest
 * reading; a cast would be a promise nothing keeps.
 *
 *
 * NULL SHOWS NOTHING, AND THAT IS THE WHOLE POINT OF THE COLUMN
 * ------------------------------------------------------------
 *
 * There are FOUR answers and a reader that collapses any two of them is the bug
 * this ticket exists to prevent:
 *
 *   NULL / unreadable  we never looked          → SAY NOTHING
 *   `'none'`           we looked, no stop       → "לא הוצב סטופ בעסקה הזו"
 *   `'kept'`           we looked, never moved   → "הסטופ לא הוזז"
 *   `'unknown'`        we looked, could not tell → "לא הצלחנו לקרוא..."
 *
 * The last two are the pair that matters. Without a distinct sentence for
 * `'unknown'` it reads exactly like `'kept'` — a trader would be told their
 * stop stayed put on the strength of a read that failed, which is a claim about
 * their discipline made out of our own missing data.
 *
 *
 * TIGHTENING IS NOT A FAILING (Imri, 19.10)
 * -----------------------------------------
 *
 * A trader who moves a stop TOWARD the profit is managing risk, not breaking
 * discipline. So `'tightened'` is phrased as a neutral fact and `'widened'` as a
 * warning, and {@link stopMoveSentence} returns the tone rather than leaving
 * each of three call sites to decide. `moved_sl` stays true for either — it is a
 * fact about what happened — and it is lib/scoring/tradeScore.ts that reads the
 * direction and declines to charge twelve points for a tightening.
 *
 * "הורחק" and not "הורע": this is a description. The judgement belongs to the
 * rule the trader wrote.
 */

/**
 * The fields a reader may ask for. EVERY ONE OPTIONAL, because every one is
 * absent from some row that exists — see the header on why there is no cast.
 */
export interface StoredStopHistory {
  verdict: 'moved' | 'kept' | 'none' | 'unknown';
  /** Why `'unknown'`. Only the two PERMANENT reasons are ever stored. */
  reason: 'interday' | 'ambiguous' | 'capped' | 'failed' | null;
  /** The stop the position opened under. `broker_stop_loss` holds this too. */
  initialStop: number | null;
  /**
   * Which side of the entry {@link initialStop} sat on.
   *
   * `'wrong'` MEANS NO PRICE MAY BE SHOWN. It is not a statement about the
   * trader — it says our own attribution picked an order that cannot have been
   * a protective stop, because the other side of the entry fills the instant it
   * reaches the book. On 19.10 a long stored an initial stop 148 ticks ABOVE
   * its entry and nothing in the shape said so. Putting that number in front of
   * a trader beside the stop they typed is the one thing this field exists to
   * stop.
   */
  initialStopSide: 'risk' | 'wrong' | null;
  /** The stop as last submitted, over the counted window alone. */
  finalStop: number | null;
  /** How many times the price changed inside the counted window. */
  movedCount: number;
  /** Which way, over consecutive steps and never end-to-end. */
  direction: 'tightened' | 'widened' | 'mixed' | null;
  /** The steps were the server's, not a decision taken mid-trade. */
  trailing: boolean;
  /**
   * How many distinct protective orders the verdict was read from, or null
   * (REF-113 Stage 5).
   *
   * **NULL IS "WE DO NOT KNOW HOW MANY", NOT ONE**, and that is why this field
   * is nullable where `movedCount` defaults to zero: every row written before
   * Stage 5 carries no such key, there is no backfill, and resolving the
   * absence to a number would state something that was never measured.
   *
   * BUT A NULL READS AS SAFE TO DESCRIBE, AND THAT IS NOT THE USUAL DIRECTION
   * IN THIS FILE. {@link stopMoveSentence} shows the from→to range on a null
   * and withholds it only above one. The rows that lack the key are rows
   * written while a scaled-in position became SEVERAL journal rows (union-find
   * grouped on shared fills, REF-117), so each of them really did describe one
   * bracket and the range really was that bracket's. Withholding it would
   * delete a true sentence from every row the feature has ever written, to
   * guard against a shape those rows cannot have.
   *
   * Above one means the position was scaled into and each entry had its own
   * bracket, so {@link initialStop} and {@link finalStop} describe ONE of
   * several real stops — the one that stated the most risk — while
   * {@link movedCount} and {@link direction} span all of them.
   */
  stopCount: number | null;
}

type Raw = Record<string, unknown>;

const str = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/**
 * A finite number, or null.
 *
 * `Number(value)` AND NOT A `typeof` TEST, because PostgREST returns `NUMERIC`
 * as a STRING and the prices inside this document came back through the same
 * client — `lib/tradovate/import.ts` compares them as strings for exactly that
 * reason. A price that arrives as `"29671.25"` has to read as 29671.25 here or
 * the sentence silently loses its numbers.
 */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const VERDICTS = ['moved', 'kept', 'none', 'unknown'] as const;
const REASONS = ['interday', 'ambiguous', 'capped', 'failed'] as const;
const SIDES = ['risk', 'wrong'] as const;
const DIRECTIONS = ['tightened', 'widened', 'mixed'] as const;

/**
 * The stored document, or null when there is nothing a reader may rely on.
 *
 * NULL FOR FOUR DIFFERENT THINGS, AND ALL FOUR MEAN "SAY NOTHING": the column
 * is NULL, migration 038 has not been run so `select('*')` returns no key at
 * all, the value is not an object, or it carries no recognisable verdict. The
 * last one is the defensive case and it is deliberately strict — a document
 * whose verdict we cannot read is a document whose other fields we have no
 * reason to trust either.
 *
 * `movedCount` AND `trailing` DEFAULT, and the directions of the two defaults
 * are not symmetric. `movedCount` falls back to zero because a count nobody
 * wrote is a count of nothing. `trailing` falls back to FALSE rather than to
 * unknown, because a true would silence the move — and an over-reported
 * `trailing` is how a real move stops being attributed to the trader at all.
 */
export function readStopHistory(value: unknown): StoredStopHistory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Raw;
  const verdict = str(raw.verdict, VERDICTS);
  if (verdict === null) return null;

  return {
    verdict,
    reason: str(raw.reason, REASONS),
    initialStop: num(raw.initialStop),
    initialStopSide: str(raw.initialStopSide, SIDES),
    finalStop: num(raw.finalStop),
    movedCount: num(raw.movedCount) ?? 0,
    direction: str(raw.direction, DIRECTIONS),
    trailing: raw.trailing === true,
    // No `?? 0` and no `?? 1`: see the field. A document that states a count
    // states it, and one that does not is a document from before the count
    // existed.
    stopCount: num(raw.stopCount),
  };
}

/**
 * Which way the stop moved, for the readers that score and block on it.
 *
 * A convenience over {@link readStopHistory} and not a second reading: scoring
 * and the rule engine both want this one field off a raw column value, and
 * neither should have to know that the column is a document.
 */
export function stopDirectionOf(value: unknown): 'tightened' | 'widened' | 'mixed' | null {
  return readStopHistory(value)?.direction ?? null;
}

/**
 * Whether the broker's evidence says the stop was moved AWAY from the entry.
 *
 * THE PREDICATE THE WIDENED-ONLY RULE AND THE SCORE BOTH READ, so that "a
 * widening happened" has one definition. `'mixed'` counts: it means at least
 * one step widened, and the product decision is that a single widening is the
 * thing being measured — a trader who gave themselves more room and later took
 * some back still gave themselves more room.
 *
 * FALSE WHEN THERE IS NO EVIDENCE, which is the permissive direction and is
 * chosen on purpose. A wrong `true` arms `moved_sl_last_trade`, which can be
 * `block_day`, and blocks a trader out of the app over something they did not
 * do; a wrong `false` silences one rule quietly. Between the two, silence.
 */
export function stopWasWidened(value: unknown): boolean {
  const direction = stopDirectionOf(value);
  return direction === 'widened' || direction === 'mixed';
}

/** A price the way every other price in the journal is rendered. */
const price = (value: number): string => value.toFixed(2);

/**
 * The broker's stop, to show beside the one the trader planned — or null.
 *
 * TAKES THE COLUMN AND THE DOCUMENT BECAUSE THEY ANSWER DIFFERENT HALVES.
 * `broker_stop_loss` is the number and is what eleven `select('*')` readers
 * already have; `stop_history` is what says whether the number means anything.
 * Null for three reasons and all three must render as nothing rather than as a
 * dash beside a figure:
 *
 *   - we never looked (no document)
 *   - we looked and the trader placed no stop (`'none'`)
 *   - we looked and the order we found cannot have been a protective stop
 *     (`initialStopSide === 'wrong'`) — see the field
 *
 * `stopCount > 1` IS NOT IN THAT LIST EITHER, AND THAT IS A DECISION (REF-113
 * Stage 5). On a position scaled into over two entries this is ONE of two real
 * stop prices — the one stating the most risk — and it is still the honest
 * answer to "what was I risking": the worst case is what a stop is. What must
 * not be shown is a from→to RANGE, because that claims the one order's
 * revisions are the trade's, and {@link stopMoveSentence} is where that is
 * withheld. A single price with the count beside it says what it is.
 *
 * `'unknown'` IS NOT IN THAT LIST, and that is not an oversight: an inter-day
 * trade has no initial stop to report, so the column is null anyway and the
 * `?? null` below is what answers. Were a future `'unknown'` to carry a price,
 * showing it would be right — the sentence beside it already says we could not
 * read the orders.
 */
export function brokerStopToShow(
  history: StoredStopHistory | null,
  column: unknown
): number | null {
  if (history === null) return null;
  if (history.verdict === 'none') return null;
  if (history.initialStopSide === 'wrong') return null;
  return num(column) ?? history.initialStop;
}

/** One sentence, and whether it is a fact or a warning. */
export interface StopSentence {
  text: string;
  /**
   * `'warning'` is reserved for the two things that COST the trader something:
   * a stop moved away from the entry (the risk grew) and no stop at all.
   * Everything else — a tightening, a trailing stop, a stop left alone, a read
   * that failed — is a fact, and colouring it would be the judgement this
   * module refuses to make.
   */
  tone: 'neutral' | 'warning';
}

/**
 * The one line the trade card shows about the broker's stop, or null for
 * "say nothing".
 *
 * THE ORDER OF THE BRANCHES IS THE DESIGN, and each one is ahead of the next for
 * a reason:
 *
 *   1. `'unknown'` first, because every field under it is unreliable by
 *      definition and a later branch would read them.
 *   2. `'none'` next: with no stop there is nothing to have moved, and the
 *      trailing flag and the direction are both meaningless.
 *   3. `trailing` ahead of the direction, because a trailing stop's steps are
 *      the SERVER'S. Reporting them as "the stop was tightened" would credit
 *      the trader with a decision they did not take — and `moved_sl` is
 *      deliberately not written for this case either (./tradovate/import.ts).
 *   4. `'kept'`, then the direction.
 *
 * PRICES ARE SHOWN ONLY WHEN BOTH ENDS ARE READABLE AND THE SIDE IS RIGHT, so
 * the sentence degrades to its own words rather than to "(מ-— ל-—)".
 *
 * AND ONLY WHEN THERE WAS ONE STOP TO DESCRIBE (REF-113 Stage 5). A position
 * scaled into over two entries has two brackets and two stops, and
 * {@link StoredStopHistory.initialStop} is then one of them — the one that
 * stated the most risk — while the verdict spans both. "הסטופ הודק (מ-4504 ל-
 * 4512)" is a true sentence about that bracket and a false one about the trade,
 * so above one stop the sentence keeps its words and drops its numbers. Same
 * reduction `'mixed'` already makes, for the same reason: two prices cannot
 * describe two stops any more than they can describe one that went both ways.
 */
export function stopMoveSentence(history: StoredStopHistory | null): StopSentence | null {
  if (history === null) return null;

  if (history.verdict === 'unknown') {
    return { text: 'לא הצלחנו לקרוא את פקודות הסטופ', tone: 'neutral' };
  }

  if (history.verdict === 'none') {
    return { text: 'לא הוצב סטופ בעסקה הזו', tone: 'warning' };
  }

  // SEVERAL PROTECTIVE ORDERS, WHICH REPLACES THE PRICES RATHER THAN THE WORDS.
  //
  // The sentences stay singular on purpose. "הסטופים הורחקו" would claim BOTH
  // brackets were widened, and `'widened'` over two orders only says that one
  // step somewhere widened and none tightened — so the plural would overstate
  // exactly where this module is most careful not to. What the trader is owed
  // instead is the count, which is also the answer to "why is there no price
  // here": the number describes one of several real stops and the verdict
  // describes all of them.
  const several = history.stopCount !== null && history.stopCount > 1;
  const manyNote = several ? ` (${history.stopCount} פקודות הגנה)` : '';

  if (history.trailing) {
    return { text: `סטופ נגרר אוטומטית${manyNote}`, tone: 'neutral' };
  }

  if (history.verdict === 'kept') {
    return { text: `הסטופ לא הוזז${manyNote}`, tone: 'neutral' };
  }

  // From here the verdict is `'moved'`. The range is appended only where the
  // spec asks for it — `'mixed'` says how MANY times instead, because two
  // prices cannot describe a stop that went both ways, and `several` withholds
  // it for the same reason one level up.
  const from = history.initialStop;
  const to = history.finalStop;
  const range =
    !several && history.initialStopSide !== 'wrong' && from !== null && to !== null
      ? ` (מ-${price(from)} ל-${price(to)})`
      : manyNote;

  if (history.direction === 'mixed') {
    return {
      text: `הסטופ הוזז ${history.movedCount} פעמים — גם הורחק וגם הודק${manyNote}`,
      tone: 'warning',
    };
  }

  if (history.direction === 'widened') {
    return { text: `הסטופ הורחק מנקודת הכניסה — הסיכון גדל${range}`, tone: 'warning' };
  }

  if (history.direction === 'tightened') {
    return { text: `הסטופ הודק לכיוון הרווח${range}`, tone: 'neutral' };
  }

  // `'moved'` WITH NO DIRECTION. The writer cannot produce this — a non-zero
  // `movedCount` always carries one — so it is a stored row from a shape that
  // predates the field, or a document somebody edited. Say the fact and not the
  // direction, and stay neutral: claiming a widening we cannot see is the error
  // this module refuses everywhere else.
  return {
    text:
      history.movedCount > 0
        ? `הסטופ הוזז ${history.movedCount} פעמים${manyNote}`
        : `הסטופ הוזז${manyNote}`,
    tone: 'neutral',
  };
}
