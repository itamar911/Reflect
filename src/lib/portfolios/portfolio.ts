/**
 * A portfolio — one row of `accounts` — as the product speaks about it
 * (REF-110 Stages 3-5).
 *
 * Browser-safe and PURE. No client, no environment access, no server-only
 * import, for `lib/trades/visible.ts`'s reason: both halves of this product
 * read portfolios. The "התיקים שלי" screen is an RSC, the "תיק" field on the
 * trade form is a browser component, and the rename/hide controls are
 * browser-side writes under RLS. One definition has to serve all three.
 *
 *
 * WHY `lib/portfolios/` AND NOT `lib/accounts/`
 * ---------------------------------------------
 *
 * Because `src/lib/account/` already exists and means something else — the
 * trader's own Reflect account (`deleteAccount.ts`, `userData.ts`,
 * `confirmation.ts`). A sibling directory one letter away from it, holding an
 * unrelated domain, is an import nobody would read twice and would sometimes
 * get wrong. The database table stays `accounts` and the route stays
 * `/accounts`, because those are the names REF-110 settled; this module is
 * named after the word the trader sees, which is "תיק".
 *
 *
 * THE TWO NAMES, AND WHICH ONE IS THE BROKER'S
 * --------------------------------------------
 *
 * `display_name` is the broker's and the sync restates it on every pull.
 * `nickname` is the trader's and nothing but the trader ever writes it. The
 * screen renders {@link portfolioLabel}, which is `nickname ?? display_name`,
 * and migration 037 plus `lib/tradovate/account-sync.ts` are what make that
 * precedence survive a resync.
 *
 *
 * PRIVACY — THIS IS THE FIRST BROKER-SUPPLIED FREE TEXT IN THE PRODUCT
 * --------------------------------------------------------------------
 *
 * On a prop trader's account `display_name` is a firm's name. It is allowed on
 * screen, under that trader's own RLS, and nowhere else: never in a log line,
 * never in an error message, and NEVER IN AN AI PROMPT. See the note on
 * {@link PORTFOLIO_SELECT} in ./read.ts, which is the only place this product
 * reads the column.
 */

/** Mirrors 037's `accounts_status_check`. */
export type PortfolioStatus = 'active' | 'closed' | 'archived';

/** Mirrors 037's `accounts_broker_check`. */
export type PortfolioBroker = 'tradovate' | 'manual';

/**
 * One row of `accounts`, as every reader in the product shapes it.
 *
 * `last_seen_at` is the broker's answer to "when did I last have this account
 * in a list", NOT "when did I last trade it" — the card's "עסקה אחרונה" comes
 * from the trades themselves (see ./figures.ts). It is carried here only to
 * order the list.
 */
export interface Portfolio {
  id: string;
  broker: PortfolioBroker;
  display_name: string;
  nickname: string | null;
  status: PortfolioStatus;
  hidden: boolean;
  last_seen_at: string | null;
  /**
   * The broker's own identity for this row — both halves, or neither
   * (REF-108 Stage 1).
   *
   * 037's `accounts_broker_identity_check` guarantees that pairing: a
   * Tradovate row carries both, a manual row carries neither. They are here
   * because the live-positions route has to join `(broker_account_id,
   * broker_host)` — which is what `/position/list` hands back — to OUR uuid,
   * and that join is the one thing between a position and the portfolio name
   * the trader recognises.
   *
   * Both are ids, neither is free text, so they carry none of the privacy
   * weight `display_name` does. Nothing renders them.
   */
  brokerAccountId: number | null;
  brokerHost: 'live' | 'demo' | null;
}

/**
 * What the trader calls this portfolio.
 *
 * A nickname that is present but blank is NOT a rename — a trader who cleared
 * the field meant "go back to the broker's name", and an empty heading on a
 * card is the one outcome neither name was for.
 */
export function portfolioLabel(p: Pick<Portfolio, 'display_name' | 'nickname'>): string {
  const nickname = p.nickname?.trim();
  return nickname ? nickname : p.display_name;
}

/** The chip beside the name. */
export function statusLabel(status: PortfolioStatus): string {
  if (status === 'closed') return 'נסגר';
  if (status === 'archived') return 'בארכיון';
  return 'פעיל';
}

/**
 * Active first, then closed, then archived — and the order inside each group
 * is the trader's own recency, newest first.
 *
 * `=== true` on `hidden` is deliberate and is `isHiddenTrade`'s rule for the
 * same reason: `undefined` is what a reader gets from a database where 037 has
 * not been run, and it means "not hidden" exactly as `false` does.
 */
const STATUS_RANK: Record<PortfolioStatus, number> = { active: 0, closed: 1, archived: 2 };

export function sortPortfolios<T extends Portfolio>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    if (rank !== 0) return rank;
    const seen = (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '');
    if (seen !== 0) return seen;
    return portfolioLabel(a).localeCompare(portfolioLabel(b), 'he');
  });
}

/** The ones whose card is on the screen. */
export function shownPortfolios<T extends Portfolio>(rows: readonly T[]): T[] {
  return rows.filter((p) => p.hidden !== true);
}

/** The ones folded away under "תיקים מוסתרים (N)". */
export function hiddenPortfolios<T extends Portfolio>(rows: readonly T[]): T[] {
  return rows.filter((p) => p.hidden === true);
}

/**
 * EVERY ELEMENT EXPLAINS ITSELF, IN ONE SHORT LINE, IN PLAIN HEBREW.
 *
 * Imri's product requirement of 17.10, as a constant rather than as six string
 * literals scattered across four components. Three things follow from it being
 * one object:
 *
 *   - The six sentences are reviewable in one place, which is what the
 *     requirement actually asks for — it is a copy decision, not a layout one.
 *   - `scripts/accounts-check.ts` pins all six verbatim, so a well-meaning
 *     rewording is a failing assertion rather than a silent product change.
 *   - A line that turns out to be wrong in context is changed once.
 *
 * NOT A HELP PAGE, and that is the requirement's other half: each of these
 * renders beside the thing it describes, at the moment the trader is looking
 * at it. Nothing here is behind a link, a tooltip-only affordance or an
 * "?" icon.
 */
export const PORTFOLIO_COPY = {
  /** Under the "התיקים שלי" heading. What a portfolio is, and what it is not. */
  screenHeader:
    'כל תיק שאתה סוחר בו — מהברוקר או ידני. הסטטיסטיקות והחוקים שלך תמיד על כל התיקים ביחד.',
  /** On the "ללא תיק" card. Why these trades have no portfolio. */
  unassigned:
    'עסקאות מלפני שהיו תיקים. בחר לאיזה תיק הן שייכות.',
  /** Beside the "נסגר" chip. What the broker did, and what we kept. */
  closedStatus:
    'הברוקר כבר לא מציג את החשבון הזה. העסקאות נשארות.',
  /** On the hide action. The sentence that stops it reading as a delete. */
  hide:
    'מוריד את הכרטיס מהמסך בלבד. העסקאות נשארות בסטטיסטיקות.',
  /** Under the "תיק" select on the trade form. */
  formField:
    'לאיזה חשבון העסקה שייכת. עסקאות מהברוקר משויכות לבד.',
  /** Beside "תיק חדש…". Who this is for. */
  createManual:
    'לסוחרים בלי ברוקר מחובר, או לחשבון נוסף שאתה מנהל ידנית.',
} as const;

/** The option value the "תיק" select uses for "no portfolio". */
export const UNASSIGNED_VALUE = '';

/** The option value the "תיק" select uses for "create a new manual one". */
export const NEW_PORTFOLIO_VALUE = '__new__';
