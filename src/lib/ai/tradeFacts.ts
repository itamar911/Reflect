/**
 * One trade, serialised for a model (REF-120).
 *
 * Until this module there was no "serialize a trade for the prompt" anywhere in
 * the repo: every AI route built its own per-trade template in its own route
 * file, and the chat coach's template carried four fields — a win/loss word,
 * the strategy, the planned R:R and the self-reported emotional state. The
 * trader who asked it to analyse their last trade was told, correctly, that it
 * had no symbol, no entry, no exit, no stop and no R:R. All of those columns
 * were already in memory: both AI routes read `select('*')`, so the whole loss
 * was in serialization.
 *
 *
 * THE DENY LIST, WHICH IS WHY THIS IS A MODULE AND NOT A TEMPLATE
 * ---------------------------------------------------------------
 *
 * THESE COLUMNS ARE NEVER READ HERE AND MUST NEVER BE ADDED:
 *
 *   `broker_account_id`   the raw Tradovate account id
 *   `broker_trade_key`    formatted `<host>:<fill id>` — a host token AND a
 *                         broker-side fill id in one string
 *   `broker_host`         `live` / `demo`; an environment label rather than a
 *                         DNS name, but still broker topology
 *   `account_id`          not a name itself, but it dereferences to one
 *   `accounts.display_name`  the broker's own name for the account — i.e. the
 *                         PROP FIRM'S identity. Nothing from `accounts` is read
 *                         here at all, and this module imports no client that
 *                         could reach that table.
 *   `accounts.nickname`, `accounts.broker*`   same class
 *   `user_id`, `id`       UUIDs that buy a model nothing
 *
 * AN EXPLICIT LIST AND NOT A WHITELIST BY OMISSION, because the hazard is not
 * that someone adds `broker_host` on purpose. Both AI routes hold the entire row
 * in memory on every call, and a single `JSON.stringify(trade)` in either file
 * would leak all of the above. A named reader with a named list is the thing
 * that can be asserted — `scripts/features-null-safety-check.ts` greps a
 * deliberately greppable fixture for each of them and fails if one appears.
 * `src/lib/tradovate/notices.ts` states its own boundary the same way.
 *
 * AND NO BROKER STOP PRICE. `broker_stop_loss` is not secret — it is in eleven
 * `select('*')` readers already — and it is still left out, for the reason
 * `src/app/api/ai-debrief/route.ts` records for its own prompt: the stop prices
 * that belong in front of a model are the ones the TRADER COMMITTED TO, and
 * adding the broker's invites the model to compute a risk figure and present it
 * as fact. The behaviour is what a coach needs, and the behaviour is
 * {@link StopSentence} — a verdict, never a price. One policy in one module
 * rather than one per call site.
 *
 * `broker_take_profit` WAS IN THAT SENTENCE UNTIL REF-130 AND IS NOT ANY MORE,
 * which is a narrowing of a stated rule and so is argued rather than assumed.
 * The hazard the rule names is specific: a model handed a stop can subtract it
 * from the entry, call the difference the risk, and divide by it. A TARGET
 * cannot be turned into a risk figure — the arithmetic needs the other leg — and
 * the one ratio it could support is `realisedRr`, which is already here and
 * already computed for the model rather than by it. What the target buys a coach
 * is the sentence `exited_early` was always supposed to support and never could
 * on an imported row: "your target was at X and you took Y". That sentence is
 * the whole of REF-130 part א, and withholding the number would leave the model
 * to infer it from the exit price — which is exactly the guessing the deny list
 * exists to prevent.
 *
 * IT GOES THROUGH `brokerTargetToShow` AND NEVER OFF THE COLUMN, for the reason
 * `realisedRr` goes through `brokerStopToShow`: that function is the single
 * definition of "a broker target a trader may be shown", and it withholds the
 * number on a wrong-side target — a price `nearestTarget` can report when every
 * candidate was on the losing side of the entry. So the model cannot be told a
 * target the trade card declines to print, and the two cannot drift.
 *
 * `realisedRr` IS NOT AN EXCEPTION TO THAT, AND THE DISTINCTION IS THE POINT
 * (REF-123). A RATIO IS NOT A PRICE. The rule above exists because a model
 * handed `broker_stop_loss` would do arithmetic on it and present the output as
 * fact; the fix is to do the arithmetic ourselves, in a tested pure function
 * with the five null cases spelled out, and hand over the RESULT.
 * `lib/journal/realisedRr.ts` will not emit a number at all where
 * `brokerStopToShow` declines to show one, so the coach can never reason about
 * a stop the trader was not shown either. Same shape as the stop sentence
 * directly above: a derived verdict, never a price of its own.
 *
 * TO BE EXACT ABOUT WHAT "NO BROKER STOP PRICE" HAS MEANT SINCE REF-113: the
 * COLUMN is not read, and `stopMoveSentence` nonetheless quotes the price
 * inside its from→to range (`הסטופ הודק לכיוון הרווח (מ-29870.25 ל-29850.50)`).
 * That is deliberate and it is the sentence the trader reads, so the rule above
 * is narrower than it first sounds — it forbids handing the model a bare stop
 * price to do arithmetic on, not every mention of one. Worth knowing before
 * reading the rule as a guarantee that the figure is absent.
 *
 *
 * VALIDATE AT THE BOUNDARY, EVERY FIELD OPTIONAL, NULL MEANS SAY NOTHING
 * ---------------------------------------------------------------------
 *
 * Exactly the discipline of `readStopHistory` and `readTradeStages`, and
 * necessary for their stated reason rather than by analogy: these migrations are
 * run by hand, and `select('*')` against a database where one has not run
 * returns NO KEY AT ALL — not a null. `TradePlan` in lib/types.ts declares none
 * of `broker_stages`, `stop_history`, `plan_symbol`, `link_method` or
 * `link_confirmed_at` either, so a cast here would be a promise nothing keeps.
 *
 * AND NULL IS OMITTED RATHER THAN DRAWN AS A DASH. The template this replaces
 * printed `R:R — מצב-רגשי:—` on every broker row, which is a row of em dashes
 * for the model to describe. The absence is already stated once, where it is
 * measurable: the system prompt's aggregates say `R:R ממוצע: לא תועד` and
 * `אסטרטגיות נפוצות: לא נקבעו` when no row carries one. Saying it again twenty
 * times costs tokens to tell the model the same thing.
 *
 * BROWSER-SAFE AND PURE. No client, no env, no server-only import — so the
 * regression suite drives these functions directly and neither route has to
 * export its prompt builder to be testable. That is the strongest argument for
 * this being its own module.
 *
 * PRICES AS BARE NUMBERS, NO `toFixed(2)`. The debrief prompt already
 * interpolates them bare, and two decimals walk into a live test landmine:
 * `'4995.00'.includes('5.00')` is true, and one assertion in
 * features-null-safety-check.ts was a bare substring test for exactly that.
 * (Anchored in the same change — but the rule stands on its own: a price is a
 * number and a model does not need it padded.)
 *
 * MONEY THROUGH lib/pnl.ts AND NEVER OFF A COLUMN. The money result on a broker
 * row is `actual_pnl`; `pnl_amount` is deliberately never written by the import.
 * `pnlRow` / `hasMoneyPnl` / `tradeMoneyPnl` already resolve that precedence for
 * the stats page, the journal and the dashboard, so the coach quotes the same
 * figure the trader sees.
 *
 * THE SENTENCES ARE REUSED, NOT REWRITTEN. `stopMoveSentence` and
 * `stagesSentence` are what the trade card shows the trader. Before this the
 * debrief built its own English stop sentences from scratch, so the trader and
 * the model read two independent implementations of the same verdict and could
 * disagree about it. One sentence, both readers.
 */

import { linkState, LINK_STATE_COPY } from '@/lib/journal/link';
import { brokerTargetToShow, readStopHistory, stopMoveSentence } from '@/lib/journal/stopHistory';
import { realisedRr, rrLabel } from '@/lib/journal/realisedRr';
import { readTradeStages, stagesSentence } from '@/lib/journal/stages';
import { intentNumber, intentText, rrValue, scaleValue, type RawValue } from '@/lib/intent';
import { formatMoney } from '@/lib/money';
import { hasMoneyPnl, isWinningTrade, pnlRow, tradeMoneyPnl } from '@/lib/pnl';
import { brokerInstrument, planInstrument } from '@/lib/symbols';

/**
 * What a model may be told about one trade. EVERY FIELD NULLABLE — see the
 * header on why none of them can be assumed present.
 */
export interface TradeFacts {
  /**
   * The instrument as a canonical root, micros folded into minis — `NQ`, not
   * `MNQZ6`.
   *
   * THE ROOT AND NOT THE CONTRACT NAME, which is the same reduction
   * lib/tradovate/fills.ts makes for its notices: a contract name carries an
   * expiry the coach has no use for, and `MNQZ6` and `NQH7` are the same
   * instrument traded two quarters apart. The root is what a sentence about a
   * trader's instrument mix can be built on.
   */
  instrument: string | null;
  direction: 'long' | 'short' | null;
  /** `units ?? quantity` — the journal's own precedence; `units` is newer. */
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  /** The stop the TRADER PLANNED. Never the broker's — see the header. */
  plannedStop: number | null;
  /** The target the TRADER PLANNED. */
  plannedTarget: number | null;
  /**
   * The target THE BROKER HELD, through `brokerTargetToShow` (REF-130 part ג,
   * item 4).
   *
   * Null whenever that function declines to state one: no stop document, a row
   * from before `tp_history` (most of the table), no target order placed, or a
   * target on the wrong side of the entry. See the header for why this is the
   * one broker price here and `broker_stop_loss` still is not.
   */
  brokerTarget: number | null;
  /**
   * Whether the broker's target was MOVED. Null when the document does not say.
   *
   * THREE STATES, AND THE THIRD IS NOT `false`. A row with no `tp_history` has
   * not told us the target stayed put — it has told us nothing — and collapsing
   * that to a `false` is the exact defect REF-130 was opened over, committed
   * against a model this time: `ai-debrief/route.ts` collapses three NULL flags
   * to `'לא'` and the model then writes praise on that footing. A null here
   * drops the piece from the line entirely.
   */
  targetMoved: boolean | null;
  rr: number | null;
  /**
   * What the trade RETURNED against the stop the broker held, as a ratio
   * (REF-123). Null whenever `lib/journal/realisedRr.ts` declines to state one
   * — an open trade, no readable broker stop, a wrong-side stop.
   *
   * THE ONE FACT HERE DERIVED FROM A DENIED COLUMN, which is allowed precisely
   * because it is derived — see the header. A coach that can compare `rr`
   * against this one can say "you planned 1:3 and took 1:1.2", which is the
   * sentence the planned figure alone could never support.
   */
  realisedRr: number | null;
  strategy: string | null;
  /** The 1..5 self-report, or null when the row carries none. */
  emotionalState: number | null;
  /** `'open'` while it is still running; null when it cannot be decided. */
  outcome: 'win' | 'loss' | 'open' | null;
  /** The money figure, resolved by lib/pnl.ts. Null when there is none. */
  money: number | null;
  /** The ENTRY instant on a broker row (`submitted_at`), as stored. */
  openedAt: string | null;
  /** The EXIT instant (`closed_at`), as stored. */
  closedAt: string | null;
  /** `stopMoveSentence(...).text` — the verdict the trader reads. */
  stopSentence: string | null;
  /** `stagesSentence(...)` — null unless a side had more than one piece. */
  stagesSentence: string | null;
  /** The stored `computeTradeScore` total. */
  planScore: number | null;
  /** Where the row came from, as the journal words it. Null on a manual plan. */
  source: string | null;
}

/**
 * An instant, or null.
 *
 * A STRING TEST AND THEN A PARSE, because a column that is not a readable
 * instant must not reach a prompt as whatever it happens to be. `submitted_at`
 * is NOT NULL in the schema and is still validated here: this reader is handed
 * `unknown`, and the one caller that cannot be checked is the one that matters.
 */
const instant = (value: unknown): string | null => {
  if (typeof value !== 'string' || value === '') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
};

/**
 * The instrument, from whichever column owns it on this row.
 *
 * TWO COLUMNS AND TWO DIFFERENT READERS, which is the trap REF-120's
 * investigation names: after an import or a link, `symbol` holds the BROKER'S
 * contract name and `plan_symbol` holds what the trader typed; on a manual row
 * `symbol` IS what the trader typed and `plan_symbol` is NULL. Pairing the wrong
 * reader with the wrong column silently mis-buckets the instrument —
 * `brokerSymbolRoot` is the narrow Tradovate reading and answers null for the
 * thinkorswim and TradingView spellings a human types (`/NQ`, `NQ1!`), so a
 * manual row read through it loses its symbol entirely.
 *
 * `plan_symbol` IS THE FALLBACK ON A BROKER ROW rather than the first choice:
 * the broker's contract name is the instrument that was actually traded, and the
 * trader's own spelling is what to fall back to when migration 041 has not run
 * or the contract name is unreadable.
 */
function instrumentOf(row: Record<string, unknown>): string | null {
  const symbol = typeof row.symbol === 'string' ? row.symbol : null;
  const planSymbol = typeof row.plan_symbol === 'string' ? row.plan_symbol : null;
  if (row.source === 'tradovate') {
    return brokerInstrument(symbol) ?? planInstrument(planSymbol);
  }
  return planInstrument(symbol);
}

/**
 * The facts, or null when there is no row to read.
 *
 * Null for the one case a caller can do nothing about — the value is not an
 * object. Everything else degrades field by field, because a row missing a
 * column is the normal case here and not an error: see the header.
 */
export function readTradeFacts(row: unknown): TradeFacts | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

  const raw = row as Record<string, unknown>;
  const money = pnlRow(raw);
  const win = isWinningTrade(money);

  const stops = readStopHistory(raw.stop_history);
  const stages = readTradeStages(raw.broker_stages);

  const direction = raw.direction === 'long' || raw.direction === 'short' ? raw.direction : null;

  return {
    instrument: instrumentOf(raw),
    direction,
    quantity: intentNumber(raw.units as RawValue) ?? intentNumber(raw.quantity as RawValue),
    entryPrice: intentNumber(raw.entry_price as RawValue),
    exitPrice: intentNumber(raw.exit_price as RawValue),
    plannedStop: intentNumber(raw.stop_loss as RawValue),
    plannedTarget: intentNumber(raw.take_profit as RawValue),
    brokerTarget: brokerTargetToShow(stops, raw.broker_take_profit),
    // `?? null` AND NOT A FALSINESS TEST. An absent sub-document gives
    // `undefined` here, and `undefined` is "we did not look" — see the field.
    targetMoved:
      stops?.tpHistory?.verdict === 'moved'
        ? true
        : stops?.tpHistory?.verdict === 'kept'
          ? false
          : null,
    rr: rrValue(raw.rr_ratio as RawValue),
    // The same four arguments the trade card passes, so the figure in the
    // prompt is the figure on the card.
    realisedRr: realisedRr(
      stops,
      raw.broker_stop_loss,
      raw.entry_price as RawValue,
      raw.exit_price as RawValue
    ),
    strategy: intentText(raw.strategy as string | null | undefined),
    emotionalState: scaleValue(raw.emotional_state as RawValue),
    outcome: win === null ? (raw.status === 'closed' ? null : 'open') : win ? 'win' : 'loss',
    // `hasMoneyPnl` first, so a row with no money figure says nothing rather
    // than reporting the measured $0.00 that `tradeMoneyPnl` returns for it.
    money: hasMoneyPnl(money) ? tradeMoneyPnl(money) : null,
    openedAt: instant(raw.submitted_at),
    closedAt: instant(raw.closed_at),
    stopSentence: stopMoveSentence(stops)?.text ?? null,
    stagesSentence: stagesSentence(stages),
    planScore: intentNumber(raw.plan_score as RawValue),
    source: (() => {
      const state = linkState(raw as Parameters<typeof linkState>[0]);
      return state === null ? null : LINK_STATE_COPY[state];
    })(),
  };
}

/** The outcome word, in the same vocabulary the chat prompt already used. */
const OUTCOME_WORD: Record<'win' | 'loss' | 'open', string> = {
  win: '[רווח]',
  loss: '[הפסד]',
  open: '[פתוחה]',
};

const DIRECTION_WORD: Record<'long' | 'short', string> = {
  long: 'לונג',
  short: 'שורט',
};

/**
 * An instant as the prompt carries it: to the minute, and explicitly UTC.
 *
 * NO LOCAL FORMATTING, AND THAT IS DELIBERATE RATHER THAN LAZY. This module is
 * pure and runs on a Vercel server whose clock is UTC while the trader is in
 * Israel, so a "local" time here would be a time neither of them keeps. The
 * stored instant with its `Z` is unambiguous, the model can reason about the
 * interval between two of them, and nothing has to assume a zone. The hour
 * BUCKETS the coach's aggregates are built from have exactly this bug today and
 * are a separate fix.
 */
const minute = (iso: string): string => iso.slice(0, 16) + 'Z';

/**
 * The full Hebrew facts row, for the trades a coach is actually asked about.
 *
 * ONE LINE AND NOT A BLOCK, because twenty of these sit inside a system prompt
 * under `**עסקאות אחרונות:**` and a block per trade would be twenty headings
 * the model has to skip. ` · ` between pieces is the separator the trade card
 * and the day panel already use.
 *
 * EVERY PIECE IS DROPPED WHEN ITS FACT IS NULL — see the header. A manual row
 * with no broker columns renders as a short line about what the trader typed,
 * with no empty labels and no stop or stages sentence, which is the honest
 * output for it and not a degraded one.
 *
 * THE TRADER'S OWN FREE TEXT IS NOT IN HERE. `post_trade_notes` is the trader's
 * prose and the debrief route fences it inside `<trader_notes>` with an
 * injection guard before showing it to a model; a facts line that silently
 * concatenated it would carry that surface into every caller. The chat route
 * appends the notes itself, truncated, exactly as it did before.
 */
export function tradeFactsLine(f: TradeFacts): string {
  const head = [
    f.outcome !== null ? OUTCOME_WORD[f.outcome] : null,
    f.instrument,
    f.direction !== null ? DIRECTION_WORD[f.direction] : null,
    f.quantity !== null ? `${f.quantity} חוזים` : null,
  ].filter((x) => x !== null).join(' ');

  const pieces = [
    head || null,
    f.entryPrice !== null ? `כניסה ${f.entryPrice}` : null,
    f.exitPrice !== null ? `יציאה ${f.exitPrice}` : null,
    f.plannedStop !== null ? `סטופ מתוכנן ${f.plannedStop}` : null,
    f.plannedTarget !== null ? `יעד מתוכנן ${f.plannedTarget}` : null,
    // DIRECTLY AFTER THE PLANNED TARGET, so the two sit side by side for the
    // reason the R:R pair below does: "you planned a target at X and the broker
    // held one at Y" is the comparison, and on an imported row the planned
    // figure is absent and this is the only target there is.
    //
    // ONE PIECE AND NOT TWO, which is what keeps `הוזז` unambiguous. The line's
    // separator is ` · `, so two pieces would render the same string — and a
    // bare `הוזז` in a list that also talks about the stop reads as a stray
    // verb attached to whichever noun is nearest. The price carries it.
    f.brokerTarget !== null
      ? f.targetMoved === null
        ? `יעד בברוקר ${f.brokerTarget}`
        : `יעד בברוקר ${f.brokerTarget} · ${f.targetMoved ? 'הוזז' : 'לא הוזז'}`
      : null,
    f.rr !== null ? `R:R ${f.rr}` : null,
    // DIRECTLY AFTER THE PLANNED R:R, so the two sit side by side in the one
    // line the model reads — the comparison is the whole value of the fact.
    // Labelled and in `1:x` form where `rr` above is bare: an unlabelled second
    // ratio would be indistinguishable from the first.
    f.realisedRr !== null ? `יחס בפועל ${rrLabel(f.realisedRr)}` : null,
    f.money !== null ? `תוצאה ${formatMoney(f.money)}` : null,
    f.openedAt !== null ? `נכנסה ${minute(f.openedAt)}` : null,
    f.closedAt !== null ? `נסגרה ${minute(f.closedAt)}` : null,
    f.strategy !== null ? `אסטרטגיה: ${f.strategy}` : null,
    f.emotionalState !== null ? `מצב-רגשי: ${f.emotionalState}/5` : null,
    f.planScore !== null ? `ציון: ${f.planScore}/100` : null,
    f.stopSentence,
    f.stagesSentence,
    // Prefixed, unlike the two sentences above it: `LINK_STATE_COPY` is the
    // journal's own wording for a row's origin ("Tradovate · מקושרת לתוכנית")
    // and without a label it reads as a stray noun in the middle of a list.
    f.source !== null ? `מקור: ${f.source}` : null,
  ];

  return pieces.filter((x) => x !== null && x !== '').join(' · ');
}

/**
 * The short form, for the tail of the history.
 *
 * WHAT A TAIL ROW IS FOR is the shape of the record rather than the detail of
 * any one trade — "did I trade NQ all month", "how long is this losing run" —
 * so it carries the date, the instrument, the side and the money, and nothing
 * that would make it worth reading twice. It is about the length of the line
 * this change replaces, which is what keeps eighty of them affordable.
 */
export function tradeFactsSummaryLine(f: TradeFacts): string {
  return [
    f.openedAt !== null ? f.openedAt.slice(0, 10) : null,
    f.outcome !== null ? OUTCOME_WORD[f.outcome] : null,
    f.instrument,
    f.direction !== null ? DIRECTION_WORD[f.direction] : null,
    f.money !== null ? formatMoney(f.money) : null,
  ].filter((x) => x !== null).join(' ');
}
