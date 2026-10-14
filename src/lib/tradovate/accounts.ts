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
 * four fields, so nothing above it can reach one by autocomplete. Same
 * discipline as `HostProbe` in ./diag-hosts.ts being the reason a hostname
 * cannot be logged by accident.
 */

import type { TradovateAccount, TradovateTradingPermission } from './types';

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
 * evidence to consult at all. Behaviour is identical — both are dropped — but a
 * log line that cannot tell "we asked and you have no permission" from "we
 * could not ask" is the kind of line that made this ticket take three
 * measurements.
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
 * DIAGNOSTIC ONLY (diag/ref-90-counts). Nothing in the product branches on
 * this; it exists because a filtered-out account and a day with no trades are
 * indistinguishable from outside — both are an honest zero carried all the way
 * to `broker_verified` — and a trader whose only account is a prop firm's would
 * see the second message for the first cause.
 *
 * EACH ACCOUNT IS COUNTED ONCE, under the FIRST reason it failed. So
 * `noOwner + noPermission + notCustomer + … + inactive + accepted === total`,
 * exactly, and the line can be read as a partition rather than as overlapping
 * tallies. An account that is both `closed` and `readonly` lands in `closed`
 * because that is tested first; the counts answer "where did they go", not "how
 * many flags does each one carry".
 *
 * `permitted` is the one field here that is not a rejection — it is how many of
 * the ACCEPTED got in on a permission rather than on ownership, and so it is
 * not part of the sum above. It exists because `mine=1` alone cannot say
 * whether Stage 2 is doing anything: on the connection this was built for it
 * should read `mine=1 permitted=1`, and on every ordinary trader `permitted=0`.
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
 * Defensive about the body in the same way ./diag-hosts.ts is, and for a
 * stronger reason: this is the input that can make an account COUNT, so every
 * uncertainty resolves towards "not permitted". A row whose `userId` is not
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
 * True when at least one account FAILED ON OWNERSHIP ALONE — it is tradeable in
 * every other respect and only `userId` dropped it. That is the whole condition
 * on the extra request: an ordinary trader whose accounts are their own pays
 * nothing for Stage 2, and neither does one whose visible scope holds other
 * people's closed or `House` accounts, because a permission would not save
 * those either.
 *
 * False for a null identity, where no permission can be matched to anyone.
 */
export function permissionsCouldHelp(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null
): boolean {
  if (tradovateUserId === null) return false;
  return accounts.some(
    (account) =>
      claimFor(account, tradovateUserId, null) === 'noOwner' && untradeable(account) === null
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
