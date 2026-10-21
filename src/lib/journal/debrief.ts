/**
 * The stored half of the AI debrief (REF-107 Stage 3a, §G step 6).
 *
 * PURE. No fetch, no Supabase client, no React, no env — a type, a defensive
 * reader and one predicate, so the regression suite can drive every state
 * without a browser or a database. The route
 * (src/app/api/ai-debrief/route.ts) owns the writing; this owns the shape.
 *
 *
 * WHY ONLY FOUR FIELDS ARE STORED
 * -------------------------------
 *
 * The debrief response carries nine things, and five of them are DERIVED:
 * `score`, `breakdown` and `correctedFlags` come from `computeTradeScore`,
 * which is deterministic arithmetic over columns that are already on the row;
 * `documented` and `outcome` are two lines of the same. Only the four text
 * fields cost a model call, and only they cannot be recomputed.
 *
 * So the four are stored and the five are recomputed on every request. That
 * is not a saving of bytes — it is what makes a later fix to the scoring
 * formula apply to debriefs that were written before it. A stored `score`
 * would freeze a number the product has since decided was wrong, next to
 * prose that still reads as current.
 *
 * `plan_score` stays written to its own column as it always has been. That
 * column predates this change, the stats read it, and it exists on every
 * database whether or not migration 036 has been run.
 */

import { linkState, type LinkableRow } from './link';

/** The four strings the model produces. Every one optional — see the reader. */
export interface StoredDebrief {
  summary?: string;
  worked?: string;
  improve?: string;
  lesson?: string;
}

/** The field names, in the order the UI renders them. */
const DEBRIEF_FIELDS = ['summary', 'worked', 'improve', 'lesson'] as const;

/**
 * Read a stored debrief out of a `debrief_ai` column value, trusting nothing.
 *
 * Returns null when there is nothing usable, which the caller must treat as
 * "no debrief" rather than "an empty debrief". The distinction matters: the
 * route serves a stored answer instead of calling the model, so a half-read
 * blob must not be able to stand in for a real one and silently show the
 * trader four empty paragraphs they cannot refresh.
 *
 * DEFENSIVE FOR A REASON THAT IS NOT PARANOIA. `debrief_ai` is JSONB with no
 * CHECK — Postgres cannot usefully constrain a free-form object — and it is
 * writable by its owner from the browser under the table's own RLS policy.
 * The same rule lib/tradovate/sync-response.ts applies to the sync route's
 * body applies here: anything unrecognised degrades to "nothing".
 *
 * A non-string field is DROPPED rather than failing the whole read, because
 * three good paragraphs are worth more to a trader than none. A blob with no
 * usable field at all is null.
 */
export function readStoredDebrief(value: unknown): StoredDebrief | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const stored: StoredDebrief = {};
  for (const field of DEBRIEF_FIELDS) {
    const text = raw[field];
    // Whitespace-only counts as absent: it renders as an empty block and
    // tells the trader nothing, so it should not keep the model from running.
    if (typeof text === 'string' && text.trim() !== '') stored[field] = text;
  }

  return Object.keys(stored).length > 0 ? stored : null;
}

/**
 * Whether this row already has a debrief worth serving instead of calling the
 * model.
 *
 * BOTH HALVES ARE REQUIRED, and that is the dedupe rule. The timestamp alone
 * would serve an empty answer for a run that reached the database with a body
 * the model never filled in; the blob alone would serve one written by a
 * version of this code that did not stamp it. Requiring both means the only
 * way to skip the model is a complete, deliberate, recorded debrief.
 */
export function hasStoredDebrief(row: {
  debrief_ai?: unknown;
  debrief_generated_at?: unknown;
}): boolean {
  const stamped =
    typeof row.debrief_generated_at === 'string' && row.debrief_generated_at !== '';
  return stamped && readStoredDebrief(row.debrief_ai) !== null;
}

// ── Who asks for a debrief, and when (REF-107 follow-up) ────────────────────
//
// TWO PURE FUNCTIONS FOR ONE PROPERTY: **a link costs exactly one model call.**
// It used to cost two, same trade id, both reaching the model, and no guard in
// the route could catch it — the dedupe gate reads `hasStoredDebrief` off the
// row as it was at the top of the request, and the first call had not stored
// anything yet. The duplicate cost ~$0.010 a link.
//
// They live here rather than inside JournalClient because the sequence they
// describe spans a REMOUNT, which no assertion can drive without a browser:
// the handler runs on one component instance, the sweep runs on the next one.
// As two pure functions the suite can play the sequence out in order and count
// the calls, which is the only way this property has ever been checkable.

/**
 * How many owed debriefs one page load will ask for.
 *
 * Three, because this spends money from a render: at roughly $0.010 a debrief
 * the worst load costs three cents, and a fourth row simply waits for the next
 * one. The number is here rather than inline because it is the knob somebody
 * will want to turn, and because the reason for its value is the reason it
 * exists at all.
 */
export const AUTO_DEBRIEF_PER_LOAD = 3;

/** How far back the sweep looks. The cron ran overnight; this reaches it. */
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Which row a resolved link decision owes a debrief request for, or null.
 *
 * NULL ON THE `linked` BRANCH, AND THAT IS THE FIX RATHER THAN AN OMISSION. A
 * link deletes the broker row, so the journal's row count drops, so `listKey`
 * in trades/page.tsx moves and JournalClient remounts — and {@link
 * owedDebriefs} on the fresh instance asks for that very trade, seconds later.
 * Asking here as well is a second call for the same id.
 *
 * AND IT IS THIS CALL THAT HAS TO GO, not the sweep's: the answer to this one
 * lands through a `setTrades` on the instance the remount is unmounting, so its
 * patch goes nowhere and the score ring reads `—` until F5. That is the bug
 * `fc4107d` fixed, so any guard that kept this call and dropped the sweep's
 * would re-open it.
 *
 * A DECLINE MOVES NOTHING THE `key` IS BUILT FROM. The row stays, the count
 * stays, there is no remount and so no sweep — so this is the only call on
 * that path, and on that path it is the one that lands.
 */
export function debriefOnResolve(
  /** The broker row that was decided about. */
  rowId: string,
  outcome: { kind: 'linked'; planId: string } | { kind: 'declined' }
): string | null {
  return outcome.kind === 'declined' ? rowId : null;
}

/** The columns {@link owedDebriefs} reads. */
export interface OwedRow extends LinkableRow {
  id: string;
  debrief_generated_at?: string | null;
}

/**
 * The decided trades still owed a debrief, freshest decision first, capped.
 *
 * THE QUEUE IS THE DATA, NOT A TABLE. "A decided trade with no stored debrief"
 * is already a complete description of the work outstanding — it needs no
 * column, no job table and nothing to keep in sync. The import never calls
 * Claude (a model call inside a 60-second nightly loop over every connected
 * trader would put a third party's latency on the critical path of a job whose
 * whole purpose is to be finished before anybody is awake), so this is what
 * asks for the cron's auto-links, the next time the trader opens the journal.
 *
 * THREE BOUNDS, because this spends money from a page load:
 *
 *   1. **Decided in the last day.** A historical backlog — rows decided weeks
 *      ago, or declined in bulk — is NOT swept, so the cost is bounded by what
 *      happened yesterday rather than by how long the trader has used the
 *      product.
 *   2. **{@link AUTO_DEBRIEF_PER_LOAD} per load.**
 *   3. **Once per mount**, which is the caller's `useRef` and not this
 *      function's business.
 *
 * SORTED, AND THE SORT IS LOAD-BEARING NOW. The caller's list is ordered by
 * `submitted_at` desc, which has nothing to do with when a row was DECIDED — so
 * a trader who links a row while three others are already owed could have their
 * own link fall outside the cap and wait for the next page load. That is the
 * symptom `fc4107d` fixed, and since the link's own request was removed this
 * sweep is the only thing that asks for it. `link_confirmed_at` is stamped
 * `now()` by the RPC, so the just-linked row sorts first by construction.
 */
export function owedDebriefs<T extends OwedRow>(rows: readonly T[], nowMs: number): T[] {
  const since = nowMs - SWEEP_WINDOW_MS;

  const owed = rows.filter((row) => {
    const state = linkState(row);
    if (state !== 'linked' && state !== 'declined') return false;
    // The stamp alone, deliberately, and NOT `hasStoredDebrief`: a row whose
    // blob is unreadable has still had its model call paid for, and asking
    // again on every page load would charge for it again forever.
    if (row.debrief_generated_at) return false;
    const decided = Date.parse(String(row.link_confirmed_at ?? ''));
    return Number.isFinite(decided) && decided >= since;
  });

  // Every row here has a readable instant — the filter required one — so the
  // comparator cannot produce NaN and leave the order to the engine.
  owed.sort((a, b) =>
    Date.parse(String(b.link_confirmed_at ?? '')) - Date.parse(String(a.link_confirmed_at ?? '')));

  return owed.slice(0, AUTO_DEBRIEF_PER_LOAD);
}
