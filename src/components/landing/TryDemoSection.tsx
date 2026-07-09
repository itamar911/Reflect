'use client';

import { useEffect, useRef, useState } from 'react';
import { ExternalLink, MousePointerClick } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';

/**
 * Phase 2 — embedded live demo. A browser-chrome frame lazy-loads /demo/dashboard
 * (same codebase, fixture data) when it nears the viewport. The iframe starts
 * pointer-events:none behind a click-to-activate overlay so page scrolling is
 * never hijacked; "מסך מלא" opens the standalone /demo in a new tab.
 */
export function TryDemoSection() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [load, setLoad] = useState(false);     // mount the iframe near viewport
  const [active, setActive] = useState(false); // overlay dismissed → interactive

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
            {/* Browser chrome bar */}
            <div
              dir="ltr"
              className="flex items-center gap-3 px-4 h-11 shrink-0"
              style={{ background: '#161b22', borderBottom: '1px solid rgba(255,255,255,0.08)' }}
            >
              <span className="flex items-center gap-1.5" aria-hidden>
                <span className="w-3 h-3 rounded-full" style={{ background: '#ff5f57' }} />
                <span className="w-3 h-3 rounded-full" style={{ background: '#febc2e' }} />
                <span className="w-3 h-3 rounded-full" style={{ background: '#28c840' }} />
              </span>
              <span
                className="hidden sm:flex flex-1 justify-center items-center h-7 rounded-lg text-xs font-medium truncate"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)', maxWidth: 420, margin: '0 auto' }}
              >
                reflect.app/demo/dashboard
              </span>
              <a
                href="/demo"
                target="_blank"
                rel="noopener"
                className="ms-auto flex items-center gap-1.5 px-3 h-7 rounded-lg text-xs font-bold transition-opacity hover:opacity-85"
                style={{ background: 'rgba(0,210,210,0.14)', color: '#00d2d2', border: '1px solid rgba(0,210,210,0.3)' }}
              >
                <ExternalLink size={12} />
                מסך מלא
              </a>
            </div>

            {/* Framed viewport */}
            <div className="relative" style={{ height: 'clamp(420px, 70vh, 720px)', background: '#0a0e14' }}>
              {load && (
                <iframe
                  src="/demo/dashboard"
                  title="דמו חי של Reflect"
                  loading="lazy"
                  className="w-full h-full border-0 block"
                  style={{ pointerEvents: active ? 'auto' : 'none' }}
                />
              )}

              {/* Click-to-activate — keeps page scroll from being hijacked */}
              {!active && (
                <button
                  onClick={() => { setLoad(true); setActive(true); }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 cursor-pointer group"
                  style={{ background: 'rgba(5,8,12,0.45)' }}
                  aria-label="הפעלת הדמו האינטראקטיבי"
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
              )}
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
