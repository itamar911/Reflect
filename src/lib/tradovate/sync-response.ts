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
import { noticeLines, readNotices, type BrokerNotice } from './notices';

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
      /**
       * The contracts whose trades this run refused to state (REF-117 Stage 6).
       *
       * Required here although the wire fields are optional — the parser
       * resolves both absences once, so no consumer has to remember the rule.
       * Empty is the ordinary day.
       */
      heldSymbols: string[];
      /**
       * How many groups were held, INCLUDING any whose contract had no
       * readable name.
       *
       * SO THAT `heldSymbols: [], heldCount: 1` IS EXPRESSIBLE, and it is not a
       * redundancy. A group whose `/contract/item` lookup found nothing — and
       * the orphan-pair group, which is about no contract at all — has an
       * absence worth stating and no symbol to state it with. Reading the list
       * length instead would silently turn that into an ordinary day.
       */
      heldCount: number;
      /**
       * What this run could not do for the trader (REF-112 §5).
       *
       * Required here although the wire field is optional — the parser
       * resolves the absence to an empty list once, the same rule
       * `heldSymbols` follows. Empty is the ordinary day.
       */
      notices: BrokerNotice[];
    } & BrokerImportCounts)
  | { source: 'broker_expired' }
  | { source: 'broker_unavailable' }
  | { source: 'reflect_only' }
  /**
   * The route refused a second sync inside its cooldown (REF-112 §4.5 item 2).
   *
   * THE ONE MEMBER OF THIS UNION THAT IS NOT A `RuleContextSource`, and that is
   * the point rather than an inconsistency. The other four are the shared
   * four-state provenance vocabulary /today and /trades answer with, and they
   * describe what Reflect knows about the broker. A cooldown describes
   * something about REFLECT: the connection is fine, Tradovate is fine, and we
   * declined to ask again this minute.
   *
   * It therefore lives HERE and not in lib/types.ts' `RuleContextSource`, which
   * must not grow a fifth value — the rule engine, the day panel and the
   * journal branch over those four exhaustively and none of them has a sentence
   * for this one.
   *
   * IT NEVER COMES OFF A 200 BODY. {@link readSyncResponse} cannot produce it,
   * because the route answers 429 with an error shape rather than a `source`.
   * The only thing that constructs it is the component's fetch wrapper, from
   * the status code.
   */
  | { source: 'sync_cooldown' };

/** The four stateless outcomes, as singletons: there is nothing to vary. */
export const SYNC_EXPIRED: BrokerSyncOutcome = Object.freeze({ source: 'broker_expired' });
export const SYNC_UNAVAILABLE: BrokerSyncOutcome = Object.freeze({ source: 'broker_unavailable' });
export const SYNC_REFLECT_ONLY: BrokerSyncOutcome = Object.freeze({ source: 'reflect_only' });
export const SYNC_COOLDOWN: BrokerSyncOutcome = Object.freeze({ source: 'sync_cooldown' });

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
    // REF-117 Stage 6. Absent means nothing was held, the same rule
    // `importEnabled` follows — and a deployment from before this stage held
    // things it could not report, which reads as the quiet day it always did.
    //
    // EVERY ELEMENT MUST BE A NON-EMPTY STRING OR IT IS DROPPED. A symbol is
    // the whole content of the sentence below; a `""` or a number would
    // render as "עסקאות ב- ממתינות", and the count is what carries an
    // unnameable group anyway.
    heldSymbols: Array.isArray(b.heldSymbols)
      ? b.heldSymbols.filter((s): s is string => typeof s === 'string' && s !== '')
      : [],
    // NOT FLOORED TO THE LIST LENGTH, deliberately: a run that held one group
    // it could not name sends `heldSymbols: []` with `heldCount: 1`, and that
    // is a sentence rather than silence. Non-finite or negative reads as zero.
    heldCount:
      typeof b.heldCount === 'number' && Number.isFinite(b.heldCount) && b.heldCount > 0
        ? b.heldCount
        : 0,
    // REF-112 §5. `readNotices` drops what it does not recognise rather than
    // refusing the body — see its own note on why that rule is the opposite of
    // the one COUNT_FIELDS follows, and why the difference is deliberate.
    notices: readNotices(b.notices),
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
 * failure. So the page states what it is showing and stops.
 *
 * It used to stop there because the allowlist was small enough that explaining
 * the refusal would identify a person. That reason is retired — the connection
 * is open to every signed-in user (lib/tradovate/allowlist.ts) — and the
 * sentence is unchanged, because `reflect_only` is now overwhelmingly reached by
 * a trader who simply has no broker connected, and "only trades you recorded
 * here" is exactly the right thing to tell them.
 */
export const REFLECT_ONLY_NOTE = 'מוצגות רק עסקאות שתיעדת ב-Reflect.';

/**
 * The sentence for a second sync inside the server's cooldown
 * (REF-112 §4.5 item 2).
 *
 * HERE RATHER THAN IN THE ROUTE, although the route is what sends it. This
 * module is the home of this route's copy — it holds `REFLECT_ONLY_NOTE` and
 * every sentence {@link describeSyncOutcome} returns — and it is browser-safe
 * and pure, so the component can render the sentence without importing a
 * server route and the route can send it without duplicating a string. One
 * definition is also what lets the suite pin it once.
 *
 * "סנכרנו לפני רגע" AND NOT "יותר מדי בקשות". The trader pressed a button and
 * the honest answer is that we already did the thing: what they are looking at
 * is a few seconds old, not withheld. A rate-limit sentence would describe our
 * own bookkeeping rather than their situation, and would read as a telling-off
 * for using the product.
 *
 * "נסה שוב בעוד דקה" IS THE ONE INSTRUCTION HERE, and it is allowed where §8's
 * "describes, does not instruct" rule — a NinjaTrader vendor compliance
 * requirement — is not. That rule is about TRADING guidance; this instructs
 * about Reflect's own button, names no market, no position and no price. A
 * refusal with no way out of it is the one thing worse than instructing.
 *
 * IT NAMES THE SAME MINUTE `SYNC_COOLDOWN_MS` DOES (./connections.ts), so the
 * two move together. No emojis (CLAUDE.md). The em-dash matches
 * {@link heldNote} and the rest of this module.
 */
export const SYNC_COOLDOWN_NOTE = 'סנכרנו לפני רגע — נסה שוב בעוד דקה';

/** What the trader is told after a sync, and whether to offer a way out of it. */
export interface SyncMessage {
  /** The result sentence. Always present; never empty. */
  text: string;
  /**
   * The qualifiers under it, one line each. Empty on most runs.
   *
   * A LIST SINCE REF-117 STAGE 6, AND IT HAD TO BECOME ONE. It was a single
   * nullable string carrying the open-position note, and there are now two
   * independent things that can both be true of one run: a position is still
   * open, AND a contract's trades could not be stated at all. They answer
   * different questions and neither may suppress the other — collapsing them
   * would mean the held sentence hid behind the routine one, or the reverse,
   * depending on the order somebody wrote the ternary in.
   *
   * Each is a second line rather than a clause because each answers a
   * different question from the headline: the headline says what this run did,
   * these say why a trade the trader took is still not in the journal.
   *
   * MOST NEWSWORTHY FIRST, like the headline's own clauses: "we could not read
   * this contract at all" outranks "an open position waits for its close",
   * because the first is a gap in the day's figures and the second is the
   * mechanism working as designed.
   */
  details: string[];
  /** Whether to offer the reconnect link. True in exactly one state. */
  reconnect: boolean;
  /** Whether this reports a run that failed to do what it set out to do. */
  problem: boolean;
}

/** A trade closed today but still open at the broker will not be imported (§A3, rule 1). */
const OPEN_POSITION_NOTE = 'פוזיציה פתוחה נכנסת ליומן רק לאחר סגירתה.';

/**
 * A contract whose trades could not be stated at all (REF-117 Stage 6).
 *
 * THE SURFACE THE STAGE 2 BUILD REPORT LEFT OPEN. `cycles.ts` refuses to state
 * any cycle for a `(account, contract)` group whose fills cannot account for
 * the broker's own `netPos` — a truncated `/fill/list`, or an overnight carry
 * whose opening fills are outside the API's depth. The group is HELD rather
 * than thrown, because throwing costs the trader every rule on every contract
 * plus the journal, while holding costs them one contract for one day. That
 * exchange was explicitly conditional on the absence being visible, and until
 * now nothing anywhere said it.
 *
 * WHAT THE WORDS DO AND DO NOT CLAIM:
 *
 *   - "ממתינות" and not "חסרות". The next sync re-offers the same window, and
 *     the usual cause — a response that arrived short — does not repeat.
 *   - "הנתונים מהברוקר לא תאמו" is the honest description of a failed
 *     reconciliation: we are not saying the broker is wrong and not saying the
 *     trader is, only that two figures from the same source disagree.
 *   - NO COUNT OF TRADES, because there is none to give: a held group produced
 *     no cycles, so "how many trades are waiting" is precisely the thing that
 *     could not be worked out. Saying "3 עסקאות ממתינות" would be inventing
 *     the number whose absence is the finding.
 *   - DESCRIPTIVE, NEVER AN INSTRUCTION — §8 of TodayContextPanel, which is a
 *     NinjaTrader vendor compliance requirement. "ננסה שוב" is what WE will
 *     do, not something the trader is told to do. No emojis (CLAUDE.md).
 *
 * THE SYMBOL IS NAMED WHEN WE HAVE IT AND THE SENTENCE STANDS WITHOUT IT. A
 * group whose `/contract/item` lookup found nothing, and the orphan-pair group
 * which is about no contract at all, still produce a line — the absence is the
 * thing worth saying and the contract is the detail. See
 * {@link BrokerSyncOutcome.heldCount} on why that case is expressible.
 */
function heldNote(symbols: readonly string[]): string {
  const tail = 'הנתונים מהברוקר לא תאמו, ננסה שוב בסנכרון הבא.';
  if (symbols.length === 0) return `עסקאות ממתינות — ${tail}`;
  // Comma-joined rather than one line per contract. Two held contracts at once
  // means something broad went wrong with the response, not two unrelated
  // facts, and two identical sentences differing only in a symbol is the shape
  // a reader skips. The symbols are latin and ltr-isolated by the component.
  return `עסקאות ב-${symbols.join(', ')} ממתינות — ${tail}`;
}

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
 * to "my trade did not appear" in both. SO DOES THE HELD NOTE (REF-117 Stage 6),
 * for the same reason and with one addition: it also flips `problem`, because
 * a run that could not state a contract's trades has not left the journal
 * up to date whatever else it managed. See {@link heldNote}.
 */
export function describeSyncOutcome(outcome: BrokerSyncOutcome): SyncMessage {
  const plain = (text: string, problem = true): SyncMessage => ({
    text,
    details: [],
    reconnect: false,
    problem,
  });

  if (outcome.source === 'broker_expired') {
    // The same words as TodayContextPanel's expired branch, trimmed of the
    // rule-engine clause that does not apply here: nothing is being evaluated,
    // a sync was asked for and the credential is what stopped it.
    return { text: 'החיבור ל-Tradovate פג.', details: [], reconnect: true, problem: true };
  }
  if (outcome.source === 'broker_unavailable') {
    return plain('לא הצלחנו למשוך עסקאות מ-Tradovate. נסה שוב בעוד רגע.');
  }
  if (outcome.source === 'reflect_only') {
    return plain(REFLECT_ONLY_NOTE);
  }
  if (outcome.source === 'sync_cooldown') {
    // `problem: false`, WHICH IS THE ONLY `false` AMONG THESE BRANCHES. Nothing
    // went wrong: the journal is as up to date as the last sync left it, which
    // was under a minute ago. `problem: true` paints the line in the warning
    // colour and tells the trader to worry about a cap working as designed.
    return plain(SYNC_COOLDOWN_NOTE, false);
  }

  if (!outcome.ran) {
    // Both of these answer with ten zeroes and `source: 'broker_verified'`.
    // `importEnabled` is the only field that separates them, and they need
    // separating because one is ours to fix and one is the trader's.
    return outcome.importEnabled
      ? plain('הגדרת שהברוקר אינו מקור העסקאות שלך')
      : plain('ייבוא עסקאות אינו פעיל בחשבון הזה');
  }

  // Every qualifier, most newsworthy first — see {@link SyncMessage.details}.
  //
  // THE NOTICES OUTRANK BOTH OF THE OTHERS (REF-112 §5), and the ordering is
  // the same judgement the other two were ranked by. A held group is a gap in
  // ONE contract's figures that the next sync is expected to close; an open
  // position is the mechanism working as designed. A notice is a part of the
  // trader's account that Reflect cannot read AT ALL and will not be able to
  // tomorrow either — an account in the wrong currency, an account type
  // nobody provisioned for, a product the chain cannot resolve. That is the
  // one of the three that might make them stop using the journal, so it goes
  // first. lib/tradovate/notices.ts orders them among themselves.
  const details = [
    ...noticeLines(outcome.notices),
    ...(outcome.heldCount > 0 ? [heldNote(outcome.heldSymbols)] : []),
    ...(outcome.skippedOpen > 0 ? [OPEN_POSITION_NOTE] : []),
  ];

  if (outcome.failed > 0) {
    return {
      text: 'חלק מהעסקאות לא נשמרו. נסה שוב בעוד רגע.',
      details,
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
    details,
    reconnect: false,
    // A HELD GROUP MAKES A RUN A PROBLEM EVEN WHEN EVERY ROW IT OFFERED WAS
    // WRITTEN (REF-117 Stage 6). `problem` decides whether the headline is
    // drawn in the ordinary text colour or the muted one, and "הכל מעודכן" in
    // grey above "עסקאות ב-MNQZ6 ממתינות" would be two lines contradicting
    // each other. Not everything IS updated: a contract's trades are missing
    // from the day, and the figures every rule reads are short by them.
    //
    // AND SO DOES A NOTICE (REF-112 §5), for the same reason and more
    // strongly: a skipped account is a whole portfolio missing from the day,
    // not one contract.
    problem: outcome.heldCount > 0 || outcome.notices.length > 0,
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
