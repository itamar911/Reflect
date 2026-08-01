'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Lock, Check, AlertTriangle } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';

/**
 * The hero's trade-plan card, animated as a self-running interception.
 *
 * Deliberately NOT the same sequence as RulesMock: a visitor meets both in one
 * session, so repeating the beats there would make the second reading of it
 * feel like filler and spend the hero's impact twice. Two concrete differences:
 *
 *   - No ghost cursor. RulesMock shows itself being *operated*; the hero shows
 *     the system acting on its own, so the button depresses under its own
 *     ripple rather than under a fake pointer.
 *   - A scan, not a blink. A light bar sweeps the card and the violation row
 *     ignites as it crosses — that reads as "checking this trade against your
 *     rules", which is the actual product metaphor, where a row simply lighting
 *     up reads as nothing in particular.
 *
 * It is also more restrained than RulesMock because it competes with the
 * headline and CTA for attention rather than owning its viewport: nothing moves
 * for the first 1.5s, and the whole thing runs exactly twice before resting on
 * the locked state permanently. An endless loop behind copy people are trying
 * to read is fatiguing and says nothing new after the second pass.
 *
 * Everything animated here is transform/opacity (plus paint-only colour fades)
 * — this card is above the fold, so it must not touch layout on any frame.
 */

const CHIPS = ['NQ1', 'Long', '5m'];

/** Shekels the block saved. Counted up when the badge lands. */
const AVOIDED = 780;

/**
 * The sub-beats are phases rather than extra state because every one of them is
 * a function of elapsed time on the same timeline. Splitting the scan at the
 * moment the bar reaches the violation row, and the lock at the moment the
 * badge lands, keeps the whole card derivable from one step index — no
 * cascading setState, and the beats cannot drift apart.
 */
type Phase = 'idle' | 'press' | 'scan' | 'scanLit' | 'locked' | 'lockedBadge' | 'resetOut' | 'resetIn';

/**
 * `idle` is the "let them read first" beat — the whole card is static for its
 * duration, which is what delays the start to ~1.5s after load. The press is
 * quick; scan + scanLit together are the 1100ms the CSS sweep takes, split at
 * the point the bar crosses the violation row; locked + lockedBadge hold the
 * end state, split so the badge lands half a second after the button locks.
 *
 * resetOut/resetIn cross-fade the return to idle between the two passes. The
 * elements that revert (the violation row and the button) fade out still
 * wearing their locked look, swap state while they are at zero opacity, and
 * fade back already idle — so the card never visibly un-ignites. Letting the
 * colour transitions simply run backwards reads as a glitch this high on the
 * page. These two beats are skipped after the final pass: `done` freezes the
 * card on lockedBadge, so there is no dip before it settles.
 */
const SEQUENCE: { phase: Phase; ms: number }[] = [
  { phase: 'idle', ms: 1500 },
  { phase: 'press', ms: 450 },
  { phase: 'scan', ms: 660 },
  { phase: 'scanLit', ms: 440 },
  { phase: 'locked', ms: 500 },
  { phase: 'lockedBadge', ms: 2500 },
  { phase: 'resetOut', ms: 220 },
  { phase: 'resetIn', ms: 260 },
];

/** Passes before the card rests on the locked state for good. */
const RUNS = 2;

const COUNT_MS = 900;

export function HeroMock() {
  const reducedMotion = usePrefersReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(0);
  const [pass, setPass] = useState(0);

  const [amount, setAmount] = useState(0);

  const done = pass >= RUNS;
  // Reduced motion and the post-loop rest state are the same picture: the trade
  // blocked, the rule lit, the money saved. A visitor who never sees a frame of
  // the animation still sees the product's whole argument.
  //
  // Until the card is on screen it rests on `idle` — the readable, un-blocked
  // plan — so the sequence starts from the top whenever it is actually seen.
  const phase: Phase =
    reducedMotion || done ? 'lockedBadge' : inView ? SEQUENCE[step].phase : 'idle';

  // Everything below is derived from the phase — no second source of truth.
  const scanning = phase === 'scan' || phase === 'scanLit';
  const ignited =
    phase === 'scanLit' || phase === 'locked' || phase === 'lockedBadge' || phase === 'resetOut';
  const locked = phase === 'locked' || phase === 'lockedBadge' || phase === 'resetOut';
  const badgeIn = phase === 'lockedBadge';

  // During the cross-fade the row and button are mid-dip, so their colour
  // transitions are suppressed: the state swap has to be instantaneous at the
  // trough, otherwise the fade-in shows the old colours easing to the new ones
  // — which is the very thing the cross-fade exists to hide.
  const resetting = phase === 'resetOut' || phase === 'resetIn';
  const dipClass = phase === 'resetOut' ? 'hero-reset-out' : phase === 'resetIn' ? 'hero-reset-in' : '';

  /**
   * On desktop this card is above the fold, so the observer fires on mount and
   * the 1.5s `idle` beat is measured from load exactly as intended. On a phone
   * the hero stacks and the card lands ~1100px down — below every phone fold —
   * so without this gate the whole sequence would play out and settle before a
   * visitor ever scrolled to it, and they would only ever meet the end state.
   * Same one-shot reveal gate CalendarMock and RulesMock use.
   */
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
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reducedMotion]);

  // Self-rescheduling timeout rather than one interval: the phases have
  // different durations. The pass counter advances when `lockedBadge` ends
  // rather than on the wrap, so the final pass can stop right there and skip
  // the two reset beats entirely.
  useEffect(() => {
    if (reducedMotion || done || !inView) return;
    const id = setTimeout(() => {
      if (SEQUENCE[step].phase === 'lockedBadge') {
        const nextPass = pass + 1;
        setPass(nextPass);
        // On the last pass `done` takes over and freezes the card here.
        if (nextPass < RUNS) setStep(step + 1);
        return;
      }
      setStep(step === SEQUENCE.length - 1 ? 0 : step + 1);
    }, SEQUENCE[step].ms);
    return () => clearTimeout(id);
  }, [reducedMotion, done, inView, step, pass]);

  // setAmount only ever fires from inside the rAF callback, never synchronously
  // in the effect body — the resting and reduced-motion values are derived at
  // render time instead (see `shownAmount`).
  useEffect(() => {
    if (!badgeIn || reducedMotion || done) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - t0) / COUNT_MS, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setAmount(Math.round(eased * AVOIDED));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [badgeIn, reducedMotion, done]);

  const shownAmount = reducedMotion || done ? AVOIDED : badgeIn ? amount : 0;

  return (
    <div ref={rootRef} className="hero-mock-wrap relative mx-auto w-full max-w-md sm:max-w-lg lg:max-w-[560px] my-6">
      {/* Tighter bleed on phones — at -inset-10 the halo pokes ~24px past the
          viewport edges on narrow screens */}
      <div
        className="absolute -inset-3 md:-inset-10 rounded-[2rem] pointer-events-none"
        style={{ background: 'radial-gradient(60% 60% at 50% 40%, rgba(0,210,210,0.16), transparent 70%)' }}
        aria-hidden
      />

      <div
        className="hero-float-1 z-20 flex absolute -top-4 -right-3 sm:-top-6 sm:-right-5 lg:-top-8 lg:-right-8 items-center gap-1.5 rounded-full px-2.5 py-1 sm:px-3 sm:py-1.5 text-sm font-bold"
        style={{
          background: 'rgba(0,210,210,0.16)',
          border: '1px solid rgba(0,210,210,0.45)',
          color: '#00d2d2',
          boxShadow: '0 4px 18px rgba(0,210,210,0.25)',
        }}
        aria-hidden
      >
        ציון משמעת 87
      </div>

      {/* The saved-money badge. The float lives on the outer element and the
          entrance on the inner one, because .hero-float-2 owns `transform` and
          a keyframe animation would win over an inline transform here. */}
      <div
        className="hero-float-2 z-20 absolute -bottom-4 -left-3 sm:-bottom-6 sm:-left-5 lg:-bottom-8 lg:-left-8"
        aria-hidden
      >
        <span
          className="relative flex items-center gap-1.5 rounded-full px-2.5 py-1 sm:px-3 sm:py-1.5 text-sm font-bold"
          style={{
            background: 'rgba(239,68,68,0.14)',
            border: '1px solid rgba(239,68,68,0.4)',
            color: '#f87171',
            boxShadow: '0 4px 18px rgba(239,68,68,0.2)',
            opacity: badgeIn ? 1 : 0,
            transform: badgeIn ? 'scale(1)' : 'scale(0.86)',
            transition: 'opacity 0.32s ease, transform 0.42s cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          {/* Red bloom, as its own scaled/faded layer so no box-shadow is
              animated. Keyed so it replays on the second pass. */}
          {badgeIn && <span className="hero-badge-bloom" aria-hidden />}
          {/* One text node, so the bidi resolution is identical to the static
              string it replaced. Padded to a constant 3 cells with figure
              spaces + tabular figures, so counting up never resizes the pill. */}
          <span style={{ position: 'relative', fontVariantNumeric: 'tabular-nums' }}>
            {`-${String(shownAmount).padStart(3,' ')}₪ נמנע`}
          </span>
        </span>
      </div>

      <div
        className="hero-mock-card relative z-10 rounded-2xl border p-6 lg:p-8 overflow-hidden"
        style={{
          borderColor: 'rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.035)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45), 0 0 40px rgba(0,210,210,0.1)',
        }}
      >
        {/* The scan. A full-height gradient whose bright band is the "bar",
            translated by ±100% of itself — which equals the card height at any
            size, so the sweep needs no measurement and stays pure transform.
            It travels top-to-bottom; that axis is direction-neutral, so RTL
            leaves it alone (a horizontal sweep would have to start at the
            right edge). */}
        {scanning && <span className="hero-scan" aria-hidden />}

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <Image src="/icon.svg" alt="" width={26} height={26} unoptimized className="shrink-0" aria-hidden />
            <span className="text-base font-bold text-white">תוכנית עסקה</span>
          </div>
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: '#00d2d2', boxShadow: '0 0 8px #00d2d2' }}
            aria-hidden
          />
        </div>

        <div className="flex items-center gap-2 mb-5">
          {CHIPS.map((chip) => (
            <span
              key={chip}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white/75"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {chip}
            </span>
          ))}
        </div>

        <div className="flex flex-col gap-3 mb-5">
          <div className="flex items-center gap-2.5">
            <Check size={17} className="shrink-0" style={{ color: '#22c55e' }} />
            <span className="text-base text-white/85">סטופ מוגדר · יחס 1:2.5</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Check size={17} className="shrink-0" style={{ color: '#22c55e' }} />
            <span className="text-base text-white/85">מתאים לאסטרטגיה שלך</span>
          </div>

          {/* The violation. Dormant until the scan bar reaches it, then lit for
              the rest of the sequence. Colour fades are paint-only. */}
          <div
            className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 -mx-1 overflow-hidden ${dipClass}`}
            style={{
              background: ignited ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${ignited ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.08)'}`,
              transition: resetting ? 'none' : 'background-color 0.35s ease, border-color 0.35s ease',
            }}
          >
            {ignited && <span className="hero-row-bloom" aria-hidden />}
            <AlertTriangle
              size={17}
              className="shrink-0"
              style={{
                color: ignited ? '#f59e0b' : 'rgba(255,255,255,0.35)',
                transition: resetting ? 'none' : 'color 0.35s ease',
              }}
            />
            <span
              className="text-base"
              style={{
                position: 'relative',
                color: ignited ? '#f59e0b' : 'rgba(255,255,255,0.45)',
                transition: resetting ? 'none' : 'color 0.35s ease',
              }}
            >
              עסקה שלישית היום — חוק שלך מופר
            </span>
          </div>
        </div>

        <div className="relative">
          <button
            type="button"
            disabled={locked}
            className={`w-full flex items-center justify-center gap-2 rounded-xl py-3.5 text-base font-bold ${
              locked ? 'cursor-not-allowed' : ''
            } ${dipClass}`}
            style={
              locked
                ? {
                    background: 'rgba(245,158,11,0.08)',
                    border: '1px solid rgba(245,158,11,0.4)',
                    color: 'rgba(255,255,255,0.5)',
                    boxShadow: '0 0 22px rgba(245,158,11,0.15)',
                    transform: 'scale(1)',
                    transition: resetting
                      ? 'none'
                      : 'background-color 0.32s ease, border-color 0.32s ease, color 0.32s ease, transform 0.28s cubic-bezier(0.16,1,0.3,1)',
                  }
                : {
                    background: 'rgba(0,210,210,0.14)',
                    border: '1px solid rgba(0,210,210,0.5)',
                    color: '#7ff3f3',
                    boxShadow: '0 0 18px rgba(0,210,210,0.12)',
                    // Transform-only depress, so the rows above never reflow.
                    transform: phase === 'press' ? 'scale(0.965)' : 'scale(1)',
                    transition: resetting
                      ? 'none'
                      : 'background-color 0.32s ease, border-color 0.32s ease, color 0.32s ease, transform 0.28s cubic-bezier(0.16,1,0.3,1)',
                  }
            }
          >
            {locked && <Lock size={16} />}
            פתח עסקה
          </button>

          {/* Ripple out of the button's own centre — the hero's replacement for
              RulesMock's ghost cursor. Clipped to the button's rounded box. */}
          {phase === 'press' && (
            <span className="hero-press-ripple-clip" aria-hidden>
              <span className="hero-press-ripple" />
            </span>
          )}
        </div>

        <p className="text-sm text-tg-muted text-center mt-3 leading-relaxed">
          Reflect עצר אותך. לפני הכניסה — לא אחרי ההפסד.
        </p>
      </div>
    </div>
  );
}
