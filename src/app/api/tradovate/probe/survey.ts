/**
 * Measuring the shape of a response without carrying its contents out.
 *
 * Ported from `scripts/spike/tradovate-spike.mjs`, whose rule this file keeps:
 * **what it prints is deliberately not the data.** Field NAMES and TYPES are
 * what REF-113 and REF-108 need; a stop price, an order id and a timestamp are
 * the trader's position.
 *
 * The emission rule is an ALLOWLIST and it fails closed. A value is emitted
 * only if its field is in {@link VOCABULARY} *and* the value is enum-shaped.
 * Everything else becomes its type name. A field nobody has thought about
 * prints as `<number>`, which is the direction that is safe to be wrong in:
 * the cost of over-redacting is a line in a report the owner reads once, and
 * the cost of under-redacting is a trader's position in a JSON body.
 *
 * This matters more here than it did in the spike. That script ran on the
 * owner's machine against a demo account and wrote to a gitignored directory.
 * This returns over HTTP, from production, and the whole point of the response
 * is that it can be pasted into a ticket.
 */

/** A row from any Tradovate list endpoint. */
export type Row = Record<string, unknown>;

/**
 * The only fields whose VALUE is emitted.
 *
 * Low-cardinality enums and nothing else — the vocabulary REF-113 is measuring
 * ("is there a `TrailingStop` in `orderType`", "does a cancelled order keep a
 * readable `ordStatus`"). An enum member names no trade.
 *
 * Taken from the spike's list MINUS `label`, which is the one deliberate
 * divergence in this file.
 *
 * The spike emits `label` values and leans on the enum-shape test to stop a
 * free-text one escaping. That test only rejects strings with spaces, so a
 * trader who names an order strategy `ApexEval4471` has that name emitted
 * verbatim — measured, not theorised. On the spike that landed in a gitignored
 * file on the owner's machine; here it would land in an HTTP response whose
 * whole purpose is to be pasted into a ticket, and the brief for this route
 * says no account names and no raw values.
 *
 * Q4 does not actually need the literal strings. It asks which linkage field a
 * bracket populates, which is answered by presence and non-null counts on
 * `ocoId` / `parentId` / `orderStrategyId`; ./orders.ts reports the label as a
 * distinct-value COUNT instead, which measures the vocabulary's size without
 * reproducing it.
 */
const VOCABULARY = new Set([
  'ordStatus',
  'orderType',
  'action',
  'timeInForce',
  'commandType',
  'commandStatus',
  'entityType',
  'eventType',
  'execType',
  'rejectReason',
  'accountType',
  'status',
]);

/** An enum member looks like this. Anything else is treated as free text. */
const ENUM_SHAPED = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Flatten nested objects to dotted paths, recording type and raw sample. */
function shapeOf(obj: unknown, prefix = ''): Record<string, { type: string; sample: unknown }> {
  const out: Record<string, { type: string; sample: unknown }> = {};
  for (const [k, v] of Object.entries((obj ?? {}) as Row)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, shapeOf(v, path));
    } else {
      out[path] = {
        type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
        sample: v,
      };
    }
  }
  return out;
}

/**
 * One field's sample value, or its type name.
 *
 * Booleans and nulls are emitted verbatim: a flag is not a measurement of
 * anything a trader did, and `archived: true` is precisely what REF-110 is
 * asking about. Arrays emit their length only.
 */
export function safeSample(fieldPath: string, value: unknown): string {
  const leaf = fieldPath.split('.').pop() ?? fieldPath;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `<array len=${value.length}>`;
  if (typeof value === 'object') return '<object>';
  if (VOCABULARY.has(leaf) && typeof value === 'string' && ENUM_SHAPED.test(value)) return value;
  return `<${typeof value}>`;
}

/** What one field looked like across every row of a response. */
export interface FieldReport {
  /** Every JS type seen for this field, sorted. */
  types: string[];
  /** How many rows carried it — the "does the field exist" answer, as a count. */
  presentOn: number;
  /** One sanitised sample, per {@link safeSample}. */
  sample: string;
  /** How many rows carried it with a non-null value. */
  nonNull: number;
}

/**
 * Every field any row carried, its types, and one sanitised sample.
 *
 * Across ALL rows and not just the first, for the spike's reason: these
 * entities have optional fields that only appear on some rows — `stopPrice` is
 * absent from a limit order's version and present on a stop's, which is exactly
 * the distinction Q1 is measuring. A shape read off row zero would report the
 * wrong answer with total confidence.
 */
export function fieldSurvey(rows: Row[]): Record<string, FieldReport> {
  const fields = new Map<string, FieldReport>();
  for (const row of rows) {
    for (const [path, info] of Object.entries(shapeOf(row))) {
      const entry = fields.get(path) ?? { types: [], presentOn: 0, sample: 'null', nonNull: 0 };
      if (!entry.types.includes(info.type)) entry.types.push(info.type);
      entry.presentOn += 1;
      if (info.sample !== null && info.sample !== undefined) entry.nonNull += 1;
      if (entry.sample === 'null') entry.sample = safeSample(path, info.sample);
      fields.set(path, entry);
    }
  }
  return Object.fromEntries(
    [...fields.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, { ...v, types: [...v.types].sort() }])
  );
}

/** Whether any row carries this field at all — the yes/no the brief asks for. */
export function hasField(rows: Row[], field: string): boolean {
  return rows.some((r) => r !== null && typeof r === 'object' && field in r);
}

/** How many rows carry this field with a non-null value. */
export function nonNullCount(rows: Row[], field: string): number {
  return rows.filter((r) => r?.[field] !== null && r?.[field] !== undefined).length;
}

/**
 * How many DISTINCT values a field takes, without naming any of them.
 *
 * For a field whose vocabulary matters but whose contents might be the
 * trader's own words — `orderStrategyLink.label` is the case this exists for.
 * "Three distinct labels across eleven links" is the measurement; which three
 * is not.
 */
export function distinctCount(rows: Row[], field: string): number {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = row?.[field];
    if (v !== null && v !== undefined) seen.add(JSON.stringify(v));
  }
  return seen.size;
}

/** Distinct values of one enum field across rows. Printable by construction. */
export function enumValues(rows: Row[], field: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = row?.[field];
    if (typeof v === 'string' && ENUM_SHAPED.test(v)) seen.add(v);
    else if (typeof v === 'number') seen.add('<number>');
  }
  return [...seen].sort();
}

/**
 * Which field NAMES differ between two rows. Names only — never the values.
 *
 * JSON comparison, because these are flat scalar entities and this is only ever
 * asked "did it change", never "to what".
 */
export function changedFields(a: Row | undefined, b: Row | undefined): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)) changed.push(k);
  }
  return changed.sort();
}

/** Milliseconds since the epoch for a row's own instant, or null. */
export function rowTime(row: Row | undefined): number | null {
  const raw = row?.['timestamp'] ?? row?.['transactTime'] ?? null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The relative timeline the brief asks for — "stop version 2 was created X
 * seconds after the entry".
 *
 * **Offsets, never instants.** A duration between two of the trader's own
 * events is the measurement REF-113 needs (did the stop move, and how long
 * into the trade). An absolute timestamp would say when that trader was at
 * their desk, which is not something this probe has any reason to carry out.
 *
 * Rounded to whole seconds: sub-second precision would start to fingerprint
 * individual events, and no question here is answered by it.
 */
export function relativeSeconds(rows: Row[]): (number | null)[] {
  const base = rowTime(rows[0]);
  if (base === null) return rows.map(() => null);
  return rows.map((r) => {
    const t = rowTime(r);
    return t === null ? null : Math.round((t - base) / 1000);
  });
}

/**
 * How far back a response reaches, in days.
 *
 * A duration, like the offsets above, and an aggregate over the whole response
 * rather than a property of any one row. This is Q3's "how far back" and Q7's
 * truncation check.
 */
export function depthDays(rows: Row[]): number | null {
  const stamps = rows.map(rowTime).filter((t): t is number => t !== null);
  if (!stamps.length) return null;
  return Number(((Date.now() - Math.min(...stamps)) / 86_400_000).toFixed(1));
}

/** The round counts that mean "truncated", per FINDINGS.md §4. */
export const CAP_COUNTS = [1000, 1024, 2000, 2048, 4096];

/** Whether a count landed on a round number — truncated, not exhausted. */
export function looksTruncated(count: number): boolean {
  return CAP_COUNTS.includes(count);
}
