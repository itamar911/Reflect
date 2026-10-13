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
 * "Their own and tradeable" is four filters, each for a stated reason:
 *
 * - `userId` must match the connection's stored `tradovate_user_id`. Visible
 *   scope is wider than ownership — a prop or funded trader can see the
 *   organization's accounts — and counting someone else's fills against this
 *   trader's limits is the worst failure available here, because it blocks a
 *   user over a trade they did not make. The id comes from GET /auth/me at
 *   connect time (connections.ts), so it is as trustworthy as the connection.
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
 */

import type { TradovateAccount } from './types';

/** Account types an end trader's own trading account can have. */
const TRADEABLE_ACCOUNT_TYPE: TradovateAccount['accountType'] = 'Customer';

/**
 * The accounts whose fills count towards this user's rules.
 *
 * `tradovateUserId` is null for a connection stored before GET /auth/me was
 * recorded. Ownership then cannot be checked, and the choice is between
 * counting accounts that may not be theirs and counting none. Counting none is
 * the fail-safe direction here — an under-count falls back to Reflect's own
 * data through the source mapping, while an over-count blocks a trader over
 * somebody else's trade.
 */
export function selectTradingAccounts(
  accounts: readonly TradovateAccount[],
  tradovateUserId: number | null
): TradovateAccount[] {
  if (tradovateUserId === null) return [];

  return accounts.filter((account) => {
    if (account.userId !== tradovateUserId) return false;
    if (account.accountType !== TRADEABLE_ACCOUNT_TYPE) return false;
    if (account.closed === true) return false;
    if (account.restricted === true) return false;
    if (account.readonly === true) return false;
    if (account.futuresDisabled === true) return false;
    if (account.active === false) return false;
    return true;
  });
}
