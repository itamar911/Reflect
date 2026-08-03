'use client';

import { useEffect, useRef, useState } from 'react';
import {
  SlidersHorizontal,
  ShieldAlert,
  GraduationCap,
  ChevronLeft,
  ChevronDown,
  Check,
  Ban,
  Sparkles,
  Radar,
  type LucideIcon,
} from 'lucide-react';
import { SectionHeading } from './SectionHeading';
import { DISCIPLINE_SCORE, DISCIPLINE_SCORE_DELTA } from './landingStats';

/**
 * The only section on the page that describes a *process*, so its job is to be
 * read as one movement rather than as three cards that happen to be numbered.
 *
 * Three things carry the sequence, none of which is the numerals alone:
 *
 *   1. A rail. It leaves each card at the exact height of that card's numeral
 *      and arrives at the next card's, so the three stations are visibly on one
 *      line. Right → left on desktop, top → bottom once the cards stack — both
 *      are "forward" for a Hebrew reader.
 *   2. An accent ramp. Station 1 is a dim turquoise outline, station 2 is lit,
 *      station 3 is solid turquoise with a dark numeral — arrival. The rail's
 *      own gradient brightens along the same ramp, so the direction is legible
 *      even in a greyscale screenshot where only the lightness survives.
 *   3. The motion. Everything enters on a transition-delay ladder ordered
 *      1 → rail → 2 → rail → 3, so the section narrates its own order the first
 *      time it is scrolled to.
 *
 * ── Why there is not a single timer or rAF in here ──
 *
 * Every entrance is a CSS transition keyed off one class, `hiw-in`, which the
 * section adds once when it first intersects. The stagger lives in per-element
 * `--hiw-d` (transition-delay) custom properties. That matters for more than
 * tidiness: the accessibility widget's "stop animations" toggle only reaches the
 * CSS layer, so a JS-timed sequence would ignore it (a known open issue with the
 * feature mocks). With the whole narration in CSS, landing.css can honour that
 * toggle — and the OS preference — for this section outright, by zeroing the
 * delays as well as the durations off `html[data-a11y-reduce-motion]`.
 *
 * That is also why the reveal is *not* short-circuited in JS under reduced
 * motion, tempting as it looks. `hiw-in` would then be computed from a value
 * that differs between the server and the hydrating client, and React 19 does
 * not patch className mismatches it finds during hydration ("this won't be
 * patched up") — the class would be dropped and the section would stay blank
 * for a visitor with reduced motion on. `intersected` is false on the server and
 * false on the first client render, so the class can only ever arrive as an
 * ordinary state update, which does patch. The observer therefore runs for
 * everyone; under reduced motion the transitions it triggers simply take no
 * time.
 */

const TURQUOISE = '#00d2d2';
const AMBER = '#f59e0b';
const GREEN = '#4ade80';

// ── The rules the trader set (card 1) ────────────────────────

/**
 * Card 1 is the source of truth for the whole section: card 2's gate enforces
 * this trade cap and prints this same number, so the two mocks cannot end up
 * disagreeing about what the rule actually is.
 */
const MAX_TRADES_PER_DAY = 3;

/**
 * Three of the four rule types the body copy names, each as a threshold on a
 * scale — `max` is what the slider track represents, so the fill length is
 * derived from the value rather than hand-placed.
 */
const RULES: { label: string; value: number; max: number; display: string }[] = [
  { label: 'מקסימום עסקאות ביום', value: MAX_TRADES_PER_DAY, max: 8, display: String(MAX_TRADES_PER_DAY) },
  { label: 'הפסד יומי מקסימלי', value: 2, max: 5, display: '2%' },
  { label: 'מצב רגשי מינימלי', value: 7, max: 10, display: '7/10' },
];

/** The fourth rule type. Not a threshold, so not a slider — a permitted set. */
const STRATEGIES = ['פריצה', 'ORB', 'תיקון'];

/** What the mock's header counts: the three thresholds plus the strategy rule. */
const ACTIVE_RULES = RULES.length + 1;

// ── The gate (card 2) ────────────────────────────────────────

/**
 * A day's queue at the gate. Three trades cleared the checks; the fourth is one
 * past the cap above and never gets through — so the count of cleared trades,
 * the count stopped, and the reason printed on the stopped chip are all read off
 * this array instead of being written down three times.
 */
const GATE_QUEUE: { symbol: string; cleared: boolean }[] = [
  { symbol: 'ES1', cleared: true },
  { symbol: 'NQ1', cleared: true },
  { symbol: 'CL1', cleared: true },
  { symbol: 'NQ1', cleared: false },
];

const CLEARED = GATE_QUEUE.filter((trade) => trade.cleared);
const STOPPED = GATE_QUEUE.filter((trade) => !trade.cleared);

// ── What came back (card 3) ──────────────────────────────────

const DEBRIEF_INSIGHT = 'בימים שבהם עצרת אחרי 2 עסקאות — 78% יצאו ירוקים';
const PATTERN = { tag: 'מסחר נקמה', note: 'זוהה ב-3 מתוך 5 הימים האדומים' };

// ── Steps ────────────────────────────────────────────────────

/**
 * `phase` is the one-word name of the step, sitting beside its numeral on the
 * rail. Read alone the three of them are the section's argument in three words:
 * you define, it enforces, you learn.
 */
const STEPS: { icon: LucideIcon; phase: string; title: string; body: string }[] = [
  {
    icon: SlidersHorizontal,
    phase: 'הגדרה',
    title: 'אתה קובע את החוקים.',
    body: 'פעם אחת. מקסימום עסקאות ביום, הפסד יומי מקסימלי, מצב רגשי מינימלי, האסטרטגיות שמותר לך לסחור — החוקים שלך, לא שלנו.',
  },
  {
    icon: ShieldAlert,
    phase: 'אכיפה',
    title: 'Reflect עומד בשער.',
    body: 'לפני כל עסקה אתה עובר דרך תכנון קצר, והמערכת בודקת אותך מול החוקים בזמן אמת. עומד בהם? ירוק, קדימה. מפר אותם? אתה תדע — לפני שלחצת, לא אחרי.',
  },
  {
    icon: GraduationCap,
    phase: 'למידה',
    title: 'כל עסקה הופכת לשיעור.',
    body: 'תחקיר AI, ציון משמעת, וזיהוי הדפוסים שהורסים לך את החודש. אתה רואה שחור על גבי לבן מה קורה כשאתה נאמן לתוכנית — ומה קורה כשלא.',
  },
];

/**
 * The accent ramp. Alpha and fill climb across the three stations so the row has
 * a direction of its own; station 3 inverts to a solid tile, which reads as the
 * end of the line rather than as one more of the same.
 */
const STATIONS = [
  {
    tileBg: 'rgba(0,210,210,0.10)',
    tileBorder: 'rgba(0,210,210,0.32)',
    numeral: 'rgba(0,210,210,0.85)',
    topBorder: 'rgba(0,210,210,0.30)',
    tileGlow: 'none',
  },
  {
    tileBg: 'rgba(0,210,210,0.20)',
    tileBorder: 'rgba(0,210,210,0.55)',
    numeral: TURQUOISE,
    topBorder: 'rgba(0,210,210,0.55)',
    tileGlow: '0 0 16px rgba(0,210,210,0.22)',
  },
  {
    tileBg: TURQUOISE,
    tileBorder: TURQUOISE,
    numeral: '#0a0d12',
    topBorder: 'rgba(0,210,210,0.85)',
    tileGlow: '0 0 24px rgba(0,210,210,0.4)',
  },
];

/**
 * The delay ladder, in milliseconds, all in one place so the narration order can
 * be read off without hunting through JSX. Roughly: card 1 lands and its rules
 * slide out, the rail draws to card 2, the blocked trade runs into the gate, the
 * rail draws to card 3, and the score resolves last.
 */
const DELAY = {
  card: [0, 700, 1680],
  rail: [520, 1500],
  railHead: [1000, 1980],
  ruleFirst: 180,
  ruleStagger: 70,
  strategies: 400,
  token: 880,
  gate: 1420,
  gateLegend: 1500,
  arc: 1860,
  debrief: 1980,
  pattern: 2080,
} as const;

/** CSS custom properties are not part of React's CSSProperties type. */
function vars(values: Record<string, string | number>): React.CSSProperties {
  return values as React.CSSProperties;
}

export function HowItWorksSection() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  // Runs for every visitor, reduced motion included — see the header comment
  // for why this must not be short-circuited. One shot: the section states its
  // sequence once and then rests.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <section className="section-alt relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        {/* Ends in a full stop like the page's other declarative headings
            (LoopSection, SocialProofSection, DistinctionSection). The colon was
            promising a list the heading never delivered — the subheading does
            that job now, and does it in words. */}
        <SectionHeading sub="שלושה שלבים. את הראשון עושים פעם אחת — השניים הבאים רצים מעצמם, בכל עסקה.">
          ככה נראה מסחר עם Reflect.
        </SectionHeading>

        {/* One flex row rather than a grid: `items-stretch` + `flex-1` makes the
            three cards structurally the same height, with no min-height constant
            to keep in sync. Each card then pins its own mock to its floor with
            `mt-auto`, so whatever slack a shorter body leaves lands as breathing
            room above the mock instead of as dead space below it.

            Three across only from lg. At md each column is ~210px, which is too
            narrow for the body copy at any text scale; stacked, the cards are
            capped at 560px so they do not stretch to a 900px measure. */}
        <div
          ref={rootRef}
          className={`hiw-row flex flex-col lg:flex-row items-stretch max-w-[560px] lg:max-w-none mx-auto ${
            inView ? 'hiw-in' : ''
          }`}
          style={{ gap: 'var(--hiw-gap)' }}
        >
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            const station = STATIONS[i];
            return (
              <div
                key={step.title}
                className="hiw-step hiw-card relative flex-1 min-w-0 glass-card rounded-2xl flex flex-col"
                style={{
                  ...vars({ '--hiw-d': `${DELAY.card[i]}ms` }),
                  padding: 'var(--hiw-pad)',
                  borderTop: `2px solid ${station.topBorder}`,
                }}
              >
                {/* ── Station: the numeral inside the card's own header row,
                       above a hairline, sharing the row with the step's icon.
                       It is structure, not a sticker floating over the card. ── */}
                <div
                  className="flex items-center gap-3 pb-4 mb-4"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <span
                    className="shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-2xl font-extrabold"
                    style={{
                      background: station.tileBg,
                      border: `1px solid ${station.tileBorder}`,
                      color: station.numeral,
                      boxShadow: station.tileGlow,
                    }}
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0 truncate text-sm font-bold" style={{ color: 'rgba(0,210,210,0.9)' }}>
                    {step.phase}
                  </span>
                  <Icon size={20} className="ms-auto shrink-0" style={{ color: 'rgba(0,210,210,0.5)' }} aria-hidden />
                </div>

                <h3 className="text-xl font-bold text-white">{step.title}</h3>
                {/* rem rather than a px literal so the accessibility widget's
                    text scale actually reaches the body copy. 1.0625rem is the
                    17px this section already used. */}
                <p className="text-tg-muted mt-3" style={{ fontSize: '1.0625rem', lineHeight: 1.7 }}>
                  {step.body}
                </p>

                <div className="mt-auto pt-5">
                  {i === 0 && <RulesMock />}
                  {i === 1 && <GateMock />}
                  {i === 2 && <LessonMock />}
                </div>

                {/* ── The rail out of this station. Both variants hang off the
                       card root and are aria-hidden decoration. ── */}
                {i < STEPS.length - 1 && <RailToNext index={i} />}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── The rail ─────────────────────────────────────────────────

/**
 * Two variants of the same connector, one per layout.
 *
 * Horizontal (lg+): `insetInlineEnd: -var(--hiw-gap)` is the *left* edge under
 * RTL, so the slot occupies exactly the gutter between this card and the next
 * one, and `top` is computed from the card's padding plus half the numeral tile
 * — both in rem, so the rail stays centred on the numeral at every text-scale
 * step rather than drifting off it the way a pixel constant would.
 *
 * Vertical (below lg): the same connector rotated into the stacked layout,
 * hanging out of the card's bottom edge and centred on it.
 *
 * The line draws with `scaleX`/`scaleY` from its own start edge; the chevron is
 * a separate element so it is not squashed by that scale, and it points along
 * the reading direction (leftward is forward under RTL — the same reasoning as
 * RulesMock's ArrowLeft).
 */
function RailToNext({ index }: { index: number }) {
  const lineDelay = vars({ '--hiw-d': `${DELAY.rail[index]}ms` });
  const headDelay = vars({ '--hiw-d': `${DELAY.railHead[index]}ms` });
  // Picks up the ramp where the previous station left off and hands it to the
  // next one, so the three cards and two rails are one continuous gradient.
  const from = index === 0 ? 0.32 : 0.58;
  const to = index === 0 ? 0.58 : 0.88;
  const headColor = `rgba(0,210,210,${to})`;

  return (
    <>
      <span
        className="hidden lg:block absolute pointer-events-none"
        style={{
          top: 'calc(var(--hiw-pad) + 1.5rem)',
          marginTop: -1,
          insetInlineEnd: 'calc(-1 * var(--hiw-gap))',
          width: 'var(--hiw-gap)',
          height: 2,
        }}
        aria-hidden
      >
        <span
          className="hiw-rail-h block w-full h-full rounded-full"
          style={{
            ...lineDelay,
            background: `linear-gradient(to left, rgba(0,210,210,${from}), rgba(0,210,210,${to}))`,
          }}
        />
        <ChevronLeft
          size={14}
          className="hiw-fade absolute"
          style={{ ...headDelay, insetInlineEnd: 0, top: '50%', marginTop: -7, color: headColor }}
        />
      </span>

      <span
        className="lg:hidden absolute pointer-events-none"
        style={{
          bottom: 'calc(-1 * var(--hiw-gap))',
          height: 'var(--hiw-gap)',
          left: '50%',
          marginLeft: -1,
          width: 2,
        }}
        aria-hidden
      >
        <span
          className="hiw-rail-v block w-full h-full rounded-full"
          style={{
            ...lineDelay,
            background: `linear-gradient(to bottom, rgba(0,210,210,${from}), rgba(0,210,210,${to}))`,
          }}
        />
        <ChevronDown
          size={14}
          className="hiw-fade absolute"
          style={{ ...headDelay, bottom: 0, left: '50%', marginLeft: -7, color: headColor }}
        />
      </span>
    </>
  );
}

// ── Mocks ────────────────────────────────────────────────────

/**
 * Shared shell for the three micro-mocks — a labelled header over a body — so
 * three quite different illustrations still read as one family, the same way
 * DistinctionSection's PanelShell holds its two panels together.
 */
function MockPanel({
  title,
  cue,
  cueColor,
  live,
  children,
}: {
  title: string;
  cue: string;
  cueColor: string;
  live?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl border p-3.5 flex flex-col gap-3"
      style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.28)' }}
      aria-hidden
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-bold" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.5)' }}>
          {title}
        </span>
        <span className="shrink-0 flex items-center gap-1.5 font-bold" style={{ fontSize: 10.5, color: cueColor }}>
          {live && <span className="hero-live-dot" style={{ width: 6, height: 6 }} />}
          {cue}
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Card 1 — the four rule types the copy names. Three are thresholds, so they get
 * tracks whose fill is derived from value/max; the fourth is a permitted set, so
 * it gets chips instead of a fourth identical slider.
 *
 * The fills sweep out from the inline-start edge (right, under RTL) on a
 * stagger. `width` is the animated property rather than a transform because the
 * fill is absolutely positioned — it cannot reflow a sibling — and because the
 * thumb rides on the fill's end edge, which a `scaleX` would have squashed.
 */
function RulesMock() {
  return (
    <MockPanel title="החוקים שלך" cue={`${ACTIVE_RULES} פעילים`} cueColor="rgba(0,210,210,0.9)">
      {RULES.map((rule, i) => (
        <div key={rule.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate" style={{ fontSize: 12, color: 'rgba(255,255,255,0.62)' }}>
              {rule.label}
            </span>
            <span
              className="shrink-0 font-bold text-white"
              style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}
            >
              {rule.display}
            </span>
          </div>
          <span className="relative block h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.09)' }}>
            <span
              className="hiw-fill absolute inset-y-0 rounded-full"
              style={{
                ...vars({
                  '--hiw-w': `${(rule.value / rule.max) * 100}%`,
                  '--hiw-d': `${DELAY.ruleFirst + i * DELAY.ruleStagger}ms`,
                }),
                insetInlineStart: 0,
                background: 'linear-gradient(to left, rgba(0,210,210,0.45), #00d2d2)',
              }}
            >
              {/* Rides the fill's end edge. A logical negative margin centres it
                  on that edge in either direction, where a translate would have
                  had to know which way is forward. */}
              <span
                className="absolute top-1/2 w-2.5 h-2.5 rounded-full"
                style={{
                  insetInlineEnd: 0,
                  marginInlineEnd: -5,
                  marginTop: -5,
                  background: '#fff',
                  boxShadow: '0 0 8px rgba(0,210,210,0.8)',
                }}
              />
            </span>
          </span>
        </div>
      ))}

      <div
        className="hiw-fade flex items-center justify-between gap-2 pt-2.5"
        style={{ ...vars({ '--hiw-d': `${DELAY.strategies}ms` }), borderTop: '1px solid rgba(255,255,255,0.07)' }}
      >
        <span className="truncate" style={{ fontSize: 12, color: 'rgba(255,255,255,0.62)' }}>
          אסטרטגיות מותרות
        </span>
        <span className="shrink-0 flex items-center gap-1.5">
          {STRATEGIES.map((strategy) => (
            <span
              key={strategy}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-bold whitespace-nowrap"
              style={{
                fontSize: 9.5,
                color: TURQUOISE,
                background: 'rgba(0,210,210,0.12)',
                border: '1px solid rgba(0,210,210,0.35)',
              }}
            >
              <Check size={9} className="shrink-0" />
              {strategy}
            </span>
          ))}
        </span>
      </div>
    </MockPanel>
  );
}

/**
 * Card 2 — enforcement at the gate, told as a queue rather than as a checklist
 * with a warning row. That checklist is already the hero's visual and RulesMock's
 * visual; a third copy of it here would have spent the same idea three times on
 * one page and taught a visitor nothing new on the third reading.
 *
 * So: a lane with a barrier across it. Trades run right → left (forward, under
 * RTL), the ones within the rules are through and parked past the gate, and the
 * one over the cap slides up to the barrier and stops dead against it. The gate
 * lights as it arrives. The idea is interception, and here it is the *geometry*
 * that says so — nothing has to be read for the picture to land.
 */
function GateMock() {
  const stopped = STOPPED[0];

  return (
    <MockPanel title="בדיקה לפני פתיחה" cue="בזמן אמת" cueColor={TURQUOISE} live>
      {/* Clipped: the incoming chip starts parked outside the lane, and the card
          itself does not clip its children.

          The lane's gaps and the chips' own padding are pixel values rather
          than rem, like every other measurement inside these mocks. The lane is
          the section's tightest row — 210px at 376px wide with the text scale at
          150% — and letting the spacing grow with the type it does not contain
          was enough on its own to push a tile out of the clip. */}
      <div className="relative flex items-center overflow-hidden" style={{ minHeight: 46, gap: 8 }}>
        {/* Incoming side — inline-start is the right edge under RTL, so this is
            where a trade arrives from. `justify-end` rests the chip against the
            barrier once it has travelled.

            Both halves are `flex: 1 0 auto`: they share the slack evenly, so the
            barrier sits near the middle of a wide lane, but neither is ever
            sized below its own content the way an equal `flex-1` split did. */}
        <span className="flex justify-end" style={{ flex: '1 0 auto' }}>
          <span
            className="hiw-token flex items-center rounded-lg whitespace-nowrap"
            style={{
              gap: 5,
              padding: '5px 8px',
              // Positive X is physically rightward in both directions, which is
              // "not yet arrived" under RTL.
              ...vars({ '--hiw-x': 'calc(100% + 2.5rem)', '--hiw-d': `${DELAY.token}ms` }),
              background: 'rgba(245,158,11,0.14)',
              border: `1px solid ${AMBER}`,
            }}
          >
            <Ban size={11} className="shrink-0" style={{ color: AMBER }} />
            <span className="font-bold" style={{ fontSize: 10, color: AMBER }}>
              {stopped.symbol}
            </span>
          </span>
        </span>

        {/* The barrier */}
        <span className="relative shrink-0 flex items-center justify-center" style={{ width: 26, height: 46 }}>
          <span
            className="hiw-gate-bar absolute inset-y-0 rounded-full"
            style={{ ...vars({ '--hiw-d': `${DELAY.gate}ms` }), left: '50%', marginLeft: -1.5, width: 3 }}
          />
          <span
            className="hiw-gate relative flex items-center justify-center rounded-full"
            style={{
              ...vars({ '--hiw-d': `${DELAY.gate}ms` }),
              width: 24,
              height: 24,
              background: '#11151b',
            }}
          >
            <ShieldAlert size={13} style={{ color: TURQUOISE }} />
          </span>
        </span>

        {/* Cleared side. `justify-start` is its right edge — against the gate —
            so these read as trades that have just come through it.

            Ticks rather than labelled chips: three symbol chips plus the gate
            plus the incoming chip need ~266px of lane, and the lane has 268px
            at 376px wide — 214px once the accessibility text scale grows the
            paddings around it — so the third one was clipped before this. The
            trades that passed are a count; the one that did not is the one with
            an identity, and it keeps its symbol. */}
        <span className="flex justify-start" style={{ flex: '1 0 auto', gap: 5 }}>
          {CLEARED.map((trade, i) => (
            <span
              key={`${trade.symbol}-${i}`}
              className="flex items-center justify-center rounded-md shrink-0"
              style={{
                width: 22,
                height: 22,
                background: 'rgba(0,210,210,0.1)',
                border: '1px solid rgba(0,210,210,0.32)',
              }}
            >
              <Check size={11} style={{ color: TURQUOISE }} />
            </span>
          ))}
        </span>
      </div>

      <div
        className="hiw-fade flex items-center justify-between gap-2"
        style={vars({ '--hiw-d': `${DELAY.gateLegend}ms` })}
      >
        <span className="truncate font-bold" style={{ fontSize: 10.5, color: AMBER }}>
          {`נעצרה ${STOPPED.length} — מעל ${MAX_TRADES_PER_DAY} ליום`}
        </span>
        <span className="shrink-0 font-bold" style={{ fontSize: 10.5, color: 'rgba(0,210,210,0.85)' }}>
          {`עברו ${CLEARED.length}`}
        </span>
      </div>

      <p className="pt-2.5" style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        {`החוק שנאכף: מקסימום ${MAX_TRADES_PER_DAY} עסקאות ביום`}
      </p>
    </MockPanel>
  );
}

const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Card 3 — one row per promise the copy makes, because the copy makes three and
 * the mock used to show one. The score arc, an AI debrief line, and a named
 * pattern with the history behind it.
 *
 * The arc sweeps on a `stroke-dashoffset` transition and the numeral simply
 * arrives at its value. Deliberately not a count-up: that is a rAF loop, which
 * is exactly the kind of motion the accessibility toggle cannot currently reach,
 * and both HeroMock and DisciplineScoreMock already count a number up on this
 * page anyway.
 */
function LessonMock() {
  return (
    <MockPanel title="אחרי הסגירה" cue="30 הימים האחרונים" cueColor="rgba(255,255,255,0.55)">
      <div className="flex items-center gap-3">
        <span className="relative shrink-0" style={{ width: 52, height: 52 }}>
          <svg width={52} height={52} viewBox="0 0 52 52">
            <circle cx={26} cy={26} r={RING_R} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={5} />
            <circle
              className="hiw-arc"
              cx={26}
              cy={26}
              r={RING_R}
              fill="none"
              stroke={TURQUOISE}
              strokeWidth={5}
              strokeLinecap="round"
              strokeDasharray={RING_C}
              style={{
                ...vars({
                  '--hiw-arc-len': RING_C,
                  '--hiw-arc-off': RING_C * (1 - DISCIPLINE_SCORE / 100),
                  '--hiw-d': `${DELAY.arc}ms`,
                }),
                // Starts the sweep at twelve o'clock instead of three.
                transform: 'rotate(-90deg)',
                transformOrigin: '50% 50%',
              }}
            />
          </svg>
          <span
            className="hiw-fade absolute inset-0 flex items-center justify-center font-extrabold text-white"
            style={{ ...vars({ '--hiw-d': `${DELAY.arc}ms` }), fontSize: 17, fontVariantNumeric: 'tabular-nums' }}
          >
            {DISCIPLINE_SCORE}
          </span>
        </span>

        <span className="min-w-0 flex flex-col gap-0.5">
          <span className="truncate font-bold text-white" style={{ fontSize: 12.5 }}>
            ציון משמעת
          </span>
          <span className="truncate font-bold" style={{ fontSize: 11, color: GREEN }}>
            {`+${DISCIPLINE_SCORE_DELTA} מהחודש שעבר`}
          </span>
        </span>
      </div>

      <div
        className="hiw-fade flex items-start gap-2 rounded-lg px-2.5 py-2"
        style={{
          ...vars({ '--hiw-d': `${DELAY.debrief}ms` }),
          background: 'rgba(0,210,210,0.07)',
          border: '1px solid rgba(0,210,210,0.22)',
        }}
      >
        <Sparkles size={13} className="shrink-0" style={{ color: TURQUOISE, marginTop: 2 }} />
        <span style={{ fontSize: 11.5, lineHeight: 1.5, color: 'rgba(255,255,255,0.85)' }}>{DEBRIEF_INSIGHT}</span>
      </div>

      <div className="hiw-fade flex items-center gap-2" style={vars({ '--hiw-d': `${DELAY.pattern}ms` })}>
        <Radar size={13} className="shrink-0" style={{ color: AMBER }} />
        <span
          className="shrink-0 rounded-md px-1.5 py-0.5 font-bold whitespace-nowrap"
          style={{
            fontSize: 9.5,
            color: AMBER,
            background: 'rgba(245,158,11,0.14)',
            border: '1px solid rgba(245,158,11,0.4)',
          }}
        >
          {PATTERN.tag}
        </span>
        <span className="truncate" style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)' }}>
          {PATTERN.note}
        </span>
      </div>
    </MockPanel>
  );
}
