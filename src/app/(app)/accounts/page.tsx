/**
 * "התיקים שלי" — one card per portfolio (REF-110 Stage 4).
 *
 * READ-ONLY ON THE SERVER. Everything on this page is rendered from what
 * Stages 1-2 recorded; the only writes are the trader's own, made from the
 * browser under 037's RLS (see components/accounts/AccountsClient.tsx).
 *
 * EVERY FIGURE IS COMPUTED HERE, not in the browser, and every one of them
 * goes through lib/pnl.ts. The card must not become the fourth definition of
 * a win rate — see the header on lib/portfolios/figures.ts, which is where
 * the arithmetic lives and where there is none of it.
 *
 * ONE READ OF `trade_plans`, UNBOUNDED, like the stats page and for the stats
 * page's reason: a card's figures are a statement about a portfolio's whole
 * history, and a `.limit()` here would quietly make them a statement about
 * its most recent thousand trades instead. This is the one page in the
 * product where that distinction is the entire point.
 */

import { redirect } from 'next/navigation';
import { Wallet } from 'lucide-react';

import { createClient, getCachedUser } from '@/lib/supabase/server';
import { isImportEnabled } from '@/lib/tradovate/import';
import { isUserAllowed } from '@/lib/tradovate/allowlist';
import { readPortfolios, UNASSIGNED_SAMPLE_LIMIT } from '@/lib/portfolios/read';
import {
  PORTFOLIO_COPY,
  sortPortfolios,
  type Portfolio,
} from '@/lib/portfolios/portfolio';
import {
  UNASSIGNED_KEY,
  countableTrades,
  figuresByPortfolio,
  NO_FIGURES,
  type PortfolioFigures,
  type PortfolioTradeRow,
} from '@/lib/portfolios/figures';
import AccountsClient, {
  type PortfolioCardData,
  type UnassignedTrade,
} from '@/components/accounts/AccountsClient';

export const metadata = { title: 'התיקים שלי — Reflect' };

/**
 * The columns a card needs, named rather than `select('*')`.
 *
 * `account_id` is 037's and `hidden` is 034's, which is why the whole page
 * sits behind `isImportEnabled()` — naming either on a database without the
 * migration is a PostgREST 42703 and a 500 on the route.
 *
 * `symbol` is here for the "ללא תיק" list only: a trader deciding which
 * portfolio an old trade belongs to needs to see what it was.
 */
const ACCOUNTS_TRADE_SELECT =
  'id,account_id,symbol,status,submitted_at,entry_price,exit_price,take_profit,direction,pnl_amount,actual_pnl,hidden';

interface RawRow extends PortfolioTradeRow {
  id: string;
  symbol: string | null;
}

/** Dates are formatted on the server so the markup cannot disagree with
 *  itself: `toLocaleDateString('he-IL', …)` can resolve differently under
 *  Node and under the browser, and a hydration mismatch on every card is a
 *  console full of warnings for a date nobody re-renders. */
function hebrewDate(iso: string | null): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
}

export default async function AccountsPage() {
  const supabase = await createClient();
  const { data: { user } } = await getCachedUser();
  if (!user) redirect('/login');

  const enabled = isImportEnabled();

  // Migration 037 has not been run on this deployment. Nothing below could
  // answer, so the page says so in one line rather than failing on its first
  // query. Not reachable in production — the flag has been '1' since before
  // Stage 1 — and it is the state a fresh environment starts in.
  if (!enabled) {
    return (
      <div dir="rtl" className="px-4 py-5 flex flex-col gap-2">
        <PageHeader />
        <p className="text-sm text-tg-text-2">התיקים עדיין לא זמינים בסביבה הזו.</p>
      </div>
    );
  }

  const [portfolios, tradesRes] = await Promise.all([
    readPortfolios(supabase, user.id, enabled),
    supabase
      .from('trade_plans')
      // 'not_entered' is not a trade (REF-82 §5.2). Excluded at the query so
      // the unassigned list does not offer the trader plans to file, and
      // excluded again in countableTrades so the figures cannot drift from
      // this decision if a second reader ever forgets it.
      .select(ACCOUNTS_TRADE_SELECT)
      .eq('user_id', user.id)
      .neq('status', 'not_entered')
      .order('submitted_at', { ascending: false }),
  ]);

  const rows = countableTrades((tradesRes.data ?? []) as unknown as RawRow[]);

  // The ids that have a card. Passed to the grouping so that a row pointing
  // at anything else is filed as unassigned rather than into a bucket nothing
  // renders — see `bucketFor`. The invariant it buys is the one this screen
  // lives or dies by: every trade is on exactly one card, and the cards sum
  // to the trader's own total.
  const known = new Set(portfolios.map((p) => p.id));
  const figures = figuresByPortfolio(rows, known);

  const cards: PortfolioCardData[] = sortPortfolios(portfolios).map((p: Portfolio) => {
    const f: PortfolioFigures = figures.get(p.id) ?? NO_FIGURES;
    return {
      id: p.id,
      label: p.nickname?.trim() ? p.nickname.trim() : p.display_name,
      /** The broker's name, shown under a rename so the trader can still tell
       *  which account they renamed. Omitted when there is no rename. */
      brokerName: p.nickname?.trim() ? p.display_name : null,
      broker: p.broker,
      status: p.status,
      hidden: p.hidden,
      trades: f.trades,
      netPnl: f.netPnl,
      winRate: f.winRate,
      lastTradeLabel: hebrewDate(f.lastTradeAt),
    };
  });

  // The same rule as the grouping above, or the card's count and its list
  // would disagree about what "unassigned" means.
  const unassignedRows = rows.filter(
    (row) => row.account_id == null || !known.has(row.account_id),
  );
  const unassignedFigures = figures.get(UNASSIGNED_KEY) ?? NO_FIGURES;

  // Bounded for RENDERING only. `assignAllUnassigned` reaches the rest in one
  // statement and the card says so when the backlog is longer than this.
  const unassignedSample: UnassignedTrade[] = unassignedRows
    .slice(0, UNASSIGNED_SAMPLE_LIMIT)
    .map((row) => ({
      id: row.id,
      symbol: row.symbol,
      dateLabel: hebrewDate(row.submitted_at),
    }));

  return (
    <div dir="rtl" className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <PageHeader />
      <AccountsClient
        userId={user.id}
        // REF-108: whether the cards' reserved slot has anything to poll
        // for. Stricter than `enabled` above — the allowlist as well as the
        // migration — and server-only on both halves.
        liveEnabled={enabled && isUserAllowed(user.id)}
        cards={cards}
        unassignedCount={unassignedFigures.trades}
        unassignedPnl={unassignedFigures.netPnl}
        unassignedWinRate={unassignedFigures.winRate}
        unassignedSample={unassignedSample}
      />
    </div>
  );
}

/**
 * The heading, and the sentence under it.
 *
 * The sub-line is not decoration: it is the first of Imri's six, and it
 * answers the two questions a trader opening this screen has — what counts as
 * a portfolio, and whether their statistics have just been split up. The
 * answer to the second is no, and saying so here is cheaper than a support
 * conversation about it.
 */
function PageHeader() {
  return (
    <div className="flex items-start gap-3">
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'rgba(0,210,210,0.12)', border: '1px solid rgba(0,210,210,0.2)' }}
      >
        <Wallet aria-hidden="true" size={18} color="#00d2d2" />
      </div>
      <div className="min-w-0">
        <h1 className="text-xl font-bold text-tg-text">התיקים שלי</h1>
        <p className="text-xs mt-0.5 text-tg-muted" style={{ fontWeight: 600 }}>
          {PORTFOLIO_COPY.screenHeader}
        </p>
      </div>
    </div>
  );
}
