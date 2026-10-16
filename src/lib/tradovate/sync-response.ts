/**
 * What POST /api/tradovate/sync said, and the sentence the trader is shown for
 * it (REF-107 Stage 2.5).
 *
 * BROWSER-SAFE AND PURE. No fetch, no env, no Supabase client, no React — the
 * two things in here are a parser that trusts nothing and a mapping from an
 * outcome to copy, and both are plain functions over values so the regression
 * suite can drive every state without a browser. The component that calls them
 * (components/tradovate/BrokerSyncButton.tsx) holds the fetch and the state.
 *
 *
 * WHY A PARSER AND NOT A CAST
 * ---------------------------
 *
 * The same reason {@link import('@/lib/rules/brokerDayContext').readBrokerDayResponse}
 * is one: a half-built body must not reach the copy as a set of zeroes, because
 * every count in this response reads as zero when it is absent and "0 imported,
 * 0 failed" is the exact shape of "הכל מעודכן". A response that cannot be
 * recognised is {@link BROKER_UNAVAILABLE} — degrade and say so — which is the
 * same fallback and the same rule as /today's reader.
 *
 *
 * READ `ran`, NEVER `source` ALONE
 * --------------------------------
 *
 * The route answers `source: 'broker_verified'` in two states where it never
 * spoke to Tradovate at all: the import flag is off, and the trader has
 * declared the broker is not a source of their trades (E7). Both are honest —
 * there is no broker data and none was claimed — but a UI that branched on
 * `source` would report "synced with your broker" on a deployment with the
 * integration switched off. `ran` is the field that tells them apart from a
 * real run, and `importEnabled` is the field that tells the two of THEM apart
 * from each other. The suite asserts both.
 *
 * NOT `isTradeSource`, which is what the Stage 2.5 investigation proposed and
 * which does not work: lib/tradovate/sync.ts forces that field to false
 * whenever the flag is off — it cannot read a column migration 034 may not
 * have added yet — so it arrives exactly equal to `ran` and discriminates
 * nothing. The flag does.
 */

import type { BrokerImportCounts } from './import';

/**
 * The sync route's answer, after parsing.
 *
 * The same four-state `source` union as /today and /trades, so a caller renders
 * "your connection lapsed" identically on all three. `importEnabled` is
 * required here although the wire field is optional — the parser resolves the
 * absence to `false` once, so no consumer has to remember the rule.
 */
export type BrokerSyncOutcome =
  | ({
      source: 'broker_verified';
      /** The earliest close this run covered, ISO 8601. */
      windowStart: string;
      /** When this was read from Tradovate, ISO 8601. */
      asOf: string;
      /** Whether TRADOVATE_IMPORT_ENABLED was set for this run. See the header. */
      importEnabled: boolean;
    } & BrokerImportCounts)
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' };

/** The three stateless outcomes, as singletons: there is nothing to vary. */
export const SYNC_EXPIRED: BrokerSyncOutcome = Object.freeze({ source: 'broker_expired' });
export const SYNC_UNAVAILABLE: BrokerSyncOutcome = Object.freeze({ source: 'broker_unavailable' });
export const SYNC_REFLECT_ONLY: BrokerSyncOutcome = Object.freeze({ source: 'reflect_only' });

/**
 * The seven NUMERIC fields of {@link BrokerImportCounts} THAT HAVE ALWAYS BEEN
 * THERE, in the order it declares them. `ran` is checked on its own, because
 * it is a boolean and because it is the one the display branches on.
 *
 * `linkedAuto` and `queued` are deliberately NOT here. A body missing
 * `imported` is not a body we understand and the whole response is refused;
 * a body missing the two Stage 3b counts is a deployment from before Stage 3b,
 * which linked nothing because it could not — so they are read below as
 * optional with a floor of zero, the same rule `importEnabled` follows.
 */
const COUNT_FIELDS = [
  'offered',
  'imported',
  'updated',
  'unchanged',
  'skippedOpen',
  'skippedHidden',
  'failed',
] as const;

/**
 * Turn a route response into an outcome, trusting none of its shape.
 *
 * Anything unrecognised is `broker_unavailable`. That includes a
 * `broker_verified` body missing a single count, and a `ran` that arrived as
 * the string `"true"` — only the boolean will do, for the reason the header
 * gives: `ran` is the field the whole display branches on, and a truthy string
 * would make "the import is switched off" render as a successful sync.
 */
export function readSyncResponse(body: unknown): BrokerSyncOutcome {
  if (typeof body !== 'object' || body === null) return SYNC_UNAVAILABLE;
  const b = body as Record<string, unknown>;

  if (b.source === 'reflect_only') return SYNC_REFLECT_ONLY;
  if (b.source === 'broker_expired') return SYNC_EXPIRED;
  if (b.source === 'broker_unavailable') return SYNC_UNAVAILABLE;
  if (b.source !== 'broker_verified') return SYNC_UNAVAILABLE;

  if (typeof b.windowStart !== 'string' || typeof b.asOf !== 'string') return SYNC_UNAVAILABLE;
  if (typeof b.ran !== 'boolean') return SYNC_UNAVAILABLE;

  const counts: Record<string, number> = {};
  for (const field of COUNT_FIELDS) {
    const value = b[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) return SYNC_UNAVAILABLE;
    counts[field] = value;
  }

  return {
    source: 'broker_verified',
    windowStart: b.windowStart,
    asOf: b.asOf,
    // Absence means false, the same rule readBrokerDayResponse applies to its
    // own optional flag. Talking to a deployment from before Stage 2.5, the
    // field is missing and `ran: false` is genuinely ambiguous — so it
    // resolves to the sentence that blames nobody ("the import is not active
    // on this account") rather than to one that tells a trader they made a
    // setting they may never have touched.
    importEnabled: b.importEnabled === true,
    ran: b.ran,
    offered: counts.offered,
    imported: counts.imported,
    // Optional on the wire, zero when absent — see COUNT_FIELDS on why these
    // two are not treated like the seven above.
    linkedAuto: typeof b.linkedAuto === 'number' && Number.isFinite(b.linkedAuto) ? b.linkedAuto : 0,
    queued: typeof b.queued === 'number' && Number.isFinite(b.queued) ? b.queued : 0,
    updated: counts.updated,
    unchanged: counts.unchanged,
    skippedOpen: counts.skippedOpen,
    skippedHidden: counts.skippedHidden,
    failed: counts.failed,
  };
}

// ── The copy ────────────────────────────────────────────────────────────────

/**
 * The sentence shown where the broker view is not available at all (E16).
 *
 * The same words as components/trade/TodayContextPanel.tsx' fallback, as a
 * constant because this is now said in four places — the panel, and the slot
 * beside the CSV button on each of the three pages. §E16 of the Stage 1
 * investigation is why it is said at all: in a JOURNAL, where the trader
 * expects their trades to appear by themselves, silence is the worst available
 * failure, and the allowlist is small enough that explaining the refusal would
 * identify a person. So the page states what it is showing and stops.
 */
export const REFLECT_ONLY_NOTE = 'מוצגות רק עסקאות שתיעדת ב-Reflect.';

/** What the trader is told after a sync, and whether to offer a way out of it. */
export interface SyncMessage {
  /** The result sentence. Always present; never empty. */
  text: string;
  /**
   * A qualifier under it, or null.
   *
   * Only ever the open-position note today. It is a second line rather than a
   * clause because it answers a different question from the headline: the
   * headline says what this run did, this says why a trade the trader took is
   * still not in the journal.
   */
  detail: string | null;
  /** Whether to offer the reconnect link. True in exactly one state. */
  reconnect: boolean;
  /** Whether this reports a run that failed to do what it set out to do. */
  problem: boolean;
}

/** A trade closed today but still open at the broker will not be imported (§A3, rule 1). */
const OPEN_POSITION_NOTE = 'פוזיציה פתוחה נכנסת ליומן רק לאחר סגירתה.';

/**
 * Hebrew counts one, and then everything else.
 *
 * "נוספו 1 עסקאות" is the kind of thing that makes a product look unfinished,
 * and the singular is a different verb form and not just a different noun — so
 * both are spelled out rather than built from a template.
 */
function addedSentence(n: number): string {
  return n === 1 ? 'נוספה עסקה אחת' : `נוספו ${n} עסקאות`;
}

function updatedSentence(n: number): string {
  return n === 1 ? 'עודכנה עסקה אחת' : `עודכנו ${n} עסקאות`;
}

/**
 * A trade that found the plan behind it (Stage 3b).
 *
 * ITS OWN CLAUSE AND NOT FOLDED INTO `addedSentence`, because what happened is
 * different and better: nothing was added to the journal — one of the trader's
 * OWN plans now carries the result of the trade they planned. "נוספה עסקה
 * אחת" would describe it as a new row, and the row is not new.
 */
function linkedSentence(n: number): string {
  return n === 1
    ? 'עסקה אחת שויכה לתוכנית שכתבת'
    : `${n} עסקאות שויכו לתוכניות שכתבת`;
}

/**
 * The outcome, as a sentence.
 *
 * THE ORDER OF THE BRANCHES IS THE POINT, and it is this:
 *
 * 1. **The three non-verified states** say what went wrong with the connection,
 *    because no count is meaningful when the pull did not happen.
 * 2. **`ran === false`** splits on `importEnabled` into the two states §D could
 *    not tell apart before this stage: the flag is off (an operator fact) and
 *    the trader declared the broker is not their source of trades (their own
 *    setting, which they can change). With the flag on, the declaration is the
 *    only remaining reason a run did not happen.
 * 3. **`failed > 0` outranks everything that follows**, including a successful
 *    import in the same run. "הכל מעודכן" next to rows the database refused is
 *    the one sentence here that would be a lie, and the next run retries them.
 * 4. Then imports, then updates, then "nothing to do" — most newsworthy first.
 *
 * The open-position note rides along with any run that happened, because it is
 * equally true whether the run added five trades or none, and it is the answer
 * to "my trade did not appear" in both.
 */
export function describeSyncOutcome(outcome: BrokerSyncOutcome): SyncMessage {
  const plain = (text: string, problem = true): SyncMessage => ({
    text,
    detail: null,
    reconnect: false,
    problem,
  });

  if (outcome.source === 'broker_expired') {
    // The same words as TodayContextPanel's expired branch, trimmed of the
    // rule-engine clause that does not apply here: nothing is being evaluated,
    // a sync was asked for and the credential is what stopped it.
    return { text: 'החיבור ל-Tradovate פג.', detail: null, reconnect: true, problem: true };
  }
  if (outcome.source === 'broker_unavailable') {
    return plain('לא הצלחנו למשוך עסקאות מ-Tradovate. נסה שוב בעוד רגע.');
  }
  if (outcome.source === 'reflect_only') {
    return plain(REFLECT_ONLY_NOTE);
  }

  if (!outcome.ran) {
    // Both of these answer with ten zeroes and `source: 'broker_verified'`.
    // `importEnabled` is the only field that separates them, and they need
    // separating because one is ours to fix and one is the trader's.
    return outcome.importEnabled
      ? plain('הגדרת שהברוקר אינו מקור העסקאות שלך')
      : plain('ייבוא עסקאות אינו פעיל בחשבון הזה');
  }

  const detail = outcome.skippedOpen > 0 ? OPEN_POSITION_NOTE : null;

  if (outcome.failed > 0) {
    return {
      text: 'חלק מהעסקאות לא נשמרו. נסה שוב בעוד רגע.',
      detail,
      reconnect: false,
      problem: true,
    };
  }

  // The clauses that actually happened, newsworthy first. An update is only
  // mentioned when it is the ONLY thing that happened, which is the precedence
  // this function already had — a run that imported and updated reads as an
  // import. A link is mentioned always, because it is the one outcome the
  // trader has no other way to notice: no row appeared, one of their plans
  // quietly grew a result.
  const clauses: string[] = [];
  if (outcome.imported > 0) clauses.push(addedSentence(outcome.imported));
  if (outcome.linkedAuto > 0) clauses.push(linkedSentence(outcome.linkedAuto));
  if (clauses.length === 0 && outcome.updated > 0) clauses.push(updatedSentence(outcome.updated));

  return {
    text: clauses.length > 0 ? clauses.join(' · ') : 'הכל מעודכן',
    detail,
    reconnect: false,
    problem: false,
  };
}

/**
 * Whether this run put something in the journal that is not on screen yet.
 *
 * The refresh is driven off this rather than off "the request finished",
 * because two of the three pages pay a server round trip for it (§C) and
 * "הכל מעודכן" is the common case — a trader who clicks the button twice in a
 * row should not re-run a thousand-row query to be told nothing changed.
 */
export function syncChangedRows(outcome: BrokerSyncOutcome): boolean {
  return outcome.source === 'broker_verified' && outcome.ran &&
    // `linkedAuto` belongs here for the same reason it gets its own clause in
    // the copy: it changes a row that is already on screen, from an open plan
    // to a closed trade with a result. Leaving it out would show the trader
    // "עסקה אחת שויכה לתוכנית שכתבת" over a list that still says פתוחה.
    (outcome.imported > 0 || outcome.linkedAuto > 0 || outcome.updated > 0);
}
