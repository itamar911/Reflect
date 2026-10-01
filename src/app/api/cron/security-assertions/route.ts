/**
 * GET /api/cron/security-assertions — run the standing database assertions.
 *
 * Once a day, from vercel.json. Not from CI: the dangerous changes in this
 * project come from the Supabase dashboard and the SQL Editor, not from a push,
 * and a check that runs on push is watching the wrong door. The setup-images
 * policy was applied correctly from a file in this repo and was still wrong; the
 * limit triggers that broke plan changes were never in a file at all.
 *
 * READ-ONLY. Nothing here writes to the database.
 *
 * The rules live in lib/security/assertions.ts and are documented in full in
 * supabase/queries/security_assertions.sql, which runs the same checks by hand.
 *
 *
 * WHAT IT SENDS
 * -------------
 *
 * One email, to the address the other operational mail already uses, listing
 * every finding. Nothing at all on a clean run — daily mail gets filtered, and a
 * filtered security report is worse than none.
 *
 * The `grant.table_to_*` inventory is excluded from the mail and returned under
 * its own key in the JSON. It is about forty rows describing the normal state of
 * the database, and mailing it daily would bury the handful of rows that mean
 * something. The alarms carved out of it — a table-level grant overriding a
 * column grant, and the never-list — are mailed.
 *
 * A run in which some checks could not execute is NOT a clean run. It mails,
 * and the notice sits above the findings, because an empty list from a check
 * that never ran reads exactly like a clean bill of health.
 *
 *
 * LOGGING
 * -------
 *
 * Rule ids and object names only, same as the email. No key, no token, no
 * connection string, no policy expression. The Resend key and the service-role
 * key are read from the environment and never appear in a log line or a
 * response body.
 */

import { NextResponse } from 'next/server';

import { securityAssertionsEmail } from '@/lib/email/securityAssertions';
import { checkBuckets, checkCatalog, groupByRule, isInventoryRule } from '@/lib/security/assertions';
import type { SecurityFinding } from '@/lib/security/assertions';
import { createAdminClient } from '@/lib/supabase/admin';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Reflect <feedback@reflecttrading.app>';
const TO_EMAIL = 'seince33@gmail.com';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function sendReport(subject: string, html: string, text: string): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: TO_EMAIL, subject, html, text }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { message?: string }).message ?? 'Resend error');
  }
}

export async function GET(request: Request) {
  // Same gate as /api/cron/send-alerts, and fails closed for the same reason:
  // this route uses the service-role client, so an unset or renamed CRON_SECRET
  // must reject rather than skip the check.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch (error) {
    // No client means no checks ran at all, which is a reportable state rather
    // than a quiet 500 — but there is also nothing to query, so say so plainly.
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[security-assertions] could not build the admin client:', message);
    return NextResponse.json({ ok: false, ran: false, reason: message }, { status: 500 });
  }

  const [buckets, catalog] = await Promise.all([checkBuckets(admin), checkCatalog(admin)]);

  const all: SecurityFinding[] = [...catalog.findings, ...buckets.findings];

  // The inventory rules describe the normal state of the database — about forty
  // tables a client role can reach, which is how the app works. They are split
  // off here rather than filtered in the email builder so that nothing
  // downstream has to remember: `findings` is the mailable set, full stop.
  const findings = all.filter((f) => !isInventoryRule(f.rule));
  const inventory = all.filter((f) => isInventoryRule(f.rule));

  const unavailable: Array<{ group: string; reason: string }> = [];
  if (!catalog.ran) {
    unavailable.push({ group: 'catalog (rules 1-7)', reason: catalog.unavailableReason ?? 'unknown' });
  }
  if (!buckets.ran) {
    unavailable.push({ group: 'storage buckets (rules 8-9)', reason: buckets.unavailableReason ?? 'unknown' });
  }

  const groups = groupByRule(findings);
  const inventoryGroups = groupByRule(inventory);

  // Inventory deliberately does not count: a clean day is one with no alarms,
  // and forty inventory rows is what a clean day looks like.
  const clean = findings.length === 0 && unavailable.length === 0;

  // Rule ids and object names only — the same material the email carries.
  console.info(
    `[security-assertions] findings=${findings.length} rules=${groups.length} ` +
      `inventory=${inventory.length} unavailable=${unavailable.length}` +
      (groups.length > 0 ? ` rules_fired=${groups.map((g) => g.rule).join(',')}` : '')
  );

  let emailed = false;
  let emailError: string | undefined;

  if (!clean) {
    const mail = securityAssertionsEmail({
      groups,
      unavailable,
      ranAt: new Intl.DateTimeFormat('he-IL', {
        timeZone: 'Asia/Jerusalem',
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date()),
    });

    try {
      await sendReport(mail.subject, mail.html, mail.text);
      emailed = true;
    } catch (error) {
      // A failed send must not lose the findings: they are in the JSON body and
      // in the log line above either way. Reported rather than thrown so the
      // cron's own status reflects "checks ran", not "mail provider was down".
      emailError = error instanceof Error ? error.message : 'unknown error';
      console.error('[security-assertions] report email failed:', emailError);
    }
  }

  return NextResponse.json({
    ok: true,
    clean,
    emailed,
    emailError,
    // Named so a reader of the raw JSON cannot mistake an unavailable group's
    // silence for a pass.
    unavailable,
    findingCount: findings.length,
    findings: groups,
    // Returned for checking by hand, never mailed. Kept under its own key so a
    // reader of the JSON cannot mistake the two for one list.
    inventoryCount: inventory.length,
    inventory: inventoryGroups,
  });
}
