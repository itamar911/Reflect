/**
 * POST /api/tradovate/disconnect — remove a user's Tradovate connection.
 *
 * POST rather than GET because it destroys data: a GET would be triggerable by
 * any image tag or prefetch pointed at it. Reflect's Supabase session cookies are
 * SameSite=Lax, so a cross-site POST arrives without them and fails the auth
 * check below — which is the CSRF defence for this route.
 *
 * Returns JSON. Unlike connect and callback this is called from the app rather
 * than navigated to, so there is no redirect.
 *
 * On what "revoke" can mean here: Tradovate publishes no OAuth token-revocation
 * endpoint. disconnectUser() destroys our copy of the token, drops it from the
 * in-process cache, and stops renewing — after which the access token lapses on
 * its own. See the note on disconnectUser in lib/tradovate/connections.ts.
 */

import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { disconnectUser } from '@/lib/tradovate/connections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { existed } = await disconnectUser(user.id);
    // Disconnecting something already gone is a success, not a 404: the caller
    // asked for a state, and the state holds.
    return NextResponse.json({ ok: true, disconnected: existed });
  } catch (error) {
    console.error(
      '[tradovate] disconnect failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
