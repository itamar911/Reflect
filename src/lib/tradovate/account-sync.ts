/**
 * A trader's broker accounts become rows, and stay rows after they close
 * (REF-110 Stages 1-2).
 *
 * SERVER ONLY. Driven from ./sync.ts, which is reached by POST
 * /api/tradovate/sync and by the nightly /api/cron/tradovate-import.
 *
 * This is the half of REF-110 nobody can see. It writes no UI, changes no
 * figure, and makes no upstream request: everything it records comes out of the
 * `/account/list` the day pull already made (`discoverHostAccounts` in
 * ./fills.ts returns `claimed` beside `accepted` for exactly this). What it
 * buys is history — a prop trader's accounts rotate, and an account is only
 * recorded FROM THE FIRST RUN ONWARDS, so every day this is not shipped is a
 * day of rotation nothing captured.
 *
 *
 * WHY IT IS NOT AN UPSERT, WHICH IS NOT A STYLE CHOICE
 * ----------------------------------------------------
 *
 * The same reason ./import.ts is not one, against a different index. 037's key
 * is `UNIQUE (user_id, broker, broker_account_id, broker_host) WHERE
 * broker_account_id IS NOT NULL` — PARTIAL, because manual portfolios all carry
 * NULL there. PostgREST's `upsert(..., { onConflict })` compiles to `ON
 * CONFLICT (cols) DO UPDATE`, and Postgres cannot INFER a partial index from a
 * bare column list; inference needs the statement to repeat the predicate,
 * which PostgREST has no way to express. An upsert here fails with "no unique
 * or exclusion constraint matching the ON CONFLICT specification".
 *
 * So this reads, inserts the new, updates the changed, and catches 23505 from
 * a concurrent insert as the update it should have been.
 *
 *
 * THE BOUNDARY: WHAT THE BROKER OWNS AND WHAT THE TRADER OWNS
 * -----------------------------------------------------------
 *
 * {@link BROKER_OWNED} is the whole of what a resync may restate. `nickname`
 * and `hidden` are the trader's and are NEVER NAMED by any statement in this
 * file — not on an insert, not on an update, not even to their defaults on a
 * row this file creates. That is E12's boundary, which ./import.ts enforces on
 * `trade_plans` through `EXECUTION_FACTS`, applied to a second table.
 *
 * `first_seen_at` is in neither set: written once, on the insert, and never
 * restated. `last_seen_at` is restated every time the account is seen, and
 * deliberately NOT moved when it goes missing — it is the answer to "when did
 * I last trade this firm", and overwriting it on the pull that notices the
 * account is gone would erase the one date the trader wants.
 *
 *
 * THE ABSENCE RULE, AND THE FAIL-SAFE INSIDE IT
 * ---------------------------------------------
 *
 *   seen on a host that answered   → 'archived' / 'closed' / 'active',
 *                                    last_seen_at = now
 *   NOT seen, host answered        → 'closed', last_seen_at unchanged
 *   NOT seen, host did not answer  → nothing at all
 *
 * THE THIRD LINE IS THE ONE THAT MATTERS. `loadBrokerDay`'s failure rule 1
 * drops a non-mint host whose discovery failed, silently and by design, so a
 * demo outage produces a pull with no demo accounts in it — indistinguishable,
 * from here, from a trader who closed all of them. Treating that as closure
 * would mark a trader's whole portfolio closed on the first bad morning.
 *
 * The asymmetry is `BrokerTrade.positionFlat`'s, restated: a stale `active` is
 * a cosmetic chip on a card, and a wrongly-`closed` account moves a trader's
 * portfolio out from under them. So the rule is scoped to hosts that returned
 * a list, and `BrokerDay.accounts` carries exactly those — a failed host has no
 * entry, and the absence IS the message.
 *
 *
 * LOGS
 * ----
 *
 * COUNTS ONLY, and this module is the reason that rule needed restating.
 * Everything else this integration stores is a number or an enum;
 * `display_name` is the first BROKER-SUPPLIED FREE TEXT in the product, and on
 * a prop trader's account it is a firm's name. `import-cron.ts` already states
 * the rule — "no user ids, no symbols, no prices, no fill ids, no account ids"
 * — and a name is worse than an id. So: `accountsSeen` and `accountsClosed`,
 * never a count broken down per account, which IS an account.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountIdentity } from './accounts';
import type { HostAccounts, KnownActiveAccount } from './fills';
import type { TradovateEnvironment } from './hosts';
import { isImportEnabled } from './import';
import { redactSecrets } from './redact';
import type { TradovateAccount } from './types';

/** Postgres unique-violation SQLSTATE. A concurrent insert of the same account. */
const UNIQUE_VIOLATION = '23505';

/**
 * How many unassigned broker rows one backfill pass reads to find identities.
 *
 * IT BOUNDS THE READ, NOT THE WRITE, and that distinction is what makes the
 * number uninteresting: the pass reads rows only to learn which
 * `(account, host)` pairs are unassigned, then issues ONE UPDATE PER PAIR that
 * reaches every matching row whether or not it was in the sample. A trader has
 * one to three accounts, so a thousand rows find every pair many times over;
 * if one somehow did not, the next sync's pass finds it.
 */
const BACKFILL_SCAN_LIMIT = 1000;

/** What `accounts.status` may hold. Mirrors 037's CHECK. */
export type AccountStatus = 'active' | 'closed' | 'archived';

/**
 * The columns a resync may restate, and the only ones it ever writes.
 *
 * ADDING A COLUMN HERE HANDS IT TO THE BROKER FOREVER — every sync will
 * overwrite whatever the trader put in it. `nickname` and `hidden` are
 * deliberately absent and the suite asserts that a trader-set `nickname`
 * survives a resync, which is the regression that catches an accidental
 * addition. Same policy, same shape, as `EXECUTION_FACTS` in ./import.ts.
 */
const BROKER_OWNED = ['display_name', 'status', 'last_seen_at'] as const;

/** {@link BROKER_OWNED}, for the regression suite. See EXECUTION_FACTS_FOR_TEST. */
export const BROKER_OWNED_FOR_TEST: readonly string[] = BROKER_OWNED;

/** Everything the comparison needs, plus the id to update by. */
const STORED_COLUMNS = [
  'id',
  'broker_account_id',
  'broker_host',
  ...BROKER_OWNED,
].join(', ');

/** What one account sync did. Counts only — see the header. */
export interface AccountSyncCounts {
  /** False means the flag is off; no column 037 adds was named. */
  ran: boolean;
  /** Claimed accounts seen across every host that answered. */
  accountsSeen: number;
  /** Rows created. */
  inserted: number;
  /** Rows whose broker-owned columns had moved and were restated. */
  updated: number;
  /** Rows already correct. Nothing was written for these. */
  unchanged: number;
  /** Rows an answered host stopped listing, moved to 'closed'. */
  accountsClosed: number;
  /** Existing trades the backfill pointed at an account. */
  backfilled: number;
  /** Statements the database refused. Nothing is concluded; the next run retries. */
  failed: number;
}

const NOTHING: AccountSyncCounts = Object.freeze({
  ran: false,
  accountsSeen: 0,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  accountsClosed: 0,
  backfilled: 0,
  failed: 0,
});

/**
 * The sync's two answers: what it did, and how to reach what it wrote.
 *
 * `identities` is the map Stage 2 joins on — `${host}:${brokerAccountId}` to
 * `accounts.id` — built from the rows this pass has just read or written, so
 * the import that follows needs no read of its own.
 */
export interface AccountSyncResult {
  counts: AccountSyncCounts;
  /** Empty when the flag is off, which is what makes the import's column optional. */
  identities: Map<string, string>;
  /**
   * The accounts that stopped being open DURING this run (REF-124).
   *
   * Empty on every ordinary sync, which is what makes it free to carry, and
   * what makes a non-empty one worth a sentence. See {@link AccountTransition}.
   */
  transitions: AccountTransition[];
}

/**
 * One account that was open to us when this run started and is not now
 * (REF-124).
 *
 * THIS IS THE ONLY PLACE A TRANSITION CAN BE SEEN. The day pull compares a
 * host's answer against our table and can tell that an account is missing, but
 * only this module knows whether the row was ALREADY closed on an earlier run
 * — and "the account closed today" and "the account has been closed for a
 * fortnight" are the same `/account/list` absence. The difference is a status
 * column, which is here.
 *
 * ONCE PER ACCOUNT, EVER, AND NOT BY A DEDUPE. Both branches that produce one
 * fire only on a row whose stored status is `'active'`, and both write a
 * different status in the same statement. So the second run cannot produce it
 * again — not because something remembered, but because the condition is
 * destroyed by the act of reporting it. That is why this needs no notices
 * table, no `dismissed_at`, and no migration.
 *
 * CARRIES THE BROKER'S OWN `display_name` AS `name`, never an id. ./sync.ts
 * resolves it to the trader's nickname where there is one, by the same path and
 * the same rule as every other account-bearing notice; the wire type has no
 * field an id could travel in.
 */
export interface AccountTransition {
  host: TradovateEnvironment;
  accountId: number;
  /** The broker's label, as the fallback. `''` when the row never held one. */
  name: string;
  /** What it moved to. Both are "the trader cannot trade this any more". */
  to: Exclude<AccountStatus, 'active'>;
}

/**
 * A fresh "did not run" answer.
 *
 * A function and not a shared constant, because `identities` is a Map and a
 * Map cannot be frozen: a module-level one handed to two callers is one
 * caller's mutation showing up in the other's. `NOTHING` beside it IS frozen
 * and can safely be shared.
 */
function didNotRun(): AccountSyncResult {
  return { counts: NOTHING, identities: new Map(), transitions: [] };
}

/**
 * Whether the broker says this account is archived.
 *
 * THE ONE UNDECLARED FIELD THIS STAGE READS, and it is read in the one way
 * ./types.ts permits: defensively, off a body, without widening
 * {@link TradovateAccount}. That type's header is explicit — "the docs are the
 * only authority — do not widen these types from guesswork" — and `archived` is
 * recalled from the public Account entity rather than found in this repo or in
 * the documentation we have.
 *
 * So it is treated as evidence and never as a requirement. The status rule
 * works whether or not the field exists: absent, this returns false and the
 * declared flags decide between 'active' and 'closed'; present and literally
 * `true`, the trader gets the more precise word for what happened. Nothing
 * reads it as false, nothing requires it, and no other code can reach it.
 *
 * `docs/tradovate-measurements.md` §2 is where the answer would be: it is the
 * section that dumps a verbatim `/account/list` row, and the question is still
 * `[PENDING]` there. IT NO LONGER SETTLES ITSELF FOR FREE — the spike that
 * would have filled it in was deleted on 21.10 (REF-107 small fixes), so
 * answering this now costs a deliberate read against a live account rather than
 * the next run of something that was going to run anyway. The decision it feeds
 * is unchanged: if the field turns out not to exist, delete this function and
 * the 'archived' branch; if it exists with different semantics, this is the one
 * place to change.
 */
function saysArchived(account: TradovateAccount): boolean {
  return (account as { archived?: unknown }).archived === true;
}

/**
 * The status this account should carry, from §A.5's first branch.
 *
 * `tradeable` is the five STATE flags — closed, restricted, readonly,
 * futuresDisabled, inactive — already reduced by `claimedAccounts`. It is
 * deliberately not re-derived here: a second copy of that test is a second
 * definition, and the one in ./accounts.ts is the one the day pull uses.
 *
 * 'closed' COVERS MORE THAN `closed`, and that is intended. A restricted or
 * read-only account is one the trader can no longer trade, which is what the
 * word means to them; the four flags are not four statuses a screen could do
 * anything useful with, and a chip reading "מוגבל" beside one reading "סגור"
 * would be a distinction without a difference on a breached evaluation.
 */
function statusFor(account: TradovateAccount, tradeable: boolean): AccountStatus {
  if (saysArchived(account)) return 'archived';
  return tradeable ? 'active' : 'closed';
}

/** A stored row, as the select brings it back. */
type StoredAccount = Record<string, unknown>;

/** Whether a stored value already says what the broker is saying. */
function alreadyStated(column: string, stored: unknown, wanted: string): boolean {
  if (stored === null || stored === undefined) return false;
  // `last_seen_at` is the only instant in BROKER_OWNED, and PostgREST returns a
  // TIMESTAMPTZ as `+00:00` where we send `Z`. Comparing the wire forms would
  // report every row as changed on every pull — idempotence lost to a
  // formatting difference, which is the trap ./import.ts' `kind: 'instant'`
  // exists for.
  if (column === 'last_seen_at') {
    const a = Date.parse(String(stored));
    const b = Date.parse(wanted);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return String(stored) === wanted;
}

/** The broker-owned subset this row does not already state. Empty means no write. */
function changedColumns(
  stored: StoredAccount,
  wanted: Record<string, string>
): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const column of BROKER_OWNED) {
    if (!alreadyStated(column, stored[column], wanted[column])) changes[column] = wanted[column];
  }
  return changes;
}

export interface AccountSyncRequest {
  /**
   * Where the rows go, and therefore whose RLS applies.
   *
   * The user's own session client on the sync route; the service-role client in
   * the cron, where there is no session. The same three properties that stand
   * in for RLS in ./import.ts hold here: `userId` is a parameter and never read
   * from a request, EVERY statement below filters or sets it, and an empty one
   * throws before any statement runs.
   */
  client: SupabaseClient;
  /** Whose accounts these are. From the session or the connection row. */
  userId: string;
  /**
   * One entry per host that ANSWERED discovery, from `BrokerDay.accounts`.
   *
   * A host that failed is ABSENT, and that absence is what scopes the closure
   * rule. Passing a fabricated full list here would re-introduce exactly the
   * bug the header describes.
   */
  hosts: readonly HostAccounts[];
  /** Test seam for the flag. Production reads process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Now, ms since epoch. Test seam; production reads the clock.
   *
   * One clock for `first_seen_at` and `last_seen_at`, so a row cannot be first
   * seen after it was last seen.
   */
  nowMs?: number;
}

/**
 * The accounts this trader's table holds as OPEN, for the day pull (REF-124).
 *
 * WHY THE PULL NEEDS THIS AT ALL. `/account/list` answers "what does the broker
 * offer right now", and the day pull built its whole account filter out of that
 * one answer. But a prop firm closes an evaluation account the moment it is
 * passed or breached, and the trade that passed it is in the same trading day.
 * From the next pull's point of view that account never existed, so its
 * position is filtered out, its fill pairs go with it, and the trade is lost at
 * the nightly reset. The missing fact is not upstream — it is here, in the row
 * this integration wrote the last time the account WAS listed.
 *
 * `status = 'active'` IS THE WHOLE PREDICATE, AND IT IS ALSO THE EXPIRY. The
 * same run that pulls a carried account's fills marks its row `'closed'`
 * ({@link syncBrokerAccounts}), so the next run does not see it here and does
 * not carry it. That is what makes the carry-forward last exactly one run with
 * no new column, no timestamp comparison and no migration — the window is a
 * consequence of the write that was already happening.
 *
 * NEVER THROWS, AND ANSWERS `[]` FOR EVERY DOUBT. A failure here must cost the
 * pull nothing: an empty answer is byte-for-byte the behaviour every caller had
 * before REF-124, while a thrown error would turn a cosmetic read into a dead
 * day pull. The flag gate is ./import.ts' — the `accounts` table is 037's and a
 * deployment may not have run it — and a refused read is swallowed for the same
 * reason. Both are the SAFE direction here, because the day's figures cannot be
 * made worse by this returning nothing; they are merely not improved.
 *
 * THE ROW SHAPE IS READ DEFENSIVELY, for `identityOf`'s reason: PostgREST
 * returns a BIGINT as a string often enough that assuming `number` is how a
 * join silently never matches. `broker_host` is checked against the two values
 * 037's CHECK permits rather than cast, so a row that somehow holds anything
 * else is skipped instead of carried onto a host it does not name.
 *
 * COUNTS NOTHING AND LOGS NOTHING. The pull logs the carried count; see the
 * log-line rule in this module's header for why not here.
 */
export async function readActiveAccounts(params: {
  client: SupabaseClient;
  userId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<KnownActiveAccount[]> {
  const { client, userId, env = process.env } = params;

  if (typeof userId !== 'string' || userId.length === 0) return [];
  if (!isImportEnabled(env)) return [];

  const { data, error } = await client
    .from('accounts')
    .select('broker_account_id, broker_host')
    .eq('user_id', userId)
    .eq('broker', 'tradovate')
    .eq('status', 'active');

  if (error) return [];

  const known: KnownActiveAccount[] = [];
  for (const row of (data ?? []) as unknown as StoredAccount[]) {
    const host = row.broker_host;
    if (host !== 'live' && host !== 'demo') continue;
    const accountId = Number(row.broker_account_id);
    if (row.broker_account_id === null || !Number.isFinite(accountId)) continue;
    known.push({ host, accountId });
  }
  return known;
}

/**
 * Record this trader's accounts, and close the ones that stopped being listed.
 *
 * Never throws for a reason the caller can do nothing about: a refused
 * statement is counted as `failed` and the run continues, because one bad
 * account must not cost the others — or the import that follows. It DOES throw
 * on a bad `userId`, which is a programming error and the one thing that must
 * not be tolerated here.
 */
export async function syncBrokerAccounts(
  request: AccountSyncRequest
): Promise<AccountSyncResult> {
  const { client, userId, hosts, env = process.env, nowMs = Date.now() } = request;

  // Before anything else, and for ./import.ts' reason: a falsy or non-string
  // user id reaching the cron's service-role client is the one bug in this
  // module that could write into somebody else's account list.
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('syncBrokerAccounts: userId must be a non-empty string.');
  }

  // Not a select, not an insert, nothing. `accounts` is a table 037 creates and
  // the deployment may not have run it yet — the same gate, and the same
  // reason, as every line of ./import.ts.
  if (!isImportEnabled(env)) return didNotRun();

  const counts: AccountSyncCounts = { ...NOTHING, ran: true };
  const refusals: string[] = [];
  const seenAt = new Date(nowMs).toISOString();
  /** Rows that left `'active'` in this run. See {@link AccountTransition}. */
  const transitions: AccountTransition[] = [];

  // One read for every Tradovate account this trader has, including the ones
  // no host listed today — those are what the closure rule is about, so the
  // read cannot be narrowed to what the pull saw.
  const { data: storedRows, error: readError } = await client
    .from('accounts')
    .select(STORED_COLUMNS)
    .eq('user_id', userId)
    .eq('broker', 'tradovate');

  if (readError) {
    // Nothing is known about what is already there, so nothing may be written:
    // inserting blind would duplicate every row the read failed to see, and
    // closing blind would close accounts that are merely invisible to us. The
    // same rule as everywhere in this integration — a failure to ask is not an
    // answer.
    counts.failed = 1;
    report(counts, [`read:${readError.code ?? 'none'}`]);
    // No transitions either, and for the same reason as the empty identities: a
    // failure to ask is not an answer, so nothing here may claim an account
    // closed today.
    return { counts, identities: new Map(), transitions: [] };
  }

  const stored = new Map<string, StoredAccount>();
  // Through `unknown`: STORED_COLUMNS is assembled from BROKER_OWNED at
  // runtime, and supabase-js infers a row shape by parsing the select string at
  // the TYPE level. Writing the list twice is how a column silently stops being
  // compared.
  for (const row of (storedRows ?? []) as unknown as StoredAccount[]) {
    const key = identityOf(row);
    if (key !== null) stored.set(key, row);
  }

  const identities = new Map<string, string>();
  for (const [key, row] of stored) {
    if (typeof row.id === 'string') identities.set(key, row.id);
  }

  // Which identities this pull SAW, and on which hosts it was able to look.
  // Both are needed and they answer different questions: the first decides
  // insert-or-update, the second decides whether an absence means anything.
  const seen = new Set<string>();
  const answered = new Set<string>();

  // Sequential throughout. A trader has one to three accounts, none of the
  // three call sites has a deadline, and a parallel write would multiply the
  // unique-violation race below for nothing.
  for (const host of hosts) {
    answered.add(host.host);

    for (const { account, tradeable } of host.claimed) {
      const key = accountIdentity(host.host, account.id);
      // A host listing the same account twice is not a thing Tradovate does,
      // and counting it twice would make `accountsSeen` disagree with the rows.
      if (seen.has(key)) continue;
      seen.add(key);
      counts.accountsSeen += 1;

      const status = statusFor(account, tradeable);
      const wanted: Record<string, string> = {
        display_name: account.name,
        status,
        last_seen_at: seenAt,
      };

      const existing = stored.get(key);
      if (existing) {
        // THE STILL-LISTED HALF OF REF-124's TRANSITION. A firm can retire an
        // evaluation account without removing it: flag it `closed`, flag it
        // `restricted`, make it read-only. The absence branch below never sees
        // that account — the host listed it, so it is `seen` — and before
        // REF-124 the status moved to 'closed' with nothing said about it.
        //
        // Read BEFORE the restate, because the restate is what destroys the
        // evidence. `'active'` and not `!== status` is the test: a row moving
        // 'archived' → 'closed' is a broker refining what it already said, not
        // an account closing today.
        if (existing.status === 'active' && status !== 'active') {
          transitions.push({ host: host.host, accountId: account.id, name: account.name, to: status });
        }
        await restate(client, userId, existing, wanted, counts, refusals);
        continue;
      }

      const id = await insertAccount(client, userId, host.host, account.id, wanted, seenAt, counts, refusals);
      if (id !== null) identities.set(key, id);
    }
  }

  // THE ABSENCE BRANCH, scoped to hosts that answered. See the header for why
  // that scope is the whole safety of this function.
  for (const [key, row] of stored) {
    if (seen.has(key)) continue;
    if (typeof row.broker_host !== 'string' || !answered.has(row.broker_host)) continue;
    // Already closed: nothing to say, and saying it again would be a write per
    // sync for every account the trader has ever closed.
    if (row.status === 'closed') continue;

    // `status` ALONE. `last_seen_at` is not touched — see the header; this is
    // the pull that NOTICED the account is gone, not the last one that saw it.
    const { error } = await client
      .from('accounts')
      .update({ status: 'closed' })
      .eq('id', String(row.id))
      .eq('user_id', userId);

    if (error) {
      counts.failed += 1;
      refusals.push(`close:${error.code ?? 'none'}`);
      continue;
    }
    counts.accountsClosed += 1;

    // REF-124: AFTER THE WRITE SUCCEEDED, AND ONLY FROM 'active'.
    //
    // After, because a notice promising the trader their account closed today
    // while the row still says `active` would repeat on every sync until the
    // write finally landed — the once-per-account guarantee is the status
    // column, so it is only earned once the column moved.
    //
    // From 'active' only, so that an 'archived' row going 'closed' is silent:
    // that is a broker refining a status it already gave us, and the trader was
    // told when the account left 'active'.
    if (row.status === 'active') {
      const accountId = Number(row.broker_account_id);
      const host = row.broker_host;
      if (Number.isFinite(accountId) && (host === 'live' || host === 'demo')) {
        transitions.push({
          host,
          accountId,
          name: typeof row.display_name === 'string' ? row.display_name : '',
          to: 'closed',
        });
      }
    }
  }

  // Stage 2's half: point the rows that already carry the ids at the accounts
  // those ids now have. Last, so it sees everything this pass created.
  counts.backfilled = await backfillTradeAccounts({
    client,
    userId,
    identities,
    counts,
    refusals,
  });

  report(counts, refusals);
  return { counts, identities, transitions };
}

/** `${host}:${id}` for a stored row, or null when the row cannot be keyed. */
function identityOf(row: StoredAccount): string | null {
  const host = row.broker_host;
  const id = row.broker_account_id;
  if (typeof host !== 'string' || host.length === 0) return null;
  // PostgREST returns a BIGINT as a STRING often enough that assuming `number`
  // is how a join silently never matches. Number() covers both.
  const numeric = Number(id);
  if (id === null || id === undefined || !Number.isFinite(numeric)) return null;
  return accountIdentity(host, numeric);
}

/** Restate the broker-owned columns on a row we have read. Zero writes when correct. */
async function restate(
  client: SupabaseClient,
  userId: string,
  existing: StoredAccount,
  wanted: Record<string, string>,
  counts: AccountSyncCounts,
  refusals: string[]
): Promise<void> {
  const changes = changedColumns(existing, wanted);

  // THE WHOLE OF IDEMPOTENCE, IN ONE BRANCH — and it is worth being precise
  // about what it promises, because `last_seen_at` moves on every real pull.
  // What this guarantees is that NO BROKER FACT IS RESTATED NEEDLESSLY: a
  // re-run against the same clock sends nothing at all, which is what the
  // suite asserts, and a re-run an hour later sends one timestamp and not a
  // name or a status. The thing a wrong comparison would cost — every row
  // rewritten every pull because `+00:00` is not `Z` — is what this catches.
  if (Object.keys(changes).length === 0) {
    counts.unchanged += 1;
    return;
  }

  // Both predicates, not just the id. The id came from a read filtered by
  // user, so this is belt and braces — and it is the statement that would be
  // wrong if the id ever came from somewhere else.
  const { error } = await client
    .from('accounts')
    .update(changes)
    .eq('id', String(existing.id))
    .eq('user_id', userId);

  if (error) {
    counts.failed += 1;
    refusals.push(`update:${error.code ?? 'none'}`);
    return;
  }
  counts.updated += 1;
}

/**
 * Create a row for an account this trader has not had one for.
 *
 * Returns the new row's id, or null when nothing was written.
 *
 * `nickname` and `hidden` ARE NOT NAMED, not even as their defaults. 037 gives
 * them a NULL and a false; naming them here would make this the statement that
 * owns them, which is precisely what the trader/broker boundary says it must
 * not be. `first_seen_at` is named once, here, and never again.
 */
async function insertAccount(
  client: SupabaseClient,
  userId: string,
  host: TradovateEnvironment,
  brokerAccountId: number,
  wanted: Record<string, string>,
  seenAt: string,
  counts: AccountSyncCounts,
  refusals: string[]
): Promise<string | null> {
  const { data, error } = await client
    .from('accounts')
    .insert({
      user_id: userId,
      broker: 'tradovate',
      broker_account_id: brokerAccountId,
      broker_host: host,
      first_seen_at: seenAt,
      ...wanted,
    })
    .select('id')
    .maybeSingle();

  if (!error) {
    counts.inserted += 1;
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? id : null;
  }

  // Somebody inserted this account between the read and now — the sync route
  // and the cron can overlap. The index did its job; the row exists, so this
  // becomes the update it would have been had the read seen it. Re-read rather
  // than trust a row we never saw, which is also how we learn its id.
  if (error.code === UNIQUE_VIOLATION) {
    return await restateByIdentity(client, userId, host, brokerAccountId, wanted, counts, refusals);
  }

  counts.failed += 1;
  // The CODE, never the message: a PostgREST message can echo the row back, and
  // this row carries an account name.
  refusals.push(`insert:${error.code ?? 'none'}`);
  return null;
}

/** Re-read one identity and restate it. The concurrent-insert path only. */
async function restateByIdentity(
  client: SupabaseClient,
  userId: string,
  host: TradovateEnvironment,
  brokerAccountId: number,
  wanted: Record<string, string>,
  counts: AccountSyncCounts,
  refusals: string[]
): Promise<string | null> {
  const { data, error } = await client
    .from('accounts')
    .select(STORED_COLUMNS)
    .eq('user_id', userId)
    .eq('broker', 'tradovate')
    .eq('broker_account_id', brokerAccountId)
    .eq('broker_host', host)
    .maybeSingle();

  if (error || !data) {
    counts.failed += 1;
    refusals.push(`conflict:${error?.code ?? 'norow'}`);
    return null;
  }

  const existing = data as unknown as StoredAccount;
  await restate(client, userId, existing, wanted, counts, refusals);
  return typeof existing.id === 'string' ? existing.id : null;
}

/**
 * Point already-imported trades at the accounts they name (REF-110 Stage 2).
 *
 * THE MIGRATION COULD NOT DO THIS, which is why it is a code pass: mapping
 * `(broker_account_id, broker_host) → accounts.id` needs `accounts` rows, and
 * those need a sync to have run. 037 is therefore safe to run before any code
 * ships, and this is what closes the gap afterwards.
 *
 * IT RUNS ON EVERY SYNC AND COSTS ONE SELECT IN THE STEADY STATE. The read asks
 * "is there an imported row with no account yet"; once every row has one the
 * answer is empty and not a single UPDATE is sent. That is what makes a pass
 * that is logically a one-off safe to leave in the loop forever — and it has to
 * stay, because `/api/tradovate/today` imports rows without the identity map
 * (it does not run this module) and a trader who never presses Sync would
 * otherwise accumulate unassigned rows between cron runs.
 *
 * ONE UPDATE PER IDENTITY, NOT PER ROW. A trader with four hundred unassigned
 * trades across two accounts sends two statements.
 *
 * `.is('account_id', null)` IS REPEATED ON THE UPDATE, and it is not redundant
 * with the select: between the two statements the import may have assigned a
 * row, and an unqualified update would restate an assignment this pass has no
 * business having an opinion about. It also makes the pass safe to run twice.
 */
async function backfillTradeAccounts(params: {
  client: SupabaseClient;
  userId: string;
  identities: ReadonlyMap<string, string>;
  counts: AccountSyncCounts;
  refusals: string[];
}): Promise<number> {
  const { client, userId, identities, counts, refusals } = params;
  if (identities.size === 0) return 0;

  const { data, error } = await client
    .from('trade_plans')
    .select('broker_account_id, broker_host')
    .eq('user_id', userId)
    .is('account_id', null)
    .not('broker_account_id', 'is', null)
    .limit(BACKFILL_SCAN_LIMIT);

  if (error) {
    counts.failed += 1;
    refusals.push(`backfill:${error.code ?? 'none'}`);
    return 0;
  }

  // The rows are read for their IDENTITIES and nothing else, which is why the
  // scan limit does not bound what gets fixed — see BACKFILL_SCAN_LIMIT.
  const pending = new Set<string>();
  for (const row of (data ?? []) as unknown as StoredAccount[]) {
    const key = identityOf(row);
    if (key !== null && identities.has(key)) pending.add(key);
  }

  let assigned = 0;
  for (const key of pending) {
    const accountId = identities.get(key)!;
    const separator = key.lastIndexOf(':');
    const host = key.slice(0, separator);
    const brokerAccountId = Number(key.slice(separator + 1));

    const { error: writeError } = await client
      .from('trade_plans')
      .update({ account_id: accountId })
      .eq('user_id', userId)
      .eq('broker_account_id', brokerAccountId)
      .eq('broker_host', host)
      .is('account_id', null);

    if (writeError) {
      counts.failed += 1;
      refusals.push(`backfill:${writeError.code ?? 'none'}`);
      continue;
    }
    assigned += 1;
  }

  return assigned;
}

/**
 * One line per run, counts only, through redactSecrets. See the header.
 *
 * `backfilled` counts IDENTITIES assigned, not rows: PostgREST does not report
 * an affected-row count without asking for the rows back, and asking for them
 * back would pull a trader's trades through this function for a log line.
 */
function report(counts: AccountSyncCounts, refusals: readonly string[]): void {
  const line =
    `[tradovate][accounts] accountsSeen=${counts.accountsSeen} ` +
    `inserted=${counts.inserted} updated=${counts.updated} unchanged=${counts.unchanged} ` +
    `accountsClosed=${counts.accountsClosed} backfilled=${counts.backfilled} ` +
    `failed=${counts.failed}` +
    (refusals.length > 0 ? ` refusals=${[...new Set(refusals)].join(',')}` : '');

  if (counts.failed > 0) console.warn(redactSecrets(line));
  else console.info(redactSecrets(line));
}
