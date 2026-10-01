/**
 * ============================================================================
 * CONNECTION-READ DIAGNOSTICS — DELETE THIS FILE ONCE THE READ IS EXPLAINED
 * ============================================================================
 *
 * SERVER ONLY — see ./config.ts.
 *
 * Temporary instrumentation for one question: Settings renders "not connected"
 * for a user whose row exists, is 'active', and carries exactly the user_id the
 * page is signed in as. Everything checkable from outside has been checked and
 * come back clean:
 *
 *   - getConnectionSummary() uses createAdminClient(), the SERVICE ROLE. It
 *     bypasses RLS and column grants, so neither the select-own-row policy nor
 *     030's withheld api_hosts grant can be what is filtering the row out.
 *   - The service role demonstrably works on this table: 017 creates no INSERT
 *     policy for `authenticated`, so RLS denies every client write, and the row
 *     is there — only saveConnection()'s identical createAdminClient() can have
 *     written it.
 *   - auth.users confirms the id belongs to the signed-in address.
 *   - The card's badge reads 'בדיקה מוקדמת', so isUserAllowed() passed and the
 *     read definitely ran.
 *
 * Which leaves facts only the running process holds. This module reports them.
 *
 *
 * WHAT IS LOGGED, AND WHAT IS NOT
 * -------------------------------
 *
 * Logged: the user id, JSON-encoded so that stray whitespace or a case
 * difference is visible rather than invisible, and its length. A Supabase user
 * id is not a secret — ./allowlist.ts says so explicitly, it is in the session
 * the caller already holds, and it has already been pasted into this thread.
 *
 * Logged: which of row / none / error came back, and for an error its
 * PostgREST code and message. Those name statements and columns, never values.
 *
 * Logged: an unfiltered count of the table and the user_ids in it, so that
 * "the service role cannot see this row" is distinguishable from "the service
 * role is looking at an empty table" — a wrong project, schema or privilege set
 * looks identical to a missing row through a filtered query, and that is the
 * distinction every remaining hypothesis turns on.
 *
 * NEVER logged: any token column. The control query selects user_id alone and
 * the summary select names four non-secret columns; neither
 * access_token_encrypted nor refresh_token_encrypted is read by anything here.
 *
 *
 * TO REMOVE
 * ---------
 *   1. Delete this file.
 *   2. Delete the fenced block in src/app/(app)/settings/page.tsx and the
 *      import above it (one block, clearly marked).
 *   3. npx tsc --noEmit will find anything missed.
 */

import { createAdminClient } from '@/lib/supabase/admin';

import { readConnectionSummary, type ConnectionRead } from './connections';

/** Everything one render learned about the read. No token, no field values. */
export interface ConnectionReadReport {
  /** JSON-encoded so whitespace and casing are visible in a log line. */
  userIdLiteral: string;
  userIdLength: number;
  /** What the filtered read returned. */
  outcome: ConnectionRead['outcome'];
  /** PostgREST error code, when the read failed. */
  errorCode?: string;
  /** PostgREST error message, when the read failed. */
  errorMessage?: string;
  /** Status of the row, when one came back. */
  rowStatus?: string;
  /** Rows the service role can see at all, ignoring the filter. */
  visibleRowCount?: number;
  /** The user_ids in those rows, JSON-encoded, for a character-exact compare. */
  visibleUserIds?: string[];
  /** Why the control query could not run, if it could not. */
  controlError?: string;
  /** Whether the filtered id is byte-identical to one the table holds. */
  exactMatchInTable?: boolean;
}

/**
 * Run the real read plus an unfiltered control, and report both.
 *
 * Never throws: this runs inside a page render that must not be taken down by
 * its own instrumentation.
 */
export async function reportConnectionRead(userId: string): Promise<ConnectionReadReport> {
  const report: ConnectionReadReport = {
    userIdLiteral: JSON.stringify(userId),
    userIdLength: userId.length,
    outcome: 'none',
  };

  const read = await readConnectionSummary(userId);
  report.outcome = read.outcome;
  if (read.outcome === 'error') {
    report.errorCode = read.code;
    report.errorMessage = read.message;
  }
  if (read.outcome === 'row') {
    report.rowStatus = read.summary.status;
  }

  // The control. Deliberately unfiltered and deliberately user_id only: if this
  // returns rows while the filtered read returns none, the filter value is
  // wrong; if this returns nothing either, the client is not looking where we
  // think it is.
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.from('tradovate_connections').select('user_id');

    if (error) {
      report.controlError = `${error.code ?? 'no-code'}: ${error.message}`;
    } else {
      const ids = (data ?? []).map((row) => String((row as { user_id: unknown }).user_id));
      report.visibleRowCount = ids.length;
      report.visibleUserIds = ids.map((id) => JSON.stringify(id));
      report.exactMatchInTable = ids.includes(userId);
    }
  } catch (error) {
    report.controlError = error instanceof Error ? error.message : 'unknown error';
  }

  return report;
}

/** Emit the report as one greppable line per field. */
export function logConnectionRead(label: string, report: ConnectionReadReport): void {
  const parts = [
    `userId=${report.userIdLiteral}`,
    `userIdLength=${report.userIdLength}`,
    `outcome=${report.outcome}`,
    report.rowStatus ? `rowStatus=${report.rowStatus}` : null,
    report.errorCode ? `errorCode=${report.errorCode}` : null,
    report.errorMessage ? `errorMessage=${JSON.stringify(report.errorMessage)}` : null,
    report.visibleRowCount === undefined ? null : `visibleRowCount=${report.visibleRowCount}`,
    report.visibleUserIds ? `visibleUserIds=[${report.visibleUserIds.join(', ')}]` : null,
    report.exactMatchInTable === undefined
      ? null
      : `exactMatchInTable=${report.exactMatchInTable}`,
    report.controlError ? `controlError=${JSON.stringify(report.controlError)}` : null,
  ].filter(Boolean);

  console.info(`[tradovate][conn-read] ${label} ${parts.join(' ')}`);
}
