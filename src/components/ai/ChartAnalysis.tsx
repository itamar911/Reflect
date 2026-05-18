'use client';

import { useState, useRef } from 'react';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';

export default function ChartAnalysis() {
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImage(f);
    setAnalysis(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target?.result as string);
    reader.readAsDataURL(f);
  }

  async function analyze() {
    if (!image) return;
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('image', image);
      if (context.trim()) fd.append('context', context.trim());
      const res = await fetch('/api/ai-chart', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setAnalysis(data.analysis);
      }
    } catch {
      setError('שגיאה בתקשורת — נסה שוב');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPreview(null);
    setImage(null);
    setAnalysis(null);
    setError(null);
    setContext('');
  }

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">📊</span>
        <h3 className="text-sm font-semibold text-tg-text">ניתוח גרף AI</h3>
      </div>

      {!preview ? (
        <button onClick={() => fileRef.current?.click()}
          className="w-full py-10 rounded-xl border-2 border-dashed flex flex-col items-center gap-2 transition-colors active:scale-[0.98]"
          style={{ borderColor: 'var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}>
          <span className="text-3xl">📤</span>
          <span className="text-sm text-tg-text-2">העלה גרף לניתוח טכני</span>
          <span className="text-xs text-tg-muted">PNG, JPG, WEBP — עד 5MB</span>
        </button>
      ) : (
        <div className="relative mb-3">
          <img src={preview} alt="chart" className="w-full rounded-xl object-contain max-h-52" />
          <button onClick={reset}
            className="absolute top-2 left-2 w-7 h-7 rounded-full flex items-center justify-center text-white font-bold"
            style={{ background: 'var(--color-tg-danger)' }}>
            ×
          </button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*,image/jpeg,image/png,image/webp" className="hidden" onChange={handleFile} />

      {preview && !analysis && (
        <div className="flex flex-col gap-2">
          <input type="text"
            placeholder="הקשר נוסף — למשל: SPY 1H, NQ Futures"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary"
            style={{ background: 'var(--color-tg-surface-2)' }}
          />
          <Button fullWidth loading={loading} onClick={analyze}>
            {loading ? 'מנתח גרף...' : 'נתח גרף עם AI'}
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3 p-3 rounded-xl text-sm"
          style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>
          ⚠️ {error}
        </div>
      )}

      {analysis && (
        <div className="mt-4 animate-fade-in">
          <AnalysisDisplay text={analysis} />
          <Button variant="secondary" size="sm" onClick={reset} className="mt-3 w-full">
            ניתוח גרף חדש
          </Button>
        </div>
      )}
    </Card>
  );
}

function AnalysisDisplay({ text }: { text: string }) {
  const sections = text.split(/\*\*(.+?)\*\*/g);
  const parts: { title?: string; content: string }[] = [];

  for (let i = 0; i < sections.length; i++) {
    if (i % 2 === 1) {
      parts.push({ title: sections[i], content: sections[i + 1]?.trim() ?? '' });
      i++;
    } else if (i === 0 && sections[i].trim()) {
      parts.push({ content: sections[i].trim() });
    }
  }

  if (parts.length === 0) {
    return (
      <div className="p-4 rounded-xl text-sm leading-relaxed whitespace-pre-wrap"
        style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }}>
        {text}
      </div>
    );
  }

  const sectionColors: Record<string, string> = {
    'מגמה כללית': 'var(--color-tg-primary)',
    'רמות תמיכה והתנגדות': 'var(--color-tg-success)',
    'נקודות כניסה מומלצות': 'var(--color-tg-success)',
    'Stop Loss ו-Take Profit': 'var(--color-tg-danger)',
    'סיכום והמלצה': 'var(--color-tg-primary)',
  };

  return (
    <div className="flex flex-col gap-2.5">
      {parts.map((part, i) => (
        <div key={i} className="rounded-xl p-3"
          style={{ background: 'var(--color-tg-surface-2)' }}>
          {part.title && (
            <p className="text-xs font-bold mb-1.5"
              style={{ color: sectionColors[part.title] ?? 'var(--color-tg-text-2)' }}>
              {part.title}
            </p>
          )}
          <p className="text-xs leading-relaxed whitespace-pre-wrap"
            style={{ color: 'var(--color-tg-text)' }}>
            {part.content}
          </p>
        </div>
      ))}
    </div>
  );
}
