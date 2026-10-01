/**
 * Standing security assertions over the live database.
 *
 * SERVER ONLY. Uses the Supabase service-role key.
 *
 * The readable twin of this file is supabase/queries/security_assertions.sql,
 * which carries the full rationale for each rule and is what to run by hand.
 * Keep the two in step: the SQL file is what makes these rules reviewable
 * without reading TypeScript, and a rule that exists in only one of them is
 * worse than a rule that exists in neither.
 *
 *
 * WHAT THESE ARE, AND WHY THEY ARE NOT A BASELINE DIFF
 * ---------------------------------------------------
 *
 * The setup-images hole was a policy written without TO and without a folder
 * restriction, beside a correctly hardened one in the same migration file,
 * correctly recorded and correctly applied. Nothing had drifted. A snapshot
 * comparison, a migration CLI and a baseline reset would all have reported
 * everything fine, because the thing that was written down was itself wrong.
 *
 * So nothing here compares production to a stored baseline. Each rule encodes a
 * judgement about what is WRONG and fires when production matches it. There is
 * no list of expected tables, buckets or functions anywhere in this module, so
 * a new object never trips an alarm by existing and there is nothing to keep in
 * step with the migrations.
 *
 *
 * WHAT MAY LEAVE THIS MODULE
 * --------------------------
 *
 * A finding is an object name and the rule it broke. Never the policy
 * expression, never the privilege list, never a bucket column beyond the name.
 * A list of where the weaknesses are is a map; a list of how each one is shaped
 * is an exploitation guide, and this one is going into an inbox.
 *
 *
 * "NO FINDINGS" AND "COULD NOT LOOK" ARE DIFFERENT ANSWERS
 * -------------------------------------------------------
 *
 * Every function here reports whether it managed to run, separately from what
 * it found. A security check that returns an empty list because it was unable
 * to query is the single worst outcome available to it — it is indistinguishable
 * from a clean bill of health, and the reader will take it as one. This is the
 * same trap as reading information_schema, whose row-filtering makes "no rows"
 * and "no permission to see the rows" look identical.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Every rule this module can report, and what each one means.
 *
 * Scope notes that the catalog function is expected to honour, from the first
 * production run:
 *
 * - `rls.no_policies` and `function.execute_to_public` are PUBLIC SCHEMA ONLY.
 *   Across storage they return Supabase's own internals — buckets, migrations,
 *   s3_multipart_uploads, vector_indexes, and about twenty storage.* functions —
 *   none of which is ours to change. The other rules still cover storage,
 *   because a policy or grant there is ours to get wrong and is where the
 *   original hole was.
 * - `grant.secret_column_to_*` excludes the exact column name `token_type`.
 *   030 grants it deliberately and it holds "bearer", the token TYPE. Excluded
 *   by whole name rather than by weakening the pattern, so `token`,
 *   `access_token` and `refresh_token` all still fire.
 */
export const SECURITY_RULES = {
  'rls.disabled': 'טבלה ללא RLS',
  'rls.no_policies': 'RLS פעיל אך אין אף מדיניות',
  'policy.role_public': 'מדיניות שחלה על public (נכתבה בלי TO)',
  'policy.role_anon': 'מדיניות שחלה על anon',
  'policy.using_true': 'מדיניות שתנאי ה-USING שלה הוא true',
  'policy.with_check_true': 'מדיניות שתנאי ה-WITH CHECK שלה הוא true',
  'function.execute_to_public': 'פונקציה עם EXECUTE ל-PUBLIC',
  'grant.table_overrides_column_anon': 'הרשאה ברמת טבלה עוקפת הרשאות עמודה (anon)',
  'grant.table_overrides_column_authenticated':
    'הרשאה ברמת טבלה עוקפת הרשאות עמודה (authenticated)',
  'grant.table_on_never_list': 'הרשאה ברמת טבלה על טבלה שאסור שתהיה לה',
  'grant.secret_column_to_anon': 'הרשאה על עמודת סוד ל-anon',
  'grant.secret_column_to_authenticated': 'הרשאה על עמודת סוד ל-authenticated',
  'bucket.public': 'דלי אחסון ציבורי',
  'bucket.no_size_limit': 'דלי אחסון ללא מגבלת גודל',
  'bucket.no_mime_allowlist': 'דלי אחסון ללא הגבלת סוגי קבצים',

  // Inventory. Never mailed — see INVENTORY_RULES below.
  'grant.table_to_anon': 'מצאי: הרשאה ברמת טבלה ל-anon',
  'grant.table_to_authenticated': 'מצאי: הרשאה ברמת טבלה ל-authenticated',
} as const;

export type SecurityRule = keyof typeof SECURITY_RULES;

/**
 * Rules that are an inventory of the normal state, not an alarm.
 *
 * `grant.table_to_*` answers "which tables can a client role reach at the table
 * level", which is about forty rows and is correct: the browser talks to
 * Postgres as `authenticated` and RLS is what scopes it. Worth asking by hand,
 * worthless as a daily email — forty lines of noise around the few that matter
 * is how a report stops being read.
 *
 * The alarms carved out of it are `grant.table_overrides_column_*` (a blanket
 * grant quietly widening a careful column grant) and `grant.table_on_never_list`.
 *
 * Filtered here rather than only in SQL so that a catalog function which returns
 * the inventory rows anyway still cannot put them in the mail.
 */
export const INVENTORY_RULES: ReadonlySet<string> = new Set([
  'grant.table_to_anon',
  'grant.table_to_authenticated',
]);

export function isInventoryRule(rule: string): boolean {
  return INVENTORY_RULES.has(rule);
}

/** One violation: which object, which rule. Nothing else, ever. */
export interface SecurityFinding {
  /** Schema the object lives in, or 'storage' for a bucket. */
  schema: string;
  /** The object's name. A table, a `table.policy`, a function signature. */
  object: string;
  rule: SecurityRule;
}

/** The outcome of one group of checks: what it found, and whether it ran. */
export interface CheckGroupResult {
  findings: SecurityFinding[];
  /**
   * False when the group could not be evaluated at all.
   *
   * `findings` is then meaningless and must not be read as "clean" — see the
   * header. The caller reports the group as unavailable instead.
   */
  ran: boolean;
  /** Why it could not run. Never carries a key, a token or a URL. */
  unavailableReason?: string;
}

/** The name of the SECURITY DEFINER function the catalog checks would call. */
export const CATALOG_RPC = 'security_assertions';

/**
 * Checks 8 and 9: storage buckets.
 *
 * Goes through the Storage API rather than SQL because that is the one part of
 * the storage schema the service-role key can reach over HTTP. listBuckets()
 * returns every bucket with `public`, `file_size_limit` and `allowed_mime_types`
 * — and only the bucket's name and the rule leave this function.
 *
 * Both rules are absolute. There is no configuration of this application in
 * which a public bucket is correct, and an image bucket with neither a size cap
 * nor a MIME allowlist takes a file of any type and any size from anyone the
 * policies admit.
 */
export async function checkBuckets(admin: SupabaseClient): Promise<CheckGroupResult> {
  const { data, error } = await admin.storage.listBuckets();

  if (error) {
    return { findings: [], ran: false, unavailableReason: error.message };
  }
  if (!data) {
    return { findings: [], ran: false, unavailableReason: 'listBuckets returned no data' };
  }

  const findings: SecurityFinding[] = [];

  for (const bucket of data) {
    const name = bucket.name ?? bucket.id;

    if (bucket.public === true) {
      findings.push({ schema: 'storage', object: name, rule: 'bucket.public' });
    }
    // Explicitly `== null`: both fields are nullable, and an absent field and a
    // null one mean the same thing here — no limit is configured.
    if (bucket.file_size_limit == null) {
      findings.push({ schema: 'storage', object: name, rule: 'bucket.no_size_limit' });
    }
    if (bucket.allowed_mime_types == null) {
      findings.push({ schema: 'storage', object: name, rule: 'bucket.no_mime_allowlist' });
    }
  }

  return { findings, ran: true };
}

/**
 * Checks 1-7: the catalog rules.
 *
 * These need pg_class, pg_policy, pg_proc and aclexplode, and PostgREST exposes
 * only the `public` schema — there is no path from the service-role key to
 * pg_catalog over HTTP. {@link CATALOG_RPC} is the function that bridges it:
 * public.security_assertions(), created by migration 031, SECURITY DEFINER with
 * a pinned search_path, EXECUTE granted to service_role alone. It returns a row
 * per finding as (schema_name, object_name, rule_broken).
 *
 * While 031 is unapplied the RPC call fails and this returns ran: false. It does
 * NOT return an empty findings list and call that clean, which is the whole
 * point — see the header.
 */
export async function checkCatalog(admin: SupabaseClient): Promise<CheckGroupResult> {
  const { data, error } = await admin.rpc(CATALOG_RPC);

  if (error) {
    return {
      findings: [],
      ran: false,
      // The PostgREST message names the missing function, which is what the
      // reader needs; it carries no credential.
      unavailableReason: error.message,
    };
  }

  const rows = (data ?? []) as Array<{
    schema_name?: unknown;
    object_name?: unknown;
    rule_broken?: unknown;
  }>;

  const findings: SecurityFinding[] = [];

  for (const row of rows) {
    const rule = String(row.rule_broken ?? '');
    // An unrecognised rule id is still reported rather than dropped: the
    // function is the authority on what it checked, and silently discarding a
    // finding because this file has not been taught its name yet would be the
    // same failure as reporting empty when the query could not run.
    findings.push({
      schema: String(row.schema_name ?? 'unknown'),
      object: String(row.object_name ?? 'unknown'),
      rule: rule as SecurityRule,
    });
  }

  return { findings, ran: true };
}

/** Human label for a rule, falling back to the raw id for an unknown one. */
export function describeRule(rule: string): string {
  return SECURITY_RULES[rule as SecurityRule] ?? rule;
}

/**
 * Group findings by rule, so the report reads as "this rule, these objects"
 * rather than a flat list in which one bad rule repeated twenty times buries a
 * different rule that fired once.
 */
export function groupByRule(findings: SecurityFinding[]): Array<{
  rule: string;
  label: string;
  objects: string[];
}> {
  const groups = new Map<string, string[]>();

  for (const f of findings) {
    const objects = groups.get(f.rule) ?? [];
    objects.push(`${f.schema}.${f.object}`);
    groups.set(f.rule, objects);
  }

  return [...groups.entries()]
    .map(([rule, objects]) => ({ rule, label: describeRule(rule), objects: objects.sort() }))
    .sort((a, b) => a.rule.localeCompare(b.rule));
}
