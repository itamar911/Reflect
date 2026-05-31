'use client';

import { useState, useRef, type CSSProperties } from 'react';

// ── Types & config ─────────────────────────────────────────────────────────────

type FeedbackType = 'bug' | 'feature' | 'question';
type SubmitState = 'idle' | 'sending' | 'success' | 'error';

const TYPES: { value: FeedbackType; label: string; icon: string; color: string; desc: string }[] = [
  { value: 'bug',      label: 'דיווח על באג',  icon: '🐛', color: '#f87171', desc: 'משהו לא עובד כמו שצריך' },
  { value: 'feature',  label: 'הצעה לשיפור',   icon: '💡', color: '#D4AF37', desc: 'רעיון לפיצ׳ר חדש' },
  { value: 'question', label: 'שאלה',          icon: '❓', color: '#60A5FA', desc: 'שאלה כללית' },
];

const MAX_IMG_MB = 3;

// ── Design tokens ─────────────────────────────────────────────────────────────
const SURF   = 'var(--color-tg-surface)';
const SURF2  = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';
const MUTED  = 'var(--color-tg-muted)';
const GOLD   = '#D4AF37';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function FeedbackPage() {
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('bug');
  const [title,       setTitle]        = useState('');
  const [description, setDescription]  = useState('');
  const [imgDataUrl,  setImgDataUrl]   = useState<string | null>(null);
  const [imgName,     setImgName]      = useState<string | null>(null);
  const [imgError,    setImgError]     = useState('');
  const [submitState, setSubmitState]  = useState<SubmitState>('idle');
  const [serverError, setServerError]  = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = TYPES.find(t => t.value === feedbackType)!;
  const canSubmit = title.trim().length > 0 && description.trim().length > 5;

  // ── Image handling ──────────────────────────────────────────────────────────
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImgError('');

    if (file.size > MAX_IMG_MB * 1024 * 1024) {
      setImgError(`הקובץ גדול מדי — מקסימום ${MAX_IMG_MB}MB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImgDataUrl(reader.result as string);
      setImgName(file.name);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function removeImage() {
    setImgDataUrl(null);
    setImgName(null);
    setImgError('');
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!canSubmit || submitState === 'sending') return;
    setSubmitState('sending');
    setServerError('');

    try {
      const res = await fetch('/api/send-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: feedbackType,
          title: title.trim(),
          description: description.trim(),
          screenshot:     imgDataUrl  ?? undefined,
          screenshotName: imgName     ?? undefined,
        }),
      });

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'שגיאה לא ידועה' }));
        throw new Error(error ?? 'שגיאה בשליחה');
      }

      setSubmitState('success');
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'שגיאה בשליחה');
      setSubmitState('error');
    }
  }

  // ── Success screen ──────────────────────────────────────────────────────────
  if (submitState === 'success') {
    return (
      <div dir="rtl" className="min-h-screen flex flex-col items-center justify-center px-6 gap-5">
        <div className="rounded-full w-20 h-20 flex items-center justify-center text-4xl animate-fade-in"
          style={{ background: 'rgba(74,222,128,0.12)', border: '2px solid rgba(74,222,128,0.3)' }}>
          ✓
        </div>
        <div className="text-center">
          <h2 className="text-xl font-bold mb-2" style={{ color: TEXT }}>הפנייה נשלחה!</h2>
          <p className="text-sm leading-relaxed" style={{ color: TEXT2 }}>
            {selected.icon} {selected.label} התקבל בהצלחה.<br />
            אגיב בהקדם האפשרי.
          </p>
        </div>
        <button
          onClick={() => {
            setSubmitState('idle');
            setTitle('');
            setDescription('');
            setImgDataUrl(null);
            setImgName(null);
          }}
          className="text-sm px-5 py-2.5 rounded-xl"
          style={{ background: SURF2, color: TEXT2 }}
        >
          שלח פנייה נוספת
        </button>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────────────
  return (
    <div dir="rtl" className="min-h-screen px-4 py-6 flex flex-col gap-5">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.2)' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60A5FA"
            strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            <line x1="9" y1="9" x2="15" y2="9"/>
            <line x1="9" y1="13" x2="13" y2="13"/>
          </svg>
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: TEXT }}>פנייה למפתח</h1>
          <p className="text-xs" style={{ color: MUTED }}>באג, הצעה לשיפור, או שאלה</p>
        </div>
      </div>

      {/* ── Type selector ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium" style={{ color: TEXT2 }}>סוג הפנייה</p>
        <div className="grid grid-cols-3 gap-2">
          {TYPES.map(t => {
            const active = feedbackType === t.value;
            return (
              <button
                key={t.value}
                onClick={() => setFeedbackType(t.value)}
                className="flex flex-col items-center gap-1.5 py-4 px-2 rounded-2xl transition-all active:scale-95"
                style={{
                  background:  active ? `${t.color}14` : SURF,
                  border:      `1.5px solid ${active ? t.color : BORDER}`,
                  boxShadow:   active ? `0 0 0 1px ${t.color}30` : undefined,
                }}
              >
                <span style={{ fontSize: 24 }}>{t.icon}</span>
                <span className="text-[11px] font-semibold text-center leading-tight"
                  style={{ color: active ? t.color : TEXT2 }}>
                  {t.label}
                </span>
                <span className="text-[9px] text-center leading-tight"
                  style={{ color: active ? `${t.color}aa` : MUTED }}>
                  {t.desc}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Form card ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 rounded-2xl p-4"
        style={{ background: SURF, border: `1px solid ${BORDER}` }}>

        {/* Title */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" style={{ color: TEXT2 }}>
            כותרת <span style={{ color: '#f87171' }}>*</span>
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={120}
            placeholder={
              feedbackType === 'bug'
                ? 'לדוגמה: הכפתור לא עובד בדף הדשבורד'
                : feedbackType === 'feature'
                ? 'לדוגמה: אפשרות לייצוא גרף P&L'
                : 'לדוגמה: איך מגדירים Cooldown?'
            }
            style={inputStyle}
          />
          <p className="text-[10px] text-left" style={{ color: MUTED }}>{title.length}/120</p>
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" style={{ color: TEXT2 }}>
            תיאור מפורט <span style={{ color: '#f87171' }}>*</span>
          </label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={6}
            placeholder={
              feedbackType === 'bug'
                ? 'תאר מה קרה:\n1. נכנסתי לדף...\n2. לחצתי על...\n3. במקום לקרות X — קרה Y\n\nמה ציפיתי שיקרה:'
                : feedbackType === 'feature'
                ? 'תאר את הפיצ׳ר:\n- מה הוא יעשה?\n- מי ייהנה ממנו?\n- למה זה חשוב?'
                : 'תאר את השאלה בפירוט...'
            }
            style={{ ...inputStyle, resize: 'vertical', lineHeight: '1.7' }}
          />
        </div>

        {/* Screenshot upload */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" style={{ color: TEXT2 }}>
            סקרינשוט / תמונה
            <span className="text-[10px] font-normal mr-2" style={{ color: MUTED }}>
              (אופציונלי · עד {MAX_IMG_MB}MB)
            </span>
          </label>

          <input ref={fileRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" />

          {imgDataUrl ? (
            <div className="relative rounded-xl overflow-hidden">
              <img src={imgDataUrl} alt="Screenshot preview"
                className="w-full max-h-52 object-contain"
                style={{ background: SURF2 }} />
              <div className="absolute inset-0 flex items-start justify-between p-2 bg-gradient-to-b from-black/40 to-transparent">
                <span className="text-xs text-white/80 truncate max-w-[70%]">{imgName}</span>
                <button
                  onClick={removeImage}
                  className="w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full py-6 rounded-xl flex flex-col items-center gap-2 transition-opacity hover:opacity-70"
              style={{ border: `2px dashed ${BORDER}`, background: SURF2 }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={MUTED}
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span className="text-xs" style={{ color: MUTED }}>לחץ לצירוף תמונה</span>
            </button>
          )}

          {imgError && (
            <p className="text-xs" style={{ color: '#f87171' }}>{imgError}</p>
          )}
        </div>

        {/* Error message */}
        {submitState === 'error' && serverError && (
          <div className="px-3 py-2.5 rounded-xl text-sm"
            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>
            {serverError}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit || submitState === 'sending'}
          className="w-full py-3 rounded-xl text-sm font-bold transition-opacity disabled:opacity-40 active:scale-[0.98]"
          style={{
            background: canSubmit ? selected.color : SURF2,
            color:      canSubmit ? (feedbackType === 'bug' ? '#fff' : '#0a0a0f') : MUTED,
            cursor:     canSubmit ? 'pointer' : 'not-allowed',
          }}>
          {submitState === 'sending'
            ? '⟳ שולח...'
            : `${selected.icon} שלח ${selected.label}`}
        </button>

        <p className="text-[10px] text-center" style={{ color: MUTED }}>
          הפנייה תישלח למפתח ישירות · נשתדל להגיב תוך 24–48 שעות
        </p>
      </div>

    </div>
  );
}

// ── Shared style ──────────────────────────────────────────────────────────────

const inputStyle: CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 10,
  background: SURF2, border: `1px solid ${BORDER}`,
  color: TEXT, fontSize: 14, outline: 'none',
  boxSizing: 'border-box', direction: 'rtl',
};
