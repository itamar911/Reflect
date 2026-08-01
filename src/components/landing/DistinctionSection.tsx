'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, ShieldCheck, Check, AlertTriangle, Lock, Archive, Unlink } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

/**
 * The section's argument is that a journal is a rearview mirror and Reflect is
 * also brakes. Two panels carry it: the moment a trade is opened, and the record
 * left behind once it closed.
 *
 * The panels are deliberately NOT the same surface. A visitor who reads no copy
 * should still see one panel as happening and the other as history — so the
 * decision panel is turquoise, lit and pulsing, and the archive panel is slate,
 * desaturated and stamped with a past timestamp. They share a header/body/footer
 * skeleton and a fixed height so they still read as a matched pair rather than
 * two unrelated cards.
 *
 * They are aria-hidden: they are an illustration of the argument, and the two
 * paragraphs beside them carry the same content in prose. A screen reader gets
 * the argument without a stream of decorative figures.
 */

// ── The closed trade's record ────────────────────────────────

/**
 * Six sessions, worst to most recent. Every figure the archive panel shows is
 * derived from this — the net, the red-day count and the trade count — so the
 * chart and the numbers under it can never drift apart.
 */
const SESSIONS: { pnl: number; trades: number }[] = [
  { pnl: -180, trades: 2 },
  { pnl: 320, trades: 2 },
  { pnl: -420, trades: 3 },
  { pnl: 150, trades: 1 },
  { pnl: -640, trades: 4 },
  { pnl: -470, trades: 3 },
];

const NET = SESSIONS.reduce((sum, s) => sum + s.pnl, 0);
const RED_DAYS = SESSIONS.filter((s) => s.pnl < 0).length;
const TOTAL_TRADES = SESSIONS.reduce((sum, s) => sum + s.trades, 0);
const MAX_ABS = Math.max(...SESSIONS.map((s) => Math.abs(s.pnl)));

/** Hand-rolled rather than toLocaleString, so server and browser ICU builds
 *  cannot disagree and trip a hydration mismatch. */
function group(n: number) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const SLATE = '#94a3b8';
const TURQUOISE = '#00d2d2';
const AMBER = '#f59e0b';

// ── Motion ───────────────────────────────────────────────────

/**
 * A one-shot, scroll-triggered chain rather than a loop — the section makes its
 * point once and then rests.
 *
 * The beats encode causality, which is this section's whole idea and the reason
 * it borrows neither the hero's scan sweep nor RulesMock's block loop: the
 * decision panel resolves on its own (checks land, the rule fires, the trade is
 * blocked), a pulse then physically travels from it into the archive panel, and
 * only then does the archive materialise — so the record visibly *follows from*
 * the decision instead of the two appearing side by side. The synthesis lands
 * last, once both halves are on screen to be synthesised.
 *
 * Each entry is the dwell before advancing to the next step.
 */
const STEPS = [
  { ms: 120 }, // 0 → 1  decision panel settles
  { ms: 260 }, // 1 → 2  first check
  { ms: 200 }, // 2 → 3  second check
  { ms: 300 }, // 3 → 4  the rule fires
  { ms: 340 }, // 4 → 5  the trade is blocked
  { ms: 240 }, // 5 → 6  beat, then the pulse leaves
  { ms: 620 }, // 6 → 7  pulse travels (matches .dist-pulse duration)
  { ms: 560 }, // 7 → 8  archive materialises, then the synthesis
];

const FINAL_STEP = STEPS.length; // 8
const COUNT_MS = 900;

/**
 * Both panels are pinned to this so the pair stays matched however the two very
 * different bodies inside them measure out. It is also the lever for balancing
 * the two columns: merging the redundant paragraphs made the copy column
 * shorter, so the panels come down to meet it rather than the prose being
 * padded back out.
 */
const PANEL_MIN_H = 272;

export function DistinctionSection() {
  const reducedMotion = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(0);
  const [net, setNet] = useState(0);

  // Reduced motion lands on the finished state: both panels resolved and the
  // synthesis shown. Nothing is mounted that would animate.
  const s = reducedMotion ? FINAL_STEP : step;

  const panelIn = s >= 1;
  const check1 = s >= 2;
  const check2 = s >= 3;
  const fired = s >= 4;
  const blocked = s >= 5;
  const pulsing = s === 6;
  const archiveIn = s >= 7;
  const synthesisIn = s >= FINAL_STEP;

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

  // Self-rescheduling timeout, because the beats have different dwells. Stops
  // for good at FINAL_STEP — this is a chain, not a loop.
  useEffect(() => {
    if (reducedMotion || !inView || step >= FINAL_STEP) return;
    const id = setTimeout(() => setStep(step + 1), STEPS[step].ms);
    return () => clearTimeout(id);
  }, [reducedMotion, inView, step]);

  // setNet fires only from inside the rAF callback; the resting and
  // reduced-motion values are derived at render instead (see shownNet).
  useEffect(() => {
    if (!archiveIn || reducedMotion) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - t0) / COUNT_MS, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setNet(Math.round((eased * NET) / 10) * 10);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [archiveIn, reducedMotion]);

  const shownNet = reducedMotion ? NET : archiveIn ? net : 0;

  return (
    <section className="relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        {/* The punchline leads. It framed the section badly at the bottom, where
            it could only summarise what had already been read. */}
        <SectionHeading
          sub={
            <span className="font-semibold text-white/90">
              <span className="text-gradient-cyan font-extrabold">מראה אחורית + בלמים.</span> זה ההבדל
              בין לדעת מה קרה — לבין למנוע את זה.
            </span>
          }
        >
          יומן מסחר עובד. אבל רק בחצי מהזמן.
        </SectionHeading>

        {/* Two columns only from xl. At lg the container's half is ~440px, and
            two panels plus the node inside that leaves each panel ~170px of
            content — not enough for the labels, and the pair reads cramped.
            Below xl the section runs full width instead, which the panels use
            far better than a squeezed two-column split would. */}
        <div ref={rootRef} className="grid grid-cols-1 xl:grid-cols-2 gap-10 xl:gap-16 items-center">
          {/* copy — first child = right column in RTL */}
          <div className="flex flex-col gap-7">
            <ScrollReveal delay={80}>
              <p
                className="text-tg-muted max-w-[36rem] mx-auto xl:mx-0 xl:max-w-[33rem]"
                style={{ fontSize: 18.5, lineHeight: 1.85 }}
              >
                יומן טוב מראה לך מה קרה: איפה טעית, מה עבד, אילו דפוסים חוזרים אצלך. זה שלב הכרחי —
                בלי תיעוד אף אחד לא בוחן אותך.
              </p>
            </ScrollReveal>

            <ScrollReveal delay={160}>
              <p
                className="text-tg-muted max-w-[36rem] mx-auto xl:mx-0 xl:max-w-[33rem]"
                style={{ fontSize: 18.5, lineHeight: 1.85 }}
              >
                אבל יש רגע אחד שאף יומן בעולם לא מכסה: הרגע שבו האצבע על הכפתור, וכל מה שראית אתמול
                בסטטיסטיקות נעלם. Reflect בנוי על שני החצאים — הוא מנתח אותך לעומק אחרי כל עסקה, והוא
                נמצא איתך ברגע ההחלטה ואומר לך בפרצוף כשאתה עומד להפר את החוקים של עצמך.
              </p>
            </ScrollReveal>
          </div>

          {/* The pair. Decision first in DOM = right-most under RTL, so the two
              panels run decision → archive right-to-left, the same direction the
              pulse travels and the same order the synthesis below states them. */}
          <ScrollReveal delay={200}>
            {/* Stacked below sm: side by side the panels need ~380px of content
                width and force page-level horizontal scroll on a phone. */}
            <div className="relative flex flex-col sm:flex-row items-stretch gap-4" aria-hidden>
              <DecisionPanel
                panelIn={panelIn}
                check1={check1}
                check2={check2}
                fired={fired}
                blocked={blocked}
              />

              {/* The "+" is the section's thesis — both halves, not either one —
                  so it is built as a deliberate node with a halo ring rather than
                  a default-weight chip. */}
              <div className="shrink-0 self-center z-10">
                <span className="dist-plus-node flex items-center justify-center rounded-full">
                  <Plus size={22} strokeWidth={2.75} style={{ color: TURQUOISE }} />
                </span>
              </div>

              <ArchivePanel archiveIn={archiveIn} shownNet={shownNet} />

              {/* Causality pulse. Clipped by its own overlay rather than by the
                  row, so the panels keep their glow and nothing translated can
                  overflow the page. */}
              {pulsing && (
                <span className="absolute inset-0 overflow-hidden pointer-events-none z-20" aria-hidden>
                  <span className="dist-pulse" />
                </span>
              )}
            </div>
          </ScrollReveal>
        </div>

        {/* The synthesis — the one chip worth keeping, now the section's closing
            beat rather than one of three equal-weight items. */}
        <div className="mt-12 flex justify-center">
          <span
            className="dist-synthesis flex items-center gap-3 rounded-2xl px-7 py-4"
            style={{
              opacity: synthesisIn ? 1 : 0,
              transform: synthesisIn ? 'translateY(0)' : 'translateY(10px)',
              transition: 'opacity 0.5s ease, transform 0.6s cubic-bezier(0.16,1,0.3,1)',
            }}
          >
            <Unlink size={20} className="shrink-0" style={{ color: TURQUOISE }} />
            <span className="text-lg md:text-xl font-bold text-white">יחד — הלופ נשבר</span>
          </span>
        </div>
      </div>
    </section>
  );
}

// ── Panels ───────────────────────────────────────────────────

/**
 * Shared skeleton: a header row carrying the label and a state cue, a body that
 * takes the slack, and a two-stat footer above a hairline. It is what keeps two
 * very differently-weighted bodies reading as a pair.
 */
function PanelShell({
  children,
  label,
  Icon,
  accent,
  cue,
  live,
  stats,
  style,
}: {
  children: React.ReactNode;
  label: string;
  Icon: typeof ShieldCheck;
  accent: string;
  cue: React.ReactNode;
  live?: boolean;
  stats: { label: string; value: string; color: string }[];
  style: React.CSSProperties;
}) {
  return (
    <div
      className="flex-1 min-w-0 rounded-2xl border p-5 flex flex-col gap-3.5"
      style={{ minHeight: PANEL_MIN_H, ...style }}
    >
      {/* The labels are the section's most load-bearing words — the whole point
          of relabelling them was that they read correctly on their own — so
          nothing here may clip or reflow them. The state cue sits on its own
          row rather than beside the label: side by side the pair needs ~220px
          and the panel offers ~200px at the narrowest two-column width, which
          wrapped the label and pushed the two panels' bodies out of alignment.
          Two fixed rows also mean both headers are identically tall whatever
          the labels say. */}
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2">
          <Icon size={16} className="shrink-0" style={{ color: accent }} />
          <span className="font-bold leading-tight" style={{ color: accent, fontSize: 13.5 }}>
            {label}
          </span>
        </span>
        <span className="flex items-center gap-1.5" style={{ minHeight: 13 }}>
          {live && <span className="hero-live-dot" style={{ width: 6, height: 6 }} />}
          {cue}
        </span>
      </div>

      <div className="flex flex-col gap-2.5 flex-1">{children}</div>

      <div className="flex items-stretch pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        {stats.map((stat, i) => (
          <span key={stat.label} className="flex flex-1 items-stretch">
            {i > 0 && (
              <span className="w-px self-stretch shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }} />
            )}
            <span className="flex flex-1 flex-col items-center gap-0.5">
              <span className="text-center" style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
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
  );
}

/** The live half: turquoise, glowing, with a pulsing dot and a rule mid-fire. */
function DecisionPanel({
  panelIn,
  check1,
  check2,
  fired,
  blocked,
}: {
  panelIn: boolean;
  check1: boolean;
  check2: boolean;
  fired: boolean;
  blocked: boolean;
}) {
  return (
    <PanelShell
      label="ברגע ההחלטה"
      Icon={ShieldCheck}
      accent={TURQUOISE}
      live
      cue={
        <span className="font-bold" style={{ fontSize: 11, color: TURQUOISE }}>
          עכשיו
        </span>
      }
      stats={[
        { label: 'חוקים פעילים', value: '4', color: TURQUOISE },
        { label: 'נחסמו החודש', value: '12', color: AMBER },
      ]}
      style={{
        borderColor: 'rgba(0,210,210,0.45)',
        background: 'rgba(0,210,210,0.06)',
        boxShadow: '0 0 34px rgba(0,210,210,0.14)',
        opacity: panelIn ? 1 : 0,
        transform: panelIn ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 0.5s ease, transform 0.6s cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <CheckRow shown={check1} text="סטופ מוגדר · יחס 1:2.5" />
      <CheckRow shown={check2} text="סיכון 1.8% מהחשבון" />

      <div
        className="flex items-center gap-2 rounded-lg px-2.5 py-2 -mx-0.5"
        style={{
          background: fired ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${fired ? 'rgba(245,158,11,0.45)' : 'rgba(255,255,255,0.07)'}`,
          opacity: check2 ? 1 : 0,
          transition: 'background-color 0.35s ease, border-color 0.35s ease, opacity 0.4s ease',
        }}
      >
        <AlertTriangle
          size={15}
          className="shrink-0"
          style={{ color: fired ? AMBER : 'rgba(255,255,255,0.3)', transition: 'color 0.35s ease' }}
        />
        <span
          style={{
            fontSize: 13.5,
            lineHeight: 1.4,
            color: fired ? AMBER : 'rgba(255,255,255,0.4)',
            transition: 'color 0.35s ease',
          }}
        >
          עסקה שלישית היום — חוק שלך מופר
        </span>
      </div>

      {/* Reserved height, so the blocked bar appearing never shifts the rows. */}
      <div className="mt-auto" style={{ minHeight: 38 }}>
        <span
          className="flex items-center justify-center gap-2 rounded-lg w-full"
          style={{
            height: 38,
            background: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.45)',
            opacity: blocked ? 1 : 0,
            transform: blocked ? 'scale(1)' : 'scale(0.97)',
            transition: 'opacity 0.35s ease, transform 0.45s cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <Lock size={14} className="shrink-0" style={{ color: '#f87171' }} />
          <span className="font-bold" style={{ fontSize: 13, color: '#f87171' }}>
            פתיחת העסקה נחסמה
          </span>
        </span>
      </div>
    </PanelShell>
  );
}

function CheckRow({ shown, text }: { shown: boolean; text: string }) {
  return (
    <span
      className="flex items-center gap-2"
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'translateX(0)' : 'translateX(6px)',
        transition: 'opacity 0.4s ease, transform 0.5s cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
      <span className="text-white/85" style={{ fontSize: 13.5 }}>
        {text}
      </span>
    </span>
  );
}

/**
 * The archived half: slate, desaturated, no glow, and stamped with a past
 * timestamp — a record of something already over rather than something running.
 * The bars grow from a shared zero baseline on transform only.
 */
function ArchivePanel({ archiveIn, shownNet }: { archiveIn: boolean; shownNet: number }) {
  return (
    <PanelShell
      label="אחרי שהעסקה נסגרה"
      Icon={Archive}
      accent={SLATE}
      cue={
        <span style={{ fontSize: 10.5, color: 'rgba(148,163,184,0.75)', fontVariantNumeric: 'tabular-nums' }}>
          אתמול 17:42
        </span>
      }
      stats={[
        { label: 'ימים אדומים', value: `${RED_DAYS}/${SESSIONS.length}`, color: SLATE },
        { label: 'עסקאות', value: String(TOTAL_TRADES), color: SLATE },
      ]}
      style={{
        borderColor: 'rgba(148,163,184,0.22)',
        background: 'rgba(148,163,184,0.045)',
        opacity: archiveIn ? 1 : 0,
        transform: archiveIn ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 0.55s ease, transform 0.65s cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      {/* Six sessions around a zero baseline: wins grow up, losses grow down.
          Each bar scales from the baseline, so the growth is transform-only. */}
      <div className="relative w-full" style={{ height: 66 }}>
        <span
          className="absolute inset-x-0"
          style={{ top: '50%', height: 1, background: 'rgba(148,163,184,0.28)' }}
        />
        <div className="absolute inset-0 flex items-stretch justify-between gap-1.5">
          {SESSIONS.map((session, i) => {
            const up = session.pnl > 0;
            // A floor as well as a scale, so the smallest session is still a
            // legible bar rather than a hairline.
            const h = 6 + (Math.abs(session.pnl) / MAX_ABS) * 22;
            return (
              <span key={i} className="relative flex-1">
                <span
                  className="absolute rounded-sm"
                  style={{
                    // Fixed narrow width, centred in the column: filling the
                    // column made the bars wider than they were tall, which
                    // read as blocks rather than as a chart. marginLeft is
                    // static so the animated transform stays a pure scale.
                    left: '50%',
                    marginLeft: -5.5,
                    width: 11,
                    height: h,
                    [up ? 'bottom' : 'top']: '50%',
                    transformOrigin: up ? 'bottom' : 'top',
                    transform: archiveIn ? 'scaleY(1)' : 'scaleY(0)',
                    transition: 'transform 0.55s cubic-bezier(0.16,1,0.3,1)',
                    transitionDelay: `${i * 60}ms`,
                    background: up ? 'rgba(148,163,184,0.55)' : 'rgba(239,68,68,0.45)',
                  }}
                />
              </span>
            );
          })}
        </div>
      </div>

      <div className="mt-auto">
        {/* The paragraph stays RTL so the figure sits on the panel's start edge
            with everything else; only the numeral itself is isolated LTR, which
            is where the sign and separators would otherwise be reordered. */}
        <p className="font-extrabold leading-none" style={{ fontSize: 24, color: '#f87171' }}>
          <span dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {`-₪${group(Math.abs(shownNet))}`}
          </span>
        </p>
        <p className="mt-1.5" style={{ fontSize: 12.5, color: 'rgba(148,163,184,0.8)' }}>
          שישה ימים אחורה — אחרי שהכול כבר נסגר
        </p>
      </div>
    </PanelShell>
  );
}
