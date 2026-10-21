/**
 * What `trade_plans.broker_stages` says, read defensively, and the one line a
 * trader is shown about it (REF-117 Stage 6).
 *
 * BROWSER-SAFE AND PURE, and it DELIBERATELY DOES NOT IMPORT `TradeStages`
 * FROM lib/tradovate/fills.ts — the same split lib/journal/stopHistory.ts
 * makes and for the same reason. That module is server-only and the shape
 * declared there describes what the WRITER writes; this describes what a READER
 * may assume, and the two are not the same claim. `broker_stages` is JSONB with
 * no CHECK (migration 040 says so and says why), and there is no backfill and
 * cannot be one: the legs come from `/fill/list`, measured at `depthDays = 0`,
 * so the fills behind every row written before 040 are gone. A structural type
 * validated at the boundary is the honest reading; a cast would be a promise
 * nothing keeps.
 *
 *
 * SILENCE IS THE DEFAULT, AND THE BAR FOR BREAKING IT IS TWO PIECES
 * ----------------------------------------------------------------
 *
 * Three answers, and the first two are the same rendering:
 *
 *   NULL / unreadable          we never measured it        → SAY NOTHING
 *   one entry and one exit     entered whole, exited whole → SAY NOTHING
 *   more than one on a side    scaled in, or scaled out    → one line
 *
 * THE SECOND ROW IS THE ONE WORTH ARGUING. "נכנסת בשלב אחד · יצאת בשלב אחד" is
 * true of most trades and tells a trader nothing they did not type themselves;
 * printed on every imported row it would be a column announcing a feature that
 * does not apply. REF-117's §5.1 makes the same reduction for the live line and
 * the trade card's stop row makes it for a manual trade. A simple round trip
 * renders as it did before this stage.
 *
 *
 * AND THE SUM IS NOT ASSERTED AGAINST `quantity`
 * ----------------------------------------------
 *
 * It would be an easy check and it is the wrong one. The two sides of a CLOSED
 * cycle sum to the same figure, which `quantity` holds — but a row that
 * disagrees is a row whose stages were written by a shape nobody has seen, and
 * the honest response to that is to say nothing rather than to say a number
 * that came from somewhere else. So the reader validates each PIECE (a finite
 * quantity, a finite price) and drops a document it cannot read whole; it does
 * not reconcile the document against its own row. The place that reconciliation
 * belongs is the pull, where `reconcile()` in lib/tradovate/cycles.ts already
 * refuses to state a cycle whose fills cannot account for the broker's netPos.
 */

/**
 * One piece of an entry or an exit. BOTH FIELDS REQUIRED, because a piece with
 * no quantity is not a piece and a piece with no price cannot be shown.
 */
export interface StoredStage {
  qty: number;
  price: number;
}

/** The pieces, in the order they happened. */
export interface StoredStages {
  entries: StoredStage[];
  exits: StoredStage[];
}

/**
 * A finite number, or null.
 *
 * `Number(value)` AND NOT A `typeof` TEST, for lib/journal/stopHistory.ts'
 * measured reason: PostgREST returns `NUMERIC` as a STRING, and although the
 * numbers inside this document are JSONB rather than columns, the same client
 * and the same hazard apply the moment anything re-serialises them.
 */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * One side's pieces, or null when ANY of them cannot be read.
 *
 * ALL OR NOTHING PER SIDE, which is the opposite of dropping the bad ones and
 * is the only safe reading: a side that silently lost a piece reports "נכנסת
 * ב-2 שלבים" on a position entered in three, and a count that is wrong by one
 * is worse than no count — the trader has no way to tell which they are
 * looking at. Same rule `versionInstants` applies to a clock in
 * lib/tradovate/orders.ts.
 */
function readSide(value: unknown): StoredStage[] | null {
  if (!Array.isArray(value)) return null;

  const pieces: StoredStage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entry = raw as Record<string, unknown>;
    const qty = num(entry.qty);
    const price = num(entry.price);
    if (qty === null || price === null) return null;
    pieces.push({ qty, price });
  }
  return pieces;
}

/**
 * The stored document, or null when there is nothing a reader may rely on.
 *
 * NULL FOR FIVE DIFFERENT THINGS, AND ALL FIVE MEAN "SAY NOTHING": the column
 * is NULL, migration 040 has not been run so `select('*')` returns no key at
 * all, the value is not an object, a side is not an array, or a piece inside
 * one cannot be read. The last two are the defensive cases and they are
 * deliberately strict — see {@link readSide}.
 *
 * AN EMPTY SIDE IS KEPT RATHER THAN REFUSED, and that is not an oversight. A
 * cycle with no visible entries is the `interday` shape, which the pull
 * declines to import at all today — so the document cannot currently arrive —
 * and if a later stage gives interday cycles a row, "we know of no entry
 * pieces" is a true thing for it to hold. {@link stagesSentence} says nothing
 * for it either way, because nothing above one is a stage worth naming.
 */
export function readTradeStages(value: unknown): StoredStages | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const entries = readSide(raw.entries);
  const exits = readSide(raw.exits);
  if (entries === null || exits === null) return null;

  return { entries, exits };
}

/**
 * Whether this trade is worth saying anything about. See the header.
 *
 * Exported because three surfaces ask it — the trade card, the day panel's
 * line and the suite — and "more than one on either side" must have one
 * definition rather than three.
 */
export function wasScaled(stages: StoredStages | null): boolean {
  return stages !== null && (stages.entries.length > 1 || stages.exits.length > 1);
}

/**
 * "בשלב אחד", "בשני שלבים", "ב-3 שלבים" — how many pieces, with the preposition.
 *
 * TWO RULES IN FOUR WORDS, and both were caught in the browser rather than in
 * an assertion.
 *
 * 1. HEBREW HAS A DUAL. "ב-2 שלבים" reads as a translation; "בשני שלבים" is
 *    the sentence. The same rule `contractsLabel` applies in
 *    components/tradovate/LivePositionLines.tsx, and it is written out twice
 *    rather than shared because that module is a client component about live
 *    positions and this one is a pure reader about stored rows — importing one
 *    into the other to share four words would couple two unrelated surfaces.
 *
 * 2. THE PREPOSITION IS PART OF THIS AND NOT OF THE TEMPLATE, which is why the
 *    "ב" is here. `ב` attaches directly to a Hebrew word and takes a MAQAF
 *    only before a numeral or a latin token — "בשני שלבים" but "ב-3 שלבים".
 *    A template that wrote `ב-${word}` got "נכנסת ב-שני שלבים", which is the
 *    bidi-and-punctuation mistake this codebase has already made twice with
 *    separators inside `dir="ltr"` spans.
 */
function inStages(n: number): string {
  if (n === 1) return 'בשלב אחד';
  if (n === 2) return 'בשני שלבים';
  return `ב-${n} שלבים`;
}

/**
 * The one line the trade card shows, or null for "say nothing".
 *
 * BOTH HALVES ARE ALWAYS NAMED WHEN EITHER IS INTERESTING, which is a decision
 * rather than a convenience: "יצאת ב-3 שלבים" alone leaves the reader to
 * wonder about the entry, and the answer ("in one") is a fact the document
 * holds. The threshold is on the PAIR and the sentence is on both.
 *
 * A STATEMENT OF FACT AND NEVER AN INSTRUCTION — §8 of
 * components/trade/TodayContextPanel.tsx, which is a NinjaTrader vendor
 * compliance requirement rather than a style preference. "נכנסת" and "יצאת"
 * describe what happened; there is no "כדאי" and no judgement about whether
 * scaling in was wise. No emojis (CLAUDE.md).
 */
export function stagesSentence(stages: StoredStages | null): string | null {
  if (!wasScaled(stages)) return null;
  return describeStages(stages!.entries.length, stages!.exits.length);
}

/**
 * The same sentence from two COUNTS, for a surface that has only those.
 *
 * EXPORTED SO THERE IS ONE SENTENCE AND NOT TWO. The day panel renders the
 * counts as "2→3" and puts this behind them as the title — a reader who cannot
 * see the shorthand, or a screen reader, gets the words. It had its own
 * template for one commit and the template said "נכנסת ב-1 שלבים" the first
 * time a trade was entered whole and exited in three, because a raw numeral
 * knows nothing about Hebrew's dual or about where a maqaf goes. See
 * {@link inStages}.
 */
export function describeStages(entries: number, exits: number): string {
  return `נכנסת ${inStages(entries)} · יצאת ${inStages(exits)}`;
}

/**
 * The pieces themselves, one short string each, for the detail under the line.
 *
 * `qty × price`, LTR, which is how every figure in this journal is rendered —
 * the quantity first because that is the order the sentence above names them
 * in and the order a broker statement prints them in.
 *
 * Empty when there is nothing to show, so a caller renders nothing rather than
 * an empty container. A trade that was not scaled returns two empty lists for
 * the same reason {@link stagesSentence} returns null: there is nothing here a
 * trader does not already have from `quantity` and the two prices.
 */
export function stagePieces(stages: StoredStages | null): { entries: string[]; exits: string[] } {
  if (!wasScaled(stages)) return { entries: [], exits: [] };
  const piece = (stage: StoredStage): string => `${stage.qty} × ${stage.price.toFixed(2)}`;
  return {
    entries: stages!.entries.map(piece),
    exits: stages!.exits.map(piece),
  };
}

/**
 * How many pieces each side had, for a surface with room for a number and not
 * a sentence — the day panel's line (REF-117 Stage 6, step 2 of the ticket).
 *
 * Null when there is nothing to say, so the panel's existing rows are
 * untouched on an ordinary trade. The pair rather than a single figure: a
 * trader reading a list of the day's closes wants to see WHICH of them were
 * scaled and on which side, and "2·3" is the whole of that in four characters.
 */
export function stageCounts(stages: StoredStages | null): { entries: number; exits: number } | null {
  if (!wasScaled(stages)) return null;
  return { entries: stages!.entries.length, exits: stages!.exits.length };
}
