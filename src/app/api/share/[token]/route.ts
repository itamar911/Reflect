/**
 * Revoke a share link, or change what it shows. Owner only.
 *
 * THE FIRST DYNAMIC ROUTE SEGMENT IN THIS CODEBASE and the first PATCH handler
 * — both worth naming, because there is no local precedent to match and a
 * reader will look for one.
 *
 * On Next 16 `params` is a Promise and has to be awaited; there is no other
 * `[param]` route here to copy that from, so it is written out rather than
 * inferred. The token is in the PATH rather than the body because it names the
 * resource being changed, which is what a path segment is for — and because
 * the public page's URL already has that shape, so one token format serves
 * both.
 *
 * PATCH RATHER THAN THE POST THIS REPO OTHERWISE USES, and it is safe for a
 * better reason than POST is. The CSRF argument recorded at
 * tradovate/disconnect/route.ts:3-12 is that Supabase cookies are
 * `SameSite=Lax`, so a cross-site POST arrives without them. PATCH is stronger
 * still: it is not a CORS "simple method", so a cross-origin attempt needs a
 * preflight that this route never answers, and the request is never made.
 * PATCH is also the honest verb — this edits two fields of an existing row and
 * leaves the rest, which is precisely what the method means.
 */

import { NextResponse } from 'next/server';

import { readShareVisibility } from '@/lib/share/snapshot';
import { isWellFormedShareToken, updateDailyShare } from '@/lib/share/store';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' };

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const { token } = await params;
  // Shape-checked before it becomes a query. A malformed token is 404 and not
  // 400, for the same reason a wrong one is: this route must not be usable to
  // learn anything about which tokens exist.
  if (!isWellFormedShareToken(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  // Two independent fields, and either alone is a valid request. `revoked`
  // absent means "leave the revocation alone" — distinct from `false`, which
  // means "un-revoke". `undefined` and `false` must not collapse, or every
  // visibility change would quietly restore a revoked link.
  const revoke = typeof body.revoked === 'boolean' ? body.revoked : undefined;
  const visibility =
    body.visibility === undefined ? undefined : readShareVisibility(body.visibility);

  if (revoke === undefined && visibility === undefined) {
    return NextResponse.json({ error: 'nothing_to_change' }, { status: 400, headers: NO_STORE });
  }

  const updated = await updateDailyShare({
    supabase,
    userId: user.id,
    token,
    revoke,
    visibility,
  });

  if (!updated.ok) {
    if (updated.reason === 'unavailable') {
      return NextResponse.json(
        { error: 'share_unavailable', available: false },
        { status: 503, headers: NO_STORE }
      );
    }
    // A token that is not this trader's is 'not_found', not 403 — the store
    // puts the ownership test in the WHERE clause so the two cases are the
    // same answer. A 403 would confirm the link exists and belongs to somebody.
    if (updated.reason === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
    }
    console.error(`[share] update failed (${updated.reason})`);
    return NextResponse.json({ error: 'share_update_failed' }, { status: 500, headers: NO_STORE });
  }

  return NextResponse.json({ ok: true, share: updated.value }, { headers: NO_STORE });
}
