/**
 * Every read and write of `daily_shares`, in one module (REF-125 Stage 2).
 *
 * SERVER ONLY. The public read uses the service role, which bypasses RLS —
 * never import this into anything that reaches the browser.
 *
 *
 * WHY ONE MODULE
 * --------------
 *
 * Because `snapshot` is the feature's whole privacy surface and the public
 * read is the only path a stranger is on. Keeping that read in one function
 * means the column list it names — `snapshot, revoked_at, trading_day` — is a
 * thing a reviewer can check once rather than a thing every future call site
 * has to get right. There is deliberately NO `select('*')` on the public path
 * anywhere in this file: a row carries `user_id`, and a wildcard select would
 * put it one careless `JSON.stringify` away from a page.
 *
 * Migration 043's header records what this arrangement replaced — the ticket's
 * `SECURITY DEFINER` RPC — and what it gives up by not having it.
 *
 *
 * EVERY FUNCTION HERE SURVIVES THE TABLE NOT EXISTING
 * ---------------------------------------------------
 *
 * Migrations are run by hand by the owner (CLAUDE.md), so there is a window in
 * which this code is deployed and `daily_shares` is not there. Each function
 * returns a DISCRIMINATED UNION whose `'unavailable'` arm means exactly that,
 * classified by `isMissingTable()` — so the API routes answer a clean 503, the
 * dashboard does not render the button, and nothing anywhere logs a stack
 * trace about a table that was never promised. 042's header makes the general
 * argument; this is its narrow case.
 *
 * `'unavailable'` IS NOT `'failed'`, and collapsing the two would be the bug.
 * A failure is worth a 500 and a log line; an absent table is the expected
 * state of a deployment that is simply ahead of its migration, and a 500 there
 * would read as a broken feature rather than an unbuilt one.
 */

import { randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';

import { createAdminClient } from '@/lib/supabase/admin';
import { isMissingColumn, isMissingTable } from '@/lib/supabase/missing';
import { tradingDayBounds, type TradingDay } from '@/lib/tradingDay';

import {
  buildDailyShareSnapshot,
  readDailyShareSnapshot,
  readPublicNickname,
  readShareVisibility,
  type DailyShareSnapshot,
  type ShareTradeRow,
  type ShareVisibility,
} from './snapshot';

/**
 * 256 bits. The same constant and the same reasoning as
 * `STATE_BYTES` in lib/tradovate/oauth-state.ts — "not guessable, and cheap" —
 * which is the repo's reference implementation for a random capability.
 *
 * `base64url` because the token goes in a path segment. 32 bytes is 43
 * characters, comfortably past migration 043's 24-character CHECK.
 */
const SHARE_TOKEN_BYTES = 32;

/**
 * How far back the snapshot's trade query reaches.
 *
 * THE SQL FILTER IS DELIBERATELY WIDER THAN THE ANSWER. Which trades belong to
 * a trading day is decided by `countedShareTrades()`, in TypeScript, against
 * `tradingDayOfTrade` — the Stage 1 definition. This bound exists only to keep
 * the query from reading a trader's whole history, and it is generous on
 * purpose: a row is dated by `closed_at ?? submitted_at`, so a position opened
 * months before it closed is dated into the day it CLOSED, and a SQL filter
 * cut at the day's own window would silently drop it.
 *
 * Having two places decide which rows count is the precise failure REF-125
 * exists to have ended, so only one of them decides and the other is a bound.
 */
const TRADE_LOOKBACK_DAYS = 120;

/** Columns the OWNER's own reads may name. `snapshot` is included: it is theirs. */
const OWN_SHARE_COLUMNS = 'token,trading_day,visibility,snapshot,revoked_at,created_at';

/**
 * Columns the PUBLIC read may name. Three, and the list is the point.
 *
 * NO `user_id`, NO `id`, NO `created_at`. A stranger gets the card, whether it
 * is still live, and which day it describes. `trading_day` is here rather than
 * taken from the snapshot so that a snapshot which fails to parse still 404s
 * against a real row instead of rendering a dayless page.
 */
const PUBLIC_SHARE_COLUMNS = 'snapshot,revoked_at,trading_day';

/** A share as its owner sees it in the dialog. */
export interface OwnShare {
  token: string;
  tradingDay: TradingDay;
  visibility: ShareVisibility;
  snapshot: DailyShareSnapshot | null;
  revokedAt: string | null;
  createdAt: string;
}

export type ShareResult<T> =
  | { ok: true; value: T }
  /** `daily_shares` does not exist yet. Expected; not an error. */
  | { ok: false; reason: 'unavailable' }
  /** No live row for that token, or not this trader's. Indistinguishable on purpose. */
  | { ok: false; reason: 'not_found' }
  /** A real database failure. Worth a 500 and a log line. */
  | { ok: false; reason: 'failed'; code: string };

const unavailable = { ok: false, reason: 'unavailable' } as const;
const notFound = { ok: false, reason: 'not_found' } as const;
const failed = (code: string | null | undefined) =>
  ({ ok: false, reason: 'failed', code: code ?? 'unknown' }) as const;

/** A fresh capability. */
export function mintShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
}

/**
 * Whether a string could be one of our tokens, before it reaches the database.
 *
 * Mirrors migration 043's `daily_shares_token_shape_check`. Cheap, and it
 * means a path segment full of punctuation never becomes a query — which also
 * keeps the public page's 404 path free of database work for the obvious
 * garbage.
 *
 * NOT A SECURITY BOUNDARY and not a substitute for the lookup: a well-shaped
 * token that is not in the table is still not found. There is no constant-time
 * comparison anywhere in this file and none is wanted — the token is looked up
 * by a UNIQUE index rather than compared against a secret, so there is no
 * secret to leak timing about.
 */
export function isWellFormedShareToken(value: string): boolean {
  return value.length >= 24 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

// ── The owner's side ────────────────────────────────────────────────────────

/**
 * The trader's own opt-in handle, or null.
 *
 * A ONE-COLUMN READ OF ITS OWN rather than a field added to the dashboard's
 * `profiles` select, and that is what makes the column safe to deploy before
 * 043 runs. Naming `public_nickname` in an existing select would be a 42703
 * that takes the whole dashboard down; naming it here means the failure is
 * this read's alone, and its answer — null — is already the value that means
 * "has not opted in". A pre-043 database therefore renders every card
 * anonymously, which is the only correct card for a database in which nobody
 * can have opted in.
 */
export async function readOwnPublicNickname(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('public_nickname')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    if (isMissingColumn(error) || isMissingTable(error)) return null;
    // Any other failure is also answered as "no handle". The alternative is
    // failing the whole mint over a name the trader may not even have set, and
    // anonymous is the safe direction for a public card by construction.
    console.warn(`[share] nickname read failed (${error.code ?? 'no code'})`);
    return null;
  }
  return readPublicNickname((data as { public_nickname?: unknown } | null)?.public_nickname);
}

/** Write the handle. `null` clears it, which is how a trader opts back out. */
export async function writeOwnPublicNickname(
  supabase: SupabaseClient,
  userId: string,
  nickname: string | null
): Promise<ShareResult<string | null>> {
  const normalised = nickname === null ? null : readPublicNickname(nickname);

  const { error } = await supabase
    .from('profiles')
    .update({ public_nickname: normalised })
    .eq('id', userId);

  if (error) {
    // The COLUMN is what might be missing here, not the table — `profiles` has
    // existed since schema.sql. Reported as 'unavailable' all the same: from
    // the caller's side the handle feature is equally not deployed.
    if (isMissingColumn(error) || isMissingTable(error)) return unavailable;
    return failed(error.code);
  }
  return { ok: true, value: normalised };
}

/**
 * Build today's card WITHOUT publishing it — what the dialog previews.
 *
 * THE SAME FUNCTION THE MINT USES, which is the whole point:
 * `createDailyShare` calls this and inserts the result, so the trader cannot
 * be shown one thing and publish another. A separate "preview" code path is
 * precisely the bug this shape forecloses, and it is a bug that would be
 * invisible in review — two builders agreeing today and drifting in six
 * months.
 *
 * Costs the same two reads as the mint and writes nothing. The dialog calls it
 * on open, so pressing "צור קישור" immediately afterwards does repeat them;
 * that is accepted rather than cached, because a snapshot is a claim about a
 * moment and the moment that matters is the one the trader published in, not
 * the one they opened a dialog in.
 */
export async function previewDailyShare({
  supabase,
  userId,
  day,
  visibility,
}: {
  supabase: SupabaseClient;
  userId: string;
  day: TradingDay;
  visibility: ShareVisibility;
}): Promise<ShareResult<DailyShareSnapshot>> {
  const rows = await readTradesForDay(supabase, userId, day);
  if (!rows.ok) return rows;

  return {
    ok: true,
    value: buildDailyShareSnapshot({
      rows: rows.value,
      day,
      visibility,
      publicNickname: visibility.nickname ? await readOwnPublicNickname(supabase, userId) : null,
    }),
  };
}

/**
 * Freeze today's card and mint a link for it.
 *
 * TWO READS AND ONE WRITE, in that order, and the order is the only thing here
 * that matters: the snapshot is built from what the trader's own session can
 * see — `supabase` is the RLS-scoped client, so the trade query returns their
 * rows and nobody else's — and then written as a value. Nothing about the
 * public row is derived later.
 *
 * RE-SHARING A DAY MINTS A NEW ROW, deliberately. There is no upsert and no
 * unique on `(user_id, trading_day)`: a trader who shares Tuesday twice has
 * two independently revocable links, because collapsing them would mean
 * revoking today's link silently breaks the one they sent last week
 * (REF-125 §7).
 */
export async function createDailyShare({
  supabase,
  userId,
  day,
  visibility,
}: {
  supabase: SupabaseClient;
  userId: string;
  day: TradingDay;
  visibility: ShareVisibility;
}): Promise<ShareResult<OwnShare>> {
  const built = await previewDailyShare({ supabase, userId, day, visibility });
  if (!built.ok) return built;
  const snapshot = built.value;

  const token = mintShareToken();
  const { data, error } = await supabase
    .from('daily_shares')
    .insert({ user_id: userId, token, trading_day: day, snapshot, visibility })
    .select(OWN_SHARE_COLUMNS)
    .single();

  if (error) {
    if (isMissingTable(error)) return unavailable;
    return failed(error.code);
  }
  const share = toOwnShare(data);
  return share === null ? failed('unreadable_row') : { ok: true, value: share };
}

/**
 * The trader's own shares, newest first — optionally for one day only.
 *
 * What the dialog opens onto: "you already have a live link for today" is the
 * state that decides whether it offers a copy button or a create button.
 */
export async function listOwnShares({
  supabase,
  userId,
  day,
}: {
  supabase: SupabaseClient;
  userId: string;
  day?: TradingDay;
}): Promise<ShareResult<OwnShare[]>> {
  let query = supabase
    .from('daily_shares')
    .select(OWN_SHARE_COLUMNS)
    .eq('user_id', userId);
  if (day !== undefined) query = query.eq('trading_day', day);

  const { data, error } = await query.order('created_at', { ascending: false }).limit(50);

  if (error) {
    if (isMissingTable(error)) return unavailable;
    return failed(error.code);
  }
  const rows = (data ?? []) as unknown[];
  return { ok: true, value: rows.map(toOwnShare).filter((s): s is OwnShare => s !== null) };
}

/**
 * Revoke a link, or change what it shows. Owner only.
 *
 * THE OWNERSHIP TEST IS THE `.eq('user_id', userId)` AND NOT A PRIOR READ, so
 * a token belonging to somebody else matches no row and comes back
 * `'not_found'` — the same answer as a token that never existed. That is
 * `link_broker_trade`'s rule (035:248-250): put the predicate in the WHERE
 * clause, so the statement cannot report whether a row exists. RLS says the
 * same thing underneath; this is the half that does not depend on it.
 *
 * `snapshot` IS NEVER WRITTEN HERE. Turning the nickname toggle off after the
 * fact changes what the stored card SAYS only if the stored card is rewritten,
 * and rewriting it would mean a link whose content changes under its reader —
 * the thing freezing exists to prevent. So a visibility change applies to
 * cards minted from now on, and the honest way to un-publish a name already
 * published is to revoke the link and mint a new one. The dialog says exactly
 * that; see ShareDayDialog.
 */
export async function updateDailyShare({
  supabase,
  userId,
  token,
  revoke,
  visibility,
}: {
  supabase: SupabaseClient;
  userId: string;
  token: string;
  revoke?: boolean;
  visibility?: ShareVisibility;
}): Promise<ShareResult<OwnShare>> {
  const patch: Record<string, unknown> = {};
  if (revoke === true) patch.revoked_at = new Date().toISOString();
  // Un-revoking is deliberately expressible: a trader who revoked by mistake
  // has no other way back to the same link, and the alternative — mint a new
  // one — invalidates the link they already sent, which is the outcome they
  // were trying to undo.
  if (revoke === false) patch.revoked_at = null;
  if (visibility !== undefined) patch.visibility = visibility;

  if (Object.keys(patch).length === 0) return notFound;

  const { data, error } = await supabase
    .from('daily_shares')
    .update(patch)
    .eq('token', token)
    .eq('user_id', userId)
    .select(OWN_SHARE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return unavailable;
    return failed(error.code);
  }
  if (data === null) return notFound;
  const share = toOwnShare(data);
  return share === null ? failed('unreadable_row') : { ok: true, value: share };
}

// ── The public side ────────────────────────────────────────────────────────

export interface SharedCard {
  snapshot: DailyShareSnapshot;
  tradingDay: TradingDay;
}

/**
 * The card behind a token, for an anonymous visitor — or nothing.
 *
 * THE ONLY FUNCTION IN THE PRODUCT THAT READS THIS TABLE WITH THE SERVICE
 * ROLE, and the reason the public page needs no `anon` grant: the browser
 * never holds a Supabase client, so an anonymous VISITOR is served by an
 * authenticated READER. Migration 043's "WHO MAY READ ANY OF THIS" is the long
 * version.
 *
 * `revoked_at IS NULL` IS IN THE QUERY. A revoked token and an invented one
 * produce the identical answer, so the page cannot be used to probe which
 * tokens are real — and a trader who revokes gets a 404 rather than a page
 * that says "this was withdrawn", which would still confirm it existed. The
 * Hebrew "הקישור בוטל" copy is what the page renders for BOTH cases, which is
 * the honest compromise: it tells a human what probably happened without
 * telling a scanner anything.
 *
 * DEMO MODE GOES THROUGH THE FIXTURE CLIENT, which is the one branch in this
 * file that knows demo mode exists. It mirrors the single sanctioned exception
 * at lib/supabase/server.ts:7-13 exactly, and it is needed because
 * `createAdminClient()` is not the client that function returns — a
 * `/demo/share/...` request would otherwise reach the real database with the
 * service role, which is the opposite of what /demo is for.
 *
 * THE HEADER CANNOT BE SPOOFED: src/proxy.ts:15-20 rejects any inbound request
 * carrying `x-demo-mode` with a 400, and the only thing that sets it is the
 * /demo rewrite. So this branch is reachable from /demo/* and from nowhere
 * else.
 */
export async function readSharedCard(token: string): Promise<SharedCard | null> {
  if (!isWellFormedShareToken(token)) return null;

  const client = await publicReadClient();

  const { data, error } = await client
    .from('daily_shares')
    .select(PUBLIC_SHARE_COLUMNS)
    .eq('token', token)
    .is('revoked_at', null)
    .maybeSingle();

  // EVERY FAILURE IS A 404, including a missing table. There is nothing useful
  // to tell a stranger about our deployment state, and a 503 on the public
  // page would announce that a share feature exists and is half-built. The
  // code is logged for us; the visitor gets a card or nothing.
  if (error) {
    // PGRST116 is "no rows" and is the ordinary not-found path through the
    // demo stub, whose maybeSingle() behaves like single(). Not worth a line.
    if (error.code !== 'PGRST116' && !isMissingTable(error)) {
      console.warn(`[share] public read failed (${error.code ?? 'no code'})`);
    }
    return null;
  }
  if (data === null) return null;

  const row = data as { snapshot?: unknown; trading_day?: unknown };
  const snapshot = readDailyShareSnapshot(row.snapshot);
  if (snapshot === null) return null;

  const tradingDay = typeof row.trading_day === 'string' ? row.trading_day : snapshot.day;
  return { snapshot, tradingDay };
}

/**
 * The service-role client, or the fixture one under /demo.
 *
 * `createAdminClient()` THROWS when its env vars are missing (admin.ts:6), and
 * that throw is left to propagate: a deployment with no service-role key
 * cannot serve this page at all, and swallowing it into a 404 would make a
 * misconfiguration look like an empty table.
 */
async function publicReadClient(): Promise<SupabaseClient> {
  const headerStore = await headers();
  if (headerStore.get('x-demo-mode') === '1') {
    const { createDemoServerClient } = await import('@/lib/demo/demoServer');
    return createDemoServerClient();
  }
  return createAdminClient();
}

// ── Shared plumbing ────────────────────────────────────────────────────────

/**
 * The rows a day's snapshot is built from.
 *
 * `select('*')` AND NOT A COLUMN LIST, which is the decision that makes this
 * safe on a database missing 034, 037, 038 or 041. A wildcard returns whatever
 * the database has and simply omits the keys it does not, so `source`,
 * `stop_history` and `hidden` arrive when they exist and are `undefined` when
 * they do not — and `ShareTradeRow` declares all three optional for exactly
 * that reason. A named column list would be a 42703 and a failed mint.
 * app/(app)/trades/page.tsx:144-157 is the precedent and states the rule.
 *
 * The wildcard is safe HERE in a way it would not be on the public path: this
 * is the owner's own RLS-scoped session reading their own trades, and the rows
 * go straight into the allow-list builder, which names every field it emits.
 */
async function readTradesForDay(
  supabase: SupabaseClient,
  userId: string,
  day: TradingDay
): Promise<ShareResult<ShareTradeRow[]>> {
  const { start } = tradingDayBounds(day);
  const from = new Date(start.getTime() - TRADE_LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('trade_plans')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'not_entered')
    .gte('submitted_at', from)
    .order('submitted_at', { ascending: false })
    .limit(1000);

  if (error) {
    // `trade_plans` predates everything and is not what can be missing here,
    // so a missing-table code would mean something much larger is wrong. It is
    // still classified rather than thrown: the caller's 503 is a better answer
    // than a stack trace either way.
    if (isMissingTable(error)) return unavailable;
    return failed(error.code);
  }
  return { ok: true, value: (data ?? []) as ShareTradeRow[] };
}

/** One wire row to the shape the dialog reads. Null when it cannot be read. */
function toOwnShare(value: unknown): OwnShare | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.token !== 'string' || typeof raw.trading_day !== 'string') return null;
  return {
    token: raw.token,
    tradingDay: raw.trading_day,
    visibility: readShareVisibility(raw.visibility),
    snapshot: readDailyShareSnapshot(raw.snapshot),
    revokedAt: typeof raw.revoked_at === 'string' ? raw.revoked_at : null,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
  };
}
