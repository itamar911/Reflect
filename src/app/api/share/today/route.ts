/**
 * The owner's side of the share card: list today's links, and mint one.
 *
 * THE DAY IS THE SERVER'S AND NOT THE CLIENT'S, which is why this route is
 * `/today` rather than `/[day]`. `currentTradingDay()` is the Stage 1
 * definition and runs here; a client-supplied day would let a trader publish a
 * card labelled with a day whose trades are not the ones in it, and would be a
 * second answer to "what is today" after REF-125 spent a stage reducing six to
 * one.
 *
 * POST AND NOT PUT, following the repo's own rule for state-changing routes
 * (tradovate/disconnect/route.ts:3-12, account/delete/route.ts:8-11): Supabase
 * session cookies are `SameSite=Lax`, so a cross-site POST arrives without
 * them and fails the auth check below. There is no CSRF token anywhere in this
 * codebase and this route does not introduce the need for one.
 */

import { NextResponse } from 'next/server';

import {
  createDailyShare,
  readShareToday,
  shareExistsForDay,
  writeOwnPublicNickname,
} from '@/lib/share/store';
import { readShareVisibility } from '@/lib/share/snapshot';
import { createClient } from '@/lib/supabase/server';
import { currentTradingDay } from '@/lib/tradingDay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Per-user and never cacheable: these are a trader's own unpublished links. */
const NO_STORE = { 'Cache-Control': 'no-store, private' };

/**
 * "The table is not there yet" — the one body four call sites answer with.
 *
 * A FUNCTION AND NOT A CONSTANT. A `NextResponse` carries a body stream that is
 * consumed once, so a shared instance would serve the first request and fail
 * the second. See the GET docblock for what this status means.
 */
const unavailable = () =>
  NextResponse.json(
    { error: 'share_unavailable', available: false },
    { status: 503, headers: NO_STORE }
  );

/**
 * What the dialog opens onto — or, with `?probe=1`, merely whether to draw the
 * button.
 *
 * `available: false` IS A 503 AND NOT AN EMPTY LIST, because the two mean
 * opposite things to the button: an empty list means "you have not shared
 * today", and an absent table means "this feature is not deployed". The
 * dashboard hides the control entirely on the second and offers it on the
 * first, so collapsing them would put a button in front of a trader that
 * cannot work.
 *
 *
 * TWO SHAPES, AND THE CHEAP ONE IS WHAT THE DASHBOARD CALLS
 * --------------------------------------------------------
 *
 * REF-125 follow-up item 1.1. This route had one response, and `ShareDayButton`
 * fetched it ON MOUNT to decide whether the feature exists — so every single
 * dashboard load built the full snapshot: a 120-day scan of `trade_plans`, a
 * read of `accounts`, and a read of `profiles`, to answer a boolean. The dialog
 * was then opened by perhaps one load in fifty.
 *
 * So the question the dashboard asks is now its own request:
 *
 *     ?probe=1   → { available, day, exists }      one indexed row
 *     (no param) → { available, day, nickname, preview, shares }
 *
 * The dialog asks the second one when it opens, which is also when the trader
 * has asked to see a preview — and `previewDailyShare`'s docblock has always
 * said "the dialog calls it on open". That is now true.
 *
 * ONE ROUTE AND NOT TWO, because the two answers are the same question about
 * the same day at two depths, and a `/api/share/today/probe` would need its own
 * auth, its own cache headers and its own 503 for the sake of one query.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const day = currentTradingDay(new Date());
  const params = new URL(request.url).searchParams;
  // `?all=1` lists every day's links rather than today's. The dialog asks for
  // today; the parameter exists because "which of my links are live" is the
  // question a revoke UI will eventually be built around, and answering it
  // needed no second route.
  const all = params.get('all') === '1';

  if (params.get('probe') === '1') {
    const exists = await shareExistsForDay({ supabase, userId: user.id, day });
    if (!exists.ok) {
      if (exists.reason === 'unavailable') return unavailable();
      console.error(`[share] probe failed (${exists.reason})`);
      return NextResponse.json({ error: 'share_list_failed' }, { status: 500, headers: NO_STORE });
    }
    // `exists` IS NOT READ BY THE BUTTON TODAY and is in the response anyway:
    // it is the only thing the probe learns beyond "deployed", it costs no
    // extra query, and "you already have a link for today" is the state a
    // future label on the control would be written from.
    return NextResponse.json({ available: true, day, exists: exists.value }, { headers: NO_STORE });
  }

  // The links, the handle, and the card as it WOULD be published right now —
  // built and not stored, in parallel. The arrangement lives in the store; see
  // `readShareToday`.
  const today = await readShareToday({ supabase, userId: user.id, day, all });
  if (!today.ok) {
    if (today.reason === 'unavailable') return unavailable();
    console.error(`[share] list failed (${today.reason})`);
    return NextResponse.json({ error: 'share_list_failed' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json({ available: true, day, ...today.value }, { headers: NO_STORE });
}

/**
 * Freeze today's card and return its link.
 *
 * `nickname` IS ACCEPTED HERE rather than through a route of its own, and that
 * is the dialog's flow rather than a shortcut: a trader with no handle yet
 * types one in the dialog and presses "צור קישור", so the write and the mint
 * are one action and one request. It is written BEFORE the snapshot is built,
 * because the snapshot copies the stored value — see createDailyShare.
 *
 * A nickname is saved even when the toggle is off. That is deliberate: the
 * handle is a profile setting the trader has now chosen, and discarding it
 * because they did not also publish it this time would mean retyping it on
 * the next card.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  let body: Record<string, unknown> = {};
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
    }
  }

  // Fail-closed: a body with no `visibility` at all yields all-false, so a
  // caller that forgets the field publishes LESS rather than more.
  const visibility = readShareVisibility(body.visibility);

  if (body.nickname !== undefined) {
    const written = await writeOwnPublicNickname(
      supabase,
      user.id,
      body.nickname === null ? null : String(body.nickname)
    );
    if (!written.ok && written.reason === 'unavailable') return unavailable();
    if (!written.ok) {
      console.error(`[share] nickname write failed (${written.reason})`);
      return NextResponse.json(
        { error: 'nickname_write_failed' },
        { status: 500, headers: NO_STORE }
      );
    }
  }

  const day = currentTradingDay(new Date());
  const created = await createDailyShare({ supabase, userId: user.id, day, visibility });

  if (!created.ok) {
    if (created.reason === 'unavailable') return unavailable();
    // The code and nothing else. This route's subject matter is a trader's own
    // day, and a PostgREST message interpolated into a response can carry
    // column names and values — tradovate/trades/route.ts:249-252 makes the
    // same reduction for the same reason.
    console.error(`[share] create failed (${created.reason})`);
    return NextResponse.json({ error: 'share_create_failed' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true, day, share: created.value }, { headers: NO_STORE });
}
