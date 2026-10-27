/**
 * "That object is not in the database yet" — told apart from a real failure.
 *
 * PURE and dependency-free. Takes the error shape supabase-js RETURNS rather
 * than throws (`{ code }`), which is the thing worth remembering about this
 * client: a missing table is a value in `error`, not an exception, so nothing
 * notices it unless a caller asks.
 *
 *
 * WHY THIS MATTERS IN THIS REPO SPECIFICALLY
 * ------------------------------------------
 *
 * `supabase/migrations/` does not describe the live database and migrations
 * are run BY HAND by the owner (CLAUDE.md). So every feature that needs schema
 * has a window — possibly a long one — in which the code is deployed and the
 * objects do not exist. The house answer so far has been an ENV FLAG the owner
 * sets after running the file (`isImportEnabled()`, and `withHidden()` /
 * `withAccount()` built on it, which keep the column out of the statement
 * entirely). That is the right tool when the missing thing is a COLUMN on a
 * table that readers already query: naming it is a 42703 that takes the whole
 * page down, so the only safe move is not to ask.
 *
 * This is the other tool, for when the missing thing is the WHOLE FEATURE. A
 * new table has no existing reader to break, so the query can simply be made
 * and its failure read as "not deployed". That needs no flag for the owner to
 * remember to set, and no second source of truth about whether a migration has
 * run — the database answers directly.
 *
 * Shared rather than local because there are now two unrelated callers and the
 * codes must mean the same thing to both: `deleteAccount.ts`, which treats a
 * missing table as PROOF THE ROWS ARE GONE, and `lib/share/store.ts`, which
 * treats it as the absence of a feature. One definition, two readings.
 */

/** The error shape supabase-js returns. Structural: no supabase-js import. */
export interface MaybeCodedError {
  code?: string | null;
}

/**
 * "No such table."
 *
 * TWO CODES BECAUSE TWO LAYERS ANSWER. `42P01` is Postgres' own
 * `undefined_table`, which is what comes back when the statement reaches the
 * server. `PGRST205` is PostgREST refusing earlier, out of its own schema
 * cache — and that cache is the common case here, because PostgREST will not
 * route to a table it has never seen. A reader that handles only one of them
 * works until the cache is cold, or until it is warm.
 */
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set(['42P01', 'PGRST205']);

/**
 * "No such column."
 *
 * `42703` is Postgres' `undefined_column`; `PGRST204` is PostgREST's own
 * "column not found", raised from the schema cache on a write whose body names
 * a column the cache has no entry for. Same pair of layers as above.
 */
const MISSING_COLUMN_CODES: ReadonlySet<string> = new Set(['42703', 'PGRST204']);

/** Whether this error means the table does not exist. */
export function isMissingTable(error: MaybeCodedError | null | undefined): boolean {
  return MISSING_TABLE_CODES.has(error?.code ?? '');
}

/** Whether this error means the column does not exist. */
export function isMissingColumn(error: MaybeCodedError | null | undefined): boolean {
  return MISSING_COLUMN_CODES.has(error?.code ?? '');
}

/**
 * Whether this error means the schema a statement needed is not deployed —
 * either half.
 *
 * For the callers that cannot usefully distinguish the two, which is most of
 * them: a feature spanning a new table AND a new column on an old one is
 * equally absent either way, and branching on which object was missing would
 * be a distinction with no different behaviour behind it.
 */
export function isMissingSchema(error: MaybeCodedError | null | undefined): boolean {
  return isMissingTable(error) || isMissingColumn(error);
}
