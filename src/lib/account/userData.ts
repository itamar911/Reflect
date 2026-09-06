/**
 * Every place a user's data lives, in one list.
 *
 * This is the checklist the deletion verifier walks after the auth user is
 * gone (see ./deleteAccount.ts). It exists as data rather than as a hardcoded
 * sequence of queries because the point of the verification pass is to catch
 * the table nobody remembered — and a list that has to be edited when a table
 * is added is at least visible in review, which a scattered set of deletes is
 * not.
 *
 *
 * Where the delete rules below come from
 * --------------------------------------
 * pg_constraint in the live database, read 2026-09-06 — NOT from
 * supabase/migrations or supabase/schema.sql, which are stale and disagree with
 * production on exactly this point (REF-68):
 *
 *   - schema.sql declares weekly_summaries.user_id REFERENCES auth.users(id)
 *     with no ON DELETE clause. The live constraint is CASCADE.
 *   - setups, notebook_pages and rule_violations have no migration file at all.
 *     All three are CASCADE in the database.
 *
 * So the files cannot be used to reason about deletion behaviour, and neither
 * can this comment once it ages. Re-read pg_constraint before trusting it; the
 * query is in the REF-67 investigation notes.
 *
 * That staleness is also why deleteAccount.ts verifies rather than trusting the
 * cascade: the constraints are correct today, and nothing in the repo would
 * notice if one were dropped or recreated by hand tomorrow.
 *
 * If you add a user-keyed table, add it here in the same change.
 */
export interface UserTable {
  /** Table name in the public schema. */
  table: string;
  /** Column holding the auth user id. */
  column: string;
  /**
   * How the row is expected to disappear when auth.users is deleted.
   *   'cascade'    — ON DELETE CASCADE, confirmed against pg_constraint
   *   'explicit'   — deleted by hand before the auth user, not left to a
   *                  constraint (which does not mean it lacks one)
   */
  expectation: 'cascade' | 'explicit';
}

export const USER_TABLES: readonly UserTable[] = [
  // Keyed by `id`, not `user_id` — which is why it fell outside the column-name
  // filter of the audit that confirmed the twelve tables below, and why it was
  // the last constraint to be checked. profiles_id_fkey IS ON DELETE CASCADE.
  //
  // Deleted explicitly anyway. profiles(id) is the hinge of the graph: ten of
  // the tables below reference it rather than auth.users, so that one
  // constraint decides whether all ten cascades fire from a parent that is
  // actually deleted. Removing the row directly moves the outcome onto the ten
  // constraints below it instead of the single one above it — worth doing in a
  // project whose schema is edited by hand with no trace in the repo.
  { table: 'profiles',              column: 'id',      expectation: 'explicit' },

  // Deleted explicitly, ahead of the auth user, despite being CASCADE: these
  // are broker credentials, and the delete also drops the decrypted token from
  // the running instance's cache, which no constraint would do.
  { table: 'tradovate_connections', column: 'user_id', expectation: 'explicit' },

  { table: 'weekly_summaries',      column: 'user_id', expectation: 'cascade' },
  { table: 'preset_rules',          column: 'user_id', expectation: 'cascade' },
  { table: 'custom_rules',          column: 'user_id', expectation: 'cascade' },
  { table: 'trade_plans',           column: 'user_id', expectation: 'cascade' },
  { table: 'streaks',               column: 'user_id', expectation: 'cascade' },
  { table: 'ai_insights',           column: 'user_id', expectation: 'cascade' },
  { table: 'personal_strategies',   column: 'user_id', expectation: 'cascade' },
  { table: 'alert_settings',        column: 'user_id', expectation: 'cascade' },

  // No migration file exists for these three; the constraints were confirmed in
  // the database directly. They hold the most sensitive content in the app —
  // journal text, setup notes, rule-violation history — so a false "deleted"
  // here is the worst outcome this route can produce.
  { table: 'setups',                column: 'user_id', expectation: 'cascade' },
  { table: 'notebook_pages',        column: 'user_id', expectation: 'cascade' },
  { table: 'rule_violations',       column: 'user_id', expectation: 'cascade' },
];

/**
 * The only bucket holding per-user objects. Paths are
 * `${userId}/${Date.now()}-${filename}` (see SetupsClient), so the user id is
 * the first path segment and one user's objects are exactly one prefix.
 *
 * The bucket is public — image_url on `setups` is a getPublicUrl() result — so
 * an object left behind after deletion stays readable by anyone holding the
 * URL. Nothing else in the app ever removes from it: deleting a setup drops the
 * row and orphans the image. Deletion therefore enumerates the prefix rather
 * than deriving paths from setups.image_url, which would miss every orphan.
 */
export const USER_STORAGE_BUCKET = 'setup-images';
