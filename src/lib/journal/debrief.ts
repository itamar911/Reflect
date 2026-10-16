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
