/**
 * What `trade_plans.stop_history` says, read defensively, and the sentences a
 * trader is shown about it (REF-113 Stage 5; the target half is REF-130 part ג).
 *
 * TWO DOCUMENTS IN ONE COLUMN SINCE REF-130, and they are read apart rather than
 * together: `stop_history` now carries a nested `tp_history` describing the
 * trade's TARGET orders, and {@link StoredStopHistory.tpHistory} is null on every
 * row written before it. The stop's verdict and the target's are independent
 * claims — a trade can have a readable stop and an unreadable target — so each
 * has its own reader, its own "show nothing" list and its own sentence. See
 * {@link StoredTargetHistory} for why the target speaks on one answer where the
 * stop speaks on four.
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
 * There are FIVE answers and a reader that collapses any two of them is the bug
 * this ticket exists to prevent:
 *
 *   NULL / unreadable  we never looked          → SAY NOTHING
 *   `'none'`           we looked, no stop       → "לא הוצב סטופ בעסקה הזו"
 *   `'kept'`           we looked, never moved   → "הסטופ לא הוזז"
 *   `'unknown'`        we looked, could not tell → "לא הצלחנו לקרוא..."
 *   `stopAtEntry: false`  a stop, but not at the open → "נכנסת בלי סטופ..."
 *
 * `'kept'` AND `'unknown'` ARE THE PAIR THAT MATTERS. Without a distinct
 * sentence for `'unknown'` it reads exactly like `'kept'` — a trader would be
 * told their stop stayed put on the strength of a read that failed, which is a
 * claim about their discipline made out of our own missing data.
 *
 * THE FIFTH IS REF-113 STAGE 6 AND IT IS NOT A VERDICT. A late stop is `'kept'`
 * or `'moved'` like any other stop that existed; what it is not is a stop the
 * position opened under. See {@link StoredStopHistory.stopAtEntry} for why that
 * lives beside the verdict rather than inside it, and why its absence is a third
 * state rather than a `true`.
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
 * What the document says about the TRADE'S TARGET, as a reader may assume it
 * (REF-130 part ג).
 *
 * THE SAME CLAIM-SPLIT THIS FILE'S HEADER MAKES, applied to a sub-document:
 * `TargetHistory` in lib/tradovate/orders.ts describes what the WRITER writes,
 * and this describes what a READER may rely on. The two are not the same, and
 * here the gap is at its widest — every row written before REF-130 carries no
 * `tp_history` key at all, which is most of the table and will be forever.
 *
 * FIVE ANSWERS AGAIN, AND FOUR OF THEM SHOW NOTHING:
 *
 *   null / unreadable   we never looked, or the row predates the key → NOTHING
 *   `'none'`            we looked, no target order            → NOTHING
 *   `'unknown'`         the target was on the wrong side      → NOTHING
 *   `'kept'`            a target, never moved                 → the price
 *   `'moved'`           a target, moved                       → the price and
 *                                                               one sentence
 *
 * ONLY `'moved'` EARNS A SENTENCE, which is where this deliberately differs
 * from the stop beside it. `stopMoveSentence` speaks on all four answers because
 * each is a finding about the trader's RISK: "no stop was placed" and "we could
 * not read the orders" are both worth saying out loud. A target is an
 * expectation rather than a risk — a trade with no target is an ordinary trade
 * — so the three silent answers are silent, and the price row's own presence is
 * what says a target existed.
 */
export interface StoredTargetHistory {
  verdict: 'moved' | 'kept' | 'none' | 'unknown';
  /** The first price the chosen target order stated. */
  initialTp: number | null;
  /** The last price it stated. */
  finalTp: number | null;
  /**
   * Which side of the entry {@link initialTp} sat on.
   *
   * `'wrong'` MEANS NO PRICE MAY BE SHOWN, for the reason
   * {@link StoredStopHistory.initialStopSide} gives about stops: it says our own
   * attribution picked an order that cannot have been this trade's target. The
   * writer already resolves that case to `verdict: 'unknown'`, so this is the
   * second of two locks on one door — and the one that still works if a future
   * writer reports a side without reclassifying the verdict.
   */
  targetSide: 'gain' | 'wrong' | null;
  /** How many times the price changed, over consecutive versions. */
  movedCount: number;
  /** Which way, over consecutive steps and never end-to-end. */
  direction: 'closer' | 'farther' | 'mixed' | null;
  /**
   * How many priced target orders the row chose between, or null.
   *
   * NULL IS "WE DO NOT KNOW HOW MANY", NOT ONE — {@link StoredStopHistory.stopCount}'s
   * rule, for its reason. No reader branches on it yet; it is read so that the
   * figure is available to the next one rather than having to be added later.
   */
  targetCount: number | null;
}

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
   *
   * AND IT COUNTS CONCURRENT STOPS RATHER THAN ORDERS SINCE STAGE 6, which
   * changed the writer and needed nothing here: a cancelled stop and the order
   * that replaced it are one stop, so a single stop moved once still reports
   * `1` and still keeps its range. Every branch below reads only `> 1`.
   */
  stopCount: number | null;
  /**
   * Whether a protective stop was in force WHEN THE POSITION OPENED, or null
   * (REF-113 Stage 6).
   *
   * **NULL IS "WE DO NOT KNOW", AND IT MUST NOT BECOME `true`.** Every row
   * written before Stage 6 carries no such key and there is no backfill, so
   * resolving the absence to `true` would state that each of those positions
   * opened protected — which is the claim the field exists to be able to deny.
   * {@link stopMoveSentence} therefore branches on `=== false` and never on
   * falsiness.
   *
   * `false` IS THE FINDING: a stop existed in this trade and the position was
   * not protected when it opened. It is not the same thing as
   * `verdict === 'none'`, which is "no stop at any point", and the sentence for
   * the two is different because the trader did two different things.
   */
  stopAtEntry: boolean | null;
  /**
   * The first stop placed after the position opened, when there was none at the
   * open. Null otherwise (REF-113 Stage 6).
   *
   * DELIBERATELY NOT WHAT `broker_stop_loss` HOLDS, and {@link brokerStopToShow}
   * will not offer it: that column and that panel are "the stop the position
   * opened under", beside the stop the trader planned, and there was none.
   */
  lateStop: number | null;
  /**
   * The trade's only protective stop was cancelled with nothing in its place
   * (REF-113 Stage 6).
   *
   * THE SENTENCE CANNOT BE WRITTEN WITHOUT THIS FIELD. A cancellation is counted
   * as a widening — the trader rode the rest of the position with no stop — and
   * it is a widening WITH NO "TO" PRICE, while {@link finalStop} still holds the
   * last price the stop was submitted at. Without this flag the row renders as
   * "הסטופ הורחק מנקודת הכניסה (מ-4504 ל-4504)", a from→to range describing a
   * cancellation. {@link stopMoveSentence} gives it its own words instead.
   *
   * A PLAIN BOOLEAN, unlike {@link stopAtEntry}: an absent key and a `false`
   * withhold the same sentence, so there is nothing a third state could tell a
   * reader that it does not already know.
   */
  cancelledUnreplaced: boolean;
  /**
   * What the document says about the TARGET, or null (REF-130 part ג).
   *
   * **NULL IS "SAY NOTHING ABOUT THE TARGET", AND IT IS THE COMMON CASE.** Every
   * row written before REF-130 carries no `tp_history` key, there is no backfill
   * and there cannot be one (see the header), so this is null on most of the
   * table — and on every manual trade forever, because a manual trade has no
   * broker orders to read.
   *
   * THE CAMELCASE NAME READS A SNAKE_CASE KEY, which is the one place in this
   * file where the field and the key disagree. REF-130 named the stored key
   * `tp_history`, after the column it deliberately is not; a stored key is the
   * one thing a later rename cannot reach, so the key keeps its spelling and
   * this field keeps the file's.
   *
   * SEPARATE FROM THE STOP'S VERDICT AND NOT FOLDED INTO IT. A trade can have a
   * readable stop and an unreadable target, or the reverse, and the two
   * sentences are shown four rows apart — so a reader that had to infer one from
   * the other would eventually print a claim about a target off the stop's
   * evidence.
   */
  tpHistory: StoredTargetHistory | null;
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
const TARGET_SIDES = ['gain', 'wrong'] as const;
const TARGET_DIRECTIONS = ['closer', 'farther', 'mixed'] as const;

/**
 * The target sub-document, or null when there is nothing to rely on.
 *
 * NULL FOR FOUR THINGS AND ALL FOUR MEAN "SAY NOTHING", which is
 * {@link readStopHistory}'s own list one level down: the key is absent (every
 * row before REF-130), the value is not an object, it is an array, or it carries
 * no recognisable verdict. The last is the defensive case and is strict for the
 * same reason — a sub-document whose verdict we cannot read is one whose prices
 * we have no reason to trust.
 *
 * EXPORTED SO THE STORED KEY IS NAMED IN ONE PLACE. The stats page reads this
 * off a loose `select('*')` row rather than through the whole stop document, and
 * a second `raw.tp_history` spelled out there would be a second place to get the
 * snake_case right.
 */
export function readTargetHistory(value: unknown): StoredTargetHistory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Raw;
  const verdict = str(raw.verdict, VERDICTS);
  if (verdict === null) return null;

  return {
    verdict,
    initialTp: num(raw.initialTp),
    finalTp: num(raw.finalTp),
    targetSide: str(raw.targetSide, TARGET_SIDES),
    // `?? 0` for the same reason `movedCount` has it: a count nobody wrote is a
    // count of nothing, and every branch below treats zero as "did not move".
    movedCount: num(raw.movedCount) ?? 0,
    direction: str(raw.direction, TARGET_DIRECTIONS),
    // NO `?? 1`, unlike the count above and like `stopCount`. See the field.
    targetCount: num(raw.targetCount),
  };
}

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
    // THREE STATES, AND THE ABSENT ONE IS NOT `true`. A strict test on both
    // booleans rather than a cast or a `=== true` with a `?? true` behind it:
    // the rows that carry no key are rows from before the measurement existed,
    // and they are not entitled to say the position opened protected.
    stopAtEntry:
      raw.stopAtEntry === true ? true : raw.stopAtEntry === false ? false : null,
    lateStop: num(raw.lateStop),
    cancelledUnreplaced: raw.cancelledUnreplaced === true,
    // The snake_case key, read once. See the field.
    tpHistory: readTargetHistory(raw.tp_history),
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

/**
 * The broker's target, to show beside the one the trader planned — or null
 * (REF-130 part ג).
 *
 * TAKES THE COLUMN AND THE DOCUMENT FOR {@link brokerStopToShow}'S REASON:
 * `broker_take_profit` is the number and `stop_history.tp_history` is what says
 * whether the number means anything. Null for four reasons and all four render
 * as NOTHING rather than as a dash beside a figure:
 *
 *   - we never looked, or the row predates `tp_history` (no sub-document)
 *   - we looked and the trader placed no target (`'none'`)
 *   - the target we found was on the WRONG SIDE of the entry (`'unknown'`, and
 *     `targetSide === 'wrong'` independently) — see the field
 *   - the column is unreadable and the document names no price either
 *
 * THE THIRD IS THE ONE THIS FUNCTION EXISTS FOR, and it is why no surface reads
 * `broker_take_profit` directly. `nearestTarget` returns the best of its
 * candidates even when every one of them was on the losing side of the entry, so
 * that column has been able to hold such a price since Stage 3 — measured once
 * as the ENTRY PRICE ITSELF, from a resting BUY LIMIT that produced the fill.
 * Printing it beside the target the trader typed is the one thing this declines
 * to do.
 *
 * `targetCount > 1` IS NOT IN THAT LIST, which is {@link brokerStopToShow}'s
 * `stopCount` decision taken the same way and for a weaker reason: the nearest
 * of two targets is still "my target" (Imri, 19.10), and nothing here prints a
 * from→to range that two orders could falsify.
 */
export function brokerTargetToShow(
  history: StoredStopHistory | null,
  column: unknown
): number | null {
  const target = history?.tpHistory ?? null;
  if (target === null) return null;
  if (target.verdict === 'none' || target.verdict === 'unknown') return null;
  if (target.targetSide === 'wrong') return null;
  return num(column) ?? target.initialTp;
}

/**
 * The one line the trade card shows about the broker's target, or null for "say
 * nothing" (REF-130 part ג).
 *
 * ONLY A MOVE IS WORTH A SENTENCE. The three other answers are silent, and that
 * asymmetry against {@link stopMoveSentence} is the product decision rather than
 * an omission — see {@link StoredTargetHistory}. A target left alone is the
 * ordinary case and the price row above already says there was one; "no target
 * was placed" is not a finding about a trader the way "no stop was placed" is.
 *
 * **NEUTRAL IN BOTH DIRECTIONS, AND THE ENTRY IS NAMED IN EACH. THIS IS THE
 * TRAP THE TICKET WARNS ABOUT.** `הורחק` two rows up means the stop moved away
 * from the entry and the RISK GREW — a warning — and here it means the trader
 * let a winner run, which costs them nothing. Same word, opposite value, two
 * rows apart. So neither direction is toned as a failing and neither is left to
 * stand on the verb alone: every sentence ends in `— קורב לנקודת הכניסה` or
 * `— הורחק מנקודת הכניסה`, naming the thing the target moved relative to.
 *
 * AND IT IS NEUTRAL FOR A SECOND REASON, WHICH IS THAT WE CANNOT YET TELL THE
 * INTERESTING CASE FROM THE DULL ONE. There is no exit-drag cut for targets —
 * `TargetHistory` in lib/tradovate/orders.ts says so — so a trader who dragged a
 * limit down to the bid to get out now reads as a large `'closer'` — the same
 * shape as a trader who talked themselves out of their own target. Colouring
 * either as a failing would be scoring a measurement that cannot distinguish
 * them.
 *
 * NO PRICES. {@link stopMoveSentence} quotes a from→to range because the stop's
 * two prices are the risk and the trader can check them against their own
 * memory. A target's range adds nothing the count and the direction do not say,
 * and `finalTp` on a dragged limit is the exit price under another name.
 */
export function targetMoveSentence(history: StoredStopHistory | null): StopSentence | null {
  const target = history?.tpHistory ?? null;
  if (target === null) return null;
  if (target.verdict !== 'moved') return null;
  if (target.movedCount < 1 || target.direction === null) return null;

  const suffix =
    target.direction === 'closer'
      ? 'קורב לנקודת הכניסה'
      : target.direction === 'farther'
        ? 'הורחק מנקודת הכניסה'
        : 'גם וגם';

  // "פעם אחת" AND NOT "1 פעמים". Hebrew counts one differently, and a target
  // moved once is the common case — where the stop's own count sentence is
  // reached only by `'mixed'`, which needs two steps and can never be one.
  const times = target.movedCount === 1 ? 'פעם אחת' : `${target.movedCount} פעמים`;

  return { text: `היעד הוזז ${times} — ${suffix}`, tone: 'neutral' };
}

/** How many of a set of trades had their target moved, and which way. */
export interface TargetMoveTally {
  /** Rows whose target we can describe at all — the DENOMINATOR. */
  measured: number;
  /** Of those, how many moved it. */
  moved: number;
  /** Of those that moved it, how many only ever pulled it IN. */
  closer: number;
  /** Of those that moved it, how many only ever pushed it OUT. */
  farther: number;
}

/** A row as this tally needs it: the column, however the caller holds it. */
export interface TargetHistoryRow {
  stop_history?: unknown;
}

/**
 * The target-move tally over a set of trades (REF-130 part ג, item 3).
 *
 * **THE DENOMINATOR IS ROWS WE CAN DESCRIBE, NOT ROWS.** Only `'moved'` and
 * `'kept'` count — a row with no `tp_history` (most of the table, and every
 * manual trade), a `'none'` and an `'unknown'` are each excluded, and for the
 * reason lib/scoring/disciplineAggregate.ts states about its own four rates: a
 * trade we have no evidence about is not evidence either way, and dividing by
 * the row count would read a journal full of hand-logged trades as a trader who
 * never moves a target. `'none'` is excluded too and that is deliberate rather
 * than lumped in: it is a real finding — we read the orders and there was no
 * target — but a trade with no target cannot have had one moved, so counting it
 * as a row that "did not move the target" would be crediting discipline to the
 * absence of the thing being measured.
 *
 * A TALLY AND NOT A PERCENTAGE. "1 of 4" and "25%" are the same arithmetic and
 * very different claims at these sample sizes, and the four behaviour chips
 * beside this one already carry the percentage form; see {@link targetMoveLine}.
 *
 * `closer + farther` CAN BE LESS THAN `moved`, and nothing here hides that: a
 * `'mixed'` row moved its target both ways, so it is counted in `moved` and in
 * neither direction. {@link targetMoveLine} therefore prints the two directions
 * as a note beside the count rather than as a breakdown of it.
 *
 * AN AGGREGATE IN A PER-DOCUMENT MODULE, which is a deliberate altitude choice:
 * the counting rule above IS the reading of the column — which verdicts are an
 * answer — and leaving it in the page would put it somewhere no regression
 * script can reach. The page keeps the filtering (closed, visible, in-account)
 * that is its own business.
 */
export function targetMoveTally(rows: readonly TargetHistoryRow[]): TargetMoveTally {
  const known = rows
    .map((row) => readStopHistory(row.stop_history)?.tpHistory ?? null)
    .filter(
      (target): target is StoredTargetHistory =>
        target !== null && (target.verdict === 'moved' || target.verdict === 'kept')
    );

  const moved = known.filter((target) => target.verdict === 'moved');

  return {
    measured: known.length,
    moved: moved.length,
    closer: moved.filter((target) => target.direction === 'closer').length,
    farther: moved.filter((target) => target.direction === 'farther').length,
  };
}

/**
 * What the target-move row is called, wherever it is drawn.
 *
 * EXPORTED BECAUSE {@link targetMoveLine} IS NOT THE ONLY THING THAT PRINTS IT.
 * A zero denominator returns null here and the statistics page draws the row
 * anyway, with a dash — so the label exists in a second place, and a second
 * spelling of it is a row that renames itself the moment a trader's first
 * import lands. See BehaviorChips.tsx.
 */
export const TARGET_MOVE_LABEL = 'הזזת יעד';

/**
 * The statistics page's one line about target moves, or null for "no figure".
 *
 * NULL ON A ZERO DENOMINATOR, which is most accounts and every account whose
 * trades are all hand-logged. `הזזת יעד: 0 מתוך 0` is a row announcing a
 * measurement that was never taken.
 *
 * **NULL IS NO LONGER "SHOW NOTHING", AND THAT IS A REVERSAL OF WHAT THIS
 * COMMENT SAID.** It argued the page should omit the row entirely, on the
 * grounds that the four behaviour chips draw `—` only because they are a fixed
 * grid. The denominator here is the number of broker rows imported SINCE
 * REF-130 part ג shipped — `tp_history` is written on import and has no
 * backfill — so it is zero for every trader on the day the feature ships and
 * stays zero until their next import. Omitting the row made a shipped feature
 * indistinguishable from one that does not exist, which is what the first
 * trader to look for it reported. The row is now drawn either way: this returns
 * the figure when there is one, and the page pairs the null with a dash and a
 * sentence saying when the figure will arrive.
 *
 * STILL NULL RATHER THAN A FORMATTED `0 מתוך 0`, because the two cases need
 * different WORDS and not just a different number — "none of your trades moved
 * their target" and "we have not measured a trade yet" are opposite claims. The
 * copy for the second belongs beside the dash it explains.
 *
 * THE DIRECTIONS ARE A NOTE AND NOT A BREAKDOWN. They are dropped when nothing
 * moved — `(קורב 0 · הורחק 0)` is noise — and they do not have to sum to the
 * count, because a `'mixed'` row belongs to neither. ` · ` is the separator the
 * trade card and the facts line already use.
 */
export function targetMoveLine(tally: TargetMoveTally): string | null {
  if (tally.measured === 0) return null;

  const note =
    tally.moved > 0 ? ` (קורב ${tally.closer} · הורחק ${tally.farther})` : '';
  return `${TARGET_MOVE_LABEL}: ${tally.moved} מתוך ${tally.measured} עסקאות${note}`;
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
 *   2b. `stopAtEntry === false` next (REF-113 Stage 6): the trader entered
 *      UNPROTECTED and the stop arrived afterwards, which outranks anything
 *      that happened to it later — and there are no prices to quote, because
 *      `initialStop` is null on a late stop by construction.
 *   2c. `cancelledUnreplaced` next (REF-113 Stage 6): the stop was pulled and
 *      nothing replaced it, which is the final state of the trade's risk — and
 *      the one `'moved'` shape whose step has no "to" price to quote.
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

  // ── ENTERED WITHOUT A STOP (REF-113 Stage 6) ─────────────────────────────
  //
  // AHEAD OF `trailing` AND OF THE DIRECTION, because it is the first thing
  // about the trade: a stop that arrived after the position did is the headline,
  // and "the stop was tightened" told on its own would describe the management
  // of a risk the trader was not carrying when they took it on.
  //
  // `=== false` AND NOT `!history.stopAtEntry`. Null is "we do not know" — every
  // row written before this stage — and a falsiness test would announce this
  // finding on every one of them.
  //
  // `warning` FOR BOTH, consistently with the tone's own definition: it is
  // reserved for the things that COST the trader something, and the measured
  // seconds or minutes between the fill and the stop are seconds or minutes of
  // unbounded risk.
  //
  // AND NO PRICES ON EITHER, which falls out of {@link StoredStopHistory}
  // rather than being withheld here: `initialStop` is null on a late stop, so
  // there is no "from" for a from→to range to start at. The two sentences say
  // what happened in words, which is what the trader can check against their
  // own memory of the trade.
  if (history.stopAtEntry === false) {
    return {
      text:
        history.movedCount > 0
          ? 'נכנסת בלי סטופ — הסטופ הוצב אחרי הכניסה והוזז לאחר מכן'
          : 'נכנסת בלי סטופ — הסטופ הוצב אחרי הכניסה',
      tone: 'warning',
    };
  }

  // ── THE STOP WAS CANCELLED AND NOTHING TOOK ITS PLACE (Stage 6) ──────────
  //
  // AHEAD OF THE DIRECTION FOR THE SAME REASON THE LATE STOP IS: it is the
  // final state of the risk, and "the stop was widened" is a true but much
  // smaller thing to say about a trade that finished with no stop at all.
  //
  // AND IT IS THE ONE `'moved'` SHAPE WITH NO PRICES TO QUOTE. The step has no
  // "to" price — a cancellation states none — so this branch returns before the
  // range below can pair `finalStop` with `initialStop` and describe the
  // cancellation as a move from a price to itself.
  if (history.cancelledUnreplaced) {
    return { text: 'הסטופ בוטל ולא הוצב סטופ אחר', tone: 'warning' };
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
