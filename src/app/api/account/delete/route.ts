/**
 * POST /api/account/delete — erase the signed-in user's account and data.
 *
 * Immediate and irreversible. There is no soft-delete window, no undo, and no
 * export step: the privacy policy promises erasure, and a "deleted" account
 * that is still recoverable is not erased.
 *
 * POST, never GET: a GET that destroys an account is triggerable by any image
 * tag or link prefetch. Reflect's Supabase session cookies are SameSite=Lax, so
 * a cross-site POST arrives without them and fails the auth check below — the
 * same CSRF reasoning as /api/tradovate/disconnect.
 *
 * Two independent confirmations, both required:
 *
 *   1. The account password, re-checked against Supabase Auth right now. This
 *      is what stops an unattended logged-in browser from being used to destroy
 *      someone's journal, which the session cookie alone cannot.
 *   2. A typed confirmation word. This is not security — the attacker who has
 *      the password can read the word off the screen — it is deliberate
 *      friction, so the click is not reflexive.
 *
 * The re-check runs on a throwaway client with persistSession off, so a wrong
 * password cannot disturb the caller's real session cookies, and a right one
 * does not rotate them underneath a request that is about to delete the user
 * anyway.
 */

import { createClient as createStandaloneClient, type SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { matchesConfirmation } from '@/lib/account/confirmation';
import { AccountDeletionError, deleteAccount } from '@/lib/account/deleteAccount';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeleteRequest {
  password?: unknown;
  confirmation?: unknown;
}

/**
 * What a failed deletion tells the user, per stage it stopped at.
 *
 * Each message answers the two questions someone has the moment a deletion they
 * committed to comes back as an error: is any of my data already gone, and am I
 * still signed in. "המחיקה נכשלה. נסה שוב" answers neither, and "try again" is
 * actively wrong advice for a deletion that has already removed the storage
 * objects. AccountDeletionError.stage is exactly the fact needed to say which,
 * so it is used rather than collapsed back into one string.
 *
 * The stages run in deletion order, and each message describes what the stages
 * before it already completed — see the ordering note in ./deleteAccount.ts.
 * The last two matter most: after 'auth' the data is gone but the account is
 * not, and after 'verify' the account is gone but some data is not. Both leave
 * the user somewhere no retry can fix, so neither invites one.
 *
 * No message names a table or a count. Those go to the log, which the support
 * request gets matched against; the user gets what they need in order to act.
 */
const STAGE_MESSAGES: Record<AccountDeletionError['stage'], string> = {
  storage:
    'המחיקה נעצרה בשלב מחיקת הקבצים. החשבון והנתונים שלך עדיין קיימים ואתה עדיין מחובר, ' +
    'אך ייתכן שחלק מהתמונות שהעלית כבר נמחקו. האירוע נרשם — פנה לתמיכה.',
  tradovate:
    'המחיקה נעצרה בשלב ניתוק חשבון המסחר. התמונות שהעלית נמחקו, אך שאר הנתונים והחשבון ' +
    'עדיין קיימים ואתה עדיין מחובר. האירוע נרשם — פנה לתמיכה.',
  profile:
    'המחיקה נעצרה לפני מחיקת הנתונים עצמם. התמונות והחיבור לברוקר הוסרו, אך שאר הנתונים ' +
    'והחשבון עדיין קיימים ואתה עדיין מחובר. האירוע נרשם — פנה לתמיכה.',
  auth:
    'הנתונים שלך נמחקו, אך החשבון עצמו לא נמחק ואתה עדיין מחובר אליו. אל תמשיך להשתמש בו — ' +
    'האירוע נרשם, ופנה לתמיכה כדי להשלים את המחיקה.',
  verify:
    'החשבון שלך נמחק והגישה אליו כבר אינה תקפה, אך חלק מהנתונים עדיין קיימים במערכת. ' +
    'האירוע נרשם עם הפירוט המלא — פנה לתמיכה כדי להשלים את המחיקה.',
};

/**
 * Nothing ran. The service-role client could not even be built, so no storage
 * object, no row and no auth user was touched — the one failure this route can
 * state with certainty, and the only one where "try again" is honest advice.
 */
const NOT_STARTED_MESSAGE =
  'המחיקה לא התחילה ושום נתון לא נמחק. החשבון שלך שלם ואתה עדיין מחובר. ' +
  'האירוע נרשם — נסה שוב מאוחר יותר או פנה לתמיכה.';

/**
 * The deletion began and threw something that is not an AccountDeletionError,
 * so no stage is known. Deliberately does not claim the data is safe: every
 * stage wraps its own failures, so reaching here means the failure came from
 * somewhere unmodelled, and guessing in the reassuring direction is how a user
 * ends up trusting an account that is half gone.
 */
const UNKNOWN_STAGE_MESSAGE =
  'המחיקה החלה ונכשלה, ולא ניתן לקבוע איזה חלק ממנה הושלם. ייתכן שחלק מהנתונים נמחקו. ' +
  'האירוע נרשם — פנה לתמיכה לפני שתמשיך להשתמש בחשבון.';

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // An account with no email address has no password to re-check, so the first
  // confirmation factor cannot be satisfied. Refuse rather than fall through to
  // deleting on the strength of the typed word alone.
  if (!user.email) {
    return NextResponse.json(
      { error: 'no_password_factor', message: 'לא ניתן לאמת סיסמה לחשבון הזה. פנה לתמיכה.' },
      { status: 400 }
    );
  }

  let body: DeleteRequest;
  try {
    body = (await request.json()) as DeleteRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const confirmation = typeof body.confirmation === 'string' ? body.confirmation : '';

  if (!matchesConfirmation(confirmation)) {
    return NextResponse.json(
      { error: 'confirmation_mismatch', message: 'מילת האישור אינה נכונה.' },
      { status: 400 }
    );
  }

  if (!password) {
    return NextResponse.json(
      { error: 'invalid_credentials', message: 'הסיסמה שגויה.' },
      { status: 401 }
    );
  }

  // Re-authenticate. Throwaway client: no cookie adapter, no session storage,
  // so this verifies the password and touches nothing else.
  const verifier = createStandaloneClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const { data: reauth, error: reauthError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password,
  });

  // The id check matters: signInWithPassword succeeding proves *a* password was
  // right, and only comparing ids proves it was this session's user's.
  if (reauthError || reauth.user?.id !== user.id) {
    console.warn(
      `[account-delete] re-authentication failed user=${user.id} at=${new Date().toISOString()}`
    );
    return NextResponse.json(
      { error: 'invalid_credentials', message: 'הסיסמה שגויה.' },
      { status: 401 }
    );
  }

  // Sign the verifier's own short-lived session out; it was only ever a
  // password check, and leaving it open holds a refresh token for a user who is
  // about to stop existing.
  await verifier.auth.signOut({ scope: 'local' }).catch(() => {});

  // Built here rather than left to deleteAccount's default argument, so a
  // missing or malformed service-role key fails with nothing deleted instead of
  // as an unattributable throw from inside the first stage. It is the most
  // likely failure this route has — a deploy without the key — and the only one
  // the user can be told with certainty cost them nothing.
  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (err) {
    console.error(
      '[account-delete] FAILED ' +
        JSON.stringify({
          userId: user.id,
          at: new Date().toISOString(),
          stage: 'not_started',
          reason: err instanceof Error ? err.message : 'unknown error',
        })
    );
    return NextResponse.json(
      { error: 'deletion_not_started', stage: 'not_started', message: NOT_STARTED_MESSAGE },
      { status: 500 }
    );
  }

  try {
    const report = await deleteAccount(user.id, admin);

    // The deletion event, and only the event. No email, no row contents — the
    // whole point is that nothing survives, logs included.
    console.info(
      '[account-delete] completed ' +
        JSON.stringify({
          userId: report.userId,
          startedAt: report.startedAt,
          finishedAt: report.finishedAt,
          storageObjectsDeleted: report.storageObjectsDeleted,
          tradovateConnectionDeleted: report.tradovateConnectionDeleted,
          profileRowDeleted: report.profileRowDeleted,
          tablesVerified: report.tablesVerified,
          tablesAbsent: report.tablesAbsent,
        })
    );

    return NextResponse.json({ ok: true, deleted: report });
  } catch (err) {
    if (err instanceof AccountDeletionError) {
      // Loud, and specific about which table still holds rows: this log is the
      // only way to diagnose a half-deleted account without keeping a copy of
      // the data it failed to delete.
      console.error(
        '[account-delete] FAILED ' +
          JSON.stringify({
            userId: user.id,
            at: new Date().toISOString(),
            stage: err.stage,
            reason: err.message,
            survivingTables: err.survivors,
            partial: err.report,
          })
      );
      return NextResponse.json(
        { error: 'deletion_incomplete', stage: err.stage, message: STAGE_MESSAGES[err.stage] },
        { status: 500 }
      );
    }

    console.error(
      '[account-delete] FAILED ' +
        JSON.stringify({
          userId: user.id,
          at: new Date().toISOString(),
          stage: 'unknown',
          reason: err instanceof Error ? err.message : 'unknown error',
        })
    );
    return NextResponse.json(
      { error: 'deletion_failed', stage: 'unknown', message: UNKNOWN_STAGE_MESSAGE },
      { status: 500 }
    );
  }
}
