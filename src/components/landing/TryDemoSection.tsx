'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, MousePointerClick, X } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

/**
 * Phase 2 — embedded live demo. A clean rounded frame lazy-loads /demo/dashboard
 * (same codebase, fixture data) when it nears the viewport. The iframe starts
 * pointer-events:none behind a click-to-activate overlay so page scrolling is
 * never hijacked; the overlay re-arms when the frame scrolls mostly out of view,
 * so return passes must click again. "מסך מלא" opens an in-page fullscreen view
 * (its own iframe instance) with its own exit control.
 */
export function TryDemoSection() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState(false);     // mount the iframe near viewport
  const [active, setActive] = useState(false); // overlay dismissed → interactive
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setLoad(true);
          io.disconnect();
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Re-arm the overlay once less than ~30% of the frame is visible, so the
  // demo never scroll-traps a visitor coming back past the section.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio < 0.3) setActive(false);
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // CSS overlay, not the native Fullscreen API: iOS Safari doesn't support
  // Element.requestFullscreen() outside <video>, and this needs to behave
  // the same on a phone as on desktop. Escape is therefore our own listener
  // rather than the browser's native fullscreenchange handling.
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setFullscreen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  // Prevent the page from scrolling behind the fullscreen overlay.
  useEffect(() => {
    if (!fullscreen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  return (
    <section className="cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading sub="גלו איך נראה יומן מסחר חכם מבפנים — בלי להירשם">
          נסו את המערכת בעצמכם
        </SectionHeading>

        <ScrollReveal delay={200}>
          <div
            ref={wrapRef}
            className="relative rounded-2xl overflow-hidden border"
            style={{
              borderColor: 'rgba(255,255,255,0.1)',
              boxShadow: '0 24px 80px rgba(0,0,0,0.5), 0 0 60px rgba(0,210,210,0.08)',
            }}
          >
            {/* Framed viewport */}
            <div className="relative" style={{ height: 'clamp(420px, 70vh, 720px)', background: '#0a0e14' }}>
              {load && (
                <iframe
                  src="/demo/dashboard?embed=1"
                  title="דמו חי של Reflect"
                  loading="lazy"
                  className="w-full h-full border-0 block"
                  style={{ pointerEvents: active ? 'auto' : 'none' }}
                />
              )}

              {/* Click-to-activate — keeps page scroll from being hijacked */}
              <button
                onClick={() => { setLoad(true); setActive(true); }}
                className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 group transition-opacity duration-300 ${
                  active ? 'opacity-0 pointer-events-none' : 'opacity-100 cursor-pointer'
                }`}
                style={{ background: 'rgba(5,8,12,0.45)' }}
                aria-label="הפעלת הדמו האינטראקטיבי"
                aria-hidden={active}
                tabIndex={active ? -1 : 0}
              >
                <span
                  className="flex items-center gap-2.5 px-6 py-3.5 rounded-full text-base font-bold transition-transform group-hover:scale-105"
                  style={{
                    background: '#00d2d2',
                    color: '#0a0a0f',
                    boxShadow: '0 8px 32px rgba(0,210,210,0.4)',
                  }}
                >
                  <MousePointerClick size={19} />
                  לחצו כדי להתנסות
                </span>
                <span className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>
                  דמו חי עם נתונים לדוגמה — גלישה חופשית, בלי הרשמה
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setLoad(true); setActive(true); setFullscreen(true); }}
                className="absolute top-3 end-3 z-20 flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-bold transition-opacity hover:opacity-85"
                style={{
                  background: 'rgba(13,17,23,0.82)',
                  color: '#00d2d2',
                  border: '1px solid rgba(0,210,210,0.3)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                <Maximize2 size={12} />
                מסך מלא
              </button>
            </div>
          </div>
        </ScrollReveal>
      </div>

      {fullscreen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[104]" style={{ background: '#0a0e14' }}>
          <iframe
            src="/demo/dashboard?embed=1"
            title="דמו חי של Reflect — מסך מלא"
            className="w-full h-full border-0 block"
          />

          <button
            type="button"
            onClick={() => setFullscreen(false)}
            aria-label="יציאה ממסך מלא"
            title="יציאה ממסך מלא"
            className="fixed z-20 flex items-center justify-center rounded-full transition-colors hover:bg-white/10"
            style={{
              top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
              insetInlineEnd: 'calc(env(safe-area-inset-right, 0px) + 12px)',
              width: 44,
              height: 44,
              background: 'rgba(10,13,20,0.72)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: '1px solid rgba(255,255,255,0.18)',
            }}
          >
            <X size={22} className="text-white" aria-hidden />
          </button>
        </div>,
        document.body,
      )}
    </section>
  );
}
