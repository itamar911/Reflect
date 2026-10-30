/**
 * What a shared trading day says about itself, and nothing more (REF-125
 * Stage 2 item 2).
 *
 * PURE. No client, no environment, no server-only import, no clock of its own
 * — the day and the rows are parameters. That is not tidiness: this module is
 * the entire privacy surface of the feature, so the regression suite has to be
 * able to build a snapshot from fixtures and grep the serialised JSON for
 * things that must not be in it (scripts/share-leak-check.ts). A builder that
 * needed a database could not be asserted that way.
 *
 *
 * AN ALLOW-LIST, NOT A REDACTION PASS
 * -----------------------------------
 *
 * {@link buildDailyShareSnapshot} NAMES EVERY FIELD IT EMITS and copies
 * nothing wholesale. There is no spread of a row anywhere in this file, no
 * `delete` of a key, and no "everything except" list — because a redaction
 * pass is only as current as its deny-list, and the next column added to
 * `trade_plans` would arrive in the snapshot by default and leave by review.
 * src/lib/ai/tradeFacts.ts is the existing precedent for the shape and
 * src/lib/tradovate/fills.ts' `BrokerDayContext` (seven scalars) is the other.
 *
 * REF-125 §2.5 is the list of what must never leave the server. The sharpest
 * item on it is `accounts.display_name`, which on a prop trader's account is a
 * FIRM'S NAME — portfolio.ts:34-41 states the rule ("never in a log line,
 * never in an error message, and NEVER IN AN AI PROMPT"), and a public card is
 * strictly worse than an AI prompt. Nothing here reads the `accounts` table at
 * all, and `portfolioLabel()` is deliberately not imported: it FALLS BACK to
 * `display_name` when a nickname is empty, so reaching a portfolio name
 * through it would publish the firm for exactly the traders who never named
 * their account.
 *
 * NO SYMBOL FIELD, which is worth stating because the ticket's deny rule
 * ("symbols with contract month — root only") implies there might be one. The
 * enumerated snapshot carries no instrument at all: a day's money, counts and
 * discipline do not need one, and the rule is then satisfied by construction
 * rather than by a normaliser that has to be right about `MESZ5` vs `MES`. If
 * a later stage wants the instruments traded, it adds a field here and a root
 * normaliser beside it, and the leak suite grows a case.
 *
 *
 * THE DISCIPLINE NUMBER IS NOT DECIDED HERE ANY MORE
 * -------------------------------------------------
 *
 * `src/lib/scoring/dayDiscipline.ts` owns it as of REF-125's follow-up item 2,
 * and that module's header carries the whole argument: the unified fractions,
 * the denominator that is never `rows.length`, the `null` that is never a zero,
 * and why this card KEEPS the conservative measured number rather than adopting
 * the dashboard radar's more forgiving one (Imri, 30.10).
 *
 * WHAT CHANGED HERE is that the snapshot now CARRIES THE SCORE AS A FIELD
 * instead of leaving each renderer to pool the two fractions itself.
 * `cardImage.tsx` and `SharedDayCard.tsx` held line-for-line copies of that
 * formula — the two surfaces that must never disagree, kept in step by hand —
 * and both now read {@link DailyShareSnapshot.discipline}.
 *
 * The fractions stay in the document because they are the EVIDENCE the card
 * prints under the score, and because a card minted before this change has to
 * keep rendering: `readDailyShareSnapshot` derives the score from them when the
 * field is absent, with the same function that computed it.
 */

import { formatMoney } from '@/lib/money';
import { hasMoneyPnl, isWinningTrade, pnlRow, tradeMoneyPnl } from '@/lib/pnl';
import {
  dayDiscipline,
  pooledDisciplineScore,
  type DisciplineFraction,
} from '@/lib/scoring/dayDiscipline';
import { tradingDayLabel, tradingDayOfTrade, type TradingDay } from '@/lib/tradingDay';

/** The snapshot format. Bumped when a field changes meaning, never for an addition. */
export const SHARE_SNAPSHOT_VERSION = 1;

/**
 * The longest public handle. 24 characters, which is a display decision and
 * not a safety one: the card renders it on one line beside the day label at
 * mobile width.
 */
export const MAX_PUBLIC_NICKNAME = 24;

/**
 * A discipline count and the number of trades that answered the question.
 *
 * AN ALIAS AND NOT A SECOND DECLARATION. The shape and the rules behind it are
 * `DisciplineFraction`'s in lib/scoring/dayDiscipline.ts; the name is kept
 * because the two card renderers, the demo fixtures and the leak suite all
 * speak of a *share* fraction, and because the stored JSONB's shape is this
 * module's contract to describe.
 */
export type ShareFraction = DisciplineFraction;

/**
 * Where the day's figures came from, over the trades actually counted.
 *
 * PER-TRADE AND NEVER PER-USER. REF-125 §3.5: stats are cross-account by
 * product promise (portfolio.ts:154), so "this trader has a broker connection"
 * is not evidence about any particular trade. `source` is.
 */
export type ShareProvenance = 'broker' | 'mixed' | 'manual';

/**
 * What the trader agreed to show. All false is the resting state.
 *
 * `accounts` IS GONE FROM THIS DOCUMENT AS OF THE STAGE 3 REVISION, and its
 * absence is deliberate rather than an oversight. Per-account names are now
 * ALWAYS on the card (Imri, 28.10), so there is no consent to record — and a
 * flag nobody reads is worse than no flag, because it reads as a control that
 * exists. `readShareVisibility` therefore does not parse it, and a stored
 * document from before this change simply has a key nobody looks at.
 *
 * THE PRIVACY CONSEQUENCE IS REAL AND IS NOT MINE TO SOFTEN: `display_name` is
 * broker-supplied free text, and on a prop account it is a FIRM'S NAME
 * (portfolios/read.ts:29-53). That module's header forbids this table reaching
 * a log or an AI prompt; a public share card is now a third destination, by
 * decision. The one mitigation kept is {@link MAX_SHARE_ACCOUNT_NAME}.
 */
export interface ShareVisibility {
  nickname: boolean;
  balance: boolean;
}

/**
 * One broker account's share of the day.
 *
 * `name` IS `nickname ?? display_name`, NOT `display_name` ALONE, and that is
 * a deliberate reading of "the real account name". `portfolioLabel()` is what
 * every other screen in the product shows, and a trader who renamed
 * "Topstep Evaluation 50K" to "החשבון שלי" has already said which of those two
 * strings is their account's name. Publishing the broker's string over the
 * trader's own rename would be the more surprising and the less private of the
 * two choices. The label is resolved by the STORE and handed in — see
 * {@link buildDailyShareSnapshot} — so this module still never reads the
 * `accounts` table and still names every field it emits.
 */
export interface ShareAccountRow {
  /** Bounded by {@link MAX_SHARE_ACCOUNT_NAME}. Never an id. */
  name: string;
  /** This account's money over its counted trades. Null when none carried one. */
  pnl: number | null;
  /** Whether every counted trade here came from a broker. Drives the row mark. */
  broker: boolean;
}

/**
 * The longest account name the card prints.
 *
 * A display bound AND the only privacy mitigation left on this field now that
 * the toggle is gone: a prop-firm string that carries an account number
 * ("Topstep Evaluation 50K-884421") is cut before the digits that identify it.
 * It is not a guarantee — a short name can still be identifying — and the
 * report says so rather than pretending otherwise.
 */
export const MAX_SHARE_ACCOUNT_NAME = 22;

/**
 * The most account rows a snapshot stores.
 *
 * The card shows five and says "+N more"; this is the bound on what is
 * WRITTEN, which is a different question. Storing every account would put
 * names in the row that no surface ever renders, and the stored document is
 * the thing that outlives the design — so it holds a little more than the card
 * needs and nothing like all of it.
 */
export const MAX_SHARE_ACCOUNTS = 8;

/** Our word for "no account", never a trader's. See `figures.ts:140`. */
export const SHARE_UNASSIGNED_NAME = 'Unassigned';

export interface DailyShareSnapshot {
  /** {@link SHARE_SNAPSHOT_VERSION} at mint time. */
  v: number;
  /** The CME trading day this describes, `YYYY-MM-DD`. */
  day: TradingDay;
  /**
   * The day's money, summed over the counted trades.
   *
   * NULL AND NOT ZERO when no counted trade carries a money figure at all. The
   * distinction is the whole of §2.4's hazard 1 applied to P&L: a day of three
   * closed trades none of which recorded an amount is not a breakeven day, and
   * `$0.00` under a "Broker-synced" tag would be a claim we cannot support.
   */
  pnl: number | null;
  /** Closed trades counted. See {@link countedShareTrades} for what "counted" is. */
  trades: number;
  /** Of {@link trades}. `wins + losses === trades` by construction. */
  wins: number;
  losses: number;
  /** "עמד בתוכנית 4/5", or null when no trade answered. */
  followedPlan: ShareFraction | null;
  /** "הסטופ לא הורחק 3/4", or null. See `stopHeldOutcome` for the predicate. */
  stopHeld: ShareFraction | null;
  /**
   * The day's discipline score, 0-100 — or null when nothing was answered.
   *
   * NULL AND NEVER 0, like {@link pnl}: a day on which no trade recorded
   * either answer has no discipline score, and a zero on a public page would
   * be defamatory of the trader's own day. Both renderers print `—`.
   *
   * ADDITIVE, SO `SHARE_SNAPSHOT_VERSION` DID NOT MOVE. A card minted before
   * REF-125's follow-up has no `discipline` key, and
   * {@link readDailyShareSnapshot} derives it from the two fractions with the
   * same function that computed it here — so an old card renders the number it
   * always rendered rather than a dash.
   */
  discipline: number | null;
  /** Money only. Null when no counted trade carries a money figure. */
  best: number | null;
  worst: number | null;
  provenance: ShareProvenance;
  /** The opt-in handle, or null — which is anonymous and is the default. */
  nickname: string | null;
  /**
   * The day split per account, biggest first, `Unassigned` always last.
   *
   * EMPTY IS A REAL AND COMMON STATE, not a failure: migration 037 is applied
   * by hand and the whole accounts layer is behind `isImportEnabled()`, so a
   * deployment without it hands the builder no accounts and this is `[]`. Every
   * reader must render nothing rather than an empty panel.
   *
   * ADDITIVE — `SHARE_SNAPSHOT_VERSION` is unchanged. A card minted before this
   * deploy has no `accounts` key at all, `readDailyShareSnapshot` answers `[]`
   * for it, and it renders exactly as it did yesterday. That is the whole
   * reason the version did not move.
   */
  accounts: ShareAccountRow[];
}

/**
 * A `trade_plans` row as this module reads it: EVERY FIELD OPTIONAL.
 *
 * Optional rather than nullable, and the difference is the one `lib/types.ts`
 * draws at :108-110. A reader on a database where migration 034 has not run
 * gets no `source` KEY at all from `select('*')`, and 038's `stop_history` is
 * the same. Both are read through `?? null` and a `=== true` here, never
 * through a truthiness test, which is `lib/trades/visible.ts`' rule and the
 * reason the builder needs no migration flag to be safe.
 */
export interface ShareTradeRow {
  /**
   * Which account the trade was filed under, or absent/null for UNASSIGNED.
   *
   * NULL MEANS UNASSIGNED AND NOT MANUAL (037:146-156) — every row written
   * before REF-110 is in that state. Declared optional for the same reason the
   * rest of this interface is: a database without 037 has no such column and
   * `select('*')` returns no key.
   */
  account_id?: string | null;
  status?: string | null;
  exit_price?: number | string | null;
  entry_price?: number | string | null;
  take_profit?: number | string | null;
  direction?: 'long' | 'short' | null;
  pnl_amount?: number | string | null;
  actual_pnl?: number | string | null;
  closed_at?: string | null;
  submitted_at?: string | null;
  followed_plan?: boolean | null;
  moved_sl?: boolean | null;
  stop_history?: unknown;
  source?: string | null;
  hidden?: boolean | null;
}

// ── The counted set ─────────────────────────────────────────────────────────

/**
 * Whether a row came from a broker rather than from the trade form.
 *
 * `source === 'tradovate'` and not `broker_trade_key != null`, which is
 * JournalClient.tsx:198-200's predicate restated rather than imported — that
 * one is a local function in a 2,000-line client component and takes the
 * journal's own `Trade` type. The docstring there is explicit that `source` is
 * the right test because it is the column the product principle is stated in.
 *
 * A row with NO `source` KEY reads as manual, which is correct twice over: it
 * is the column's default on every row the trade form ever wrote, and on a
 * pre-034 database no row can have come from a broker because the import is
 * gated on the same migration.
 */
function isBrokerRow(row: ShareTradeRow): boolean {
  return row.source === 'tradovate';
}

/**
 * The trades a shared day is about: CLOSED, PRICED, NOT DELETED, and dated
 * into `day` by `closed_at`.
 *
 * CLOSED-ONLY, BY `closed_at`, AND THAT IS A PRODUCT RULING RATHER THAN A
 * PREFERENCE. TodayContextPanel.tsx:47-63 wrote it down: "how many trades
 * today" is counted by `submitted_at` and "today's money" by `closed_at`, they
 * are therefore DIFFERENT SETS, and mixing them is "the bug class
 * tradeRuleContext.ts exists to have ended". A card that showed a
 * `submitted_at` count beside a `closed_at` P&L could truthfully say "2
 * trades, +$300" about a day in which one of those two trades contributed
 * nothing to the $300.
 *
 * So the card picks ONE scope — the retrospective one — and every number on it
 * comes from this set. It is also the only scope a broker can verify: an open
 * position has no realised money to report.
 *
 * `tradingDayOfTrade` is the Stage 1 definition and resolves `closed_at` first,
 * so the filter and the `status`/`exit_price` tests agree about which
 * timestamp dates the row.
 */
export function countedShareTrades(
  rows: readonly ShareTradeRow[],
  day: TradingDay
): ShareTradeRow[] {
  return rows.filter(
    (row) =>
      row.hidden !== true &&
      row.status === 'closed' &&
      row.exit_price != null &&
      tradingDayOfTrade(row) === day
  );
}

// ── The builder ─────────────────────────────────────────────────────────────

/**
 * Where the day's figures came from.
 *
 * ZERO TRADES IS `'manual'`, AND THE ORDER OF THESE TESTS IS WHY. With no
 * counted rows, `broker === total` is `0 === 0` and a naive "all rows are
 * broker rows" test answers `'broker'` — a card with no trades on it carrying
 * a "Broker-synced" tag, which is a provenance claim about nothing. The empty
 * day is checked first and resolves to the state that renders NO TAG AT ALL.
 *
 * That is also the repo's own precedent for the manual case generally
 * (link.ts:68-69): "a journal that labels its own default case 'ידני' treats
 * hand entry as the exception."
 */
function provenanceOf(rows: readonly ShareTradeRow[]): ShareProvenance {
  if (rows.length === 0) return 'manual';
  const broker = rows.filter(isBrokerRow).length;
  if (broker === 0) return 'manual';
  if (broker === rows.length) return 'broker';
  return 'mixed';
}

/**
 * An account the TRADER OWNS, with its label already resolved.
 *
 * The store builds these from `readPortfolios` + `portfolioLabel` and hands
 * them in. This module therefore still does not import the portfolios layer
 * and still does not read the `accounts` table — which is what keeps the
 * allow-list property in the header true: every field this file emits is a
 * field it was given or computed, never a column it reached for.
 */
export interface ShareAccountSource {
  id: string;
  /** Already `nickname ?? display_name`. See {@link ShareAccountRow}. */
  label: string;
}

/**
 * Split the counted trades per account.
 *
 * THE `known` SET IS A SECURITY BOUNDARY HERE, not a tidiness measure.
 * `figures.ts:152-162` records the hole: `trade_plans`' RLS policy asks whose
 * ROW it is and not whose ACCOUNT the id names, so a crafted write can point a
 * trader's own trade at an account id belonging to somebody else. On the
 * accounts SCREEN that costs a trade falling into the wrong bucket. On a
 * PUBLIC CARD it would mean rendering a name we looked up for an id the trader
 * does not own — so an id that is not in the trader's own account list is
 * treated as unassigned and never resolved to a name.
 *
 * Only accounts the trader owns can therefore be named, and the complete fix
 * is still the `WITH CHECK` migration that file asks for.
 */
function accountRowsOf(
  counted: readonly ShareTradeRow[],
  sources: readonly ShareAccountSource[]
): ShareAccountRow[] {
  const labels = new Map(sources.map((s) => [s.id, s.label]));

  const UNASSIGNED = ' unassigned';
  const buckets = new Map<string, ShareTradeRow[]>();
  for (const row of counted) {
    const id = row.account_id ?? null;
    const key = id !== null && labels.has(id) ? id : UNASSIGNED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const rows: Array<ShareAccountRow & { unassigned: boolean }> = [];
  for (const [key, bucketRows] of buckets) {
    const amounts = bucketRows
      .map((row) => pnlRow(row as Record<string, unknown>))
      .filter(hasMoneyPnl)
      .map(tradeMoneyPnl);

    // The unassigned bucket is only worth a row when it carries MONEY. With no
    // amount it adds a nameless line that explains nothing, and the card's
    // total is unaffected by it either way — so it stays off.
    if (key === UNASSIGNED && amounts.length === 0) continue;

    rows.push({
      name:
        key === UNASSIGNED
          ? SHARE_UNASSIGNED_NAME
          : (labels.get(key) ?? SHARE_UNASSIGNED_NAME).slice(0, MAX_SHARE_ACCOUNT_NAME).trim(),
      pnl: amounts.length === 0 ? null : amounts.reduce((sum, value) => sum + value, 0),
      broker: bucketRows.every(isBrokerRow),
      unassigned: key === UNASSIGNED,
    });
  }

  // Biggest money first so the card leads with the account that moved the day,
  // `Unassigned` always last because it is our word and not an account, and
  // the name as the final tie-break so a re-mint of the same day cannot
  // reorder the rows. A frozen document has to be deterministic.
  rows.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    const left = a.pnl ?? Number.NEGATIVE_INFINITY;
    const right = b.pnl ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return right - left;
    return a.name.localeCompare(b.name);
  });

  return rows.slice(0, MAX_SHARE_ACCOUNTS).map(({ name, pnl, broker }) => ({ name, pnl, broker }));
}

/**
 * Build the frozen card for one trading day.
 *
 * TAKES THE VISIBILITY AND APPLIES IT HERE rather than leaving the caller to
 * decide what to include, so that "the nickname toggle was off" is a property
 * of the SNAPSHOT and therefore assertable by the leak suite. A caller that
 * resolved the name itself could pass one in with the toggle off and nothing
 * in a pure test would notice.
 *
 * `publicNickname` is the raw column value and is normalised here, so a row
 * holding `'   '` from some other write path is still anonymous — see
 * {@link readPublicNickname}.
 */
export function buildDailyShareSnapshot({
  rows,
  day,
  visibility,
  publicNickname,
  accounts = [],
}: {
  rows: readonly ShareTradeRow[];
  day: TradingDay;
  visibility: ShareVisibility;
  publicNickname?: unknown;
  /**
   * The trader's OWN accounts, labels already resolved by the store.
   *
   * Defaulted to empty, which is the state on any deployment without migration
   * 037 or with the import gate shut — and the state every caller that does
   * not care about accounts gets for free.
   */
  accounts?: readonly ShareAccountSource[];
}): DailyShareSnapshot {
  const counted = countedShareTrades(rows, day);

  // `pnlRow` ONCE PER TRADE rather than a cast at each call site. It is the
  // adapter lib/pnl.ts built for precisely this input — "what `select('*')`
  // hands the AI routes" — and its docstring records why the alternative is a
  // bug and not a style: the four routes that each grew their own
  // `exit_price > entry_price` win test "call every profitable short a loss".
  const facts = counted.map((row) => pnlRow(row as Record<string, unknown>));

  // Only the rows that carry a money figure may contribute to money. A closed
  // row with neither `actual_pnl` nor `pnl_amount` is a trade whose amount was
  // never recorded, and summing it as 0 would quietly average it in.
  const amounts = facts.filter(hasMoneyPnl).map(tradeMoneyPnl);

  let wins = 0;
  let losses = 0;
  for (const fact of facts) {
    // `isWinningTrade` is the canonical win test and falls back to price points
    // for a row with no money, so a day of unpriced trades still splits. It
    // answers `false` on an exact breakeven, which is the product's existing
    // definition everywhere else and is kept rather than given a third bucket
    // the rest of the app does not have.
    if (isWinningTrade(fact) === true) wins++;
    else losses++;
  }

  const nickname = visibility.nickname ? readPublicNickname(publicNickname) : null;

  // ONE FUNCTION FOR ALL THREE FIELDS, which is item 2's whole point: the score
  // the card prints and the two fractions it prints underneath cannot disagree,
  // because they are not computed separately any more.
  const discipline = dayDiscipline(counted);

  return {
    v: SHARE_SNAPSHOT_VERSION,
    day,
    pnl: amounts.length === 0 ? null : amounts.reduce((sum, value) => sum + value, 0),
    trades: counted.length,
    wins,
    losses,
    followedPlan: discipline.followedPlan,
    stopHeld: discipline.stopHeld,
    discipline: discipline.score,
    best: amounts.length === 0 ? null : Math.max(...amounts),
    worst: amounts.length === 0 ? null : Math.min(...amounts),
    provenance: provenanceOf(counted),
    nickname,
    accounts: accountRowsOf(counted, accounts),
  };
}

/**
 * The card as lines of text — what the dialog shows the trader BEFORE they
 * publish anything.
 *
 * SAME SOURCE AS THE CARD, which is the only reason this lives here rather
 * than in the dialog. "Preview" is a promise: a trader who reads these lines
 * and presses "צור קישור" must get a page saying the same things, so the
 * preview and the page have to be two renderings of one snapshot rather than
 * two descriptions of one day. Every number below comes from the same fields
 * SharedDayCard reads, and a field added to one without the other shows up as
 * a preview that lies.
 *
 * ALSO WHAT THE LEAK SUITE GREPS. The lines are flat strings, so
 * scripts/share-leak-check.ts can assert over the text a human actually sees
 * as well as over the serialised JSON — the two are different surfaces and a
 * name could in principle reach one without the other.
 */
export function shareSnapshotLines(snapshot: DailyShareSnapshot): string[] {
  const lines: string[] = [tradingDayLabel(snapshot.day)];

  if (snapshot.nickname !== null) lines.push(snapshot.nickname);

  lines.push(`תוצאת היום: ${snapshot.pnl === null ? '—' : formatMoney(snapshot.pnl)}`);
  lines.push(
    `${snapshot.trades} עסקאות סגורות · ${snapshot.wins} מנצחות, ${snapshot.losses} מפסידות`
  );

  if (snapshot.best !== null && snapshot.worst !== null) {
    lines.push(
      `הטובה ${formatMoney(snapshot.best)} · החלשה ${formatMoney(snapshot.worst)}`
    );
  }
  // THE SCORE IS IN THE PREVIEW BECAUSE IT IS THE CARD'S HEADLINE FIGURE. The
  // lines used to list the two fractions and leave the trader to pool them,
  // which meant the one number a stranger reads first was the one number the
  // consent screen did not show.
  if (snapshot.discipline !== null) lines.push(`משמעת: ${snapshot.discipline}%`);
  if (snapshot.followedPlan !== null) {
    lines.push(`עמד בתוכנית ${snapshot.followedPlan.met}/${snapshot.followedPlan.answered}`);
  }
  if (snapshot.stopHeld !== null) {
    lines.push(`הסטופ לא הורחק ${snapshot.stopHeld.met}/${snapshot.stopHeld.answered}`);
  }

  // THE ACCOUNT NAMES ARE IN THE PREVIEW BECAUSE THEY ARE ON THE CARD. This
  // function's contract is that a trader who reads these lines and presses
  // "צור קישור" gets a page saying the same things — and the names are now the
  // single most consequential thing the card publishes, so they are the last
  // thing that should be missing from the screen that precedes consent.
  for (const account of snapshot.accounts) {
    lines.push(`${account.name}: ${account.pnl === null ? '—' : formatMoney(account.pnl)}`);
  }

  // The same three states the card renders, including the manual case that
  // prints nothing. Kept in step by being the same switch, not a copy of it.
  const note = shareProvenanceNote(snapshot.provenance);
  if (note !== null) lines.push(note);

  return lines;
}

/**
 * The provenance line, in English, as the ticket specifies — or nothing.
 *
 * HERE RATHER THAN IN THE COMPONENT because both the card and the dialog's
 * preview print it, and a provenance claim that differs between the two would
 * be the worst possible place for a copy to drift. SharedDayCard's docblock
 * carries the full argument for the wording; the short version is that
 * "before fees" is not optional on the broker case (a broker row's P&L is
 * gross, and reads systematically better than the trader's statement), and
 * that neither string says "verified" — the discipline fractions are
 * intent-side and backed by nothing a broker knows.
 */
export function shareProvenanceNote(provenance: ShareProvenance): string | null {
  if (provenance === 'broker') return 'Broker-synced · before fees';
  if (provenance === 'mixed') return 'Partially broker-synced';
  return null;
}

// ── The defensive readers ───────────────────────────────────────────────────

/**
 * A public handle, or null for anonymous.
 *
 * NULL, EMPTY AND WHITESPACE-ONLY ARE ONE ANSWER, in one place. The column is
 * nullable with no default and the API route trims before writing, but a
 * handle is CONSENT and the three-state lesson applies to consent harder than
 * it does to a stop (stopHistory.ts:224-229): a row that acquires `''` by some
 * other write path must still render anonymously rather than publish an empty
 * name. Reading it through one function is what makes that true of every
 * caller instead of of the careful ones.
 *
 * Inner whitespace is collapsed and the result is bounded — a 400-character
 * handle is a layout bug on a public page, and a handle with a newline in it
 * is a handle chosen to break one.
 */
export function readPublicNickname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.slice(0, MAX_PUBLIC_NICKNAME);
}

/**
 * The visibility document, read defensively. Anything unreadable is all-false.
 *
 * FAIL-CLOSED IN EVERY DIRECTION: a missing key, a non-object, a string
 * `"true"` and a `1` all answer false. The column has a NOT NULL default in
 * migration 043, so the common path is a well-formed document — but it is
 * JSONB with no CHECK, and the one thing a bad read must never do on this
 * particular column is show MORE than the trader agreed to.
 */
export function readShareVisibility(value: unknown): ShareVisibility {
  const raw = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;
  // `accounts` is deliberately NOT read — see {@link ShareVisibility}. A
  // document stored before the revision still has the key; nothing looks at it.
  return {
    nickname: raw.nickname === true,
    balance: raw.balance === true,
  };
}

const PROVENANCES: readonly ShareProvenance[] = ['broker', 'mixed', 'manual'];

/** A finite number, or null. PostgREST hands `NUMERIC` back as a string. */
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A non-negative integer, or 0 — for the three counts, which cannot be absent. */
const count = (value: unknown): number => {
  const n = num(value);
  return n === null || n < 0 ? 0 : Math.floor(n);
};

function readFraction(value: unknown): ShareFraction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const answered = count(raw.answered);
  // A zero denominator is not a fraction — the builder never writes one, and a
  // document that carries one is a document to render nothing from. `met`
  // above `answered` is the other impossible pair and is clamped rather than
  // rejected, so a near-miss still renders something true.
  if (answered === 0) return null;
  return { met: Math.min(count(raw.met), answered), answered };
}

/**
 * The stored snapshot, or null when there is nothing a reader may rely on.
 *
 * THE ONLY WAY THE PUBLIC PAGE LEARNS ANYTHING, so it trusts nothing. JSONB
 * with no CHECK, written by a build that may be older than the reader — the
 * same situation `readStopHistory` and `readDailyDebrief` are in, and the same
 * answer: validate every field, and return null rather than a half-document
 * when the one field that identifies it is missing.
 *
 * `day` IS THE REQUIRED FIELD. A card with no day is not a card — the heading
 * is "יום מסחר 27.10" — and a reader that invented one would publish a page
 * claiming a day nobody shared. Everything else has a defined absence.
 *
 * NOTE WHAT THIS DOES NOT DO: it does not copy unknown keys through. A future
 * field is invisible to an older reader, which is the correct direction for a
 * public page — a deployment that does not understand a field cannot render it
 * wrongly, and cannot pass it on.
 */
export function readDailyShareSnapshot(value: unknown): DailyShareSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const day = typeof raw.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    ? raw.day
    : null;
  if (day === null) return null;

  const provenance = PROVENANCES.find((p) => p === raw.provenance) ?? 'manual';

  const followedPlan = readFraction(raw.followedPlan);
  const stopHeld = readFraction(raw.stopHeld);

  return {
    v: count(raw.v),
    day,
    pnl: num(raw.pnl),
    trades: count(raw.trades),
    wins: count(raw.wins),
    losses: count(raw.losses),
    followedPlan,
    stopHeld,
    // DERIVED WHEN THE FIELD IS ABSENT, which is what makes the addition
    // additive: every card minted before REF-125's follow-up carries the two
    // fractions and no score, and `pooledDisciplineScore` is the same function
    // the builder used — so such a card renders the number it always rendered
    // rather than a dash. A STORED score is clamped to 0-100 and otherwise
    // trusted; this reader does not recompute it, because the stored value is
    // what the trader consented to publish and a re-derivation could disagree
    // with it if the fractions were ever edited by hand.
    discipline: readDisciplineScore(raw.discipline, followedPlan, stopHeld),
    best: num(raw.best),
    worst: num(raw.worst),
    // An unreadable provenance resolves to the state that prints NO TAG. The
    // alternative directions both assert something: 'broker' would claim a
    // verification nothing supports, 'mixed' would claim a mixture.
    provenance,
    nickname: readPublicNickname(raw.nickname),
    accounts: readAccountRows(raw.accounts),
  };
}

/**
 * The stored discipline score, or the one its fractions imply.
 *
 * Three states and they are all different: a NUMBER is a score the mint wrote,
 * `null` with fractions present is a card from before the field existed (derive
 * it), and `null` with no fractions is a day that answered nothing (stays
 * null). Clamped rather than rejected, for `readFraction`'s reason: a near-miss
 * should still render something true.
 */
function readDisciplineScore(
  value: unknown,
  followedPlan: ShareFraction | null,
  stopHeld: ShareFraction | null
): number | null {
  const stored = num(value);
  if (stored === null) return pooledDisciplineScore(followedPlan, stopHeld);
  return Math.max(0, Math.min(100, Math.round(stored)));
}

/**
 * The per-account rows, read defensively — and bounded on the way out.
 *
 * A MISSING KEY IS `[]` AND NOT A FAILURE. Every card minted before this
 * revision has no `accounts` key, and those cards must keep rendering exactly
 * as they did; returning an empty list is what makes the addition additive and
 * is why `SHARE_SNAPSHOT_VERSION` did not move.
 *
 * The name is re-bounded here rather than trusted from the document. The
 * builder already cut it, but this reader's whole contract is that it trusts
 * nothing in the JSONB — and the one field in this list that a bad value could
 * do real damage with is a free-text name on a public page.
 */
function readAccountRows(value: unknown): ShareAccountRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ShareAccountRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== 'string') continue;
    const name = raw.name.replace(/\s+/g, ' ').trim().slice(0, MAX_SHARE_ACCOUNT_NAME);
    // A nameless row is a row with nothing to say; it is dropped rather than
    // rendered as a blank line beside a figure.
    if (name === '') continue;
    rows.push({ name, pnl: num(raw.pnl), broker: raw.broker === true });
    if (rows.length === MAX_SHARE_ACCOUNTS) break;
  }
  return rows;
}
