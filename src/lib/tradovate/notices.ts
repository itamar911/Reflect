/**
 * What Reflect could not do for this trader, and the sentence that says so
 * (REF-112 §5, live vs demo).
 *
 * BROWSER-SAFE AND PURE. No fetch, no env, no Supabase client, no React — a
 * wire type, a parser that trusts nothing, and a mapping from a notice to copy.
 * The same construction, and the same reason, as ./sync-response.ts: the
 * regression suite drives every state without a browser, and the server builds
 * the same values it sends.
 *
 *
 * WHY THIS EXISTS AS A MECHANISM RATHER THAN FIVE MORE FIELDS
 * -----------------------------------------------------------
 *
 * REF-117 Stage 6 put ONE absence on the wire — `heldSymbols` / `heldCount` —
 * and the argument it made is general: a day that is UNDER-COUNTED makes every
 * rule MORE PERMISSIVE, which is the one direction this integration must never
 * fail in, so an under-count is only defensible if the trader can see it.
 * REF-112 §5 found five more places where the live product universe is wider
 * than the demo one that was exercised, and every one of them presents to the
 * trader as the same thing: an honest-looking zero. A non-USD account, an
 * account type nobody provisioned in testing, a host that answered with a 500,
 * a connection the deployment can no longer refresh, a product the pricing
 * chain cannot resolve.
 *
 * Five more pairs of optional wire fields would be five more chances to add
 * the sixth one and forget the sentence. One list, one parser, one place the
 * copy lives.
 *
 *
 * WHAT MAY BE IN A NOTICE, AND WHAT MAY NOT
 * -----------------------------------------
 *
 * THIS TYPE CROSSES THE WIRE, so the bound is the same one `HeldGroup.symbol`
 * documents and it is tighter than it looks:
 *
 *   - `account` IS A LABEL A PERSON CHOSE OR A BROKER PRINTED, never an
 *     account id. The id is host-local, meaningless to the trader, and the
 *     leak group in scripts/tradovate-today-check.ts exists to keep ids off
 *     the wire. lib/tradovate/sync.ts is what reduces the server-side notice —
 *     which does carry the id, because it has to resolve a nickname with it —
 *     to this string.
 *   - `root` IS A SYMBOL ROOT AND NOT A CONTRACT. `MNQ`, never `MNQZ6`: the
 *     expiry says which month a trader was in, the root says which instrument,
 *     and only the second is needed to recognise the sentence.
 *   - NO PRICES, NO QUANTITIES, NO HOSTNAMES, NO IDS of any kind. There is no
 *     member of this union with a number on it.
 *
 * None of it is ever logged. The pull logs counts (lib/tradovate/fills.ts) and
 * lib/portfolios/read.ts' header states the rule for the label specifically: a
 * `display_name` on a prop trader's account is a firm's name, and its one
 * allowed destination is the screen, under that trader's own RLS.
 */

/**
 * One thing that did not work, in a form the trader can act on.
 *
 * ORDERED BY HOW BADLY IT BREAKS THE JOURNAL, most severe first, and
 * {@link orderNotices} relies on the declaration order below being that order.
 */
export type BrokerNotice =
  /**
   * The connection can no longer be refreshed (§5.4).
   *
   * Not produced by a pull — a pull cannot happen at all in this state. It is
   * derived from the stored connection row by {@link brokerStateNotices}, and
   * it is the one notice that appears on /accounts and the dashboard rather
   * than in the sync panel.
   */
  | { kind: 'connection_environment' }
  /**
   * The connection's refresh deadline is close and nothing has renewed it
   * (REF-112 follow-up item 4).
   *
   * BEFORE THE FAILURE AND NOT AFTER IT, which is the whole of why it exists.
   * The trader's only signal until now was a connection that had ALREADY
   * stopped working — `connection_environment` above, or /settings' "ההרשאה
   * השמורה פגה" — and by then the reconnect is mandatory rather than
   * avoidable. `refresh_expires_at` is known, so the window in which the
   * trader can still act is knowable too.
   *
   * NOT A COUNTDOWN, AND THAT IS WHAT MAKES IT A SIGNAL. See
   * {@link refreshDeadlineNear}: a healthy connection never renders this,
   * because every successful redemption pushes the deadline a full 26 hours
   * out and the row is never inside the window to begin with. A trader who
   * sees it is a trader for whom the automatic renewal is demonstrably not
   * working.
   *
   * Derived from the stored row by {@link brokerStateNotices}, like
   * `connection_environment` and for the same reason: no pull is involved and
   * none would help.
   */
  | { kind: 'connection_expiring' }
  /**
   * Discovery found nothing this trader could have traded (§5.12).
   *
   * AN ERROR STATE AND NOT AN EMPTY LIST, which is the reversal REF-112 asked
   * for. ./accounts.ts' header argued the other way — "a connection whose
   * scope holds nothing tradeable has honestly reported zero trades today" —
   * and that reasoning held for an allowlist of traders whose accounts were
   * known to be ordinary. At open rollout, zero eligible accounts is far more
   * likely to mean the filter rejected something real than that the trader has
   * no accounts.
   */
  | { kind: 'no_accounts' }
  /**
   * An account denominated in something other than US dollars (§5.10).
   *
   * `account` is the trader's own nickname where they set one and the
   * broker's `Account.name` otherwise — ./sync.ts resolves it. NULL degrades
   * the sentence to the one that does not name an account rather than
   * suppressing it, the same rule `unpriced_product.root` follows: a skipped
   * account is the finding and which one is the detail. Unreachable in
   * practice, because `name` is a required field on the documented entity.
   */
  | { kind: 'account_currency'; account: string | null }
  /** An account whose `accountType` this integration does not handle (§5.12). */
  | { kind: 'account_type'; account: string | null }
  /**
   * One of the two hosts did not answer, so the day may be short (§5.2).
   *
   * DELIBERATELY GENERIC. Which host failed, what it answered and how many
   * accounts it holds are operator facts; the trader's question is only
   * whether what they are looking at is complete.
   */
  | { kind: 'host_degraded' }
  /**
   * A trade whose product the pricing chain could not resolve (§5.11).
   *
   * `root` is null when the contract name is not the `<ROOT><MONTH><YEAR>`
   * shape lib/symbols.ts will read — a spread, an option, a combo leg. The
   * sentence degrades to the one without a symbol rather than disappearing:
   * the missing trade is the finding and the instrument is the detail, which
   * is the same rule {@link import('./fills').HeldGroup.symbol} follows.
   */
  | { kind: 'unpriced_product'; root: string | null };

/** The kinds, in severity order. See {@link BrokerNotice}. */
const KIND_ORDER: readonly BrokerNotice['kind'][] = [
  'connection_environment',
  'connection_expiring',
  'no_accounts',
  'account_currency',
  'account_type',
  'host_degraded',
  'unpriced_product',
];

/** The two members carrying a trader-visible account label. */
const ACCOUNT_KINDS: readonly BrokerNotice['kind'][] = ['account_currency', 'account_type'];

// ── The copy ────────────────────────────────────────────────────────────────
//
// EVERY SENTENCE DESCRIBES AND DOES NOT INSTRUCT, which is §8 of
// TradeContextPanel's rule and a NinjaTrader vendor compliance requirement.
// "ננסה שוב בסנכרון הבא" is what WE will do. The two exceptions are
// "צור קשר ונבדוק" and "חבר מחדש", and they are allowed for the reason
// SYNC_COOLDOWN_NOTE's note gives: they instruct about REFLECT, name no market,
// no position and no price, and a refusal with no way out of it is the one
// thing worse than instructing.
//
// No emojis (CLAUDE.md). The em-dash matches ./sync-response.ts.

/**
 * The sentence for one notice.
 *
 * Total over the union — there is no default branch and no fallback string,
 * so adding a member to {@link BrokerNotice} without writing its sentence does
 * not compile.
 */
export function noticeLine(notice: BrokerNotice): string {
  switch (notice.kind) {
    case 'connection_environment':
      return 'החיבור לברוקר פג — חבר מחדש';
    case 'connection_expiring':
      return CONNECTION_EXPIRING_NOTE;
    case 'no_accounts':
      return 'לא נמצאו חשבונות מסחר נתמכים בחיבור לברוקר — צור קשר ונבדוק';
    case 'account_currency':
      return notice.account === null
        ? 'אחד מחשבונות הברוקר במטבע שאינו דולר — Reflect תומכת כרגע רק בחשבונות USD'
        : `החשבון ${notice.account} במטבע שאינו דולר — Reflect תומכת כרגע רק בחשבונות USD`;
    case 'account_type':
      return notice.account === null
        ? 'אחד מחשבונות הברוקר מסוג שאינו נתמך — צור קשר ונבדוק'
        : `החשבון ${notice.account} מסוג שאינו נתמך — צור קשר ונבדוק`;
    case 'host_degraded':
      return 'חלק מהנתונים מהברוקר לא נטענו — ננסה שוב בסנכרון הבא';
    case 'unpriced_product':
      // NO COUNT OF TRADES in the second form, for `heldNote`'s reason: a
      // product that did not resolve left one cycle unstated per contract, and
      // "how many" is a figure this path has no honest answer for once the
      // instrument itself is unreadable.
      return notice.root === null
        ? 'עסקה אחת לא יובאה — מוצר לא מזוהה'
        : `עסקה ב-${notice.root} לא יובאה — מוצר לא מזוהה`;
  }
}

/**
 * What a trader is told while the connection still works but is running out
 * (REF-112 follow-up item 4).
 *
 * A NAMED CONSTANT AND NOT AN INLINE RETURN, which none of its five siblings in
 * {@link noticeLine} needed, because this is the one sentence with TWO
 * renderers. /settings takes its connection state as plain booleans and writes
 * its own copy (TradovateConnectionCard's header explains why: that card must
 * never name ./connections.ts), while /accounts and the dashboard go through
 * {@link brokerStateNotices} and this function. Two copies of a Hebrew string
 * in two files is a string that drifts; one constant imported by both cannot.
 *
 * FUTURE TENSE, AND IT NAMES NO DATE. "עומד לפוג" is the whole claim this state
 * can honestly make: the deadline is known, but whether it is reached depends
 * on something that may yet work — a cron run, or this trader's next page view.
 * A printed timestamp would read as a promise about the moment the connection
 * dies, and ./sync-response.ts' rule against stating figures we cannot stand
 * behind applies to instants as much as to numbers.
 *
 * TWO WAYS OUT, CHEAPEST FIRST. Opening Reflect is enough on its own — the
 * request path redeems a refresh token that is inside its margin — so it is
 * offered before the manual reconnect. "חבר מחדש" instructs, which §8 of
 * TradeContextPanel's rule normally forbids; it is allowed here for the reason
 * the two existing exceptions give, that a refusal with no way out of it is
 * worse than instructing.
 */
export const CONNECTION_EXPIRING_NOTE =
  'החיבור לברוקר עומד לפוג — פתח את Reflect או חבר מחדש';

/**
 * What a trader is told when the connection worked and there is nothing live
 * behind it (REF-112 §5.17, item 5).
 *
 * NOT A MEMBER OF {@link BrokerNotice}, and the difference is what it is
 * about. Every member of that union is a STANDING condition — true now, true
 * on the next page view, true until something changes — which is why they are
 * ordered, de-duplicated and re-derived on every render. This is a
 * one-off: the answer to a question the trader asked by pressing "connect",
 * shown once on the page they land on and never again. Putting it in the
 * union would mean inventing a rule for how it ranks against five conditions
 * it can never co-occur with.
 *
 * It lives here anyway because this module is where this integration's
 * refusals are worded, and a sentence kept next to its siblings is a sentence
 * that stays in the same voice.
 *
 * "אבל" AND NOT A FULL STOP. Both halves are news and the second does not
 * cancel the first: the connection IS made and nothing has to be redone. A
 * trader reading only "לא נמצאו חשבונות" would try to connect again.
 */
export const NO_LIVE_ENTITLEMENT_NOTE =
  'החשבון מחובר, אבל לא נמצאו חשבונות מסחר פעילים';

/**
 * What a trader is told when the connection is not open to them (REF-112-C
 * item 2).
 *
 * THE SENTENCE THAT CLOSES §2's GAP. Both OAuth paths have always refused a
 * user outside the list by redirecting to `/settings?tradovate=not_available`,
 * and NOTHING READ THAT CODE — ./oauth-results.ts said "the UI for this is not
 * built yet" from the day it was written. So the refusal was effectively
 * SILENT: the trader clicked "connect", left the app, came back to Settings,
 * and found an unexplained query string and no statement of any kind. §2 lists
 * that as a defect in its own right, and a refusal with no explanation is the
 * one thing ./notices.ts' copy rules call worse than instructing.
 *
 * ONE SHOT, LIKE {@link NO_LIVE_ENTITLEMENT_NOTE} and by the same
 * construction: it is a query parameter on the redirect the route issued, so
 * it is true for exactly one page view and gone the moment the trader
 * navigates. Nothing stored, nothing to clear.
 *
 * IT IS NOT A MEMBER OF {@link BrokerNotice} for that reason — every member of
 * that union is a standing condition, re-derived on every render. This is the
 * answer to a question the trader asked by pressing a button.
 *
 * WHY IT IS NOT THE BADGE. `זמין בקרוב` stays exactly where it is and says
 * what it has always said; it is a STATE, visible to a restricted trader on
 * every view of this page, and it is why the button beside it is grey. This is
 * the extra fact that only a trader who just tried needs: that the attempt was
 * refused and the greyed-out control was not a rendering accident.
 *
 * "עדיין" AND "לְחשבון שלך" ARE BOTH LOAD-BEARING. "עדיין" says the state is
 * temporary, which matches `זמין בקרוב` beside it and is true — this is a
 * rollback lever, not a judgement. "לחשבון שלך" says it is about their account
 * rather than the product being unbuilt, because the trader can see from the
 * marketing that the feature exists. It names no list, no reason and no
 * number, which is the same bound ./oauth-results.ts puts on the result codes:
 * probing must reveal neither who is on a list nor whether one exists.
 */
export const NOT_AVAILABLE_NOTE = 'חיבור לברוקר עדיין לא פתוח לחשבון שלך';

// ── Which notices mean the DAY is short (REF-112-C item 3) ──────────────────

/**
 * The notice kinds that mean this day's figures are missing something.
 *
 * THE ONE THING STAGE B TRADED AWAY, and its own report said so: items 1 and 6
 * turned a non-USD account and an unresolvable product from "the pull throws
 * and the day fails" into "that account / that trade is skipped and named".
 * Before, `/api/tradovate/today` answered `broker_unavailable` and the rule
 * engine degraded to Reflect's own rows — the fail-safe direction. After, the
 * day is STATED with the skipped trades missing, and `max_daily_loss` is
 * measured against a number short by exactly them. The sync panel says so; the
 * trade form did not.
 *
 * So these five are the kinds that make a day PARTIAL, each because something
 * that happened is not in the figures:
 *
 *   - `account_currency` and `account_type` — a whole account was skipped.
 *   - `unpriced_product` — one trade was skipped.
 *   - `host_degraded` — a host was dropped, so an unknown amount is missing.
 *   - `no_accounts` — discovery found nothing eligible, so the day is a zero
 *     that nothing was measured into. See below.
 *
 * `no_accounts` IS HERE, AND IT WAS NOT AT FIRST. The first cut of this list
 * left it out on the grounds that it is not a day SHORT of something but a day
 * with no broker scope at all, which already has its own sentence (stage B
 * item 2). That reasoning is wrong in the direction that matters, and the
 * argument against it is the same one the rest of this list rests on:
 *
 *   - The route still answers `source: 'broker_verified'` with an all-zero
 *     day, so without the flag `max_daily_loss` is measured against **$0** —
 *     the most permissive figure there is — for a trader whose own rows may say
 *     they are down $800. That is the identical failure a skipped account
 *     causes, at its maximum rather than at the margin.
 *   - `no_accounts` CANNOT TELL "the filter rejected everything" from "the
 *     scope was genuinely empty" (stage B §5.2 records that limitation
 *     explicitly). The first reading is an under-count of the whole day. A rule
 *     that has to pick one has to pick the fail-safe one, and the fail-safe one
 *     is to fall back to Reflect's rows.
 *   - It is also what stage B's own reversal already implies: zero eligible
 *     accounts was made an ERROR STATE because at open rollout a trader who
 *     completed an OAuth consent screen almost certainly has an account. A
 *     state we have decided is probably a filter bug must not be the state in
 *     which we trust the broker's zero over the trader's own record.
 *
 * TWO KINDS ARE STILL NOT HERE, and it is the same reason for both.
 * `connection_environment` and `connection_expiring` are not produced by a pull
 * at all — they are derived from the stored row by
 * {@link brokerStateNotices} — and neither describes a day that is short of
 * anything. A connection that cannot refresh never reaches `broker_verified`,
 * so there is no broker figure for the flag to displace; a connection that is
 * merely CLOSE to its refresh deadline is still working perfectly, and its
 * day is complete. Marking that day partial would fall back to Reflect's own
 * rows for a trader whose broker figures are entirely sound.
 *
 * As `kind` strings rather than a type, so the SERVER-side
 * {@link import('./fills').PullNotice} and the wire-side {@link BrokerNotice}
 * can both be measured by one rule — the two unions share these five members
 * and the routes hold the first kind, not the second.
 */
export const PARTIAL_DAY_KINDS: readonly string[] = [
  'account_currency',
  'account_type',
  'host_degraded',
  'no_accounts',
  'unpriced_product',
];

/**
 * Whether these notices mean the day's figures are incomplete.
 *
 * Takes anything with a `kind`, for the reason {@link PARTIAL_DAY_KINDS}
 * gives. False on an empty list, which is every ordinary day — so the flag it
 * decides is absent from almost every response and costs nothing to carry.
 */
export function makesDayPartial(notices: readonly { kind: string }[]): boolean {
  return notices.some((notice) => PARTIAL_DAY_KINDS.includes(notice.kind));
}

/**
 * What the trade form says when the day it is judging rules against is short
 * (REF-112-C item 3).
 *
 * ONE LINE, AND IT REPLACES THE PROVENANCE SENTENCE RATHER THAN JOINING IT.
 * `broker_verified` normally renders "הסגירות של היום נקראו מ-Tradovate", and
 * on a partial day that claim is no longer true of the numbers above it: the
 * figures have fallen back to Reflect's own rows (see
 * lib/rules/tradeRuleContext.ts), because measuring a loss limit against a
 * broker total that is short by a skipped account is the one direction this
 * integration must never fail in. Printing both would be a panel telling the
 * trader its figures came from somewhere they did not.
 *
 * "חלקיים" AND NOT "שגויים". Nothing here is wrong — it is incomplete, and the
 * difference is what the trader does next. "הנתונים חלקיים" describes the
 * figures; it does not instruct, which is §8 of TodayContextPanel's rule and a
 * NinjaTrader vendor compliance requirement. The sync panel is where the
 * SPECIFIC notices live — which account, which symbol — and this is the one
 * sentence the form owes a trader who is about to have a rule checked against
 * these numbers.
 */
export const PARTIAL_DAY_NOTE =
  'חלק מהעסקאות מהברוקר לא נטענו היום — הנתונים חלקיים';

/** Every notice as a line, in severity order and without repeats. */
export function noticeLines(notices: readonly BrokerNotice[]): string[] {
  return orderNotices(notices).map(noticeLine);
}

// ── Ordering, de-duplication, and the parser ────────────────────────────────

/**
 * A notice's identity, for de-duplication.
 *
 * TWO HOSTS CAN REPORT THE SAME THING. A trader whose live and demo scopes
 * both hold an `Omnibus` account named the same way produces two identical
 * notices, and two identical sentences one above the other is the shape a
 * reader skips — the same argument `heldNote` makes for comma-joining symbols.
 */
function noticeKey(notice: BrokerNotice): string {
  if (notice.kind === 'unpriced_product') return `${notice.kind}:${notice.root ?? ''}`;
  if (notice.kind === 'account_currency' || notice.kind === 'account_type') {
    return `${notice.kind}:${notice.account ?? ''}`;
  }
  return notice.kind;
}

/**
 * Sorted by severity, then alphabetically, with repeats removed.
 *
 * The second key is what makes the panel stable: two runs that saw the same
 * two accounts must produce the same two lines in the same order, and the
 * order `/account/list` happens to return is no grounds for anything.
 */
export function orderNotices(notices: readonly BrokerNotice[]): BrokerNotice[] {
  const unique = new Map<string, BrokerNotice>();
  for (const notice of notices) {
    const key = noticeKey(notice);
    if (!unique.has(key)) unique.set(key, notice);
  }

  return [...unique.values()].sort((a, b) => {
    const rank = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return rank !== 0 ? rank : noticeKey(a).localeCompare(noticeKey(b));
  });
}

/**
 * Read a wire value as notices, trusting none of its shape.
 *
 * ANYTHING UNRECOGNISED IS DROPPED RATHER THAN FAILING THE RESPONSE, which is
 * the opposite of the rule {@link import('./sync-response').readSyncResponse}
 * applies to its counts, and the difference is deliberate. A missing count
 * reads as zero and "0 imported, 0 failed" is the exact shape of "הכל מעודכן",
 * so a half-built body must not reach the copy. A notice is additive: an
 * unknown `kind` is a deployment newer than this bundle, and refusing the
 * whole response over it would turn a new sentence into "לא הצלחנו למשוך
 * עסקאות" for every trader with an open tab.
 *
 * AN EMPTY LABEL DEGRADES TO THE UNNAMED SENTENCE rather than rendering.
 * "החשבון  במטבע שאינו דולר" is worse than either, and the label is the whole
 * content of that clause — but a skipped account the trader is not told about
 * is the failure this whole mechanism exists to remove, so the line stays and
 * loses its name. Same rule as `root`.
 */
export function readNotices(value: unknown): BrokerNotice[] {
  if (!Array.isArray(value)) return [];

  const notices: BrokerNotice[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;

    if (
      kind === 'connection_environment' ||
      kind === 'connection_expiring' ||
      kind === 'no_accounts' ||
      kind === 'host_degraded'
    ) {
      notices.push({ kind });
      continue;
    }

    if (typeof kind === 'string' && ACCOUNT_KINDS.includes(kind as BrokerNotice['kind'])) {
      const account = record.account;
      notices.push({
        kind: kind as 'account_currency' | 'account_type',
        account: typeof account === 'string' && account !== '' ? account : null,
      });
      continue;
    }

    if (kind === 'unpriced_product') {
      // A root that arrived as a number, an empty string or an object is the
      // unnameable case, which this union can already express. Degrade to it
      // rather than dropping the line: a trade is missing either way.
      const root = record.root;
      notices.push({
        kind: 'unpriced_product',
        root: typeof root === 'string' && root !== '' ? root : null,
      });
    }
  }

  return orderNotices(notices);
}

// ── The pre-expiry window (REF-112 follow-up item 4) ───────────────────────

/**
 * How close to the refresh deadline is close enough to tell the trader.
 *
 * SIX HOURS, and the number is doing less work than it looks. Against a
 * measured 26-hour refresh lifetime, a 25-hour keep-alive window and a 12-hour
 * request-path margin, EVERY mechanism that could renew this connection has
 * already had its chance long before the row reaches six hours out. So the
 * threshold is not a lead time the trader is meant to act within — it is the
 * point past which "nothing renewed it" has stopped being a coincidence.
 *
 * Wide enough that a trader who opens the app once a day will see it, narrow
 * enough that a single late cron run does not produce it.
 */
export const REFRESH_DEADLINE_NOTICE_MS = 6 * 60 * 60_000;

/**
 * Whether this connection's refresh deadline is near AND nothing has renewed it
 * (REF-112 follow-up item 4).
 *
 * ONE PREDICATE AND NOT TWO, which is the part worth reading. The condition
 * wanted here is "the deadline is close and the last redemption did not work",
 * and the second half is not a separate fact to look up — IT IS IMPLIED BY THE
 * FIRST. Every successful redemption rotates the refresh token and stores a
 * fresh ~26-hour deadline, so a row whose deadline is only six hours away has
 * not had a successful redemption for roughly twenty hours, through a daily
 * cron run and a 12-hour request-path margin that were both due in that time.
 * The deadline IS the record of the last success, which is why no attempt
 * counter is kept anywhere: one would need a column, and the column would say
 * what this value already says.
 *
 * (A row that has never had a lifetime recorded at all — `null` — is NOT near
 * its deadline, because nobody knows where its deadline is. That row's problem
 * is item 2's, and the keep-alive now attempts it rather than skipping it.)
 *
 * PAST THE DEADLINE IS NOT "NEAR" IT EITHER. "עומד לפוג" says the connection is
 * about to expire, and a row whose refresh token has already lapsed is past
 * anything a notice can help with — the next use of it writes 'expired', and
 * that state has its own copy on /settings and in the sync panel.
 *
 * Pure, so the server can decide it and the regression suite can drive every
 * boundary without a clock seam in production code.
 */
export function refreshDeadlineNear(
  refreshExpiresAt: string | null,
  now: number = Date.now()
): boolean {
  if (!refreshExpiresAt) return false;
  const deadline = Date.parse(refreshExpiresAt);
  // An unparsable value says nothing. Silence is the answer to "I could not
  // tell", here as everywhere else in this module.
  if (!Number.isFinite(deadline)) return false;
  const remaining = deadline - now;
  return remaining > 0 && remaining <= REFRESH_DEADLINE_NOTICE_MS;
}

// ── What the stored connection alone can say ────────────────────────────────

/**
 * The state of a trader's broker connection, as a screen can read it.
 *
 * PLAIN VALUES AND NOT `ConnectionRead`, so this module stays free of
 * ./connections.ts — which reaches Supabase, reads the service-role key and
 * must never be pulled into a browser bundle. The caller is a server component
 * that has already done the read.
 */
export interface BrokerState {
  /** 'unreadable' is the read itself failing, which is not "not connected". */
  connection: 'none' | 'active' | 'expired' | 'revoked' | 'unreadable';
  /**
   * Whether the stored connection's environment is not this deployment's
   * (§5.4).
   *
   * THE QUIET KILLER REF-112 §5.4 NAMES. `redeemRefreshToken` answers
   * `{outcome: 'skipped', reason: 'environment'}` on a mismatch and
   * ./keepalive.ts counts it as an ordinary skip — so at a cutover every
   * pre-existing connection silently stops refreshing and expires at token
   * lifetime, with nothing anywhere naming it. The row still says 'active'
   * until then, which is why this is a separate flag and not a status.
   */
  environmentMismatch: boolean;
  /**
   * Whether the refresh deadline is near and nothing has renewed it
   * (REF-112 follow-up item 4).
   *
   * A BOOLEAN AND NOT THE TIMESTAMP, deliberately. The decision is
   * {@link refreshDeadlineNear}'s and it is made once, server-side, by the
   * module that did the read — so no screen has to hold a deadline it might
   * render, and the copy cannot drift into printing an instant this state has
   * no business promising. It is the same reduction `environmentMismatch` makes
   * of a pair of environment names.
   */
  refreshDeadlineNear: boolean;
  /**
   * How many broker-sourced rows the trader has in `accounts`, or null.
   *
   * NULL MEANS "NOT COUNTED", AND IT IS NOT THE SAME AS ZERO. The dashboard
   * does not read the `accounts` table and must not start: its subject is a
   * journal, and "you have no portfolios" is a sentence for the screen whose
   * whole subject is portfolios. So it passes null and gets the connection
   * notices only. /accounts has the number in hand already.
   */
  brokerAccounts: number | null;
}

/**
 * What a screen with no pull in hand can still tell the trader.
 *
 * /accounts and the dashboard are server components that read Reflect's own
 * tables; neither makes a Tradovate request and neither should. So the two
 * states they CAN derive are derived here, from the connection row and a row
 * count, and the rest of the notices reach the trader through the sync panel.
 *
 * THE ORDER OF THE TWO CHECKS IS THE POINT. A connection that cannot refresh
 * explains an empty accounts list completely, and saying both would send the
 * trader to look for a support answer to a problem one click of "חבר מחדש"
 * fixes. So the mismatch wins and returns alone.
 *
 * AN UNREADABLE CONNECTION SAYS NOTHING. "I could not ask" is not "you are not
 * connected" — ./connections.ts' `ConnectionRead` exists to keep those apart —
 * and a database hiccup must not tell a trader their broker link is dead.
 */
export function brokerStateNotices(state: BrokerState): BrokerNotice[] {
  if (state.connection === 'unreadable' || state.connection === 'none') return [];

  if (state.environmentMismatch) return [{ kind: 'connection_environment' }];

  // REF-112 follow-up item 4, and it returns ALONE on the same argument the
  // mismatch above makes. A connection that is about to stop working is the
  // thing to act on, and one click of "חבר מחדש" fixes it; pairing it with
  // "צור קשר ונבדוק" would send the trader looking for a support answer to a
  // problem they can already solve. 'active' only — the two dead statuses have
  // their own copy, and a row that has already expired is past a warning about
  // expiring.
  if (state.connection === 'active' && state.refreshDeadlineNear) {
    return [{ kind: 'connection_expiring' }];
  }

  // 'expired' and 'revoked' already have their own copy on /settings and in
  // the sync panel, and both are states the trader caused or was told about.
  // Only a LIVE connection with nothing to show is the silent failure §5.12
  // is about.
  if (state.connection === 'active' && state.brokerAccounts === 0) {
    return [{ kind: 'no_accounts' }];
  }

  return [];
}
