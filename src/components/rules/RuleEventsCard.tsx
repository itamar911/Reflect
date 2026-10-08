import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { PresetRuleKey } from '@/lib/types';

/**
 * "What your rules did" — the history of rule events, in plain Hebrew.
 *
 * Until now nothing read this back. rule_violations recorded every block,
 * warning and override and the only reader (app/(app)/trades/page.tsx) selects
 * `trade_plan_id` to mark trades, filtering out rows where it is null — which
 * is every gate block, because a block happens instead of a trade. Measured on
 * the live table: 17 of 18 rows were invisible.
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
 * deliberately untouched; their light-theme failure is a separate, larger
 * problem than this card.
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
}

/** Everything on screen is in Israel time, as the alert settings already say. */
const TZ = 'Asia/Jerusalem';

/**
 * What happened, as a sentence opener.
 *
 * `warned` and `blocked` are deliberately worded as outcomes the user owns
 * rather than things done to them.
 */
const OUTCOME_CLAUSE: Record<RuleEventOutcome, string> = {
  blocked: 'נעצרת לפני כניסה לעסקה.',
  warned: 'קיבלת אזהרה ולא נכנסת לעסקה.',
  overridden: 'קיבלת אזהרה ובחרת להמשיך.',
};

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

/**
 * Group events into days, newest first.
 *
 * Bucketed in Israel time rather than the server's. Vercel runs UTC, so a
 * 01:00 event in Tel Aviv would otherwise file itself under the previous day
 * — and this renders on the server, where there is no second opinion to
 * disagree with.
 */
function groupByDay(events: readonly RuleEvent[]): { key: string; label: string; events: RuleEvent[] }[] {
  const now = new Date();
  const todayKey = dayKeyOf.format(now);
  const yesterdayKey = dayKeyOf.format(new Date(now.getTime() - 86_400_000));

  const groups: { key: string; label: string; events: RuleEvent[] }[] = [];
  for (const event of events) {
    const date = new Date(event.created_at);
    const key = dayKeyOf.format(date);
    let group = groups.find((g) => g.key === key);
    if (!group) {
      const label = key === todayKey ? 'היום' : key === yesterdayKey ? 'אתמול' : dayLabelOf.format(date);
      group = { key, label, events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
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
  const groups = groupByDay(events);

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

      {groups.length === 0 ? (
        <p className="text-sm mt-5 leading-relaxed" style={{ color: 'var(--color-tg-text-2)' }}>
          עדיין לא קרה כלום. כשחוק שלך ייכנס לפעולה, זה יופיע כאן.
        </p>
      ) : (
        <div className="flex flex-col gap-5 mt-5">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--color-tg-text-2)' }}>
                {group.label}
              </h3>
              <ul className="flex flex-col">
                {group.events.map((event) => {
                  const { colour, Icon } = toneOf(event.outcome);
                  return (
                    <li
                      key={event.id}
                      className="flex items-start gap-3 py-3 border-b last:border-b-0"
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
                      <div className="flex flex-col gap-1 min-w-0">
                        <p className="text-sm leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
                          {OUTCOME_CLAUSE[event.outcome]} {reasonFor(event)}
                        </p>
                        <time
                          dateTime={event.created_at}
                          className="text-xs"
                          style={{ color: 'var(--color-tg-muted)' }}
                        >
                          {timeOf.format(new Date(event.created_at))}
                        </time>
                      </div>
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
