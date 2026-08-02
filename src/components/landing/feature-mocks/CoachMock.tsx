'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, SendHorizontal } from 'lucide-react';
import { usePrefersReducedMotion } from '@/lib/hooks';
import { MockFrame } from './MockFrame';

/**
 * The section copy promises answers "מבוססות על הנתונים שלך, לא על עצות
 * גנריות", so the load-bearing detail here is that every figure the coach cites
 * is rendered as a data chip. A visitor should be able to tell the reply is
 * data-backed without reading a word of it — the chips carry that on their own.
 *
 * The reply streams token by token rather than fading in whole, because a chat
 * mock that pops its answer into existence reads as a screenshot; one that
 * streams reads as a model answering.
 */

// ── Conversation ─────────────────────────────────────────────

/**
 * Replies are token arrays rather than strings so the data chips survive the
 * streaming: revealing a prefix of tokens keeps a chip atomic, where slicing a
 * string would tear "58%" in half mid-render.
 */
type Token = { t: 'w'; v: string } | { t: 'chip'; v: string };

function words(s: string): Token[] {
  return s.split(' ').map((v) => ({ t: 'w', v }));
}

function chip(v: string): Token {
  return { t: 'chip', v };
}

const A1: Token[] = [
  ...words('בימי שני שיעור ההפסד שלך הוא'),
  chip('58%'),
  ...words('מול'),
  chip('31%'),
  ...words('בשאר השבוע. ברוב המקרים נכנסת בתוך'),
  chip('10 הדקות הראשונות'),
  ...words('של המסחר.'),
];

const A2: Token[] = [
  ...words('נסה להמתין'),
  chip('15 דקות'),
  ...words('אחרי הפתיחה. ב-'),
  chip('9 עסקאות'),
  ...words('שבהן עשית זאת, הרווח הממוצע היה'),
  chip('₪420'),
  ...words('לעומת'),
  chip('₪95-'),
  ...words('באחרות.'),
];

const Q1 = 'למה אני מפסיד יותר בימי שני?';
const Q2 = 'אז מה כדאי לי לשנות?';

const SUGGESTIONS = ['מה הדפוס הכי יקר שלי?', 'איך היה השבוע?', 'מתי אני הכי ממושמע?'];

// ── Loop ─────────────────────────────────────────────────────

/**
 * Streaming phases have no fixed duration: they run until every token is out,
 * at STREAM_MS per token. The rest are held beats. Expressing it this way means
 * editing a reply's wording automatically retimes its phase instead of silently
 * truncating it against a hardcoded duration.
 */
const STREAM_MS = 85;

type Step =
  | { kind: 'wait'; ms: number; q1?: boolean; q2?: boolean; typing?: boolean }
  | { kind: 'stream'; which: 1 | 2 };

const SEQUENCE: Step[] = [
  { kind: 'wait', ms: 700 },
  { kind: 'wait', ms: 900, q1: true, typing: true },
  { kind: 'stream', which: 1 },
  { kind: 'wait', ms: 1600, q1: true },
  { kind: 'wait', ms: 900, q1: true, q2: true, typing: true },
  { kind: 'stream', which: 2 },
  { kind: 'wait', ms: 3000, q1: true, q2: true },
];

const LAST = SEQUENCE.length - 1;

export function CoachMock() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [inView, setInView] = useState(false);
  const [step, setStep] = useState(0);
  const [tokens, setTokens] = useState(0);

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

  const current = SEQUENCE[step];

  // Held beats advance on a timeout; streaming beats advance one token at a
  // time and hand over once the reply is complete. Both live in one effect so
  // there is a single owner of `step` and no chance of two timers racing it.
  useEffect(() => {
    if (reducedMotion || !inView) return;

    if (current.kind === 'wait') {
      const id = setTimeout(() => {
        setTokens(0);
        setStep((s) => (s + 1) % SEQUENCE.length);
      }, current.ms);
      return () => clearTimeout(id);
    }

    const total = current.which === 1 ? A1.length : A2.length;
    if (tokens >= total) {
      const id = setTimeout(() => setStep((s) => (s + 1) % SEQUENCE.length), 100);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setTokens((n) => n + 1), STREAM_MS);
    return () => clearTimeout(id);
  }, [reducedMotion, inView, step, tokens, current]);

  // Reduced motion renders the finished exchange; before scroll-in the card
  // rests on the opening beat so the conversation starts from the top.
  const view = reducedMotion ? SEQUENCE[LAST] : inView ? current : SEQUENCE[0];
  const streaming = view.kind === 'stream';

  const showQ1 = reducedMotion || (view.kind === 'wait' ? !!view.q1 : true);
  const showQ2 = reducedMotion || (view.kind === 'wait' ? !!view.q2 : view.which === 2);
  const typing = !reducedMotion && view.kind === 'wait' && !!view.typing;

  // A1 is complete once we are past its streaming phase; while streaming it is
  // truncated to the tokens emitted so far.
  const a1Count = reducedMotion || step > 2 ? A1.length : streaming && view.which === 1 ? tokens : 0;
  const a2Count = reducedMotion || step > 5 ? A2.length : streaming && view.which === 2 ? tokens : 0;

  return (
    <MockFrame height={440}>
      <div ref={rootRef} dir="rtl" className="flex flex-col flex-1 gap-2.5">
        {/* ── Header ── */}
        <div className="flex items-center gap-2.5 shrink-0">
          <span
            className="flex items-center justify-center w-7 h-7 rounded-full shrink-0"
            style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
            aria-hidden
          >
            <Bot size={13} style={{ color: '#00d2d2' }} />
          </span>
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-sm font-bold text-white leading-none">מאמן AI</span>
            <span style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.4)' }}>מבוסס על 128 העסקאות שלך</span>
          </span>
        </div>

        {/* ── Transcript. justify-end pins the thread to the bottom the way a
               real chat does, so if the exchange ever outgrows the card it is
               the oldest message that clips off the top rather than the newest
               one overflowing the frame. ── */}
        <div className="flex flex-1 min-h-0 flex-col justify-end gap-2 overflow-hidden">
          <UserBubble text={Q1} shown={showQ1} />
          <CoachBubble tokens={A1} count={a1Count} typing={typing && showQ1 && !showQ2} />
          <UserBubble text={Q2} shown={showQ2} />
          <CoachBubble tokens={A2} count={a2Count} typing={typing && showQ2} />
        </div>

        {/* ── Suggested questions ── */}
        <div className="flex items-center gap-1.5 shrink-0 overflow-hidden" aria-hidden>
          {SUGGESTIONS.map((s, i) => (
            <span
              key={s}
              // Three chips need ~420px; a 376px phone clips the third mid-word,
              // which reads as breakage rather than as more content off-screen.
              // Drop it below sm instead.
              className={`shrink-0 rounded-full px-2 py-1 whitespace-nowrap ${i === 2 ? 'hidden sm:inline-block' : ''}`}
              style={{
                fontSize: 10,
                background: 'rgba(0,210,210,0.08)',
                border: '1px solid rgba(0,210,210,0.25)',
                color: 'rgba(255,255,255,0.6)',
              }}
            >
              {s}
            </span>
          ))}
        </div>

        {/* ── Composer. Inert by construction — a disabled input, not a styled
               div, so assistive tech reports it the same way it looks. ── */}
        <div
          className="flex items-center gap-2 shrink-0 rounded-xl px-2.5 py-2"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
        >
          <input
            type="text"
            disabled
            placeholder="שאל את המאמן שלך..."
            tabIndex={-1}
            className="flex-1 min-w-0 bg-transparent outline-none"
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}
          />
          <span
            className="flex items-center justify-center w-6 h-6 rounded-lg shrink-0"
            style={{ background: 'rgba(0,210,210,0.16)', border: '1px solid rgba(0,210,210,0.4)' }}
            aria-hidden
          >
            {/* Mirrored: SendHorizontal points right, which is backwards for a
                send action in an RTL composer. */}
            <SendHorizontal size={12} style={{ color: '#00d2d2', transform: 'scaleX(-1)' }} />
          </span>
        </div>
      </div>
    </MockFrame>
  );
}

function UserBubble({ text, shown }: { text: string; shown: boolean }) {
  // Unmounted rather than held at opacity 0: an invisible bubble still occupies
  // its slot, which parks the visible half of the exchange at the top of the
  // transcript with a void beneath it for most of the cycle. Unmounting lets
  // justify-end keep the thread against the composer and grow upward, which is
  // also how a real chat behaves as messages arrive.
  if (!shown) return null;

  return (
    <div
      className="coach-msg-in flex justify-start shrink-0"
    >
      <div
        className="max-w-[78%] px-3 py-2"
        style={{
          background: 'var(--color-tg-surface-2)',
          color: 'var(--color-tg-text-2)',
          borderRadius: '16px 16px 4px 16px',
        }}
      >
        <span style={{ fontSize: 12.5 }}>{text}</span>
      </div>
    </div>
  );
}

function CoachBubble({ tokens, count, typing }: { tokens: Token[]; count: number; typing: boolean }) {
  const visible = tokens.slice(0, count);
  const active = typing || count > 0;

  if (!active) return null;

  return (
    <div className="coach-msg-in flex items-end justify-end gap-1.5 shrink-0">
      <div
        className="max-w-[84%] px-3 py-2"
        style={{
          background: 'rgba(0,210,210,0.06)',
          border: '1px solid rgba(0,210,210,0.35)',
          borderRadius: '16px 16px 16px 4px',
        }}
      >
        {typing ? (
          <span className="flex items-center gap-1 py-1" aria-hidden>
            {[0, 1, 2].map((j) => (
              <span
                key={j}
                className="w-1.5 h-1.5 rounded-full animate-bounce"
                style={{ background: '#00d2d2', animationDelay: `${j * 0.15}s` }}
              />
            ))}
          </span>
        ) : (
          <p style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.85)', lineHeight: 1.65, margin: 0 }}>
            {visible.map((tok, i) =>
              tok.t === 'chip' ? (
                <span
                  key={i}
                  dir="ltr"
                  className="inline-block rounded font-bold mx-0.5 px-1"
                  style={{
                    fontSize: 11.5,
                    color: '#00d2d2',
                    background: 'rgba(0,210,210,0.14)',
                    border: '1px solid rgba(0,210,210,0.3)',
                    fontVariantNumeric: 'tabular-nums',
                    // Keeps the chip on the text baseline instead of letting
                    // inline-block push the line box taller as chips stream in.
                    lineHeight: 1.35,
                  }}
                >
                  {tok.v}
                </span>
              ) : (
                <span key={i}>{tok.v} </span>
              ),
            )}
            {count < tokens.length && <span className="coach-caret" aria-hidden />}
          </p>
        )}
      </div>

      <span
        className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
        style={{ background: 'rgba(0,210,210,0.14)', border: '1px solid rgba(0,210,210,0.35)' }}
        aria-hidden
      >
        <Bot size={12} style={{ color: '#00d2d2' }} />
      </span>
    </div>
  );
}
