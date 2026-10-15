/**
 * Intent fields — the columns a broker can never supply, and how to average
 * them without inventing data (REF-107 §0ג, §B6, stage 4).
 *
 * `strategy`, `stop_loss`, `take_profit`, `rr_ratio`, `trade_reason`,
 * `emotional_state` and `confidence_level` record what the trader *meant*, not
 * what the market *did*. A row that arrives from a broker pull has none of
 * them. Today every such column is NOT NULL and the form always fills them, so
 * the hazard is latent — but three readers already average over `trades.length`
 * rather than over the rows that actually carry a value, and `Number(null)` is
 * `0`, not `NaN`. A single empty row therefore drags an average down silently
 * and in the strict direction: it reads as a disciplined trader scoring zero,
 * not as missing data.
 *
 * The pattern this module names is the one the stats page's discipline block
 * already uses (stats/page.tsx: `filter(t => t.followed_plan !== null)` before
 * the ratio): filter first, then divide by what survived, and return null —
 * not 0 — when nothing does. Null reaches the UI as "—", which is the honest
 * answer to "what is your average R:R" when no trade carries one.
 *
 * Nothing here knows about Supabase or about a trade's shape; callers pass the
 * raw column value, which may be a number, a numeric string (Postgres NUMERIC
 * arrives as a string over PostgREST), null, or undefined.
 */

/** A column value as it can arrive from the database or a form. */
export type RawValue = number | string | null | undefined;

/**
 * The numeric value of an intent column, or null when it carries no usable
 * number. `''` and `null` both mean "not recorded"; `Number('')` is 0, which is
 * exactly the coercion this exists to prevent.
 */
export function intentNumber(v: RawValue): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A 1..5 self-report (`emotional_state`, `confidence_level`), or null.
 *
 * The range is the DB's own CHECK constraint. Enforcing it here as well means
 * a value that somehow sits outside it is dropped from the average rather than
 * skewing it — the same graceful degradation the 1..5 bucket rows already get
 * for free by matching on equality.
 */
export function scaleValue(v: RawValue): number | null {
  const n = intentNumber(v);
  if (n === null) return null;
  return n >= 1 && n <= 5 ? n : null;
}

/**
 * An R:R ratio, or null. Negative is not a ratio, and the column is a
 * reward-to-risk magnitude by construction (`calcRR` takes absolute values),
 * so a negative number is corrupt input rather than a small ratio.
 */
export function rrValue(v: RawValue): number | null {
  const n = intentNumber(v);
  if (n === null) return null;
  return n >= 0 ? n : null;
}

/**
 * A free-text intent column (`strategy`, `trade_reason`), trimmed, or null when
 * absent or blank. Used to decide whether a row earns a bucket of its own: a
 * trade with no strategy belongs in no strategy's row, not in one called
 * "null" or "אחר".
 */
export function intentText(v: string | null | undefined): string | null {
  const s = v?.trim();
  return s ? s : null;
}

/**
 * Mean of the values that are present, or null when none are.
 *
 * This is the whole point of the module: the denominator is the number of rows
 * that carried a value, never the number of rows considered.
 */
export function averageOf<T>(rows: readonly T[], pick: (row: T) => number | null): number | null {
  let sum = 0;
  let n = 0;
  for (const row of rows) {
    const v = pick(row);
    if (v !== null) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}
