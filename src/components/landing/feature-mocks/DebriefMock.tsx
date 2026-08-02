'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Lightbulb, Radar, Sparkles } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

/**
 * The section copy promises analysis of *how you behaved* plus a score that is
 * "מחושב, לא מומצא". Both claims have to be visible, so this card is built
 * around two pieces of evidence: a score broken into its three real components
 * (so the total is demonstrably arithmetic, not a vibe), and a named
 * behavioural pattern with the history that identified it.
 *
 * The findings stream in one at a time before the score resolves, which is the
 * order the claim implies: observations first, score derived from them.
 */

// ── The trade under review ───────────────────────────────────

const TRADE = { symbol: 'NQ1', direction: 'לונג', timeframe: '5m', result: -320 };

// ── Score decomposition ──────────────────────────────────────

/**
 * The product's real weighting: Planning 30 + Strategy Adherence 30 +
 * Discipline 40. The total and the denominator are both summed from this array
 * rather than written down, so the headline can never drift from the bars that
 * are supposed to explain it.
 */
const SCORE_PARTS = [
  { label: 'תכנון', value: 26, max: 30 },
  { label: 'נאמנות לאסטרטגיה', value: 27, max: 30 },
  { label: 'משמעת', value: 29, max: 40 },
];

const TOTAL = SCORE_PARTS.reduce((sum, p) => sum + p.value, 0); // 82
const TOTAL_MAX = SCORE_PARTS.reduce((sum, p) => sum + p.max, 0); // 100

// ── Findings ─────────────────────────────────────────────────

/**
 * A verdict ramp, not a severity ramp — these classify what the analysis found,
 * so the axis differs from RulesMock's enforcement levels and the palette does
 * too: green reads as "this went right", which has no counterpart there, and
 * blue marks advice rather than a problem. Only amber overlaps, because a
 * warning means the same thing in both places.
 */
const KINDS = {
  ok: { label: 'אישור', color: '#4ade80', Icon: Check },
  warn: { label: 'אזהרה', color: '#f59e0b', Icon: AlertTriangle },
  tip: { label: 'המלצה', color: '#38bdf8', Icon: Lightbulb },
} as const;

type KindKey = keyof typeof KINDS;

/**
 * Deliberately coherent with the pattern below: the stop was handled well, the
 * *entry* was the impulsive part, and the tip addresses that specific failure
 * rather than being generic advice. The early-exit warning covers the third
 * behaviour the section copy names (alongside FOMO and revenge trades), so
 * between these rows and the pattern tag every claim in the paragraph under the
 * card has something on screen backing it.
 */
const FINDINGS: { kind: KindKey; text: string }[] = [
  { kind: 'ok', text: 'הסטופ הוגדר מראש ולא הוזז' },
  { kind: 'warn', text: 'כניסה 3 דקות אחרי פספוס תנועה' },
  { kind: 'warn', text: 'היציאה בוצעה ב-40% מהדרך ליעד' },
  { kind: 'tip', text: 'המתן לנר אישור לפני כניסה חוזרת' },
];

const PATTERN = { tag: 'FOMO', text: 'חוזר ב-4 מתוך 6 העסקאות האחרונות' };

// ── Loop ─────────────────────────────────────────────────────

/**
 * One phase per revealed element, so "streaming" is expressed as the sequence
 * advancing rather than as five animations that happen to be delayed into
 * agreement. Index order is load-bearing: everything below derives its
 * visibility from comparing the current index against its own.
 */
const SEQUENCE = [
  { phase: 'scan', ms: 900 },
  { phase: 'f1', ms: 680 },
  { phase: 'f2', ms: 680 },
  { phase: 'f3', ms: 680 },
  { phase: 'f4', ms: 680 },
  { phase: 'pattern', ms: 850 },
  { phase: 'score', ms: 1050 },
  { phase: 'hold', ms: 2800 },
];

/** Derived from FINDINGS rather than written down, so adding or removing a
 *  finding retimes the tail of the sequence instead of silently desyncing it. */
const I_PATTERN = FINDINGS.length + 1;
const I_SCORE = I_PATTERN + 1;
const LAST = SEQUENCE.length - 1;

function group(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatMoney(n: number) {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}₪${group(Math.abs(n))}`;
}

export function DebriefMock() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(0);

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
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    if (reducedMotion || !inView) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % SEQUENCE.length), SEQUENCE[step].ms);
    return () => clearTimeout(id);
  }, [reducedMotion, inView, step]);

  // Reduced motion jumps to the resolved report — the state that carries the
  // information. Before scroll-in the card rests on `scan`, which still renders
  // the header and the score frame, so it never reads as a broken empty box.
  const idx = reducedMotion ? LAST : inView ? step : 0;

  const scanning = idx === 0;
  const scoreIn = idx >= I_SCORE;

  return (
    <MockFrame height={440}>
      <div ref={rootRef} dir="rtl" className="flex flex-col flex-1 gap-3">
        {/* ── Header: what is being debriefed ── */}
        <div className="flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
                style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
                aria-hidden
              >
                <Sparkles size={13} style={{ color: '#00d2d2' }} />
              </span>
              <span className="text-sm font-bold text-white truncate">תחקיר עסקה</span>
            </span>

            {/* The analysing indicator occupies the same slot the findings will
                fill, so its disappearance reads as the analysis completing. */}
            {scanning && (
              <span className="flex items-center gap-1.5 shrink-0" aria-hidden>
                <span className="debrief-scan-dot" style={{ background: '#00d2d2' }} />
                <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.45)' }}>מנתח</span>
              </span>
            )}
          </div>

          {/* Trade context chips — same treatment as PlanCheckMock's header row,
              with the result carrying its own P&L colour. */}
          <div className="flex items-center gap-1.5 flex-wrap" aria-hidden>
            <Chip>{TRADE.symbol}</Chip>
            <Chip>{TRADE.direction}</Chip>
            <Chip>{TRADE.timeframe}</Chip>
            <Chip tone={TRADE.result < 0 ? '#f87171' : '#4ade80'}>{formatMoney(TRADE.result)}</Chip>
          </div>
        </div>

        {/* ── Score: total plus the three components that produce it ── */}
        <div
          className="flex items-center gap-3 shrink-0 rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {/* Fixed widths here have to give way on a phone: the card's inner
              width drops to ~240px, and a 62px total column plus a 92px label
              leaves the flex-1 bar about 15px — the bars collapse into dots and
              stop showing any proportion at all, which is the one thing they
              exist to do. */}
          <span className="flex flex-col items-center shrink-0 w-[48px] sm:w-[62px]">
            <span
              dir="ltr"
              className="font-extrabold leading-none"
              style={{ fontSize: 30, color: '#00d2d2', fontVariantNumeric: 'tabular-nums' }}
            >
              {TOTAL}
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', fontVariantNumeric: 'tabular-nums' }}>
              / {TOTAL_MAX}
            </span>
          </span>

          <span className="w-px self-stretch shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }} aria-hidden />

          <span className="flex flex-1 flex-col gap-1.5 min-w-0">
            {SCORE_PARTS.map((part, i) => (
              <span key={part.label} className="flex items-center gap-2 min-w-0">
                <span
                  className="truncate shrink-0 w-[56px] sm:w-[92px] text-[9px] sm:text-[9.5px]"
                  style={{ color: 'rgba(255,255,255,0.5)' }}
                >
                  {part.label}
                </span>

                <span
                  className="flex-1 rounded-full overflow-hidden min-w-0"
                  style={{ height: 5, background: 'rgba(255,255,255,0.08)' }}
                >
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: scoreIn ? `${(part.value / part.max) * 100}%` : '0%',
                      background: 'linear-gradient(90deg, rgba(0,210,210,0.55), #00d2d2)',
                      transition: 'width 0.75s cubic-bezier(0.16,1,0.3,1)',
                      // Staggered so the three bars fill in sequence rather than
                      // snapping together, which reads as three measurements.
                      transitionDelay: reducedMotion ? '0ms' : `${i * 130}ms`,
                    }}
                  />
                </span>

                <span
                  dir="ltr"
                  className="shrink-0 font-bold text-[9px] sm:text-[10px]"
                  style={{ color: 'rgba(255,255,255,0.75)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {part.value}/{part.max}
                </span>
              </span>
            ))}
          </span>
        </div>

        {/* ── Findings. Rows are always mounted at a reserved height and reveal
               via opacity + a clip-path wipe, so nothing below them moves as the
               analysis streams in. ── */}
        <div className="flex flex-col gap-1.5 flex-1 min-h-0 justify-center">
          {FINDINGS.map((finding, i) => {
            const kind = KINDS[finding.kind];
            const KindIcon = kind.Icon;
            const shown = idx >= i + 1;

            return (
              <div
                key={finding.text}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                style={{
                  background: shown ? `${kind.color}0f` : 'transparent',
                  border: `1px solid ${shown ? `${kind.color}33` : 'transparent'}`,
                  opacity: shown ? 1 : 0,
                  transition: 'opacity 0.28s ease, background 0.28s ease, border-color 0.28s ease',
                }}
              >
                <KindIcon size={13} className="shrink-0" style={{ color: kind.color }} aria-hidden />
                <span
                  className={`flex-1 min-w-0 truncate ${shown && !reducedMotion ? 'debrief-stream' : ''}`}
                  style={{ fontSize: 12, color: 'rgba(255,255,255,0.82)' }}
                >
                  {finding.text}
                </span>
                <span
                  className="shrink-0 rounded font-bold px-1.5 py-0.5"
                  style={{ fontSize: 8.5, color: kind.color, background: `${kind.color}1f` }}
                >
                  {kind.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* ── Detected pattern — the specific claim the section copy makes ── */}
        <div
          className="flex items-center gap-2 shrink-0 rounded-xl px-2.5 py-2"
          style={{
            background: 'rgba(168,85,247,0.1)',
            border: '1px solid rgba(168,85,247,0.35)',
            opacity: idx >= I_PATTERN ? 1 : 0,
            transform: idx >= I_PATTERN ? 'translateY(0)' : 'translateY(4px)',
            transition: 'opacity 0.32s ease, transform 0.32s cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <Radar size={14} className="shrink-0" style={{ color: '#c084fc' }} aria-hidden />
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="flex items-center gap-1.5">
              <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.45)' }}>דפוס שזוהה</span>
              <span
                dir="ltr"
                className="rounded font-extrabold px-1.5"
                style={{ fontSize: 10, color: '#c084fc', background: 'rgba(168,85,247,0.2)' }}
              >
                {PATTERN.tag}
              </span>
            </span>
            <span className="truncate" style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>
              {PATTERN.text}
            </span>
          </span>
        </div>
      </div>
    </MockFrame>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className="rounded-md px-2 py-1 font-semibold"
      style={{
        fontSize: 11,
        background: tone ? `${tone}1a` : 'rgba(255,255,255,0.06)',
        border: `1px solid ${tone ? `${tone}59` : 'rgba(255,255,255,0.1)'}`,
        color: tone ?? 'rgba(255,255,255,0.55)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {children}
    </span>
  );
}
