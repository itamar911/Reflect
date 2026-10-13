'use client';

import { AlertTriangle, CalendarDays } from 'lucide-react';
import { formatPnlIls } from '@/lib/utils';
import type { TodayClosedSummary } from '@/lib/rules/tradeRuleContext';
import type { PnlCurrency, RuleContextSource } from '@/lib/types';

/**
 * "Your day so far" — the context panel at the top of the trade form
 * (REF-82 §2.1).
 *
 * The brief's one-form decision rests on this component: users arrive with and
 * without a broker connection, there is ONE form for both, and what differs is
 * this panel. So it never disappears. Every state it can be in says something,
 * including the state where there is nothing to report and the state where we
 * could not find out.
 *
 *
 * IT DESCRIBES, IT DOES NOT INSTRUCT
 * ----------------------------------
 *
 * Every sentence here is a statement of fact about what has already happened.
 * No "כדאי", no "תעצור", no advice shape at all — §8 is a NinjaTrader vendor
 * compliance requirement, not a style preference, and the banned list includes
 * "will" where "may" belongs. The user's own limits are reported the same way:
 * "2 מתוך 3 שהגדרת" is their number read back to them, and the rule engine is
 * what acts on it. This panel only says where they stand.
 *
 *
 * TWO SCOPES, AND WHY THE COPY KEEPS THEM APART
 * ---------------------------------------------
 *
 * "How many trades today" is counted by submitted_at, and today's money is
 * counted by closed_at — that is how the rules have always counted them
 * (lib/rules/tradeRuleContext.ts), because a trade counts the moment it is
 * logged while a loss is only realised on the close.
 *
 * They are therefore DIFFERENT SETS. A plan from yesterday closed this morning
 * is in the money figures and not in the count; a plan logged an hour ago and
 * still open is in the count and not in the money. So "2 trades today, 1 of
 * them losing" can be plainly false, and the brief's phrasing ("how many of
 * them are losing") cannot be rendered literally without the panel lying on
 * ordinary data.
 *
 * The copy states two scoped facts instead — "בוצעו היום…" then "נסגרו היום…" —
 * and the word "מהן" appears only inside the closed sentence, where the
 * referent really is the closed set. Deliberate, and not a workaround to be
 * tidied away: the alternative is a third definition of "today's trades", which
 * is the bug class tradeRuleContext.ts exists to have ended.
 *
 *
 * MONEY, PER CURRENCY
 * -------------------
 *
 * pnl_amount is a bare number whose unit lives in pnl_currency, so ₪ and $
 * cannot be added. Each currency is printed on its own (§ REF-99 makes the
 * product dollar-only and settles this; until then, separately).
 *
 * The daily-loss line is therefore shown only when the day is in ONE currency.
 * With two, the rule's own threshold comparison is across currencies — a known
 * defect this component must not touch and must not dress up as meaningful, so
 * the comparison is simply not drawn. The per-currency totals above it still
 * are, so nothing about the day is hidden.
 *
 * Amounts come from formatPnlIls(), the same formatter the journal and the
 * dashboard use, so the same money reads identically wherever the user meets it.
 *
 *
 * COLOUR (§7)
 * -----------
 *
 * Red appears on one thing: an amount of money that was lost. Green on money
 * gained. Counts are never coloured — not the trade count, not the losing
 * count, not the position against a limit — because a count is not a loss and
 * red on "2 מתוך 3" would read as a verdict on the user.
 *
 * The two broker-failure states are prominent as §6 demands, and the prominence
 * is carried by an orange frame and an orange icon while the SENTENCE stays in
 * --color-tg-text. That split is forced: REF-96 records that
 * --color-tg-warning has no light-theme override and measures about 2:1 on the
 * light surface, which fails AA as text and fails even the 3:1 non-text
 * threshold. So this component carries its own orange, scoped to
 * .today-context-colours in globals.css with a darker light-theme value, and
 * the app-wide token is left alone — the same arrangement RuleEventsCard uses.
 *
 * Meaning never rides on colour: every state says what it is in words.
 *
 *
 * BIDI (§9)
 * ---------
 *
 * Every numeral, amount and currency symbol sits in its own dir="ltr" span, and
 * the Hebrew connectives between them ("מתוך", the "·" separator) stay OUTSIDE
 * those spans in the RTL flow. Inside, a separator is carried to the far end of
 * the ltr run and reads as though it belonged to the next number — the failure
 * that has already bitten this codebase twice, and the reason RuleEventsCard
 * keeps its separator out too.
 */

/** A bare amount with its symbol, unsigned — for the daily-loss comparison. */
function formatMoney(value: number, currency: PnlCurrency): string {
  return `${currency}${Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * An amount, in red when it is money lost and green when it is money gained.
 *
 * The three values are the component's own, scoped to .today-context-colours,
 * and NOT --color-tg-danger / --color-tg-success. Those two are the app's money
 * colours everywhere else, but measured as text on the surface this panel sits
 * on they fail AA in both themes — about 3.2:1 for #ef5350 on the light
 * surface-2 (#e9ecf0) and about 3.1:1 for #ef4444 on the dark one (#383840),
 * against the 4.5:1 normal-text threshold the accessibility statement declares.
 *
 * So the hues are kept and the lightness is moved until they pass: the same
 * remedy REF-96 prescribes ("scope darker values locally if you need them") and
 * the same arrangement RuleEventsCard already uses. The app-wide tokens are
 * deliberately left alone — fixing those is REF-96's job, not this panel's.
 */
function amountColour(value: number): string {
  if (value < 0) return 'var(--today-context-loss)';
  if (value > 0) return 'var(--today-context-gain)';
  return 'var(--color-tg-text)';
}

/** Numbers and symbols isolated from the surrounding Hebrew. */
function Ltr({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span dir="ltr" className="whitespace-nowrap font-semibold" style={style}>
      {children}
    </span>
  );
}

/** "אחת" for one, the numeral for anything above it. */
function countWord(n: number): React.ReactNode {
  return n === 1 ? 'אחת' : <Ltr>{n}</Ltr>;
}

/** How many closed, and how many of those lost money. */
function ClosedSentence({ closed }: { closed: TodayClosedSummary }) {
  const { count, losingCount } = closed;

  const opener =
    count === 1 ? (
      <>נסגרה היום עסקה אחת</>
    ) : (
      <>
        נסגרו היום <Ltr>{count}</Ltr> עסקאות
      </>
    );

  // "מהן" is safe here and only here — the referent is the closed set named in
  // the same sentence, not the trades-taken count above.
  const tail =
    losingCount === 0 ? (
      <>, ללא הפסד.</>
    ) : losingCount === count ? (
      count === 1 ? <>, בהפסד.</> : <>, כולן בהפסד.</>
    ) : (
      <>, {countWord(losingCount)} מהן בהפסד.</>
    );

  return (
    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
      {opener}
      {tail}
    </p>
  );
}

/** Today's money, one line, each currency on its own. */
function MoneySentence({ closed }: { closed: TodayClosedSummary }) {
  const { money } = closed;
  if (money.length === 0) return null;

  // With one currency the label carries the direction in words, so the meaning
  // survives without the sign and without the colour. With two it cannot — one
  // may be up while the other is down — so the label stays neutral and each
  // amount carries its own sign and colour.
  const single = money.length === 1 ? money[0] : null;

  if (single && single.net === 0) {
    return (
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
        העסקאות שנסגרו היום מאוזנות.
      </p>
    );
  }

  const label = single
    ? single.net < 0
      ? 'הפסד מהעסקאות שנסגרו היום'
      : 'רווח מהעסקאות שנסגרו היום'
    : 'רווח והפסד מהעסקאות שנסגרו היום';

  return (
    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
      {label}:{' '}
      {money.map((entry, i) => (
        <span key={entry.currency}>
          {/* The separator stays in the RTL flow, outside both ltr spans. */}
          {i > 0 && (
            <span aria-hidden="true" style={{ color: 'var(--color-tg-muted)' }}>
              {' · '}
            </span>
          )}
          <Ltr style={{ color: amountColour(entry.net) }}>
            {formatPnlIls(entry.net, entry.currency)}
          </Ltr>
        </span>
      ))}
    </p>
  );
}

export interface TodayContextPanelProps {
  headingId: string;
  /** False until the first load has finished, so zeros are never shown as fact. */
  loaded: boolean;
  /** Trades TAKEN today, excluding plans marked 'not_entered'. */
  tradeCount: number;
  /** Today's closes — display figures, straight from loadTradeRuleContext. */
  closed: TodayClosedSummary;
  /** The user's own limits, or null when their rules row has not been read. */
  maxDailyTrades: number | null;
  maxDailyLoss: number | null;
  /** What the day's figures are based on (REF-82 §6). */
  source: RuleContextSource;
}

export default function TodayContextPanel({
  headingId,
  loaded,
  tradeCount,
  closed,
  maxDailyTrades,
  maxDailyLoss,
  source,
}: TodayContextPanelProps) {
  const failed = source === 'broker_expired' || source === 'broker_unavailable';

  // One currency today, so the loss threshold can be stated in it. With two,
  // the comparison the rule makes is across currencies and is not drawn.
  const singleCurrency = closed.money.length === 1 ? closed.money[0] : null;
  const showLossLimit = maxDailyLoss !== null && maxDailyLoss > 0 && singleCurrency !== null;

  const nothingToday = tradeCount === 0 && closed.count === 0;

  return (
    <section
      aria-labelledby={headingId}
      // role="status" so the panel is re-announced when it changes under the
      // user — "סגרתי אותה" in the open-plan card above reloads the context and
      // these numbers move. The region is rendered in every state, never
      // conditionally, because a live region a screen reader first meets at the
      // moment its content arrives is often not announced at all.
      role="status"
      className="today-context-colours rounded-xl border p-3 flex flex-col gap-2"
      style={{
        background: 'var(--color-tg-surface-2)',
        // Orange frame for the two states where the rules are being checked
        // against an incomplete picture. §6: a small grey banner here is the
        // silent option with a clean conscience.
        borderColor: failed ? 'var(--today-context-attention)' : 'var(--color-tg-border)',
        borderWidth: failed ? 2 : 1,
      }}
    >
      <div className="flex items-start gap-2">
        {failed ? (
          <AlertTriangle
            aria-hidden="true"
            size={16}
            className="shrink-0 mt-0.5"
            style={{ color: 'var(--today-context-attention)' }}
          />
        ) : (
          <CalendarDays
            aria-hidden="true"
            size={16}
            className="shrink-0 mt-0.5"
            style={{ color: 'var(--color-tg-muted)' }}
          />
        )}
        <div className="flex flex-col gap-1 min-w-0">
          {/* h3: the sheet's title is the h2, so this is the next level down and
              the hierarchy stays correct (§9). */}
          <h3 id={headingId} className="text-sm font-semibold text-tg-text">
            היום שלך
          </h3>

          {!loaded ? (
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
              טוען את נתוני היום.
            </p>
          ) : (
            <>
              {nothingToday ? (
                <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
                  עוד לא נרשמו עסקאות היום.
                </p>
              ) : (
                <>
                  {/* The count against the user's own limit when they have one.
                      Never coloured: a count is not money (§7). */}
                  {tradeCount > 0 && (
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
                      {maxDailyTrades !== null ? (
                        <>
                          עסקאות היום: <Ltr>{tradeCount}</Ltr> מתוך <Ltr>{maxDailyTrades}</Ltr>{' '}
                          שהגדרת.
                        </>
                      ) : tradeCount === 1 ? (
                        <>בוצעה היום עסקה אחת.</>
                      ) : (
                        <>
                          בוצעו היום <Ltr>{tradeCount}</Ltr> עסקאות.
                        </>
                      )}
                    </p>
                  )}

                  {/* A day whose only activity is a close carried over from an
                      earlier day: the count sentence above would have to say
                      "0 עסקאות", which is not what happened. */}
                  {tradeCount === 0 && (
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
                      לא נרשמו עסקאות חדשות היום.
                    </p>
                  )}

                  {closed.count > 0 && <ClosedSentence closed={closed} />}
                  <MoneySentence closed={closed} />

                  {showLossLimit && (
                    <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
                      סך ההפסדים היום:{' '}
                      {/* Red on the amount lost, which is exactly what §7
                          reserves it for. The threshold beside it is not money
                          lost and stays in the ordinary text colour. */}
                      <Ltr
                        style={{
                          color:
                            singleCurrency.lost > 0
                              ? 'var(--today-context-loss)'
                              : 'var(--color-tg-text)',
                        }}
                      >
                        {formatMoney(singleCurrency.lost, singleCurrency.currency)}
                      </Ltr>{' '}
                      מתוך <Ltr>{formatMoney(maxDailyLoss, singleCurrency.currency)}</Ltr> שהגדרת.
                    </p>
                  )}
                </>
              )}

              <SourceDeclaration source={source} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Where the figures above came from, stated outright.
 *
 * All four states are built, though only 'reflect_only' can occur until REF-90
 * lands — the pull layer does not exist, so there is nothing to verify against,
 * expire or fail to reach. They are written now because §6's decision is
 * already made and the three broker states are the part of it that is easy to
 * get wrong later under time pressure: the failure states have to be as loud as
 * the success state, and that is a design choice, not a code path.
 */
function SourceDeclaration({ source }: { source: RuleContextSource }) {
  if (source === 'broker_verified') {
    return (
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
        כולל עסקאות מ-Tradovate.
      </p>
    );
  }

  if (source === 'broker_expired') {
    return (
      <div className="flex flex-col items-start gap-2">
        {/* Normal text colour, not orange — the frame and icon carry the
            prominence, and this sentence has to be readable in both themes
            (REF-96). A lapsed token is a normal step in the week, not an
            error: the access token lives 80 minutes and the market is shut
            from Friday afternoon to Sunday evening, so this is where most
            users will meet the connection most weeks. */}
        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
          החיבור ל-Tradovate פג, ולכן החוקים נבדקים רק מול מה שתיעדת כאן.
        </p>
        {/* The same href the Settings card uses for connecting. A plain link,
            because the connect flow is a server route and nothing about the
            connection is handled in this component. */}
        <a
          href="/api/tradovate/connect"
          className="h-9 px-3 rounded-xl text-xs font-semibold border flex items-center transition-all bg-tg-surface hover:bg-tg-border text-tg-text border-tg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tg-primary"
        >
          חבר מחדש
        </a>
      </div>
    );
  }

  if (source === 'broker_unavailable') {
    return (
      <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
        לא הצלחנו למשוך עסקאות מ-Tradovate, ולכן החוקים נבדקים רק מול מה שתיעדת כאן.
      </p>
    );
  }

  // Unconditional: the panel states what it is reporting on and stops there.
  // No connection invitation and no link out of the form — the trade form is
  // not where a broker connection gets sold or set up.
  return (
    <p className="text-xs leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
      מוצגות רק עסקאות שתיעדת ב-Reflect.
    </p>
  );
}
