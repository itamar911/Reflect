/**
 * Reading and writing `accounts` from either half of the product
 * (REF-110 Stages 3-4).
 *
 * Takes a `SupabaseClient` rather than making one, which is what lets the same
 * four functions serve the RSC screen (server client), the trade form (browser
 * client) and the regression suite (a stub). Every statement here runs under
 * the caller's own session and 037's `accounts_owner` policy; `user_id` is
 * carried explicitly anyway, for `import.ts`'s reason — a filter that is
 * stated is a filter that can be asserted.
 *
 *
 * THE GATE, AND WHY IT IS THE IMPORT FLAG
 * ---------------------------------------
 *
 * `accounts` and `trade_plans.account_id` are migration 037's, and a
 * deployment that has not run it answers a query naming either with PostgREST
 * `42703`/`42P01` — a 500 on whichever page asked. `isImportEnabled()` is the
 * flag the owner sets after running the migration and is already the gate for
 * 034's columns everywhere in this codebase (`withHidden`, `setups/page.tsx`,
 * `dashboard/page.tsx`, `account-sync.ts`). Using a second flag for the same
 * question would mean two ways to be half-deployed.
 *
 * It is evaluated SERVER-SIDE ONLY and passed down as a prop, exactly as
 * `withHidden`'s header describes: `lib/tradovate/import.ts` reads
 * `process.env` and must not be pulled into a browser bundle.
 *
 *
 * PRIVACY — READ THIS BEFORE JOINING THIS TABLE INTO ANYTHING
 * -----------------------------------------------------------
 *
 * `display_name` is the first BROKER-SUPPLIED FREE TEXT this product stores,
 * and on a prop trader's account it is a firm's name. `nickname` is the
 * trader's own writing about their own money. Both are allowed exactly one
 * destination: the screen, under that trader's own RLS.
 *
 *   - NEVER IN A LOG. `account-sync.ts` logs counts and never names; nothing
 *     here logs at all. An account id is not logged either (`import-cron.ts`
 *     states that rule for the whole integration).
 *   - **NEVER IN AN AI PROMPT.** This is the hazard REF-110's §F named and the
 *     reason this paragraph sits at the read site rather than in a document.
 *     `ai-chat` sends `select('*')` over a hundred trades to Claude, so it
 *     already carries `account_id` — a UUID of ours, and harmless precisely
 *     because it is meaningless to a third party. It stays harmless only while
 *     nobody joins this table to it. The moment a prompt says
 *     "account: <display_name>", a prop firm's name leaves this product.
 *     If a per-portfolio AI feature is ever wanted, send the UUID and resolve
 *     the name on the way back out, in the browser.
 *
 * The AI routes are `src/app/api/ai-chat`, `ai-coach`, `ai-debrief`,
 * `ai-patterns`, `ai-trade-review`, plus `lib/weekly` and the alert mails.
 * None of them imports this module, and none of them should.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Portfolio, PortfolioStatus } from './portfolio';

/**
 * The columns every reader of this table asks for, and no more.
 *
 * `select('*')` is deliberately not used: the point of naming them is that the
 * list above is the whole of what can reach a screen, so a column added to
 * `accounts` later does not silently start travelling.
 */
export const PORTFOLIO_SELECT =
  'id,broker,display_name,nickname,status,hidden,last_seen_at';

/** The wire shape of {@link PORTFOLIO_SELECT}. */
interface RawPortfolioRow {
  id: string;
  broker: string;
  display_name: string;
  nickname: string | null;
  status: string;
  hidden: boolean | null;
  last_seen_at: string | null;
}

const STATUSES: readonly string[] = ['active', 'closed', 'archived'];

/**
 * A stored row, narrowed.
 *
 * An unrecognised `status` falls back to 'active' rather than being dropped.
 * 037's CHECK makes the case impossible today; if a fourth value is ever added
 * to it, a portfolio the trader owns must not disappear from their own screen
 * because this file is a deploy behind.
 */
function mapPortfolio(row: RawPortfolioRow): Portfolio {
  return {
    id: row.id,
    broker: row.broker === 'manual' ? 'manual' : 'tradovate',
    display_name: row.display_name,
    nickname: row.nickname ?? null,
    status: (STATUSES.includes(row.status) ? row.status : 'active') as PortfolioStatus,
    hidden: row.hidden === true,
    last_seen_at: row.last_seen_at ?? null,
  };
}

/**
 * Every portfolio this trader has, hidden ones included.
 *
 * Hidden rows come back because two of the three callers need them: the screen
 * folds them under "תיקים מוסתרים (N)" and has to count them, and the filter
 * chip has to be able to name a portfolio the trader hid while a `?account=`
 * link to it is still in their history. The trade form drops them with
 * `shownPortfolios`.
 *
 * Returns an empty list — and issues NO STATEMENT — when the gate is shut.
 */
export async function readPortfolios(
  client: SupabaseClient,
  userId: string,
  enabled: boolean,
): Promise<Portfolio[]> {
  if (!enabled) return [];

  const { data, error } = await client
    .from('accounts')
    .select(PORTFOLIO_SELECT)
    .eq('user_id', userId);

  // An empty list rather than a throw. A failed read of this table must not
  // take down the trade form or the journal: the worst honest outcome is a
  // trader who sees no portfolios for one render, and the worst alternative is
  // a page that will not open.
  if (error || !data) return [];
  return (data as unknown as RawPortfolioRow[]).map(mapPortfolio);
}

/**
 * The portfolio the trader's most recent plan was filed under, if any.
 *
 * REF-110 §B's default for the trade form, and it needs NO NEW COLUMN — it is
 * one ordered read of a table the form already queries, and it degrades
 * correctly for a first-time trader, who gets no default and picks.
 *
 * `.not('account_id', 'is', null)` rather than reading the newest row and
 * testing it: the newest plan may be an unassigned one from before Stage 3,
 * and "no default" is a worse answer than "the last portfolio you actually
 * used" when the trader has been using one all week.
 */
export async function readLastUsedPortfolioId(
  client: SupabaseClient,
  userId: string,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled) return null;

  const { data, error } = await client
    .from('trade_plans')
    .select('account_id')
    .eq('user_id', userId)
    .not('account_id', 'is', null)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return ((data as { account_id?: string | null }).account_id) ?? null;
}

/**
 * Find or create the trader's manual portfolio of this name.
 *
 * LAZY, AND IT HAS TO BE IDEMPOTENT BY NAME. The form creates a row only when
 * a plan is actually submitted under "תיק חדש…", so a trader who opens the
 * form, types a name and closes it again leaves nothing behind. The cost of
 * that is that the same name can arrive twice — the trader submits two trades
 * to "Interactive" in a row, or double-submits — and two rows called
 * "Interactive" is the one outcome that makes the screen useless. So this
 * reads first, case-insensitively, and inserts only when nothing matches.
 *
 * NOT ENFORCED BY AN INDEX, deliberately. 037's unique index is partial on
 * `broker_account_id IS NOT NULL`, which excludes every manual row, and a
 * second unique index on `(user_id, lower(display_name))` would forbid a
 * trader from ever having a manual portfolio named after a broker one. The
 * duplicate this prevents is an accident; the collision an index would
 * prevent is sometimes a choice.
 *
 * `broker_account_id` and `broker_host` are NOT NAMED. 037's
 * `accounts_broker_identity_check` requires a manual row to carry neither, and
 * naming them as NULL would pass the CHECK while stating something the row
 * does not mean.
 *
 * Returns null when the name is blank or the insert is refused; the caller
 * files the trade as unassigned rather than failing the submit, because losing
 * a trade to a portfolio problem is the worse trade-off.
 */
export async function ensureManualPortfolio(
  client: SupabaseClient,
  userId: string,
  name: string,
  enabled: boolean,
): Promise<string | null> {
  const display = name.trim();
  if (!enabled || display === '') return null;

  const { data: existing } = await client
    .from('accounts')
    .select('id,display_name')
    .eq('user_id', userId)
    .eq('broker', 'manual');

  const match = ((existing ?? []) as { id: string; display_name: string }[]).find(
    (row) => row.display_name.trim().toLowerCase() === display.toLowerCase(),
  );
  if (match) return match.id;

  const { data: inserted, error } = await client
    .from('accounts')
    .insert({ user_id: userId, broker: 'manual', display_name: display })
    .select('id')
    .maybeSingle();

  if (error || !inserted) return null;
  return (inserted as { id: string }).id;
}

/**
 * The trader renames a portfolio — broker-owned or manual, both.
 *
 * Writes `nickname` and never `display_name`, which is the whole of the E12
 * boundary on this table: the sync restates the broker's name on every pull,
 * so a rename written there would last until the next sync and then vanish.
 * On a manual row `display_name` is the trader's own too, but it is still not
 * what a rename touches — one column means one rule, and the card renders
 * `nickname ?? display_name` either way.
 *
 * A blank name clears the nickname rather than storing an empty string, so
 * "undo my rename" is reachable from the same control.
 */
export async function renamePortfolio(
  client: SupabaseClient,
  userId: string,
  portfolioId: string,
  nickname: string,
): Promise<boolean> {
  const trimmed = nickname.trim();
  const { error } = await client
    .from('accounts')
    .update({ nickname: trimmed === '' ? null : trimmed })
    .eq('id', portfolioId)
    .eq('user_id', userId);
  return !error;
}

/**
 * Hide or unhide a portfolio's card.
 *
 * A SCREEN PREFERENCE AND NOT A DELETE (Imri, 17.10). The trades of a hidden
 * portfolio stay in every total on every page — the stats, the dashboard, the
 * calendar, the weekly summary and the rule engine all read `trade_plans` and
 * none of them joins this table. Nothing in the codebase can make this flag
 * destructive without adding that join on purpose, and
 * `scripts/accounts-check.ts` asserts the sum is unchanged across a hide.
 *
 * There is no delete, here or anywhere: removing a row would orphan every
 * trade pointing at it (037 §4).
 */
export async function setPortfolioHidden(
  client: SupabaseClient,
  userId: string,
  portfolioId: string,
  hidden: boolean,
): Promise<boolean> {
  const { error } = await client
    .from('accounts')
    .update({ hidden })
    .eq('id', portfolioId)
    .eq('user_id', userId);
  return !error;
}

/**
 * File a set of trades under a portfolio — the "ללא תיק" assign flow.
 *
 * ONE STATEMENT FOR THE WHOLE SELECTION, which is why it takes a list rather
 * than being called in a loop: a trader assigning four hundred pre-REF-110
 * rows should cost one round trip, not four hundred.
 *
 * `.eq('user_id', …)` is not redundant with RLS and is not decoration. The ids
 * arrive from a browser, and a policy that would already refuse the write is
 * the second line of defence rather than the first — the same argument
 * `import.ts` makes for stating the filter on every statement.
 *
 * `.is('account_id', null)` is the third: the flow is "assign the unassigned",
 * so a row that acquired a portfolio between the page render and the click —
 * a sync ran, another tab assigned it — is left alone rather than moved.
 */
export async function assignTradesToPortfolio(
  client: SupabaseClient,
  userId: string,
  tradeIds: readonly string[],
  portfolioId: string,
): Promise<boolean> {
  if (tradeIds.length === 0) return true;

  const { error } = await client
    .from('trade_plans')
    .update({ account_id: portfolioId })
    .eq('user_id', userId)
    .is('account_id', null)
    .in('id', [...tradeIds]);
  return !error;
}

/**
 * File EVERY unassigned trade under one portfolio.
 *
 * The common case by a distance, and the reason it is its own function rather
 * than "tick select-all": a trader who has been using Reflect for a year and
 * has just connected one broker wants their whole history in one portfolio,
 * and the list the screen can reasonably render is bounded
 * ({@link UNASSIGNED_SAMPLE_LIMIT}) while their backlog is not. Ticking every
 * box on a page of two hundred would file two hundred of eight hundred rows
 * and look like it had finished.
 *
 * Still ONE statement, and still scoped by user and by "still unassigned" —
 * the id list is the only thing that goes.
 */
export async function assignAllUnassigned(
  client: SupabaseClient,
  userId: string,
  portfolioId: string,
): Promise<boolean> {
  const { error } = await client
    .from('trade_plans')
    .update({ account_id: portfolioId })
    .eq('user_id', userId)
    .is('account_id', null);
  return !error;
}

/**
 * How many unassigned trades the "ללא תיק" card lists for picking.
 *
 * It bounds what is RENDERED, not what can be assigned — {@link
 * assignAllUnassigned} reaches the rest in one statement, and the card says
 * so when the backlog is longer than this. Two hundred rows of checkboxes is
 * already more than anyone will read; the number exists so the page cannot be
 * made unusable by a trader with a long history.
 */
export const UNASSIGNED_SAMPLE_LIMIT = 200;
