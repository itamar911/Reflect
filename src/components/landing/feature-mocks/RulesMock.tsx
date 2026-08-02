'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Ban, Bell, Lock, MousePointer2, ShieldAlert } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

/**
 * The custom-rules engine is the product's differentiator, so this mock has to
 * answer three questions without any reading: what a rule *is* (an if→then
 * pair), how hard it bites (three enforcement levels), and what it feels like
 * when one fires (a real interception, not a screenshot of the aftermath).
 *
 * The interception is a four-phase loop driven in JS rather than CSS keyframes:
 * the button, the rule row and the warning line all have to change together on
 * the same beat, and a shared piece of state expresses that far more directly
 * than four independently-timed animations that merely agree with each other.
 */

// ── Enforcement levels ───────────────────────────────────────

/**
 * Three levels on a yellow→orange→red severity ramp. Every level carries an
 * icon and a written label as well as its colour, so the ramp is still legible
 * to a red/green-colourblind visitor and in a greyscale screenshot — colour is
 * the fastest channel here, never the only one.
 */
const LEVELS = {
  warn: { label: 'התראה', color: '#eab308', Icon: Bell },
  confirm: { label: 'דורש אישור', color: '#f97316', Icon: ShieldAlert },
  block: { label: 'חסימה', color: '#ef4444', Icon: Ban },
} as const;

type LevelKey = keyof typeof LEVELS;

/**
 * One rule per level so all three are on screen at once. The blocking rule is
 * first because it is the one that fires in the loop below, and it deliberately
 * restates the example from this card's own body copy ("אחרי 2 הפסדים — סיימת
 * להיום") so the mock and the paragraph under it corroborate each other.
 */
const RULES: { id: string; level: LevelKey; trigger: string; action: string }[] = [
  { id: 'losses', level: 'block', trigger: 'אחרי 2 הפסדים ביום', action: 'חסימת פתיחת עסקה' },
  { id: 'size', level: 'confirm', trigger: 'בסיכון מעל 2% מהחשבון', action: 'דרוש אישור לפני שליחה' },
  { id: 'open', level: 'warn', trigger: 'ב-5 הדקות הראשונות למסחר', action: 'הצג התראה' },
];

/** The rule the loop fires, and the one the header toggle reports the state of. */
const FEATURED = 0;
const FEATURED_NAME = 'מגבלת הפסדים יומית';

// ── Loop ─────────────────────────────────────────────────────

type Phase = 'idle' | 'press' | 'fire' | 'blocked';

/**
 * Timings are deliberately uneven: the press is quick, the rule fires almost
 * immediately after it (that adjacency is the whole point — the block lands
 * *before* the order, not after), and the blocked state holds long enough to
 * actually be read before the loop resets.
 */
const SEQUENCE: { phase: Phase; ms: number }[] = [
  { phase: 'idle', ms: 1500 },
  { phase: 'press', ms: 520 },
  { phase: 'fire', ms: 1000 },
  { phase: 'blocked', ms: 2800 },
];

// ── Stat strip ───────────────────────────────────────────────

const STATS: { label: string; value: string; color: string }[] = [
  { label: 'חסימות החודש', value: '12', color: '#ef4444' },
  { label: 'חוקים פעילים', value: '3', color: '#00d2d2' },
  { label: 'הפסד שנמנע', value: '₪2,840', color: '#4ade80' },
];

export function RulesMock() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(0);

  // Same one-shot reveal gate as CalendarMock: the sequence is the card's whole
  // point, so it must not have already played and reset before it scrolls in.
  useEffect(() => {
    if (reducedMotion) return;
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reducedMotion]);

  // A self-rescheduling timeout rather than one interval, because the phases
  // have different durations. Re-running on `step` is what advances the loop.
  useEffect(() => {
    if (reducedMotion || !inView) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % SEQUENCE.length), SEQUENCE[step].ms);
    return () => clearTimeout(id);
  }, [reducedMotion, inView, step]);

  // Reduced motion lands on the end state, which is the informative one: a
  // visitor who never sees the animation still sees a rule having blocked a
  // trade. Before the card scrolls into view it rests on `idle` instead, so the
  // sequence starts from the beginning when it arrives.
  const phase: Phase = reducedMotion ? 'blocked' : inView ? SEQUENCE[step].phase : 'idle';

  const firing = phase === 'fire';
  const locked = phase === 'blocked';
  const engaged = firing || locked; // the featured rule is lit in both phases
  const blockColor = LEVELS[RULES[FEATURED].level].color;

  return (
    <MockFrame height={420}>
      <div ref={rootRef} dir="rtl" className="flex flex-col flex-1 gap-2.5">
        {/* ── Header: the featured rule's own on/off state, not a decorative
               switch. The label names the rule the loop is about to fire, so
               the toggle and the highlighted row below are visibly the same
               object. It lights in the severity colour while that rule is
               engaged. ── */}
        <div className="flex items-center justify-between gap-2 shrink-0">
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="font-bold text-white truncate" style={{ fontSize: 13 }}>
              {FEATURED_NAME}
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: engaged ? blockColor : 'rgba(255,255,255,0.42)',
                transition: 'color 0.3s ease',
              }}
            >
              {engaged ? 'נאכף עכשיו' : 'פעיל · נאכף בזמן אמת'}
            </span>
          </span>

          <span
            className="flex items-center shrink-0 w-9 h-5 rounded-full p-0.5"
            style={{
              background: engaged ? blockColor : '#00d2d2',
              justifyContent: 'flex-end',
              boxShadow: engaged ? `0 0 12px ${blockColor}80` : 'none',
              transition: 'background 0.3s ease, box-shadow 0.3s ease',
            }}
            aria-hidden
          >
            <span className="w-4 h-4 rounded-full bg-white shrink-0" />
          </span>
        </div>

        {/* ── The three rules ── */}
        <div className="flex flex-col gap-2 shrink-0">
          {RULES.map((rule, i) => (
            <RuleRow key={rule.id} rule={rule} active={i === FEATURED && engaged} pulsing={i === FEATURED && firing} />
          ))}
        </div>

        {/* ── The interception. mt-auto pins this group to the card floor so the
               rules above and the stats below keep fixed positions across every
               phase — the warning line appearing must not shunt the layout. ── */}
        <div className="mt-auto flex flex-col items-center gap-2 shrink-0">
          <div className="relative w-full">
            <button
              type="button"
              disabled={locked}
              className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold"
              style={
                locked
                  ? {
                      background: 'rgba(239,68,68,0.08)',
                      border: `1px solid ${blockColor}66`,
                      color: 'rgba(255,255,255,0.5)',
                      boxShadow: `0 0 18px ${blockColor}1f`,
                      cursor: 'not-allowed',
                      transition: 'all 0.32s cubic-bezier(0.16,1,0.3,1)',
                    }
                  : {
                      background: 'rgba(0,210,210,0.14)',
                      border: '1px solid rgba(0,210,210,0.5)',
                      color: '#7ff3f3',
                      boxShadow: '0 0 18px rgba(0,210,210,0.12)',
                      // The press beat is a transform so it never reflows the
                      // rows above it.
                      transform: phase === 'press' ? 'scale(0.97)' : 'scale(1)',
                      transition: 'all 0.32s cubic-bezier(0.16,1,0.3,1)',
                    }
              }
            >
              {locked && (
                <span className="relative w-4 h-4 flex items-center justify-center shrink-0">
                  <span className="mock-lock-halo" aria-hidden />
                  <Lock size={14} style={{ color: blockColor, position: 'relative' }} />
                </span>
              )}
              פתח עסקה
            </button>

            {/* Simulated pointer — the same ghost-cursor device CalendarMock
                uses to show itself being operated. Parked just off the button's
                centre so it reads as a cursor on a control, not a bullet. */}
            {phase === 'press' && (
              <span
                className="rules-cursor absolute pointer-events-none"
                style={{ left: '50%', top: '52%' }}
                aria-hidden
              >
                <MousePointer2
                  size={16}
                  style={{ color: '#fff', fill: '#00d2d2', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.55))' }}
                />
              </span>
            )}
          </div>

          {/* Reserved height, so the line fading in never moves the button. */}
          <span className="flex items-center justify-center gap-1.5" style={{ height: 16 }}>
            {locked && (
              <>
                <AlertTriangle size={12} className="shrink-0" style={{ color: blockColor }} />
                <span style={{ fontSize: 11.5, fontWeight: 600, color: blockColor }}>
                  נחסם — 2 הפסדים היום, סיימת
                </span>
              </>
            )}
          </span>
        </div>

        {/* ── Stat strip: absorbs the old dead space and turns it into the
               argument for the feature. Same footer language as CalendarMock. ── */}
        <div className="flex items-stretch pt-2.5 shrink-0" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {STATS.map((stat, i) => (
            <span key={stat.label} className="flex flex-1 items-stretch">
              {i > 0 && (
                <span className="w-px self-stretch shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }} aria-hidden />
              )}
              <span className="flex flex-1 flex-col items-center gap-0.5">
                <span className="text-center" style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)' }}>
                  {stat.label}
                </span>
                <span
                  dir="ltr"
                  className="font-extrabold leading-none"
                  style={{ fontSize: 15, color: stat.color, fontVariantNumeric: 'tabular-nums' }}
                >
                  {stat.value}
                </span>
              </span>
            </span>
          ))}
        </div>
      </div>
    </MockFrame>
  );
}

/**
 * One rule as an if→then pair. The two halves are separated on three channels
 * at once — position (own line), weight (0.6-alpha regular vs solid white bold)
 * and the arrow connector — so the structure survives being glanced at.
 *
 * The arrow is ArrowLeft rather than a mirrored ArrowRight: under dir="rtl"
 * leftward *is* the reading-forward direction, so it points from the condition
 * into its consequence exactly as a Hebrew reader traverses the line.
 */
function RuleRow({
  rule,
  active,
  pulsing,
}: {
  rule: { level: LevelKey; trigger: string; action: string };
  active: boolean;
  pulsing: boolean;
}) {
  const level = LEVELS[rule.level];
  const LevelIcon = level.Icon;

  return (
    <div
      className={`relative rounded-xl overflow-hidden ${pulsing ? 'rules-row-fire' : ''}`}
      style={{
        background: active ? `${level.color}1a` : 'rgba(255,255,255,0.05)',
        border: `1px solid ${active ? `${level.color}80` : 'rgba(255,255,255,0.08)'}`,
        transition: 'background 0.3s ease, border-color 0.3s ease',
      }}
    >
      {/* Severity spine on the inline-start edge — right under RTL. */}
      <span
        className="absolute inset-y-0"
        style={{ insetInlineStart: 0, width: 3, background: level.color, opacity: active ? 1 : 0.75 }}
        aria-hidden
      />

      <div className="flex items-center gap-2 py-2 pe-2.5" style={{ paddingInlineStart: 11 }}>
        <span className="flex flex-1 flex-col gap-1 min-w-0">
          {/* Trigger */}
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="shrink-0 font-bold" style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)' }}>
              אם
            </span>
            <span className="truncate" style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.62)' }}>
              {rule.trigger}
            </span>
          </span>

          {/* Action */}
          <span className="flex items-center gap-1.5 min-w-0">
            <ArrowLeft size={11} className="shrink-0" style={{ color: level.color }} aria-hidden />
            <span className="truncate font-bold text-white" style={{ fontSize: 12.5 }}>
              {rule.action}
            </span>
          </span>
        </span>

        <span
          className="flex items-center gap-1 shrink-0 rounded-md px-1.5 py-0.5"
          style={{ background: `${level.color}1f`, border: `1px solid ${level.color}59` }}
        >
          <LevelIcon size={9.5} className="shrink-0" style={{ color: level.color }} aria-hidden />
          <span className="font-bold whitespace-nowrap" style={{ fontSize: 9, color: level.color }}>
            {level.label}
          </span>
        </span>
      </div>
    </div>
  );
}
