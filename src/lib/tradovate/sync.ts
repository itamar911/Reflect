/**
 * Pull one user's finished trades and write them to the journal (REF-107
 * Stage 2).
 *
 * SERVER ONLY. The one place that joins the halves of the import — the broker
 * read (./fills.ts), the accounts pass (./account-sync.ts), the stop-order read
 * (./orders.ts) and the journal write (./import.ts) — so that the two triggers
 * which have to make a pull of their own do not each assemble it: POST
 * /api/tradovate/sync and the daily /api/cron/tradovate-import.
 *
 * THE FOUR HALVES ARE NOT ALL RUN BY EVERY CALLER. `readStops` is off by
 * default, because the nightly cron is structurally incapable of reading orders
 * — see the field, which has the clock arithmetic.
 *
 * /api/tradovate/today deliberately does NOT go through here. That trigger is
 * free precisely because it already has a pull in hand, and routing it through
 * a function that makes one would throw away the only thing that makes it free
 * (E9). It calls `importBrokerTrades` directly with the rows it already built.
 *
 * SO /today DOES NOT RECORD ACCOUNTS EITHER, and that is a deliberate scope
 * line for REF-110 Stages 1-2 rather than an oversight. It would be nearly
 * free — the pull it already makes now carries `BrokerDay.accounts` — but it
 * would put four more statements on the critical path of opening the trade
 * form, for a table nothing renders yet. The cost of leaving it out is bounded
 * and small: a trader's accounts are recorded on their next Sync or on the
 * nightly cron, whichever comes first, so the gap closes within a day for
 * everybody and immediately for anybody who presses the button. The rows
 * /today imports in the meantime are assigned by the backfill pass on that
 * same run. Revisit when the screen exists and a trader can notice the delay.
 *
 *
 * WHY THE WRITE CLIENT AND THE READ CLIENT ARE TWO PARAMETERS
 * ----------------------------------------------------------
 *
 * Because they are two different identities, and conflating them is the risk
 * §C12 names:
 *
 * - `client` is where the ROWS go, and therefore whose RLS applies. On the sync
 *   route it is the user's own session client, so the database enforces
 *   ownership exactly as it does for every write the browser makes today.
 * - `admin` is for the server-only reads — the decrypted token, the resolved
 *   hosts, the trade-source declaration. Those columns are unreadable from the
 *   browser by construction (migration 017), so this one has to be the
 *   service-role client and there is no version of this that does not use it.
 *
 * In the cron the two are the same object, because a background job has no
 * session. What stands in for RLS there is in ./import.ts' header: `userId` is
 * never read from a request, and every statement carries it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { portfolioLabel } from '../portfolios/portfolio';
import { readPortfolios } from '../portfolios/read';
import { accountIdentity } from './accounts';
import { readActiveAccounts, syncBrokerAccounts, type AccountSyncCounts } from './account-sync';
import { flushUserCalls } from './call-meter';
import { tradovateGet } from './client';
import { getUserTradingApi, notingPenalty, readIsTradeSource } from './connections';
import { loadBrokerDay, type PullNotice, type TradovateReader } from './fills';
import { orderNotices, type BrokerNotice } from './notices';
import {
  importBrokerTrades,
  isImportEnabled,
  tradesNeedingStopHistory,
  type BrokerImportCounts,
} from './import';
import { readStopHistories } from './orders';

export interface SyncRequest {
  userId: string;
  /** Where the rows are written, and the identity they are written as. */
  client: SupabaseClient;
  /** Service-role client for the token, the hosts and the declaration. */
  admin: SupabaseClient;
  /** The trader's local midnight. Only the discarded scalars are cut at it. */
  dayStartMs: number;
  /**
   * The earliest close to reach back to.
   *
   * This is the ONLY parameter that changes what the pull costs: §A2 measured
   * that the four list reads are unfiltered and cost the same for any window,
   * and that PRICING grows at one contract chain per distinct contract in it.
   */
  windowStartMs: number;
  /** Test seam for the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Whether to read the broker's protective orders too (REF-113 Stage 3).
   *
   * OFF BY DEFAULT, AND THE DEFAULT IS THE DECISION RATHER THAN THE SAFE
   * CHOICE. Three callers reach this function and they are not equivalent:
   *
   *   POST /api/tradovate/sync        true  — the trader is here, now, today
   *   the end-of-day summary          true  — same trading day, per user, at
   *                                           the hour that user chose
   *   /api/cron/tradovate-import      FALSE — and it could not be otherwise
   *
   * The nightly cron runs at 03:30 UTC. If the trading day rolls over at 17:00
   * CT, that is 22:00 or 23:00 UTC, so the cron fires FOUR AND A HALF TO FIVE
   * AND A HALF HOURS AFTER Tradovate has already cleared `/order/list` of the
   * day it is importing. It cannot see those orders — not on that run, and not
   * on any later one, because `/order/list` has no depth at all (`depthDays=0`,
   * measured 19.10). Asking would be seven to nine requests per trader per
   * night against a rate-limited third party, for an empty answer.
   *
   * So the cron does not ask, the trades it imports keep `stop_history = NULL`,
   * and NULL is what leaves them candidates for a run that can actually see the
   * orders. Stage 4 is the dedicated cron, timed to the trading day rather than
   * to midnight, that closes the gap for a trader who never opens the app.
   */
  readStops?: boolean;
}

/** A pull and the import it fed. `asOf` is the pull's, for the caller to report. */
export interface SyncResult {
  counts: BrokerImportCounts;
  /**
   * What the account pass recorded (REF-110 Stages 1-2).
   *
   * Counts only, and nothing upstream branches on them — the sync route does
   * not send them to the browser and the cron totals the trade counts alone.
   * They are here so that a caller CAN report them and so the regression suite
   * has something to assert against; the log line in ./account-sync.ts is what
   * an operator actually reads.
   */
  accounts: AccountSyncCounts;
  /** When this was read from Tradovate, ISO 8601. */
  asOf: string;
  /**
   * Whether the connection declares the broker a trade source (E7).
   *
   * NOT ENOUGH ON ITS OWN TO EXPLAIN A RUN THAT DID NOT HAPPEN, and the
   * regression suite asserts why: this is false whenever the FLAG is off too,
   * because the column cannot be read before migration 034 has run. So it is
   * exactly `counts.ran`, and a caller trying to tell "switched off" from "the
   * trader said no" has to read {@link importEnabled} instead. Kept because it
   * is the honest name for what the import gate was given.
   */
  isTradeSource: boolean;
  /**
   * Whether TRADOVATE_IMPORT_ENABLED was set for this run (REF-107 Stage 2.5).
   *
   * The field that separates the two `ran: false` states. With it false, no
   * column was read and no declaration was consulted — the deployment has the
   * import switched off. With it true and `ran` still false, the one remaining
   * reason is the trader's own declaration, which is a setting they can
   * change and therefore a different sentence.
   */
  importEnabled: boolean;
  /**
   * The contracts whose trades this run REFUSED to state (REF-117 Stage 6).
   *
   * SYMBOLS ONLY, DEDUPLICATED, AND NEVER THE REST OF {@link
   * import('./fills').HeldGroup}. That type carries a broker account id, a
   * broker contract id, a fill count and an `impliedPrevPos` — operator
   * diagnostics, already in the pull's log line, and ids that the leak group in
   * scripts/tradovate-today-check.ts exists to keep off the wire. What a trader
   * can act on is the symbol: "the MNQ trades are not in yet".
   *
   * EMPTY ON EVERY ORDINARY DAY, which is what makes this free to carry. A
   * non-empty list means ./cycles.ts could not reconcile a group's fills
   * against the broker's own `netPos` and therefore stated no cycles for it —
   * the day is UNDER-COUNTED on that contract, and this module's oldest
   * fail-safe is that an under-counted day makes every rule MORE PERMISSIVE.
   * REF-117 Stage 2 chose to hold the group rather than fail the pull, on the
   * grounds that one overnight carry must not take the integration down for a
   * session, and recorded that the choice is only defensible IF THE TRADER SEES
   * IT. This is the field that makes it so.
   *
   * A NULL SYMBOL IS DROPPED RATHER THAN RENDERED AS A BLANK, and the absence
   * is then carried by {@link heldCount}: a group whose contract body named
   * nothing usable, and the orphan-pair row, which is about no contract at all.
   */
  heldSymbols: string[];
  /**
   * How many groups were held, INCLUDING the ones with no readable symbol.
   *
   * So that `heldSymbols: [], heldCount: 1` is expressible — "something was
   * held and we cannot tell you what it was on" — rather than collapsing into
   * the ordinary silent day. lib/tradovate/sync-response.ts has a sentence for
   * exactly that case.
   */
  heldCount: number;
  /**
   * What this run could not do for the trader, ready for the wire
   * (REF-112 §5).
   *
   * ALREADY REDUCED FROM {@link import('./fills').PullNotice}: the host and
   * the broker account id are gone, and the account label has been resolved to
   * what the trader calls it. That reduction happens HERE, in the module that
   * has both the pull and a database client, for the same reason
   * {@link heldSymbols} is reduced here — it is the last place that holds the
   * operator diagnostics, so it is the last place they can be dropped.
   *
   * Empty on every ordinary day.
   */
  notices: BrokerNotice[];
}

/**
 * Turn the pull's notices into the ones a trader reads (REF-112 §5).
 *
 * THE ONE THING THIS DOES THAT A PURE MAP COULD NOT: it resolves the account
 * LABEL. The pull knows a broker account by `(host, id)` and by the name
 * `/account/list` printed on it; the trader may have renamed that card on
 * "התיקים שלי" months ago, and a message naming the broker's string for an
 * account they renamed away from reads as being about somebody else's money.
 * So the label is `nickname ?? display_name` — the same `portfolioLabel` the
 * card and the filter chip use — and it falls back to the broker's name when
 * there is no row at all.
 *
 * THERE IS OFTEN NO ROW, AND THAT IS NOT AN ERROR. A non-`Customer` account is
 * filtered out before ./account-sync.ts ever sees it (./accounts.ts), so it
 * has no `accounts` row, no nickname, and the broker's name is the only label
 * that will ever exist for it.
 *
 * ONE SELECT, AND ONLY WHEN THERE IS SOMETHING TO LABEL. An ordinary day has
 * no notices and issues no statement; a day with a host failure or an
 * unpriceable product has notices that carry no account and still issues none.
 * The read is the trader's own, under their own RLS, and it is the same one
 * /accounts makes on every page view.
 *
 * IT CANNOT FAIL THE SYNC. `readPortfolios` answers an empty list on a failed
 * read by design, which degrades every label to the broker's name — the
 * sentence is still said, with a name the trader still recognises.
 */
async function toWireNotices(params: {
  client: SupabaseClient;
  userId: string;
  enabled: boolean;
  notices: readonly PullNotice[];
}): Promise<BrokerNotice[]> {
  const { client, userId, enabled, notices } = params;
  if (notices.length === 0) return [];

  const named = notices.some(
    (notice) =>
      notice.kind === 'account_currency' ||
      notice.kind === 'account_type' ||
      notice.kind === 'account_closed_today'
  );

  const labels = new Map<string, string>();
  if (named) {
    for (const portfolio of await readPortfolios(client, userId, enabled)) {
      if (portfolio.brokerAccountId === null || portfolio.brokerHost === null) continue;
      labels.set(
        accountIdentity(portfolio.brokerHost, portfolio.brokerAccountId),
        portfolioLabel(portfolio)
      );
    }
  }

  return orderNotices(
    notices.map((notice) => {
      if (
        notice.kind !== 'account_currency' &&
        notice.kind !== 'account_type' &&
        notice.kind !== 'account_closed_today'
      ) {
        // `no_accounts`, `host_degraded` and `unpriced_product` carry nothing
        // that needs resolving, and the last of the three already holds a root
        // rather than a contract.
        return notice;
      }
      const label = labels.get(accountIdentity(notice.host, notice.accountId)) ?? notice.name;
      // NULL AND NOT `''`: the unnamed sentence is a real member of the union
      // and the empty string would render as a gap in the middle of a line.
      return { kind: notice.kind, account: label === '' ? null : label };
    })
  );
}

/**
 * Read the window and import what closed in it.
 *
 * THROWS WHAT THE PULL THROWS — TradovateNotConnectedError,
 * TradovateTransientError, TradovateUnpriceableError — so the caller maps them
 * through `classifyDayPullFailure` exactly as /today and /trades do. The IMPORT
 * does not throw; it returns counts, with refusals counted as `failed`.
 *
 * NO PULL AT ALL WHEN THERE IS NOTHING TO WRITE. Both gates are checked before
 * the first upstream request: an import that is switched off, or a connection
 * the trader has declared is not a source of trades, means seven to nine calls
 * against a rate-limited third party for a result that would be discarded.
 * /today cannot make this saving — it needs the pull for the figures — which is
 * the one behavioural difference between the triggers.
 */
export async function syncUserTrades(request: SyncRequest): Promise<SyncResult> {
  try {
    return await pullAndImport(request);
  } finally {
    // THE CALL COUNTER LANDS HERE, FOR FOUR CALLERS AT ONCE (REF-112 §4.5
    // item 1). This function is what the import cron, the orders cron,
    // send-alerts and POST /api/tradovate/sync all go through, so one `finally`
    // covers every one of them.
    //
    // IN A `finally` AND NOT AFTER THE RETURN, because the pull that FAILED is
    // the one whose count matters most: a trader who tripped a penalty made
    // every request up to it, and a counter that only recorded successful pulls
    // would be blind to exactly the user who caused the problem.
    //
    // `flushUserCalls` never throws and never rejects — see its own note — so
    // it cannot replace the pull's error with a bookkeeping one. Subject to
    // FLUSH_MIN_GAP_MS, so a trader pressing Sync twice in a minute writes once.
    await flushUserCalls({ admin: request.admin, userIds: [request.userId] });
  }
}

/** The body. Split only so {@link syncUserTrades} can own the `finally`. */
async function pullAndImport(request: SyncRequest): Promise<SyncResult> {
  const {
    userId,
    client,
    admin,
    dayStartMs,
    windowStartMs,
    env = process.env,
    readStops = false,
  } = request;

  const enabled = isImportEnabled(env);
  const isTradeSource = enabled ? await readIsTradeSource(userId, { admin }) : false;

  if (!enabled || !isTradeSource) {
    // `importBrokerTrades` with an empty list would return the same thing. It
    // is called anyway, with nothing, so that the "did not run" shape has one
    // definition and lives in the module that owns it.
    const counts = await importBrokerTrades({ client, userId, trades: [], isTradeSource, env });
    // Same reasoning, and the same shape: the account pass is asked with no
    // hosts so that its "did not run" answer comes from the module that owns
    // it rather than from a literal written here. It issues no statement —
    // `isImportEnabled` stops it before the read, and an empty host list has
    // nothing to close.
    const { counts: accounts } = await syncBrokerAccounts({ client, userId, hosts: [], env });
    return {
      counts,
      accounts,
      asOf: new Date().toISOString(),
      isTradeSource,
      importEnabled: enabled,
      // No pull happened, so nothing was held and nothing was refused. An
      // honest empty rather than an absence, for the reason every other field
      // in this shape is stated.
      heldSymbols: [],
      heldCount: 0,
      notices: [],
    };
  }

  const api = await getUserTradingApi(userId, { admin });

  // ONE READER PER HOST, token and host travelling together — the invariant
  // ./client.ts enforces in the type system, and the same construction as
  // /today and /trades. Both hosts are built because both are asked:
  // `environment` is the token's mint server and says nothing about where the
  // trader's accounts live (REF-90).
  //
  // WRAPPED IN `notingPenalty` (REF-112 §4.5 item 3). A penalty is a property
  // of a REQUEST, and this closure is the only thing on this path that makes
  // one — so recording the verdict here covers the import cron, the orders
  // cron, send-alerts and POST /sync in one place instead of four catch blocks.
  // It rethrows unchanged, so nothing downstream of it sees a difference.
  const readerFor = (apiUrl: string): TradovateReader => ({
    get: (path, query) =>
      notingPenalty(
        userId,
        () => tradovateGet(path, query, { accessToken: api.accessToken, apiUrl, userId }),
        { admin }
      ),
  });

  // WHAT OUR OWN TABLE SAYS WAS OPEN TODAY, READ BEFORE THE PULL (REF-124).
  //
  // The order is forced: the pull needs this to decide which accounts' fills
  // count, and `syncBrokerAccounts` below is what makes it stale again by
  // closing the rows the pull just found missing. One read, no upstream cost,
  // and `[]` on any doubt — which is exactly the behaviour this path had before
  // REF-124. See {@link readActiveAccounts}.
  const knownActiveAccounts = await readActiveAccounts({ client, userId, env });

  const {
    day,
    trades,
    held,
    notices: pulledByHosts,
    accounts: hosts,
  } = await loadBrokerDay({
    readers: {
      live: readerFor(api.hosts.live.url),
      demo: readerFor(api.hosts.demo.url),
    },
    environment: api.environment,
    dayStartMs,
    windowStartMs,
    tradovateUserId: api.tradovateUserId,
    knownActiveAccounts,
  });

  // THE ACCOUNTS FIRST, AND THE ORDER IS THE POINT (REF-110 Stages 1-2).
  //
  // The import needs `identities` to stamp `account_id` on the rows it writes,
  // and that map only exists once the accounts have rows of their own. Run the
  // other way round, every trade in a trader's FIRST sync would land
  // unassigned and wait for the next run's backfill to find it — correct in the
  // end, and a day late for no reason.
  //
  // `hosts` carries one entry per host that ANSWERED discovery, which is what
  // scopes the closure rule. It costs ZERO UPSTREAM REQUESTS: every account in
  // it came out of the `/account/list` the pull above already made.
  const {
    counts: accounts,
    identities,
    transitions,
  } = await syncBrokerAccounts({
    client,
    userId,
    hosts,
    env,
  });

  // ── The sentence for an account that closed today (REF-124 item 4) ────────
  //
  // JOINED TO THE PULL'S OWN NOTICES RATHER THAN CARRIED SEPARATELY, so it
  // reaches the trader through one reducer, one ordering, one de-duplication
  // and one label resolution. A second channel to the same panel would be a
  // second place to forget to strip an account id.
  //
  // THE ONLY NOTICE IN THE PRODUCT THAT IS NOT DERIVED FROM STATE. Every other
  // member of the union is re-computed from the world on each run and is
  // therefore self-healing if a run is lost. This one is a transition, so a
  // sync that throws between the status write and this line loses the
  // sentence — the write is what the once-per-account guarantee is made of, and
  // it has already happened. That is the right side to fail on: the wrong one
  // is a notice the trader sees every day forever because nothing could ever
  // retract it.
  const pulled: PullNotice[] = [
    ...pulledByHosts,
    ...transitions.map((transition) => ({
      kind: 'account_closed_today' as const,
      host: transition.host,
      accountId: transition.accountId,
      name: transition.name,
    })),
  ];

  // THE STOP ORDERS, AND ONLY FOR THE TRADES THAT STILL NEED THEM (REF-113
  // Stage 3). Two reads gate it and both matter: `tradesNeedingStopHistory` is
  // one select that drops everything already answered, and `readStopHistories`
  // returns only what is worth storing. A run with nothing new to ask about
  // makes ZERO upstream requests here, which is what lets three triggers share
  // a trading day without reading the same orders three times.
  //
  // It runs AFTER the pull and BEFORE the import, because the import is what
  // writes the three columns and it writes them in the same statement as the
  // facts. And it cannot throw: ./orders.ts swallows every READ and wraps the
  // DERIVATION, so a broker that refuses the order endpoints — or evidence the
  // derivation chokes on — costs this run its annotations and not its rows.
  // The derivation half of that was true by inspection for three stages and is
  // true by construction now; what sits on the other side of the bet is this
  // whole function, the journal rows of the trader's day included.
  //
  // A RUN WITH NOTHING TO ASK ABOUT NOW SAYS SO IN THE LOG rather than passing
  // in silence, which is the other half of the same lesson — see the zero-
  // candidate branch in `readStopHistories`.
  const stopHistories = readStops
    ? await readStopHistories({
        readers: {
          live: readerFor(api.hosts.live.url),
          demo: readerFor(api.hosts.demo.url),
        },
        trades: await tradesNeedingStopHistory({ client, userId, trades, env }),
      })
    : undefined;

  // `day` is used for its timestamp alone. The scalars are the rules' business
  // and no rule is being evaluated here; the rows are the point.
  const counts = await importBrokerTrades({
    client,
    userId,
    trades,
    isTradeSource,
    env,
    accountIds: identities,
    stopHistories,
  });

  // Deduplicated and sorted, so that two held groups on one contract — the
  // two-account case — produce one symbol, and so that the sentence a trader
  // reads is the same on two runs that saw the same thing. A null symbol
  // contributes to the count and not to the list; see {@link SyncResult}.
  const heldSymbols = [
    ...new Set(held.map((group) => group.symbol).filter((s): s is string => s !== null)),
  ].sort();

  return {
    counts,
    accounts,
    asOf: day.asOf,
    isTradeSource,
    importEnabled: enabled,
    heldSymbols,
    heldCount: held.length,
    // AFTER the account pass, deliberately: a trader's FIRST sync is also the
    // one that creates their `accounts` rows, and asking for a nickname before
    // those rows exist would label every notice with the broker's name on the
    // one run where the trader is most likely to be reading it.
    notices: await toWireNotices({ client, userId, enabled, notices: pulled }),
  };
}
