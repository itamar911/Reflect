import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { PresetRuleKey } from '@/lib/types';

/**
 * "What your rules did" — the history of rule events, in plain Hebrew.
 *
 * Until this card existed nothing read the table back. rule_violations recorded
 * every block, warning and override and the only reader
 * (app/(app)/trades/page.tsx) selects trade_plan_id to mark a trade row,
 * filtering out rows where it is null — which is every gate block, because a
 * block happens instead of a trade. Measured on the live table: 17 of 18 rows
 * were invisible, including all four blocks.
 *
 *
 * ONE LINE PER EPISODE, NOT PER ROW
 * ---------------------------------
 *
 * The rules fire in bursts. A real morning in the data: the same two rules
 * warning at 09:57:10, 09:57:21, 10:00:07, 10:00:26 and 10:19:47 — nine rows,
 * two distinct sentences between them. Rendered one per row that is noise, and
 * a user stops reading it.
 *
 * So consecutive events of the same rule and the same outcome are merged into
 * one line carrying a count and the span they covered. This makes the card say
 * MORE: "you were warned five times between 09:57 and 10:19" is a fact about
 * the trader. Nine identical rows are a transcript.
 *
 * Grouped per BURST rather than per day. A day is the wrong unit — being warned
 * four times in three minutes is one episode of pushing against a rule, and the
 * same rule firing again six hours later is a separate decision on a separate
 * sitting. Collapsing both into "4 times today" would erase the difference that
 * makes the first one interesting. {@link BURST_GAP_MS} is the seam.
 *
 * "Consecutive" means consecutive within that rule's own series, not adjacent
 * in the rendered list: two different rules routinely warn in the same second
 * (handleValidate logs every warn-severity violation in one batch), so their
 * events interleave and a strictly-adjacent merge would never fire.
 *
 *
 * COLOUR, AND WHY NONE OF IT CARRIES MEANING
 * ------------------------------------------
 *
 * Turquoise for `blocked` and `warned`: a rule firing is not a failure, it is
 * the moment the user's own rule worked, and `warned` means they were told and
 * stopped of their own accord. Orange for `overridden` — warned and continued
 * — the one of the three worth a second look. Red is reserved for money lost
 * and appears nowhere here.
 *
 * But the colour is emphasis only. Every event states what happened in words,
 * in --color-tg-text, which passes AA in both themes; the icon is aria-hidden
 * and the rail is decoration. Nothing is distinguishable by hue alone.
 *
 * That is not only an accessibility stance, it is forced. --color-tg-primary
 * (#00d2d2) and --color-tg-warning (#f59e0b) have NO light-theme override, and
 * against the light surface (#f4f6f8) they measure about 1.7:1 and 2.0:1 —
 * failing AA for text and failing even the 3:1 non-text threshold. So this
 * component carries its own two values, scoped to .rule-event-colours in
 * globals.css, with darker light-theme variants. The app-wide tokens are
 * deliberately untouched; their light-theme failure is REF-96.
 */

export type RuleEventOutcome = 'blocked' | 'warned' | 'overridden';

export interface RuleEvent {
  id: string;
  created_at: string;
  outcome: RuleEventOutcome;
  rule_source: 'preset' | 'custom';
  /** User-authored for a custom rule, a settings label for a preset one. */
  rule_name: string;
  /** A PresetRuleKey for preset rows, a condition_type for custom ones. */
  rule_key: string;
  /** Set for custom rules. Used only as part of the grouping key. */
  custom_rule_id: string | null;
}

/** Everything on screen is in Israel time, as the alert settings already say. */
const TZ = 'Asia/Jerusalem';

/**
 * The gap that separates two episodes of the same rule.
 *
 * Thirty minutes, chosen against the real spread rather than picked round: the
 * gaps inside a single sitting measure 0s, 11s, 19s and 166s, and the next ones
 * up are about nineteen minutes. Nineteen minutes is still the same person at
 * the same desk, so the seam belongs above it.
 *
 * A generous threshold costs nothing here because the merged line prints the
 * span it covers — "09:57–10:19" says both how often and over how long. A tight
 * threshold would fragment one morning into three lines and lose the story.
 */
const BURST_GAP_MS = 30 * 60_000;

/**
 * What happened, as a sentence opener.
 *
 * `warned` and `blocked` are deliberately worded as outcomes the user owns
 * rather than things done to them.
 */
function outcomeClause(outcome: RuleEventOutcome, count: number): string {
  // Hebrew has a dual: "פעמיים" is what a person says for two, never "2 פעמים".
  const times = count === 2 ? 'פעמיים' : `${count} פעמים`;
  switch (outcome) {
    case 'blocked':
      return count === 1 ? 'נעצרת לפני כניסה לעסקה.' : `נעצרת לפני כניסה לעסקה ${times}.`;
    case 'warned':
      return count === 1
        ? 'קיבלת אזהרה ולא נכנסת לעסקה.'
        : `קיבלת אזהרה ${times} ולא נכנסת לעסקה.`;
    case 'overridden':
      return count === 1
        ? 'קיבלת אזהרה ובחרת להמשיך.'
        : `קיבלת אזהרה ${times} ובחרת להמשיך.`;
  }
}

/**
 * Why it happened, for the five built-in rules.
 *
 * A preset rule's stored `rule_name` is its settings label ("מספר עסקאות
 * מקסימלי ליום") which reads as a heading, not a reason, so each key gets a
 * clause instead. Custom rules use the name the user wrote themselves.
 */
const PRESET_REASON: Record<PresetRuleKey, string> = {
  max_daily_trades: 'הגעת למספר העסקאות שהגדרת ליום.',
  cooldown_after_losses: 'היו לך כמה הפסדים רצופים.',
  max_daily_loss: 'עברת את ההפסד היומי שהגדרת.',
  min_rr_ratio: 'יחס הסיכון־סיכוי היה נמוך מהמינימום שהגדרת.',
  min_emotional_state: 'דיווחת על מצב רגשי נמוך מהמינימום שהגדרת.',
};

function reasonFor(event: RuleEvent): string {
  if (event.rule_source === 'custom') {
    // The user's own wording, quoted. rule_key here is a condition_type —
    // an English identifier — and must never reach the screen.
    return `לפי החוק שלך: «${event.rule_name}»`;
  }
  // rule_key is a free-text column, so an unrecognised value is possible.
  // Falling back to a generic Hebrew clause keeps an identifier off screen.
  return PRESET_REASON[event.rule_key as PresetRuleKey] ?? 'לפי אחד החוקים המובנים.';
}

/** Turquoise for the two the user can be pleased about, orange for the third. */
function toneOf(outcome: RuleEventOutcome): { colour: string; Icon: typeof ShieldCheck } {
  return outcome === 'overridden'
    ? { colour: 'var(--rule-event-attention)', Icon: AlertTriangle }
    : { colour: 'var(--rule-event-ok)', Icon: ShieldCheck };
}

const dayKeyOf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayLabelOf = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const timeOf = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
});

/** One line on screen: a run of the same rule and outcome, close together. */
interface Burst {
  key: string;
  event: RuleEvent;
  count: number;
  /** Oldest and newest event in the run. Equal when count is 1. */
  firstAt: string;
  lastAt: string;
}

interface DayGroup {
  key: string;
  label: string;
  bursts: Burst[];
}

/** Which rule-and-outcome series an event belongs to. Never rendered. */
function seriesKey(event: RuleEvent): string {
  return [
    event.rule_source,
    event.custom_rule_id ?? event.rule_key,
    event.rule_name,
    event.outcome,
  ].join('\u0000');
}

/**
 * Group events into days, and days into bursts.
 *
 * NEWEST FIRST, AND DELIBERATELY SO at both levels: the most recent day is the
 * one a user opens this card to see, and within a day the latest episode is the
 * one that explains the state they are in now. `events` must already be sorted
 * newest-first — app/(app)/rules/page.tsx orders by created_at descending — and
 * the day order simply follows the order days are first encountered.
 *
 * Days are bucketed in Israel time rather than the server's. Vercel runs UTC,
 * so a 01:00 event in Tel Aviv would otherwise file itself under the previous
 * day, and this renders on the server where there is no second opinion to
 * disagree with.
 */
function groupByDay(events: readonly RuleEvent[]): DayGroup[] {
  const now = new Date();
  const todayKey = dayKeyOf.format(now);
  const yesterdayKey = dayKeyOf.format(new Date(now.getTime() - 86_400_000));

  const days: DayGroup[] = [];
  // Newest open burst per series, per day. Keyed by day + series so a rule that
  // fires either side of midnight cannot merge across the day heading.
  const open = new Map<string, Burst>();

  for (const event of events) {
    const at = new Date(event.created_at);
    const dayKey = dayKeyOf.format(at);

    let day = days.find((d) => d.key === dayKey);
    if (!day) {
      const label =
        dayKey === todayKey ? 'היום' : dayKey === yesterdayKey ? 'אתמול' : dayLabelOf.format(at);
      day = { key: dayKey, label, bursts: [] };
      days.push(day);
    }

    const key = `${dayKey}\u0000${seriesKey(event)}`;
    const current = open.get(key);
    // Walking newest-first, so this event is OLDER than the open burst: it
    // extends the run backwards while it stays inside the gap.
    if (current && new Date(current.firstAt).getTime() - at.getTime() <= BURST_GAP_MS) {
      current.count += 1;
      current.firstAt = event.created_at;
      continue;
    }

    const burst: Burst = {
      key: event.id,
      event,
      count: 1,
      firstAt: event.created_at,
      lastAt: event.created_at,
    };
    open.set(key, burst);
    day.bursts.push(burst);
  }

  return days;
}

export default function RuleEventsCard({
  events,
  truncated = false,
}: {
  events: readonly RuleEvent[];
  /** True when older events exist beyond the ones passed in. */
  truncated?: boolean;
}) {
  const headingId = 'rule-events-heading';
  const days = groupByDay(events);

  return (
    <section
      aria-labelledby={headingId}
      dir="rtl"
      // Matches the wrapper the rules editor above it sits in, rather than the
      // Card primitive used on Settings — on this page the flat surface is what
      // belongs.
      className="rule-event-colours rounded-2xl p-4"
      style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}
    >
      <h2 id={headingId} className="text-sm font-semibold" style={{ color: 'var(--color-tg-text)' }}>
        מה החוקים שלך עשו
      </h2>
      <p className="text-xs mt-1" style={{ color: 'var(--color-tg-muted)' }}>
        הפעמים שהחוקים שלך נכנסו לפעולה
      </p>

      {days.length === 0 ? (
        <p className="text-sm mt-5 leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
          עדיין לא קרה כלום. כשחוק שלך ייכנס לפעולה, זה יופיע כאן.
        </p>
      ) : (
        <div className="flex flex-col gap-5 mt-5">
          {days.map((day) => (
            <div key={day.key} className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--color-tg-text-2)' }}>
                {day.label}
              </h3>
              <ul className="flex flex-col">
                {day.bursts.map((burst) => {
                  const { colour, Icon } = toneOf(burst.event.outcome);
                  const spans = burst.firstAt !== burst.lastAt;
                  return (
                    <li
                      key={burst.key}
                      className="flex items-start gap-3 py-3.5 border-b last:border-b-0"
                      style={{
                        borderBottomColor: 'var(--color-tg-border)',
                        // Logical, not `right`: the rail belongs on the reading
                        // start edge and this subtree is RTL.
                        borderInlineStartWidth: 3,
                        borderInlineStartStyle: 'solid',
                        borderInlineStartColor: colour,
                        paddingInlineStart: 12,
                      }}
                    >
                      <Icon aria-hidden="true" size={18} style={{ color: colour, flexShrink: 0, marginTop: 2 }} />
                      {/* The time rides with the sentence rather than sitting on
                          its own line beneath it, where it ended up closer to
                          the next row than to the row it belongs to. */}
                      <p className="text-sm leading-relaxed min-w-0" style={{ color: 'var(--color-tg-text)' }}>
                        {outcomeClause(burst.event.outcome, burst.count)} {reasonFor(burst.event)}{' '}
                        {/* The separator stays OUTSIDE the ltr span, in the RTL
                            flow, so it lands between the sentence and the time.
                            Inside, it would be carried to the far edge of the
                            ltr run and read as though it came after the clock. */}
                        <span aria-hidden="true" style={{ color: 'var(--color-tg-muted)' }}>
                          ·
                        </span>{' '}
                        <span
                          // dir="ltr" so a range reads 09:57–10:19 rather than
                          // having the clock times reordered by the RTL context.
                          dir="ltr"
                          className="whitespace-nowrap"
                          style={{ color: 'var(--color-tg-muted)' }}
                        >
                          <time dateTime={burst.firstAt}>{timeOf.format(new Date(burst.firstAt))}</time>
                          {spans && (
                            <>
                              <span aria-hidden="true">–</span>
                              <time dateTime={burst.lastAt}>{timeOf.format(new Date(burst.lastAt))}</time>
                            </>
                          )}
                        </span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {truncated && (
            <p className="text-xs" style={{ color: 'var(--color-tg-muted)' }}>
              מוצגים האירועים האחרונים.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
