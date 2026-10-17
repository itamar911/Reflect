/**
 * Which of a user's Tradovate accounts the rules count (REF-90 §5).
 *
 * THIS IS A PRODUCT DECISION, NOT A LOOKUP. GET /v1/account/list returns every
 * account in the logged-on user's visible scope, and the response carries no
 * "primary" flag, no default, and no currency. Nothing in the API answers
 * "which account is the one the trader means", so the answer is written here,
 * in one place, where it can be read and argued with.
 *
 *
 * THE RULE
 * --------
 *
 * Count every account that is the user's OWN and could have been traded today;
 * aggregate across them. A discipline rule is about the trader, not about one
 * of their accounts: "I have lost $500 today" is true whichever account it
 * happened in, and a per-account view would let someone stay inside every limit
 * while breaking all of them together.
 *
 * An account is counted when it is TRADEABLE and it is THIS TRADER'S.
 *
 * Tradeable is four filters, each for a stated reason:
 *
 * - `accountType` must be `Customer`. The other five (`Employee`, `Giveup`,
 *   `House`, `Omnibus`, `Wash`) are not an end trader's own trading account.
 * - `closed` and `restricted` must not be set: nothing was traded there today.
 * - `readonly` and `futuresDisabled` must not be set, for the same reason.
 *
 * `active` is checked when present for the same reason, and its absence is not
 * treated as inactive — these flags are optional in the schema and a missing
 * boolean is "not stated", not `false`.
 *
 *
 * "THIS TRADER'S" IS TWO WAYS, NOT ONE (REF-90 Stage 2)
 * -----------------------------------------------------
 *
 * - **owned** — `account.userId` matches the connection's stored
 *   `tradovate_user_id`. The id comes from GET /auth/me at connect time
 *   (connections.ts), so it is as trustworthy as the connection.
 * - **permitted** — a `TradingPermission` on the SAME HOST whose own `userId`
 *   is ours, whose `accountId` is this account's, and whose `status` is
 *   `Accepted` or `Approved`.
 *
 * The second half is what REF-90 turned out to be. Ownership alone was measured
 * wrong on 14 Oct 2026: the trader's only account is a prop firm's evaluation
 * account, `/user/createTradingPermission` documents such an account as being
 * **owned by the API Admin** with the trader holding a permission on it, and
 * the probe found exactly that — the account's `userId` is the firm's and a
 * permission naming our trader sits beside it with `status: Approved`. Under
 * ownership alone that trader is told they traded nothing, every day, forever.
 *
 * **Why this does not let the firm's other traders in.** The filter keys on the
 * PERMISSION'S OWN `userId`, never on the account's visibility. A permission
 * belonging to another trader has a different `userId` and is excluded — even
 * when an admin's wider visible scope returns it. Nothing here infers a claim
 * from "this appeared in the list", from the account's name, from
 * `evaluationSize`, or from how many rows came back. One trader's limits can
 * only be moved by a row that names that trader.
 *
 * **Statuses, deliberately narrow.** `Requested` is a pending offer rather than
 * an arrangement; `Declined` and `Revoked` are refusals. Only `Accepted` and
 * `Approved` count. `Approved` is the one the prop flow was measured to use.
 *
 * **And when the join cannot be read**, the permitted set is absent and this is
 * exactly the owned-only rule it replaced. That under-counts, which falls back
 * to Reflect's own data through the source mapping; it never over-counts. Same
 * direction as the null-identity branch below, and for the same reason.
 *
 * `legalStatus` is NOT consulted, and it is the trap here: it is `Individual` /
 * `Corporation` / `Trust` and reads like a way to say "a person's own account",
 * but it describes the account HOLDER's legal form — a firm's sim account is
 * plausibly `Corporation` while being precisely the account this ticket is
 * about. Same class of mistake as `evaluationSize` below: a field whose name
 * suggests an answer to a question it was not written for.
 *
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 *
 * It does not ask the user to pick, and it does not look at `evaluationSize` to
 * guess whether an account is an evaluation. Picking needs a settings UI and a
 * column, and the field's meaning is not documented — the investigation marks
 * it unverified. If a trader ever turns out to hold two live `Customer`
 * accounts they use for different things, the fix is the picker, not a cleverer
 * heuristic here.
 *
 * It also does not treat "no eligible account" as a failure. A connection whose
 * scope holds nothing tradeable has honestly reported zero trades today, and
 * calling that a broker outage would put an orange warning in front of a user
 * whose data is fine. See the `accountIds.size === 0` branch in ./fills.ts.
 *
 *
 * THE PII RULE, WHICH IS STRICTER THAN ANYTHING ABOVE IT
 * -----------------------------------------------------
 *
 * `TradingPermission` carries `accountHolderContact`, `accountHolderEmail`,
 * `ctaContact` and `ctaEmail` — two names and two email addresses, required
 * fields on the documented entity. They are the first real PII this integration
 * reads. They are never retained, never logged, and never sent to the browser,
 * and that is enforced by shape rather than by discipline: the only thing that
 * leaves {@link permittedAccountIds} is a `Set<number>` of account ids, which
 * cannot hold a name or an email address. ./types.ts does not even declare the
 * four fields, so nothing above it can reach one by autocomplete.
 */

import type { TradovateAccount, TradovateTradingPermission } from './types';

/**
 * How an account is named on BOTH sides of the REF-110 join: `<host>:<id>`.
 *
 * THE ID ALONE IS NOT ENOUGH, which is 034's finding about `broker_trade_key`
 * restated for accounts. Tradovate account ids are HOST-LOCAL — nothing
 * documents live and demo as sharing an id space, and this module's own header
 * is the record of how expensive a wrong assumption about account identity is.
 * Unqualified, a demo account 401 and a live account 401 are one portfolio, and
 * a trade from either would resolve to whichever row was written first.
 *
 * Lives HERE, in the module that owns what an account is, rather than in
 * ./account-sync.ts beside its only two callers: ./import.ts needs it to
 * resolve a trade's account and ./account-sync.ts needs it to key the map, and
 * the second already imports the first. A third module owning it is what keeps
 * that a line rather than a cycle.
 */
export function accountIdentity(host: string, brokerAccountId: number): string {
  return `${host}:${brokerAccountId}`;
}

/** Account types an end trader's own trading account can have. */
const TRADEABLE_ACCOUNT_TYPE: TradovateAccount['accountType'] = 'Customer';

/**
 * The permission statuses that make an account this trader's to trade.
 *
 * Two of the five. `Requested` is a pending offer rather than an arrangement,
 * and `Declined` and `Revoked` are refusals — counting any of the three would
 * move a trader's limits on the strength of a permission they do not hold.
 */
const ACCEPTED_PERMISSION_STATUSES: readonly TradovateTradingPermission['status'][] = [
  'Accepted',
  'Approved',
];

/**
 * Why one account did not count. The order is the order they are tested in,
 * and that order is the definition — see {@link AccountFilterCounts}.
 *
 * `noOwner` and `noPermission` are the two ways to fail the ONE question "is
 * this account this trader's", and which one is reported says what was known
 * when it was asked: `noPermission` means the permission list was read and does
 * not name this trader on this account, `noOwner` means there was no permission
 * evidence to consult at all. Behaviour is identical — both are dropped — but
 * conflating "we asked and you have no permission" with "we could not ask" is
 * what made this ticket take three measurements, so the two stay separate.
 */
type AccountRejection =
  | 'noOwner'
  | 'noPermission'
  | 'notCustomer'
  | 'closed'
  | 'restricted'
  | 'readonly'
  | 'futuresDisabled'
  | 'inactive';

/**
 * How many accounts the filter saw, and why each one that fell out did.
 *
 * NOTHING IN THE PRODUCT BRANCHES ON THIS. It travels no further than
 * {@link partitionAccounts}'s return value — the day pull takes `accepted` and
 * discards it — and it is here because the day figures cannot say WHY they are
 * zero: a filtered-out account and a day with no trades are the same honest
 * zero from outside. That makes it the shape the suite asserts the rule
 * against, which is its only remaining caller.
 *
 * EACH ACCOUNT IS COUNTED ONCE, under the FIRST reason it failed. So
 * `noOwner + noPermission + notCustomer + … + inactive + accepted === total`,
 * exactly, and it can be read as a partition rather than as overlapping
 * tallies. An account that is both `closed` and `readonly` lands in `closed`
 * because that is tested first; the counts answer "where did they go", not "how
 * many flags does each one carry".
 *
 * `permitted` is the one field here that is not a rejection — it is how many of
 * the ACCEPTED got in on a permission rather than on ownership, and so it is
 * not part of the sum above. It exists because the accepted count alone cannot
 * say whether the owned-OR-permitted rule is doing anything: on the connection
 * this was built for it reads 1, and on every ordinary trader 0.
 */
export interface AccountFilterCounts {
  total: number;
  noOwner: number;
  noPermission: number;
  notCustomer: number;
  closed: number;
  restricted: number;
  readonly: number;
  futuresDisabled: number;
  inactive: number;
  permitted: number;
}

/**
 * Whether this account is this trader's, and how.
 *
 * `permitted` is the set of account ids a `TradingPermission` of ours names, or
 * **null for "there is no permission evidence"** — the list was not fetched, or
 * it could not be read. Null is today's owned-only rule exactly, which is what
 * makes the fail-safe a value rather than a code path.
 */
function claimFor(
  account: TradovateAccount,
  tradovateUserId: number | null,
  permitted: ReadonlySet<number> | null
): 'owned' | 'permitted' | 'noOwner' | 'noPermission' {
  // Null identity fails for EVERY account, and it fails as `noOwner` rather
  // than as a separate state: ownership is the thing that cannot be
  // established, and a permission cannot be matched without an id to match it
  // to either. Checked before `permitted` rather than relying on the caller
  // having passed null for it, so the rule holds however this is called.
  if (tradovateUserId === null) return 'noOwner';
  if (account.userId === tradovateUserId) return 'owned';
  if (permitted === null) return 'noOwner';
  return permitted.has(account.id) ? 'permitted' : 'noPermission';
}

/**
 * The first TRADEABILITY condition this account fails, or null when it passes.
 *
 * Separate from the claim above because the two are asked in both orders: the
 * partition asks claim first, and {@link permissionsCouldHelp} asks this one
 * first — "would a permission actually change this account's verdict" is the
 * question that decides whether the extra request is worth making.
 */
function untradeable(account: TradovateAccount): AccountRejection | null {
  if (account.accountType !== TRADEABLE_ACCOUNT_TYPE) return 'notCustomer';
  if (account.closed === true) return 'closed';
  if (account.restricted === true) return 'restricted';
  if (account.readonly === true) return 'readonly';
  if (account.futuresDisabled === true) return 'futuresDisabled';
  if (account.active === false) return 'inactive';
  return null;
}

/**
 * The account ids a `TradingPermission` of ours names, or null when the body
 * could not be read as a list at all.
 *
 * READS `userId`, `accountId` AND `status`, AND NOTHING ELSE. The four PII
 * fields on this entity are not read, not copied, and not in the return value's
 * type — see the PII note in this module's header. A `Set<number>` is the
 * narrowest thing that can carry the answer.
 *
 * Defensive about the body at every step, and for a strong reason: this is the
 * input that can make an account COUNT, so every uncertainty resolves towards
 * "not permitted". A row whose `userId` is not
 * exactly ours, whose `accountId` is not a number, or whose `status` is not one
 * of the two accepted words contributes nothing. A body that is not an array
 * answers null — "no evidence" — which is the owned-only rule, and so does a
 * null `tradovateUserId`: with no id to match, a list of permissions is not
 * evidence about anybody.
 *
 * An EMPTY ARRAY is not null: it is the host answering that this trader holds
 * no permissions, which is a finding, and accounts then fall out as
 * `noPermission` rather than as `noOwner`. Neither one counts.
 */
export function permittedAccountIds(
  body: unknown,
  tradovateUserId: number | null
): Set<number> | null {
  if (!Array.isArray(body)) return null;
  if (tradovateUserId === null) return null;

  const ids = new Set<number>();

  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { userId, accountId, status } = entry as {
      userId?: unknown;
      accountId?: unknown;
      status?: unknown;
    };

    if (userId !== tradovateUserId) continue;
    if (typeof accountId !== 'number' || !Number.isFinite(accountId)) continue;
    if (typeof status !== 'string') continue;
    if (!(ACCEPTED_PERMISSION_STATUSES as readonly string[]).includes(status)) continue;

    ids.add(accountId);
  }

  return ids;
}

/**
 * Whether reading the permission list could change any verdict here.
 *
 * True when at least one account FAILED ON OWNERSHIP and is an end trader's own
 * kind of account. `userId` is not ours, so only a permission can say the
 * account is this trader's — and `accountType` is `Customer`, so it is an
 * account worth saying it about.
 *
 * False for a null identity, where no permission can be matched to anyone.
 *
 *
 * THE FIVE STATE FLAGS ARE NO LONGER ASKED ABOUT HERE (REF-110 Stage 1)
 * ---------------------------------------------------------------------
 *
 * The condition used to be "failed on ownership ALONE and is otherwise
 * tradeable", which folded in `closed`, `restricted`, `readonly`,
 * `futuresDisabled` and `inactive` on the reasoning that a permission cannot
 * make a closed account tradeable, so the request would change nothing. That
 * was true while the only question was which fills count today. It stopped
 * being true when REF-110 began RECORDING accounts: a closed account is
 * precisely a row the accounts table wants — with `status: 'closed'` — and
 * {@link claimedAccounts} cannot claim one it has no permission evidence for.
 *
 * The case this fixes is the live one. A trader whose only prop account has
 * just been breached reaches it through a permission rather than ownership, and
 * it is now closed. Under the old gate the permission list was not read, the
 * account answered `noOwner`, and it was never recorded — so the one ticket
 * whose promise is "an account's history survives it closing" would have lost
 * the account the first time it closed.
 *
 * `accountType` STAYS, and that is the half that is easy to drop by accident. A
 * type is what an account IS, not a state it is in: a `House` or `Omnibus`
 * account is never an end trader's portfolio, closed or open, so a permission
 * naming one would still change nothing. Keeping it preserves the property the
 * old gate had — a trader whose visible scope holds a firm's `House` accounts
 * pays nothing — and narrows the new cost to accounts this stage would actually
 * record.
 *
 * WHAT THIS COSTS, EXACTLY. One `/tradingPermission/list` per host per pull, in
 * one new case: a trader with no owned-and-tradeable gap but with somebody
 * else's CUSTOMER account in their visible scope. It is the cheapest read in
 * the chain and its failure is already swallowed ({@link readPermittedAccounts}
 * in ./fills.ts).
 *
 * WHAT IT CANNOT COST: a different day. An account that becomes `permitted`
 * only now is one that FAILED a state flag — otherwise the old gate would have
 * fired on it — so {@link untradeable} drops it either way and `accepted` is
 * unchanged BY CONSTRUCTION, not by luck. What moves is which counter it lands
 * in: `noOwner` before, its real rejection reason now, which is strictly more
 * informative. The suite asserts the unchanged half.
 */
export function permissionsCouldHelp(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null
): boolean {
  if (tradovateUserId === null) return false;
  return accounts.some(
    (account) =>
      claimFor(account, tradovateUserId, null) === 'noOwner' &&
      account.accountType === TRADEABLE_ACCOUNT_TYPE
  );
}

/**
 * The accounts whose fills count, and the tally of what was dropped.
 *
 * One pass, two predicates — {@link claimFor} and {@link untradeable} — so the
 * counts cannot drift from the selection they describe. That is the whole
 * reason this exists rather than a second function that re-implements the same
 * eight tests: a diagnostic that disagrees with the code it is diagnosing is
 * worse than none.
 *
 * `permitted` defaults to null, which is the owned-only rule — every caller
 * that does not read the permission list gets exactly the behaviour this
 * module had before Stage 2.
 */
export function partitionAccounts(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null,
  permitted: ReadonlySet<number> | null = null
): { accepted: TradovateAccount[]; counts: AccountFilterCounts } {
  const counts: AccountFilterCounts = {
    total: accounts.length,
    noOwner: 0,
    noPermission: 0,
    notCustomer: 0,
    closed: 0,
    restricted: 0,
    readonly: 0,
    futuresDisabled: 0,
    inactive: 0,
    permitted: 0,
  };

  const accepted: TradovateAccount[] = [];

  for (const account of accounts) {
    // The claim first, so the order of the counters is the order of the tests
    // and `noOwner` keeps the meaning it has always had.
    const claim = claimFor(account, tradovateUserId, permitted);
    if (claim === 'noOwner' || claim === 'noPermission') {
      counts[claim]++;
      continue;
    }

    // A permission says whose account it is. It does not make a closed one
    // tradeable, and nothing below this line was changed by Stage 2.
    const rejection = untradeable(account);
    if (rejection !== null) {
      // 'inactive' is the counter for `active: false`; the key differs from the
      // flag so the log line reads as a reason rather than as a field name.
      counts[rejection]++;
      continue;
    }

    accepted.push(account);
    if (claim === 'permitted') counts.permitted++;
  }

  return { accepted, counts };
}

/**
 * One account this trader has a claim on, and what kind of claim it is.
 *
 * `tradeable` is {@link untradeable} inverted — "could this have been traded
 * today" — carried as a FLAG rather than used as a filter, which is the whole
 * difference between this and {@link partitionAccounts}.
 */
export interface ClaimedAccount {
  account: TradovateAccount;
  /** How it is this trader's. Never a rejection: an unclaimed account is absent. */
  claim: 'owned' | 'permitted';
  /**
   * False when a STATE flag is set: closed, restricted, readonly,
   * futuresDisabled, inactive.
   *
   * Never false for `accountType`, because a non-`Customer` account is not in
   * this list at all — see {@link claimedAccounts}. So this reads as "is this
   * portfolio currently open for business", which is what a status is derived
   * from, rather than as the eight-way verdict {@link untradeable} gives.
   */
  tradeable: boolean;
}

/**
 * Every account that is THIS TRADER'S, tradeable or not (REF-110 Stage 1).
 *
 * THE ONE THING THIS MODULE DID NOT ALREADY ANSWER, and the reason it is three
 * lines rather than a new filter: the two predicates have always been separate
 * — {@link claimFor} asks whose account it is, {@link untradeable} asks whether
 * it could have been traded today — and the accounts TABLE wants the first
 * without the second.
 *
 * WHY `accepted` IS THE WRONG INPUT FOR IT, which is the finding that shaped
 * REF-110 Stage 1. `discoverHostAccounts` returns
 * `partitionAccounts(...).accepted`: a list with every closed, restricted,
 * readonly, inactive, non-`Customer` and not-ours account already removed.
 * Recording from it would NEVER RECORD A CLOSED ACCOUNT — the exact thing the
 * ticket is about — and would stamp `status: 'active'` on everything, because
 * nothing else survives to be seen.
 *
 * WHY THE RAW LIST IS EQUALLY WRONG, in the other direction and worse. A prop
 * firm's API admin has OTHER TRADERS' ACCOUNTS in their visible scope (see this
 * module's header), so recording the raw list would put other people's account
 * names in our table. {@link claimFor} is the filter that prevents that, and it
 * keys on the permission's own `userId` — never on "this appeared in the list",
 * never on the account's name, never on how many rows came back.
 *
 * ONE FILTER SURVIVES BESIDE THE CLAIM, AND IT IS NOT A STATE: `accountType`
 * must be `Customer`. The five state flags are dropped because they describe a
 * moment — a closed evaluation is a portfolio with a history and belongs on
 * the screen — while the type describes what the account IS. `Employee`,
 * `Giveup`, `House`, `Omnibus` and `Wash` are not an end trader's own trading
 * account and never become one, so recording them would put a card on
 * "התיקים שלי" that is not a portfolio, with a P&L that is not the trader's.
 * This is the same line {@link untradeable} tests first, read for a different
 * question.
 *
 * So: claimed, filtered by kind, unfiltered by state, and the state carried
 * alongside so the caller can derive a status from it. Order is the input's,
 * which is the host's.
 *
 * ZERO UPSTREAM COST. This reads the list `discoverHostAccounts` has already
 * fetched; it makes no request and cannot.
 */
export function claimedAccounts(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null,
  permitted: ReadonlySet<number> | null = null
): ClaimedAccount[] {
  const claimed: ClaimedAccount[] = [];

  for (const account of accounts) {
    if (account.accountType !== TRADEABLE_ACCOUNT_TYPE) continue;

    const claim = claimFor(account, tradovateUserId, permitted);
    if (claim !== 'owned' && claim !== 'permitted') continue;

    claimed.push({ account, claim, tradeable: untradeable(account) === null });
  }

  return claimed;
}

/**
 * The accounts whose fills count towards this user's rules.
 *
 * `tradovateUserId` is null for a connection stored before GET /auth/me was
 * recorded. Neither half of the claim can be checked then — ownership has
 * nothing to compare and a permission has no trader to name — and the choice is
 * between counting accounts that may not be theirs and counting none. Counting
 * none is the fail-safe direction here: an under-count falls back to Reflect's
 * own data through the source mapping, while an over-count blocks a trader over
 * somebody else's trade.
 */
export function selectTradingAccounts(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null,
  permitted: ReadonlySet<number> | null = null
): TradovateAccount[] {
  return partitionAccounts(accounts, tradovateUserId, permitted).accepted;
}
