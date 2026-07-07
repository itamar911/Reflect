import { Lock, Check, AlertTriangle } from 'lucide-react';

const CHIPS = ['NQ1', 'Long', '5m'];

export function HeroMock() {
  return (
    <div className="hero-mock-wrap relative mx-auto w-full max-w-md md:max-w-lg">
      <div
        className="absolute -inset-10 rounded-[2rem] pointer-events-none"
        style={{ background: 'radial-gradient(60% 60% at 50% 40%, rgba(0,210,210,0.16), transparent 70%)' }}
        aria-hidden
      />

      <div
        className="hero-float-1 hidden sm:flex absolute -top-5 -right-4 md:-right-8 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold"
        style={{
          background: 'rgba(0,210,210,0.14)',
          border: '1px solid rgba(0,210,210,0.4)',
          color: '#00d2d2',
          boxShadow: '0 4px 18px rgba(0,210,210,0.2)',
        }}
        aria-hidden
      >
        ציון משמעת 87
      </div>
      <div
        className="hero-float-2 hidden sm:flex absolute -bottom-4 -left-4 md:-left-8 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold"
        style={{
          background: 'rgba(239,68,68,0.12)',
          border: '1px solid rgba(239,68,68,0.35)',
          color: '#f87171',
          boxShadow: '0 4px 18px rgba(239,68,68,0.18)',
        }}
        aria-hidden
      >
        -780₪ נמנע
      </div>

      <div
        className="hero-mock-card relative rounded-2xl border p-5 md:p-6"
        style={{
          borderColor: 'rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.035)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45), 0 0 40px rgba(0,210,210,0.1)',
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span
              className="flex items-center justify-center w-6 h-6 rounded-md text-xs font-extrabold shrink-0"
              style={{ background: 'linear-gradient(135deg, #00d2d2, #0891b2)', color: '#0b0f14' }}
              aria-hidden
            >
              R
            </span>
            <span className="text-sm font-bold text-white">תוכנית עסקה</span>
          </div>
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: '#00d2d2', boxShadow: '0 0 8px #00d2d2' }}
            aria-hidden
          />
        </div>

        <div className="flex items-center gap-2 mb-4">
          {CHIPS.map((chip) => (
            <span
              key={chip}
              className="rounded-lg px-2.5 py-1 text-xs font-semibold text-white/75"
              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {chip}
            </span>
          ))}
        </div>

        <div className="flex flex-col gap-2.5 mb-4">
          <div className="hero-check-row flex items-center gap-2" style={{ animationDelay: '0s' }}>
            <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
            <span className="text-sm text-white/85">סטופ מוגדר · יחס 1:2.5</span>
          </div>
          <div className="hero-check-row flex items-center gap-2" style={{ animationDelay: '0.9s' }}>
            <Check size={15} className="shrink-0" style={{ color: '#22c55e' }} />
            <span className="text-sm text-white/85">מתאים לאסטרטגיה שלך</span>
          </div>
          <div
            className="hero-check-row hero-warn-row flex items-center gap-2 rounded-lg px-2.5 py-1.5 -mx-1"
            style={{ animationDelay: '1.8s', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)' }}
          >
            <AlertTriangle size={15} className="shrink-0" style={{ color: '#f59e0b' }} />
            <span className="text-sm" style={{ color: '#f59e0b' }}>
              עסקה שלישית היום — חוק שלך מופר
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled
          className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold cursor-not-allowed"
          style={{
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.4)',
            color: 'rgba(255,255,255,0.5)',
            boxShadow: '0 0 22px rgba(245,158,11,0.15)',
          }}
        >
          <Lock size={15} />
          פתח עסקה
        </button>
        <p className="text-xs text-tg-muted text-center mt-3 leading-relaxed">
          Reflect עצר אותך. לפני הכניסה — לא אחרי ההפסד.
        </p>
      </div>
    </div>
  );
}
