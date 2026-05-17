'use client';

import { useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

interface TradeData {
  id: string;
  strategy: string;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  rr_ratio: number;
  emotional_state: number;
  trade_reason: string;
  status: string;
  exit_price: number | null;
}

interface AIDebriefResult {
  overall?: string;
  entry_quality?: string;
  risk_management?: string;
  execution?: string;
  emotional?: string;
  lessons?: string;
  score?: number;
}

interface TradeDebriefProps {
  trade: TradeData;
  existingAnswer?: string | null;
}

export default function TradeDebrief({ trade, existingAnswer }: TradeDebriefProps) {
  const [answer, setAnswer] = useState(existingAnswer ?? '');
  const [editing, setEditing] = useState(!existingAnswer);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AIDebriefResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImage(f);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(f);
  }

  async function handleSave() {
    if (!answer.trim()) return;
    setSaving(true);
    const supabase = createClient();
    await supabase.from('trade_plans').update({
      debrief_answer: answer.trim(),
      debrief_submitted_at: new Date().toISOString(),
    }).eq('id', trade.id);
    setSaving(false);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleAIDebrief() {
    setAiLoading(true);
    try {
      const fd = new FormData();
      fd.append('trade', JSON.stringify(trade));
      if (answer.trim()) fd.append('description', answer.trim());
      if (image) fd.append('image', image);
      const res = await fetch('/api/ai-debrief', { method: 'POST', body: fd });
      const data = await res.json();
      setAiResult(data);
    } catch {
      setAiResult({ overall: '׳©׳’׳™׳׳” ׳‘׳ ׳™׳×׳•׳— ג€” ׳ ׳¡׳” ׳©׳•׳‘' });
    } finally {
      setAiLoading(false);
    }
  }

  if (!editing && answer && !showAI) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium" style={{ color: 'var(--color-tg-primary)' }}>׳×׳—׳§׳™׳¨ ׳¢׳¦׳׳™</p>
          <div className="flex gap-2">
            <button onClick={() => setShowAI(true)}
              className="text-xs px-2 py-0.5 rounded-lg"
              style={{ color: 'var(--color-tg-primary)', background: 'var(--color-tg-primary-muted)' }}>
              נ₪– AI ׳ ׳™׳×׳•׳—
            </button>
            <button onClick={() => setEditing(true)}
              className="text-xs text-tg-text-2">׳¢׳¨׳•׳</button>
          </div>
        </div>
        <div className="px-3 py-2 rounded-xl text-xs"
          style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)' }}>
          {answer}
        </div>
        {saved && <p className="text-xs" style={{ color: 'var(--color-tg-success)' }}>ג“ ׳ ׳©׳׳¨</p>}
      </div>
    );
  }

  if (showAI) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-tg-text">נ₪– ׳×׳—׳§׳™׳¨ AI</p>
          <button onClick={() => setShowAI(false)} className="text-xs text-tg-text-2">׳—׳–׳¨׳”</button>
        </div>

        {!aiResult && (
          <>
            {!imagePreview ? (
              <button onClick={() => fileRef.current?.click()}
                className="w-full py-6 rounded-xl border-2 border-dashed flex flex-col items-center gap-1"
                style={{ borderColor: 'var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}>
                <span className="text-2xl">נ“¸</span>
                <span className="text-xs text-tg-text-2">׳”׳¢׳׳” Screenshot (׳׳•׳₪׳¦׳™׳•׳ ׳׳™)</span>
              </button>
            ) : (
              <div className="relative">
                <img src={imagePreview} alt="trade screenshot" className="w-full rounded-xl object-contain max-h-32" />
                <button onClick={() => { setImage(null); setImagePreview(null); }}
                  className="absolute top-1 left-1 w-5 h-5 rounded-full text-white flex items-center justify-center text-xs"
                  style={{ background: 'var(--color-tg-danger)' }}>ֳ—</button>
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
            <button
              onClick={handleAIDebrief}
              disabled={aiLoading}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
              style={{ background: 'var(--color-tg-primary)', color: 'black' }}>
              {aiLoading ? '׳׳ ׳×׳—...' : '׳ ׳×׳— ׳¢׳¡׳§׳” ׳¢׳ AI'}
            </button>
          </>
        )}

        {aiResult && (
          <div className="flex flex-col gap-2 animate-fade-in">
            {aiResult.score !== undefined && (
              <div className="flex items-center justify-between p-3 rounded-xl"
                style={{ background: 'var(--color-tg-primary-muted)', border: '1px solid var(--color-tg-primary)30' }}>
                <span className="text-xs text-tg-text-2">׳¦׳™׳•׳ ׳¢׳¡׳§׳”</span>
                <span className="text-xl font-bold" style={{ color: 'var(--color-tg-primary)' }}>{aiResult.score}/100</span>
              </div>
            )}
            {[
              ['׳¡׳™׳›׳•׳ ׳›׳׳׳™', aiResult.overall],
              ['׳׳™׳›׳•׳× ׳›׳ ׳™׳¡׳”', aiResult.entry_quality],
              ['׳ ׳™׳”׳•׳ ׳¡׳™׳›׳•׳ ׳™׳', aiResult.risk_management],
              ['׳‘׳™׳¦׳•׳¢', aiResult.execution],
              ['׳׳¦׳‘ ׳¨׳’׳©׳™', aiResult.emotional],
              ['׳׳§׳—׳™׳', aiResult.lessons],
            ].filter(([, v]) => v).map(([label, value]) => (
              <div key={label as string} className="rounded-xl p-2.5"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <p className="text-[10px] font-semibold text-tg-muted mb-1">{label as string}</p>
                <p className="text-xs text-tg-text leading-relaxed">{value as string}</p>
              </div>
            ))}
            <button onClick={() => setAiResult(null)}
              className="text-xs text-tg-muted py-1">׳ ׳™׳×׳•׳— ׳—׳“׳©</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-primary)" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <p className="text-xs font-medium text-tg-text">׳׳” ׳’׳¨׳ ׳׳ ׳׳¦׳׳×?</p>
      </div>
      <textarea rows={2} value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="׳¡׳₪׳¨ ׳׳” ׳§׳¨׳”... ׳”׳’׳¢׳×׳™ ׳-SL? ׳™׳¦׳׳×׳™ ׳׳•׳§׳“׳? ׳₪׳—׳“׳×׳™?"
        className="w-full px-3 py-2.5 rounded-xl text-xs border focus:outline-none transition-colors resize-none"
        style={{ background: 'var(--color-tg-surface-2)', borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text)' }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--color-tg-primary)'; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--color-tg-border)'; }}
      />
      <div className="flex gap-2">
        {existingAnswer && (
          <button onClick={() => { setAnswer(existingAnswer); setEditing(false); }}
            className="flex-1 py-1.5 rounded-xl text-xs font-medium border transition-all"
            style={{ borderColor: 'var(--color-tg-border)', color: 'var(--color-tg-text-2)', background: 'transparent' }}>
            ׳‘׳™׳˜׳•׳
          </button>
        )}
        <button onClick={handleSave} disabled={saving || !answer.trim()}
          className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-50"
          style={{ background: 'var(--color-tg-primary)', color: 'black' }}>
          {saving ? '׳©׳•׳׳¨...' : '׳”׳’׳© ׳×׳—׳§׳™׳¨'}
        </button>
        <button onClick={() => setShowAI(true)}
          className="py-1.5 px-3 rounded-xl text-xs border transition-all"
          style={{ borderColor: 'var(--color-tg-primary)40', color: 'var(--color-tg-primary)', background: 'var(--color-tg-primary-muted)' }}>
          נ₪–
        </button>
      </div>
    </div>
  );
}
