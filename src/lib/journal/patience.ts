/**
 * Whether the trader waited for their own target, derived from the prices
 * (REF-130 part א).
 *
 * `סבלנות` HAS READ ZERO ON EVERY IMPORTED TRADE SINCE THE IMPORT EXISTED, and
 * not because imported traders are impatient. It is derived from
 * `exited_early`, which is a self-report column, and a trade that arrives from
 * the broker answers no questions: the auto-link path never touches the flag
 * (lib/tradovate/import.ts), the manual link path offers it only when the PLAN
 * carries a `take_profit` (./link.ts: `proposeFlags`), and `CloseTrade.tsx` is
 * the only writer and is never shown on a broker row. So the column is NULL,
 * every reader tests `=== true`, and NULL reads as "did not exit early" on the
 * score and as 0% on the axis.
 *
 * Everything needed to answer it properly is already on the row.
 *
 *
 * THE RULE, AND THE PRECEDENCE THAT MAKES IT WORK ON AN IMPORTED ROW
 * ------------------------------------------------------------------
 *
 *   target = `take_profit` → else `broker_take_profit` → else UNKNOWN
 *
 * THE PLAN'S TARGET WINS, which is the opposite precedence to
 * {@link realisedRr}'s and is right for the opposite reason. That module
 * measures the risk the trader WAS REALLY CARRYING, so it must use the stop the
 * broker held and not the one typed into a form. This measures whether the
 * trader HONOURED THEIR OWN INTENTION, and the intention is the number they
 * wrote down. The broker's target is the fallback for the row that has no
 * intention recorded, which is every imported trade — and that fallback is the
 * whole of what this ticket adds.
 *
 *   exit at or beyond the target          → PATIENT  (`'target'`)
 *   the stop closed it, breakeven included → PATIENT  (`'stop'`)
 *   out in profit, short of the target     → IMPATIENT (`'early'`)
 *   a loss that never reached the stop     → UNKNOWN
 *   no target anywhere                     → UNKNOWN
 *   a target on the wrong side of the entry → UNKNOWN
 *
 * A STOP-OUT IS PATIENCE AND NOT A FAILURE. The trader set a level, the market
 * took it, and they were still in the trade when it did. Reading a loss as
 * impatience would make the metric a second win-rate.
 *
 *
 * NO TICK TOLERANCE, BECAUSE THERE IS NO TICK SIZE
 * ------------------------------------------------
 *
 * `tickSize` is declared in lib/tradovate/types.ts and read in ZERO places. The
 * product does not know an instrument's tick, and inventing a tick tolerance
 * would need a new API read and a new column. It also does not need one: `>=`
 * and `<=` ARE the tolerance, for the reason ./link.ts states where the same
 * comparison already lives — the exit price is a quantity-weighted mean of real
 * fills and will essentially never equal a typed number, so equality would read
 * every target hit as an early exit.
 *
 * THE ONE TOLERANCE IS THE BREAKEVEN TEST, and it is {@link withinTolerance} —
 * the product's existing 0.1%, reused rather than re-chosen. A stop moved to the
 * entry and then hit leaves an exit AT THE ENTRY, which is at or beyond no stop
 * this module can resolve: `broker_stop_loss` holds the stop the position OPENED
 * under, ninety points away. Without this test such a trade falls through to
 * "out in profit, short of the target" on any exit a hair above the entry and
 * the trader is told they were impatient about a scratch.
 *
 * **AND 0.1% IS WIDE ON AN INDEX FUTURE — ROUGHLY 30 POINTS ON NQ.** That is a
 * real cost and it is accepted in ONE DIRECTION: inside that band a genuinely
 * early exit reads as `'stop'`, so the trader is credited rather than accused.
 * The reverse error — telling somebody they bailed out of a trade the stop
 * closed — is the one this module refuses, the same standing answer
 * `stopWasWidened` gives for the same reason. The precise fix is the broker's
 * `finalStop`, which would say whether the stop really was at the entry when the
 * trade closed; that is a Stage-2 question and this is deliberately not it.
 *
 *
 * THE WRONG-SIDE TARGET IS UNKNOWN AND NEVER IMPATIENT
 * ----------------------------------------------------
 *
 * `nearestTarget` (lib/tradovate/orders.ts) partitions its candidates by side
 * and then returns the best of whatever it has, so `broker_take_profit` can
 * carry a price on the LOSING side of the entry — measured once as the entry
 * price itself, off a resting BUY LIMIT that produced the fill. An exit is at or
 * beyond such a "target" immediately, so without a side test this module would
 * read `'target'` on a trade with no target at all; and if the sign went the
 * other way it would read `'early'`, which is an accusation built out of our own
 * mis-attribution. So the side is tested HERE, on the resolved number, and a
 * failure is UNKNOWN.
 *
 * TESTED ON THE NUMBER RATHER THAN ON `tp_history.targetSide`, which is the one
 * place this module deliberately does NOT read the sub-document REF-130 part ג
 * writes. Three reasons, and the first is sufficient:
 *
 *   - the sub-document exists only on rows imported after part ג shipped, and
 *     `broker_take_profit` has been populated since Stage 3 — gating on it would
 *     leave `סבלנות` unanswerable on every historical broker row, which is the
 *     entire complaint this ticket opens with;
 *   - the plan's own `take_profit` wins the precedence above and has no
 *     sub-document to carry a side at all. A trader can type a target on the
 *     wrong side of their entry, and that row needs the same answer;
 *   - the test is one subtraction read off `direction`, so there is no
 *     machinery to share.
 *
 * The consequence is visible and is worth stating: the trade card can show
 * `סבלנות: יצאת ביעד` on a row where it shows no `יעד בברוקר` price, because the
 * verdict is answerable from the column where the PRICE is not printable without
 * the document. That is sound — the price row's absence says "we cannot describe
 * this target's history", not "there was no target" — and it is the opposite
 * trade-off from {@link realisedRr}, which must agree with the printed stop
 * because a trader can check its arithmetic by hand. A verdict has no
 * arithmetic to check.
 *
 *
 * IT NEVER WRITES `exited_early`, AND THE TRADER'S ANSWER OUTRANKS IT
 * -------------------------------------------------------------------
 *
 * `exited_early` is a self-report. Writing a derived verdict into it would
 * overwrite what the trader said about their own trade AND arm the
 * `exited_early_last_trade` rule, which can be `block_day` — locking somebody
 * out of the app over a derivation. That is exactly what the import refuses to
 * do for `moved_sl` and explains at length while refusing it
 * (lib/tradovate/import.ts). So there is no column, no migration and no stored
 * verdict: every input is on the row already, and this is a pure derivation at
 * read time, like `stopDirection` before it.
 *
 * AND WHERE THE TRADER HAS ANSWERED, THEY WIN. {@link wasPatient} reads the
 * boolean and does not derive at all; the derivation is the fallback for the row
 * that answered nothing. A manual trade therefore reads EXACTLY as it reads
 * today, which is the property that keeps this change confined to the absence it
 * was opened about.
 *
 *
 * DISPLAY AND AGGREGATION ONLY. `computeTradeScore` is untouched — `exited_early`
 * still costs its twelve points exactly as it did — and nothing here reaches a
 * rule. Scoring a trader on a derivation whose breakeven band is 30 NQ points
 * wide is a product decision this ticket does not take.
 *
 * BROWSER-SAFE AND PURE, for ./stopHistory.ts' reason: the trade card runs in
 * the browser, the statistics page is a server component, and the regression
 * suite drives both without either.
 */

import { intentNumber, type RawValue } from '@/lib/intent';
import { withinTolerance } from '@/lib/scoring/tradeScore';

/**
 * What the prices say about the exit, in the three answers a trader is shown.
 *
 *   `'target'` the exit reached the target
 *   `'stop'`   the stop closed the trade, breakeven included
 *   `'early'`  out in profit, short of the target
 *
 * TWO OF THE THREE ARE PATIENCE. See {@link wasPatient}, which is what an
 * aggregate must read — a caller that treated this as a three-way split would
 * have to re-decide which of them count, and would eventually decide
 * differently from the other caller.
 */
export type PatienceVerdict = 'target' | 'stop' | 'early';

/**
 * One trade, as this module needs it.
 *
 * `RawValue` ON EVERY PRICE, because Postgres `NUMERIC` arrives as a STRING over
 * PostgREST — the hazard ./stopHistory.ts names where it explains why its own
 * reader uses `Number()` rather than a `typeof` test. A `typeof === 'number'`
 * guard here would silently answer UNKNOWN on every row.
 */
export interface PatienceInput {
  /** From the COLUMN and never guessed from target-vs-entry (REF-107 §0ד). */
  direction: 'long' | 'short' | null;
  entryPrice: RawValue;
  /** Null while the trade is open, which is UNKNOWN. */
  exitPrice: RawValue;
  /** `take_profit` — the target the TRADER wrote down. Wins. */
  planTarget: RawValue;
  /** `broker_take_profit` — the fallback that makes an imported row answerable. */
  brokerTarget: RawValue;
  /** `stop_loss` — the stop the trader wrote down. Wins. */
  planStop: RawValue;
  /** `broker_stop_loss` — the stop the position OPENED under (migration 038). */
  brokerStop: RawValue;
  /**
   * `exited_early` — the trader's own answer, in three states.
   *
   * `unknown` AND NOT `boolean | null`, so a typed `TradePlan` and the loose
   * `select('*')` record an AI route carries are both assignable without a cast
   * — lib/scoring/disciplineAggregate.ts states the same reason for
   * `BehaviourFlagRow`. Only a real boolean is an answer.
   */
  exitedEarly: unknown;
}

/**
 * The verdict the PRICES support, or null for unknown.
 *
 * THE ORDER OF THE BRANCHES IS THE DESIGN, and each is ahead of the next for a
 * reason:
 *
 *   1. The side test first, because every branch under it compares against the
 *      target and a wrong-side target makes all of them meaningless.
 *   2. The target next: reaching it is the one answer no other reading can
 *      override. A trade that hit its target and whose stop had been dragged
 *      past the entry would otherwise read as a stop-out.
 *   3. The stop, then breakeven. Both are the same finding — a level the trader
 *      set closed the trade — and breakeven is second only because it is the
 *      weaker evidence of the two.
 *   4. Profit short of the target, which is the only accusation this function
 *      makes and so is the last thing it tries.
 *   5. Everything left is a loss that reached no stop we can name: UNKNOWN.
 *      Not impatience. The trade may have been closed by hand at a level
 *      nobody recorded, and that is our missing data rather than their failing.
 */
export function patienceFromPrices(input: PatienceInput): PatienceVerdict | null {
  const { direction } = input;
  if (direction === null) return null;

  const entry = intentNumber(input.entryPrice);
  const exit = intentNumber(input.exitPrice);
  if (entry === null || exit === null) return null;

  const long = direction === 'long';

  // ── The target: the plan's, then the broker's ─────────────────────────────
  const target = intentNumber(input.planTarget) ?? intentNumber(input.brokerTarget);
  if (target === null) return null;

  // THE SIDE TEST, on the resolved number. `> 0` and not `>= 0`: a "target" AT
  // the entry pays nothing, and the measured wrong-side case was exactly that
  // — the entry price itself, reported as the target.
  const gain = long ? target - entry : entry - target;
  if (gain <= 0) return null;

  // "At or beyond", for the reason the header gives: an exit is a mean of real
  // fills and will never equal a typed price.
  if (long ? exit >= target : exit <= target) return 'target';

  // ── The stop: the plan's, then the broker's, and side-tested too ──────────
  //
  // THE SAME SIDE DISCIPLINE AS THE TARGET, and it is why the raw column is
  // safe to read here without the stop document. `brokerStopToShow` withholds a
  // wrong-side price by branching on `initialStopSide`; `risk > 0` is that test
  // done arithmetically, and it also catches a stop the TRADER typed on the
  // wrong side of their own entry — which no document would have flagged.
  const stop = intentNumber(input.planStop) ?? intentNumber(input.brokerStop);
  const risk = stop === null ? null : long ? entry - stop : stop - entry;
  if (stop !== null && risk !== null && risk > 0) {
    if (long ? exit <= stop : exit >= stop) return 'stop';
  }

  // THE STOP THAT HAD BEEN MOVED TO BREAKEVEN. Neither of the two stops this
  // module can resolve is at the entry — both are "the stop the position opened
  // under" — so a breakeven stop-out is invisible to the comparison above and
  // falls into the accusation below. See the header on the width of this band
  // and on the direction the error is accepted in.
  if (withinTolerance(exit, entry)) return 'stop';

  // ── Out in profit, short of the target ───────────────────────────────────
  if (long ? exit > entry : exit < entry) return 'early';

  // A loss that reached no stop. Say nothing.
  return null;
}

/**
 * The verdict to SHOW, with the trader's own answer ahead of the derivation.
 *
 * `exited_early === true` IS `'early'` OUTRIGHT, with no derivation consulted.
 * The trader said they left early; the prices cannot overrule that, and a
 * reading that did would be arguing with the only person who was there.
 *
 * `exited_early === false` DEFERS TO THE DERIVATION AND CENSORS ONE ANSWER. The
 * prices may be able to say WHICH patient exit it was — `'target'` or `'stop'` —
 * and that is worth showing. What they may not do is contradict the trader into
 * `'early'`, so that one verdict is suppressed and the row shows no line rather
 * than a sentence the trader has already denied. {@link wasPatient} still counts
 * it, which is where the answer belongs: a contradiction is a reason to say
 * nothing, not a reason to forget the trader answered.
 *
 * NULL MEANS SHOW NO LINE, which on the trade card is most rows: every manual
 * trade the trader closed without answering, every imported loss that reached no
 * stop, and every row with no target anywhere.
 */
export function patienceOf(input: PatienceInput): PatienceVerdict | null {
  if (input.exitedEarly === true) return 'early';

  const derived = patienceFromPrices(input);
  if (input.exitedEarly === false) return derived === 'early' ? null : derived;
  return derived;
}

/**
 * Whether the trader waited, as an aggregate must read it. Null for unknown.
 *
 * **THE TRADER'S OWN ANSWER IS THE ANSWER WHEN THERE IS ONE**, in both
 * directions and with no derivation consulted at all — `!exitedEarly`. This is
 * the property that keeps a manual trade reading exactly as it reads today, and
 * it is the one the fixtures lead with.
 *
 * A `typeof` TEST AND NOT `!== null`, which is lib/scoring/disciplineAggregate.ts'
 * one correction to the formula it inherited, made for the reason it states: on
 * a row where the KEY IS ABSENT — a `select('*')` against a database missing the
 * column, or a broker row read as a loose record — `undefined !== null` holds,
 * so the row enters the denominator and then fails the `=== true` test, and an
 * absence counts as a violation. Only a real boolean is an answer.
 *
 * NULL IS NOT FALSE, AND THAT IS THE WHOLE POINT OF THE FUNCTION. A caller that
 * resolved an unknown to "impatient" would be the defect this ticket was opened
 * over, rebuilt. Every caller filters the nulls out of its denominator; see the
 * statistics page.
 */
export function wasPatient(input: PatienceInput): boolean | null {
  if (typeof input.exitedEarly === 'boolean') return !input.exitedEarly;

  const derived = patienceFromPrices(input);
  return derived === null ? null : derived !== 'early';
}

/**
 * The verdict as the trade card says it.
 *
 * THREE SENTENCES, ALL IN THE SECOND PERSON AND NONE OF THEM A JUDGEMENT.
 * `יצאת לפני היעד` is a description of what happened and not `לא היה לך סבלנות`
 * — the same line ./stopHistory.ts draws when it chooses `הורחק` over `הורע`:
 * this module describes, and the judgement belongs to the rule the trader wrote.
 *
 * NO TONE FIELD, unlike {@link StopSentence}. The stop's sentences carry one
 * because two of its four answers COST the trader something — the risk grew, or
 * there was no stop at all. None of these three does: two are patience and the
 * third is a verdict whose evidence has a 30-point breakeven band under it, and
 * colouring that red would be the accusation the header refuses.
 */
export function patienceSentence(verdict: PatienceVerdict): string {
  if (verdict === 'target') return 'יצאת ביעד';
  if (verdict === 'stop') return 'הסטופ סגר';
  return 'יצאת לפני היעד';
}

/** The patience rate over a set of trades, and how many were measurable. */
export interface PatienceTally {
  /** Rows that answered — the DENOMINATOR. */
  measured: number;
  /** Of those, how many waited. */
  patient: number;
}

/**
 * The patience tally over a set of trades (REF-130 part א, item 6).
 *
 * **THE DENOMINATOR IS MEASURED TRADES, AND ZERO IS NOT A ZERO PERCENT.** A
 * trader whose every row is unanswerable has not been measured at 0% patience;
 * they have not been measured. {@link patienceRate} returns null there and the
 * page shows a dash, which is the same rule lib/intent.ts states for the
 * averages and lib/scoring/disciplineAggregate.ts for the four behaviour rates.
 *
 * TAKES THE PROJECTION AND NOT THE ROWS, deliberately: the mapping from a
 * `trade_plans` row to {@link PatienceInput} names eight columns, two of which
 * (`broker_take_profit`, `broker_stop_loss`) are not on the `TradePlan` type at
 * all, and a module that did it internally would need its own loose-record
 * reader and its own cast. The caller holds the row and does it once.
 */
export function patienceTally(inputs: readonly PatienceInput[]): PatienceTally {
  const measured = inputs
    .map((input) => wasPatient(input))
    .filter((value): value is boolean => value !== null);

  return {
    measured: measured.length,
    patient: measured.filter((value) => value).length,
  };
}

/** The rate as a whole percent, or null when nothing was measured. */
export function patienceRate(tally: PatienceTally): number | null {
  if (tally.measured === 0) return null;
  return Math.round((tally.patient / tally.measured) * 100);
}
