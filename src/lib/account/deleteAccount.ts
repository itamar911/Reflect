/**
 * Account deletion — the right to erasure the privacy policy promises (REF-67).
 *
 * SERVER ONLY. Uses the service role key, which bypasses RLS. Never import
 * this from a client component.
 *
 *
 * Why the order is what it is
 * ---------------------------
 * Deleting the auth user first would be the shortest path and the wrong one:
 * the user id is the only key that finds anything else. Storage objects live
 * under a `${userId}/` prefix and have no foreign key to auth.users at all, so
 * once the auth row is gone they are unreachable orphans in a PUBLIC bucket —
 * still served to anyone holding the URL, with no way left to enumerate them.
 * So: storage, then the broker tokens, then the profile row, then the auth row.
 *
 * The profile row is deleted explicitly even though profiles_id_fkey is
 * ON DELETE CASCADE (confirmed against pg_constraint). profiles(id) is the hinge
 * of the whole graph — ten of the twelve user-keyed tables reference it rather
 * than auth.users — so with that one constraint intact everything falls, and
 * without it nothing does. Deleting the row directly makes the outcome depend on
 * the ten constraints below it instead of on one above it, and this project
 * edits schema by hand in the SQL editor with no trace in the repo, which is how
 * the migration files came to disagree with production in the first place.
 *
 * It stays in the verification list regardless: deleting a row is not proof it
 * is gone.
 *
 *
 * Why it verifies instead of trusting CASCADE
 * -------------------------------------------
 * The constraints are correct today: every user-keyed table was confirmed
 * ON DELETE CASCADE against pg_constraint (see ./userData.ts). Verification is
 * not doubt about that reading — it is that nothing in this repo can notice it
 * changing. The migration files already disagree with production on precisely
 * these constraints (REF-68), and three of the tables have no migration file at
 * all, so a constraint dropped or recreated by hand in the SQL editor would
 * leave no trace here and no failing test anywhere.
 *
 * A deletion that silently leaves rows behind is worse than one that fails,
 * because the user is told their data is gone. So every table in USER_TABLES is
 * queried for survivors afterwards, and any survivor — or any table whose
 * survivors cannot be counted — fails the whole operation loudly.
 *
 *
 * On logging
 * ----------
 * The event is logged; the data never is. Table names, row counts and object
 * counts are recorded so a failed deletion can be diagnosed from Vercel's logs
 * without the logs themselves becoming a copy of what was supposed to be
 * erased. Nothing here logs a journal entry, a trade, an email address or a
 * storage object name.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient } from '@/lib/supabase/admin';
import { disconnectUser } from '@/lib/tradovate/connections';

import { USER_STORAGE_BUCKET, USER_TABLES } from './userData';

/** What a completed deletion removed. Safe to log and to return to the client. */
export interface DeletionReport {
  userId: string;
  startedAt: string;
  finishedAt: string;
  storageObjectsDeleted: number;
  tradovateConnectionDeleted: boolean;
  /** False when the user had no profile row to begin with — not a failure. */
  profileRowDeleted: boolean;
  authUserDeleted: boolean;
  /** Tables confirmed empty of this user's rows. */
  tablesVerified: string[];
  /** Tables that do not exist in this database — no data possible. */
  tablesAbsent: string[];
}

/** A deletion that did not fully complete. `report` is partial by definition. */
export class AccountDeletionError extends Error {
  readonly stage: 'storage' | 'tradovate' | 'profile' | 'auth' | 'verify';
  readonly report: Partial<DeletionReport>;
  /** Tables still holding rows, or whose rows could not be counted. */
  readonly survivors: string[];

  constructor(
    stage: AccountDeletionError['stage'],
    message: string,
    report: Partial<DeletionReport>,
    survivors: string[] = []
  ) {
    super(message);
    this.name = 'AccountDeletionError';
    this.stage = stage;
    this.report = report;
    this.survivors = survivors;
  }
}

/** PostgREST codes meaning "no such table" — proof of absence, not a failure. */
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

/** Storage list page size, and the batch size for remove(). */
const STORAGE_PAGE = 100;

/**
 * Remove every object under the user's prefix. Returns how many were deleted.
 *
 * Enumerates rather than deriving paths from setups.image_url: deleting a setup
 * has never deleted its image, so existing accounts carry orphans that only a
 * prefix listing will find.
 */
async function deleteStorageObjects(userId: string, admin: SupabaseClient): Promise<number> {
  const bucket = admin.storage.from(USER_STORAGE_BUCKET);
  const paths: string[] = [];

  // Collect the full listing before removing anything: paginating with an
  // offset while deleting from under it would skip objects.
  for (let offset = 0; ; offset += STORAGE_PAGE) {
    const { data, error } = await bucket.list(userId, { limit: STORAGE_PAGE, offset });
    if (error) throw new Error(`storage list failed: ${error.message}`);
    if (!data || data.length === 0) break;
    paths.push(...data.map((o) => `${userId}/${o.name}`));
    if (data.length < STORAGE_PAGE) break;
  }

  for (let i = 0; i < paths.length; i += STORAGE_PAGE) {
    const { error } = await bucket.remove(paths.slice(i, i + STORAGE_PAGE));
    if (error) throw new Error(`storage remove failed: ${error.message}`);
  }

  // Confirm the prefix is actually empty. remove() reports per-object results
  // that a bulk call can swallow, so ask the bucket rather than believe it.
  const { data: left, error: recheckErr } = await bucket.list(userId, { limit: 1 });
  if (recheckErr) throw new Error(`storage recheck failed: ${recheckErr.message}`);
  if (left && left.length > 0) {
    throw new Error('objects still present under the user prefix after remove');
  }

  return paths.length;
}

/**
 * Count this user's surviving rows in every user-keyed table.
 *
 * Returns the tables that still hold rows OR could not be checked — both are
 * failures, because both mean the deletion cannot be reported as complete.
 * A table that does not exist is neither: it cannot hold data.
 */
async function findSurvivors(
  userId: string,
  admin: SupabaseClient
): Promise<{ survivors: string[]; verified: string[]; absent: string[] }> {
  const survivors: string[] = [];
  const verified: string[] = [];
  const absent: string[] = [];

  for (const { table, column } of USER_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select(column, { count: 'exact', head: true })
      .eq(column, userId);

    if (error) {
      if (MISSING_TABLE_CODES.has(error.code ?? '')) {
        absent.push(table);
        continue;
      }
      // Cannot prove the rows are gone — treat exactly like rows remaining.
      survivors.push(`${table} (count failed: ${error.code ?? 'unknown'})`);
      continue;
    }

    if ((count ?? 0) > 0) survivors.push(`${table} (${count} rows)`);
    else verified.push(table);
  }

  return { survivors, verified, absent };
}

/**
 * Delete a user and everything belonging to them. Immediate and irreversible.
 *
 * Throws AccountDeletionError if any stage fails or if any row survives. The
 * caller must not report success on a throw — a partial deletion is a state the
 * user needs to know about, not one to paper over.
 */
export async function deleteAccount(
  userId: string,
  admin: SupabaseClient = createAdminClient()
): Promise<DeletionReport> {
  const startedAt = new Date().toISOString();
  const partial: Partial<DeletionReport> = { userId, startedAt };

  // 1. Storage first — nothing else can find these objects afterwards.
  let storageObjectsDeleted: number;
  try {
    storageObjectsDeleted = await deleteStorageObjects(userId, admin);
  } catch (err) {
    throw new AccountDeletionError('storage', errorMessage(err), partial);
  }
  partial.storageObjectsDeleted = storageObjectsDeleted;

  // 2. Broker tokens. Declared ON DELETE CASCADE, deleted explicitly anyway:
  //    these are credentials, and disconnectUser also drops the decrypted token
  //    from this instance's in-memory cache, which no constraint would do.
  //
  //    Tradovate publishes no revocation endpoint, so "revoked" here means our
  //    copy is destroyed and renewal stops; the access token then lapses on its
  //    own at expires_at. Other warm lambda instances may hold a cached copy
  //    until their own TTL passes — bounded, and not reachable from here.
  let tradovateConnectionDeleted: boolean;
  try {
    ({ existed: tradovateConnectionDeleted } = await disconnectUser(userId, admin));
  } catch (err) {
    throw new AccountDeletionError('tradovate', errorMessage(err), partial);
  }
  partial.tradovateConnectionDeleted = tradovateConnectionDeleted;

  // 3. The profile row, which cascades the ten tables hanging off profiles(id).
  //    See the ordering note at the top: this is the step that stops the whole
  //    deletion from resting on a single constraint above it.
  //
  //    No row is not a failure. A profile is created by an auth trigger, and an
  //    account whose trigger failed still has an auth row and a right to be
  //    deleted — refusing here would strand exactly the users least able to
  //    clean up after a bug of ours.
  const { error: profileError, count: profileCount } = await admin
    .from('profiles')
    .delete({ count: 'exact' })
    .eq('id', userId);
  if (profileError) {
    throw new AccountDeletionError(
      'profile',
      `profile delete failed: ${profileError.message}`,
      partial
    );
  }
  partial.profileRowDeleted = (profileCount ?? 0) > 0;

  // 4. The auth user. By now only the auth row and its own auth-schema children
  //    should remain; step 5 checks whether anything else does.
  const { error: authError } = await admin.auth.admin.deleteUser(userId, false);
  if (authError) {
    throw new AccountDeletionError(
      'auth',
      // A foreign-key violation here means some table references auth.users
      // without CASCADE — i.e. the constraint set has drifted from what
      // ./userData.ts records. The message names the constraint; start there.
      `auth user delete failed: ${authError.message}`,
      partial
    );
  }
  partial.authUserDeleted = true;

  // 5. Verify. profiles is checked here too — deleting a row is not proof it
  //    is gone, and this is the only step that can say so.
  const { survivors, verified, absent } = await findSurvivors(userId, admin);
  if (survivors.length > 0) {
    throw new AccountDeletionError(
      'verify',
      `auth user deleted but data survives in: ${survivors.join(', ')}`,
      { ...partial, tablesVerified: verified, tablesAbsent: absent },
      survivors
    );
  }

  return {
    userId,
    startedAt,
    finishedAt: new Date().toISOString(),
    storageObjectsDeleted,
    tradovateConnectionDeleted,
    profileRowDeleted: partial.profileRowDeleted ?? false,
    authUserDeleted: true,
    tablesVerified: verified,
    tablesAbsent: absent,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
