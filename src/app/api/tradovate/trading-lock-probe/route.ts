/**
 * /api/tradovate/trading-lock-probe — a TEMPORARY diagnostic route
 * (REF-126 Stages 3 and 4).
 *
 * **This is not product code, nothing in the app imports it, and it is due for
 * deletion the day it answers.**
 *
 * Three handlers' worth of behaviour behind one path:
 *
 *   - `GET ?mode=lockout`     — Stage 3. The read survey. Writes nothing.
 *   - `GET ?mode=create-lock` — Stage 4. Renders a form. **Writes nothing, and
 *                               makes no upstream call at all.**
 *   - `POST ?mode=create-lock` — Stage 4. THE ONE WRITE. Six gates, then three
 *                                preflight reads, then one unretried call.
 *
 * THE GET/POST SPLIT IS A SAFETY PROPERTY. The write liquidates open positions,
 * cancels working orders, and cannot be undone by the trader — only by the prop
 * firm. A GET that did that could be fired by a prefetch, a refresh, a link
 * preview or a bot following a URL out of a chat window. So the only thing GET
 * does is draw a form.
 *
 * Stage 3 measured that Reflect's token READS lockout state fine. That is not
 * evidence about the write: `/user/accountlockoutstatus` carries no eval-user
 * restriction and `/user/createaccountlockout` is documented "only the eval
 * user may initiate a trading lockout". Stage 4 is what settles it.
 *
 * Restored from the deleted REF-113 probe at `e2240c6` — not `2102bf3` — and
 * the reason is {@link STRICT_SUBTREE_KEY}. `2102bf3` checked only `sample`
 * keys, which is enough when every emitted value is a field shape; `e2240c6`
 * added a subtree whose EVERY value is checked and whose numbers must be
 * integers. This probe reports measurements rather than only shapes, so it
 * needs the stronger guard. `live.ts`, `orders.ts` and `q8.ts` were not
 * restored: they answer REF-108/REF-110/REF-113 and have no business here.
 *
 *
 * HOW THIS IS CLOSED
 * ------------------
 *
 * Three gates, each failing closed, and a caller that fails any of them cannot
 * tell this route from one that does not exist:
 *
 *   1. A session. No session, no route.
 *   2. {@link PROBE_ENV_VAR} — a SEPARATE allowlist from the integration's own
 *      `TRADOVATE_OAUTH_ALLOWED_USER_IDS`. Deliberately separate: being allowed
 *      to connect a broker account is not the same permission as being allowed
 *      to run a diagnostic that walks it. Unset means NOBODY, including the
 *      owner.
 *   3. The read-only guard in ./guard.ts, on every upstream call — where the
 *      ALLOWLIST is the control and the denylist is only a net. REF-126 Stage 2
 *      measured why: two write endpoints pass that regex.
 *
 * **404, not 403, for every refusal** — including an unrecognised `mode`, which
 * the REF-113 version answered with a 400. REF-126 Stage 3 item 4 asks for one
 * refusal, and it is right: a 400 on a bad mode tells an unauthorised caller
 * that the route exists and that there is a mode worth guessing.
 *
 *
 * WHAT IT MAY RETURN
 * ------------------
 *
 * Field names, field types, presence booleans, counts, enum members from a
 * fixed vocabulary, and durations in seconds — ./survey.ts owns that rule and
 * fails closed.
 *
 * **Plus two deliberate exceptions, which ./tradingLock.ts argues for one at a
 * time: the trader's OWN account ids, and `errorText` verbatim.** The documented
 * failure strings are the measurement here, and the owner needs the ids to line
 * the answer up against the accounts they locked by hand. Both are the owner's
 * own data, returned to the owner, behind an allowlist holding one id.
 *
 * It may NOT return a balance, a price, a quantity, a position, a fill, an
 * account NAME, an instant, or a hostname. No `endTime` is emitted — only
 * `endsInSeconds`.
 *
 * Two mechanisms, in this order:
 *
 *   - **By construction.** Every field shape goes through `safeSample`, whose
 *     allowlist emits a value only for a known low-cardinality enum.
 *   - **By check.** {@link scanForLeaks} re-reads the finished payload. Its
 *     result is in the response, so a reader can see that it ran rather than
 *     trusting this comment.
 *
 * `redactSecrets` is then applied to the serialised body. It is the LAST line
 * of defence and not the primary one.
 *
 * The two hosts are reported as the logical names `demo` and `live`. No URL is
 * emitted.
 *
 *
 * NO WRITES OF ANY KIND. No Tradovate write — `createaccountlockout` is absent
 * from the allowlist AND matches the denylist, and ./guard.ts reports that
 * refusal in the response. No database write either: `notingPenalty` was
 * deliberately NOT wrapped around these calls, because it records a penalty row
 * and this route's "no DB write" property is worth more than that bookkeeping.
 * `getUserTradingApi` already refuses to run while a penalty is live, so this
 * cannot pile onto one, and ./call.ts reports `rate_limited` if a new one
 * appears. No log line carries a value; this route logs nothing at all.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { getUserTradingApi } from '@/lib/tradovate/connections';
import { redactSecrets } from '@/lib/tradovate/redact';

import { DURATION_MINUTES } from './call';
import { CONFIRM_TOKEN, runCreateLockExperiment } from './createLock';
import { guardSelfCheck, PROBE_ENDPOINTS, THE_ONE_WRITE } from './guard';
import {
  claimedIdsOnHost,
  MAX_ACCOUNT_IDS,
  probeHostTradingLock,
  TRADING_LOCK_QUESTIONS,
} from './tradingLock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Comma-separated Supabase user ids. Unset or empty means nobody. */
export const PROBE_ENV_VAR = 'TRADOVATE_PROBE_USER_ID';

/** The read survey (Stage 3). GET only. */
const MODE = 'lockout';

/**
 * The write experiment (Stage 4). GET renders a form; POST performs it.
 *
 * THE SPLIT IS THE SAFETY PROPERTY, not a REST nicety. A GET that wrote could be
 * fired by a browser prefetch, a refresh, a shared link, a link preview or a
 * bot following a URL out of a chat window — and the thing it fires is
 * irreversible. So GET renders a page and writes nothing, and the write lives
 * behind a POST that additionally needs a typed confirmation string.
 */
const WRITE_MODE = 'create-lock';

/** The host the write experiment runs against. Demo, and not a parameter. */
const WRITE_HOST = 'demo' as const;

const NO_STORE = { 'Cache-Control': 'no-store, private' };

/** The 404 every refused caller gets, whatever the reason. */
function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
}

/**
 * Whether this user may run the probe. Fails closed in every direction, for
 * the reasons lib/tradovate/allowlist.ts spells out — a typo here should mean
 * "the owner cannot run it either", never "everyone can".
 */
export function isProbeUser(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = userId.trim().toLowerCase();
  if (!id) return false;
  const allowed = (env[PROBE_ENV_VAR] ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return allowed.includes(id);
}

/**
 * The grammar every emitted sample must match.
 *
 * `safeSample` produces exactly these shapes: a type placeholder, an array
 * length, `null`, a boolean, or an enum member. Anything else in a `sample`
 * position means a raw value reached the response.
 */
const SAFE_SAMPLE =
  /^(<(string|number|boolean|bigint|symbol|function|object|undefined)>|<array len=\d+>|null|true|false|[A-Za-z][A-Za-z0-9_-]{0,31})$/;

/**
 * The subtree every value of which is checked, not just its `sample` fields.
 *
 * `measurement` (./tradingLock.ts) reports COUNTS and BOOLEANS rather than
 * field shapes, so it has no `sample` keys for the rule above to catch and the
 * rule above would wave it through. Under this key the grammar applies to every
 * string, every object KEY, and numbers must be INTEGERS.
 *
 * The integer rule is the one with teeth: every number in that block is a count
 * by construction, so anything fractional arriving there is a value that was
 * never meant to be a measurement.
 *
 * NOTE WHAT IS DELIBERATELY *OUTSIDE* IT: `accountIdsAsked`, `statuses` and
 * `errors`. Those carry the owner's own ids and the verbatim error strings that
 * REF-126 Stage 3 item 5.4 asks for, and ./tradingLock.ts argues for each. They
 * are exceptions that were decided, not ones that slipped through — which is
 * why they sit outside the strict block rather than having the block weakened
 * to admit them.
 */
const STRICT_SUBTREE_KEY = 'measurement';

/**
 * Re-read the finished payload and confirm no unintended raw value is in it.
 *
 * Returns the offending paths rather than throwing: a probe that refuses to
 * answer because its own self-check tripped tells the owner less than one that
 * answers and says so.
 */
export function scanForLeaks(payload: unknown): {
  ok: boolean;
  samplesChecked: number;
  strictValuesChecked: number;
  offenders: string[];
} {
  const offenders: string[] = [];
  let samples = 0;
  let strictValues = 0;

  /** A leaf inside the strict subtree. Booleans and nulls carry no measurement. */
  const strictLeaf = (value: unknown, path: string): void => {
    if (value === null || value === undefined || typeof value === 'boolean') return;
    strictValues += 1;
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) offenders.push(path);
      return;
    }
    if (typeof value !== 'string' || !SAFE_SAMPLE.test(value)) offenders.push(path);
  };

  const walk = (node: unknown, path: string, strict: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, strict));
      return;
    }
    if (!node || typeof node !== 'object') {
      if (strict) strictLeaf(node, path);
      return;
    }

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (key === 'sample') {
        samples += 1;
        if (typeof value !== 'string' || !SAFE_SAMPLE.test(value)) offenders.push(here);
        continue;
      }
      // Entering the strict subtree is one-way: everything nested below it is
      // checked, so a block cannot opt its own children back out.
      const strictHere = strict || key === STRICT_SUBTREE_KEY;
      if (strictHere && !SAFE_SAMPLE.test(key)) offenders.push(`${here} <key>`);
      walk(value, here, strictHere);
    }
  };

  walk(payload, '', false);
  return {
    ok: offenders.length === 0,
    samplesChecked: samples,
    strictValuesChecked: strictValues,
    offenders,
  };
}

/**
 * The write experiment's form. Plain HTML, no JavaScript.
 *
 * No script tag on purpose: a form POST is a top-level navigation, so it needs
 * no `fetch`, survives a strict CSP, and leaves the browser's own "are you sure
 * you want to resubmit" behaviour in place. The confirmation string is NOT
 * pre-filled — typing it is the deliberate act, and a pre-filled hidden field
 * would reduce the whole gate to one click.
 */
function writeFormHtml(): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<title>REF-126 Stage 4 — ניסוי כתיבה</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem;
       background:#0b0f10;color:#e6edf0}
  h1{font-size:1.25rem} code{background:#182022;padding:.1rem .35rem;border-radius:.25rem}
  .warn{border:1px solid #d9534f;background:#2a1415;padding:1rem;border-radius:.5rem;margin:1.5rem 0}
  .warn ul{margin:.5rem 0 0;padding-inline-start:1.25rem}
  label{display:block;margin:1rem 0 .25rem;font-weight:600}
  input{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;background:#121819;
        color:#e6edf0;border:1px solid #2b3638;border-radius:.35rem}
  button{font:inherit;margin-top:1.5rem;padding:.6rem 1.2rem;background:#d9534f;color:#fff;
         border:0;border-radius:.35rem;cursor:pointer}
</style></head>
<body>
<h1>REF-126 שלב 4 — ניסוי כתיבה יחיד</h1>
<p>הכפתור הזה שולח קריאה אחת ל-<code>POST ${THE_ONE_WRITE}</code> עם
<code>durationMinutes: ${DURATION_MINUTES}</code> על host <code>${WRITE_HOST}</code>.
המשך הנעילה קבוע בקוד ואינו פרמטר.</p>

<div class="warn">
<strong>הפעולה אינה הפיכה.</strong>
<ul>
  <li>פוזיציות פתוחות בחשבון <strong>ייסגרו</strong>, ופקודות ממתינות <strong>יבוטלו</strong>.</li>
  <li><strong>אתה לא יכול לבטל את הנעילה.</strong> רק אדמין של הארגון — כלומר הפירמה — יכול.</li>
  <li>לפני הכתיבה ירוצו שלוש בדיקות קריאה. אם החשבון נעול, יש בו פוזיציה או פקודה פעילה,
      <strong>או שאחת הבדיקות לא הצליחה לענות</strong> — הכתיבה לא תתבצע.</li>
  <li>הרץ זאת על חשבון שטוח, בלי פקודות, מחוץ לשעות המסחר שלך.</li>
</ul>
</div>

<form method="post">
  <label for="accountId">accountId (host ${WRITE_HOST}, חשבון שאומת כשלך)</label>
  <input id="accountId" name="accountId" inputmode="numeric" pattern="[0-9]+" required
         placeholder="למשל 71454220">
  <label for="confirm">הקלד בדיוק <code>${CONFIRM_TOKEN}</code> כדי לאשר</label>
  <input id="confirm" name="confirm" required autocomplete="off" placeholder="${CONFIRM_TOKEN}">
  <button type="submit">נעל את החשבון לדקה אחת</button>
</form>
<p style="margin-top:2rem;opacity:.7">כל סירוב — חשבון שאינו שלך, אישור שגוי, או מצב לא מתאים —
מוחזר כ-404 זהה. התשובה היא JSON להדבקה ב-REF-126.</p>
</body></html>`;
}

/**
 * Same-origin check for the write, when the browser tells us the origin.
 *
 * A cross-site form POST would carry the session cookie only if it were
 * `SameSite=None`, and Supabase's are not — so this is a second lock on a door
 * that is already shut. It is here because the cost is four lines and the thing
 * behind the door cannot be undone. Absent header (curl, a server-side call) is
 * allowed: it is not a browser, so it is not the attack this prevents.
 */
function originMismatch(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** `{ accountId, confirm }`, from either a JSON body or the form above. */
async function readWriteBody(request: Request): Promise<{ accountId: number | null; confirm: string }> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      const raw = body.accountId;
      const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      return {
        accountId: Number.isInteger(parsed) ? parsed : null,
        confirm: typeof body.confirm === 'string' ? body.confirm : '',
      };
    }
    const form = await request.formData();
    const parsed = Number(form.get('accountId'));
    return {
      accountId: Number.isInteger(parsed) ? parsed : null,
      confirm: String(form.get('confirm') ?? ''),
    };
  } catch {
    return { accountId: null, confirm: '' };
  }
}

/**
 * POST /api/tradovate/trading-lock-probe?mode=create-lock — THE WRITE.
 *
 * Six gates, in this order, every one answering an identical 404:
 *
 *   1. a session
 *   2. the probe-user allowlist
 *   3. `mode=create-lock`
 *   4. same-origin, when the browser states an origin
 *   5. `confirm` exactly equal to {@link CONFIRM_TOKEN}
 *   6. `accountId` in the claim set ON THE DEMO HOST — resolved by the same
 *      `claimedIdsOnHost` the Stage 3 survey uses, so the write cannot be
 *      guarded by a second opinion about which accounts are the trader's
 *
 * Then the three preflight READS in ./createLock.ts, any of which blocks. Only
 * after all of that does one unretried call go out.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) return notFound();
  if (!isProbeUser(user.id)) return notFound();
  if (new URL(request.url).searchParams.get('mode') !== WRITE_MODE) return notFound();
  if (originMismatch(request)) return notFound();

  const { accountId, confirm } = await readWriteBody(request);
  // Exact equality. Not `includes`, not case-insensitive, not trimmed.
  if (confirm !== CONFIRM_TOKEN) return notFound();
  if (accountId === null || accountId <= 0) return notFound();

  const guard = guardSelfCheck();

  let api: Awaited<ReturnType<typeof getUserTradingApi>>;
  try {
    api = await getUserTradingApi(user.id);
  } catch {
    return NextResponse.json(
      { error: 'no usable Tradovate connection for this user' },
      { status: 409, headers: NO_STORE }
    );
  }

  const apiUrl = api.hosts[WRITE_HOST].url;
  const callerOptions = { accessToken: api.accessToken, apiUrl, userId: user.id };

  // Gate 6. An account that is not provably this trader's is a 404, not an
  // error message: the caller does not get to learn which ids exist.
  const claim = await claimedIdsOnHost({ ...callerOptions, tradovateUserId: api.tradovateUserId });
  if (!claim.claimed.includes(accountId)) return notFound();

  const nowMs = Date.now();
  const experiment = await runCreateLockExperiment({ ...callerOptions, accountId, nowMs });

  const payload = {
    ticket: 'REF-126 Stage 4',
    mode: WRITE_MODE,
    generatedAt: new Date().toISOString(),
    host: WRITE_HOST,
    theOneWrite: THE_ONE_WRITE,
    readOnlyGuard: {
      ok: guard.ok,
      allowlist: [...PROBE_ENDPOINTS],
      writeDoorAcceptsOnly: guard.writeDoorAcceptsOnly,
      writeEndpoints: guard.writeEndpoints,
      mutationShapedEndpoints: guard.offenders,
    },
    experiment,
  };

  const leakGuard = scanForLeaks(payload);
  const body = JSON.parse(redactSecrets(JSON.stringify({ ...payload, leakGuard })));
  return NextResponse.json(body, { headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // All refusals answer identically — see the header on why.
  if (!user?.id) return notFound();
  if (!isProbeUser(user.id)) return notFound();

  const mode = new URL(request.url).searchParams.get('mode');

  // The write experiment's GET renders a form and performs NOTHING. Every
  // upstream call it would make lives in the POST handler below.
  if (mode === WRITE_MODE) {
    return new NextResponse(writeFormHtml(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
    });
  }

  if (mode !== MODE) return notFound();

  // The allowlist is checked per call in ./call.ts; this reports the guard's
  // verdict on itself, so the response can state that no listed endpoint is
  // mutation-shaped AND that the four named write endpoints are refused, rather
  // than asking a reader to trust it.
  const guard = guardSelfCheck();

  let api: Awaited<ReturnType<typeof getUserTradingApi>>;
  try {
    // Pairs the token with the hosts it is addressed to, decrypts it, renews it
    // if it is close to expiring, and refuses outright while a rate-limit
    // penalty is live.
    api = await getUserTradingApi(user.id);
  } catch {
    // No detail: the message can name the connection's state, and the caller
    // already knows whether they connected an account.
    return NextResponse.json(
      { error: 'no usable Tradovate connection for this user' },
      { status: 409, headers: NO_STORE }
    );
  }

  // One clock for the whole report, so two hosts' offsets are comparable.
  const nowMs = Date.now();

  const hosts: Record<string, unknown> = {};
  for (const host of ['demo', 'live'] as const) {
    // BOTH HOSTS, SEQUENTIALLY, AND NOT ROUTED BY `api.environment` — that
    // field is the token's MINT server and says nothing about where the
    // trader's accounts live (REF-90; `connections.ts:736-748`, which measured
    // an evaluation account on demo while live held nothing). A host with no
    // provisioning answers 401/403, which ./call.ts records as an answer.
    hosts[host] = await probeHostTradingLock({
      accessToken: api.accessToken,
      apiUrl: api.hosts[host].url,
      userId: user.id,
      tradovateUserId: api.tradovateUserId,
      nowMs,
    });
  }

  const payload = {
    ticket: 'REF-126 Stage 3',
    mode: MODE,
    generatedAt: new Date().toISOString(),
    questions: TRADING_LOCK_QUESTIONS,
    readOnlyGuard: {
      ok: guard.ok,
      allowlist: [...PROBE_ENDPOINTS],
      mutationShapedEndpoints: guard.offenders,
      writeDoorAcceptsOnly: guard.writeDoorAcceptsOnly,
      writeEndpoints: guard.writeEndpoints,
      note:
        'ה-allowlist היא הבקרה; ה-denylist היא רשת בלבד. שימו לב ש-byDenylist=false ' +
        'על שני endpoints כותבים — בדיוק הפער שחלק ב\' של שלב 2 מדד. ' +
        'refusedByReadDoor=true לכל הארבעה; רק createaccountlockout עובר בדלת הכתיבה.',
    },
    maxAccountIdsPerRequest: MAX_ACCOUNT_IDS,
    hosts,
  };

  const leakGuard = scanForLeaks(payload);

  // Serialise, redact, parse back. redactSecrets takes a string, and this is
  // the last thing that happens to the body — see the header on why it is the
  // net and not the mechanism.
  const body = JSON.parse(redactSecrets(JSON.stringify({ ...payload, leakGuard })));

  return NextResponse.json(body, { headers: NO_STORE });
}
