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

  return (
    <div className="flex flex-col gap-2.5">
      {parts.map((part, i) => (
        <SectionCard key={i} title={part.title} content={part.content} />
      ))}
    </div>
  );
}

function SectionCard({ title, content }: { title?: string; content: string }) {
  if (title === 'המלצה') return <RecommendationCard content={content} />;
  if (title === 'רמת סיכון') return <RiskCard content={content} />;
  if (title === 'רמות מפתח') return <KeyLevelsCard content={content} />;

  // מגמה כללית / fallback
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      {title && (
        <p className="text-xs font-bold mb-1" style={{ color: 'var(--color-tg-primary)' }}>
          {title}
        </p>
      )}
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
        {content}
      </p>
    </div>
  );
}

function RecommendationCard({ content }: { content: string }) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] ?? '';
  const isBuy = /buy/i.test(firstLine);
  const isSell = /sell/i.test(firstLine);
  const isWait = /wait/i.test(firstLine);

  const actionColor = isBuy
    ? 'var(--color-tg-success)'
    : isSell
      ? 'var(--color-tg-danger)'
      : 'var(--color-tg-warning)';
  const actionBg = isBuy
    ? 'var(--color-tg-success-muted)'
    : isSell
      ? 'var(--color-tg-danger-muted)'
      : 'var(--color-tg-warning-muted)';
  const actionLabel = isBuy ? 'Buy' : isSell ? 'Sell' : isWait ? 'Wait' : firstLine;

  const details = lines.slice(1);

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs font-bold mb-2" style={{ color: 'var(--color-tg-primary)' }}>המלצה</p>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold px-3 py-1 rounded-lg" style={{ background: actionBg, color: actionColor }}>
          {actionLabel}
        </span>
      </div>
      {details.map((line, i) => {
        const [label, ...rest] = line.split(':');
        const val = rest.join(':').trim();
        return val ? (
          <div key={i} className="flex items-center justify-between py-0.5">
            <span className="text-xs text-tg-muted">{label.trim()}</span>
            <span className="text-xs font-semibold font-mono text-tg-text">{val}</span>
          </div>
        ) : (
          <p key={i} className="text-xs text-tg-text">{line}</p>
        );
      })}
    </div>
  );
}

function RiskCard({ content }: { content: string }) {
  const isLow = /low/i.test(content);
  const isHigh = /high/i.test(content);
  const isMedium = /medium/i.test(content);

  const level = isLow ? 'Low' : isHigh ? 'High' : isMedium ? 'Medium' : null;
  const color = isLow
    ? 'var(--color-tg-success)'
    : isHigh
      ? 'var(--color-tg-danger)'
      : 'var(--color-tg-warning)';
  const bg = isLow
    ? 'var(--color-tg-success-muted)'
    : isHigh
      ? 'var(--color-tg-danger-muted)'
      : 'var(--color-tg-warning-muted)';

  // Strip the level word from the explanation sentence
  const explanation = content.replace(/^(low|medium|high)\s*[—\-–]?\s*/i, '').trim();

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs font-bold mb-2" style={{ color: 'var(--color-tg-text-2)' }}>רמת סיכון</p>
      <div className="flex items-center gap-2">
        {level && (
          <span className="text-xs font-bold px-2.5 py-1 rounded-lg shrink-0" style={{ background: bg, color }}>
            {level}
          </span>
        )}
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-tg-text)' }}>
          {explanation || content}
        </p>
      </div>
    </div>
  );
}

function KeyLevelsCard({ content }: { content: string }) {
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--color-tg-surface-2)' }}>
      <p className="text-xs font-bold mb-2" style={{ color: 'var(--color-tg-success)' }}>רמות מפתח</p>
      <div className="flex flex-col gap-1">
        {lines.map((line, i) => {
          const isSupport = /תמיכה/i.test(line);
          const isResistance = /התנגד/i.test(line);
          const dotColor = isResistance
            ? 'var(--color-tg-danger)'
            : isSupport
              ? 'var(--color-tg-success)'
              : 'var(--color-tg-text-2)';
          const clean = line.replace(/^•\s*/, '');
          const [label, ...rest] = clean.split(':');
          const val = rest.join(':').trim();

          return (
            <div key={i} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
              {val ? (
                <>
                  <span className="text-xs text-tg-muted">{label.trim()}</span>
                  <span className="text-xs font-semibold font-mono ml-auto" style={{ color: dotColor }}>{val}</span>
                </>
              ) : (
                <span className="text-xs text-tg-text">{clean}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
