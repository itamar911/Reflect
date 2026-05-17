'use client';

import { useState, useRef } from 'react';
import Card from '@/components/ui/Card';
import Button from '@/components/ui/Button';

interface ChartResult {
  timeframe?: string;
  trend?: string;
  pattern?: string;
  support_levels?: string[];
  resistance_levels?: string[];
  key_observations?: string[];
  bias?: string;
  recommendation?: string;
  risk_notes?: string;
}

export default function ChartAnalysis() {
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [result, setResult] = useState<ChartResult | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setImage(f);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target?.result as string);
    reader.readAsDataURL(f);
  }

  async function analyze() {
    if (!image) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('image', image);
      if (context.trim()) fd.append('context', context.trim());
      const res = await fetch('/api/ai-chart', { method: 'POST', body: fd });
      const data = await res.json();
      setResult(data);
    } catch {
      setResult({ recommendation: 'שגיאה בניתוח' });
    } finally {
      setLoading(false);
    }
  }

  function reset() { setPreview(null); setImage(null); setResult(null); setContext(''); }

  const biasColor = result?.bias?.toLowerCase().includes('bull') ? 'var(--color-tg-success)'
    : result?.bias?.toLowerCase().includes('bear') ? 'var(--color-tg-danger)'
    : 'var(--color-tg-warning)';

  return (
    <Card>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">📊</span>
        <h3 className="text-sm font-semibold text-tg-text">ניתוח גרף AI</h3>
      </div>

      {!preview ? (
        <button onClick={() => fileRef.current?.click()}
          className="w-full py-10 rounded-xl border-2 border-dashed flex flex-col items-center gap-2 transition-colors"
          style={{ borderColor: 'var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}>
          <span className="text-3xl">📤</span>
          <span className="text-sm text-tg-text-2">העלה גרף לניתוח טכני</span>
          <span className="text-xs text-tg-muted">PNG, JPG, WEBP</span>
        </button>
      ) : (
        <div className="relative">
          <img src={preview} alt="chart" className="w-full rounded-xl object-contain max-h-48" />
          <button onClick={reset}
            className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center text-white text-sm"
            style={{ background: 'var(--color-tg-danger)' }}>
            ×
          </button>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />

      {preview && !result && (
        <div className="mt-3 flex flex-col gap-2">
          <input type="text"
            placeholder="הקשר נוסף (אופציונלי) — למשל: SPY 1H"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            className="w-full px-3 py-2 rounded-xl text-sm text-tg-text border border-tg-border focus:outline-none focus:border-tg-primary"
            style={{ background: 'var(--color-tg-surface-2)' }}
          />
          <Button fullWidth loading={loading} onClick={analyze}>נתח גרף</Button>
        </div>
      )}

      {result && (
        <div className="mt-4 flex flex-col gap-3 animate-fade-in">
          {result.bias && (
            <div className="flex items-center justify-between p-3 rounded-xl"
              style={{ background: `${biasColor}15`, border: `1px solid ${biasColor}30` }}>
              <span className="text-xs text-tg-text-2">הטיה</span>
              <span className="text-sm font-bold" style={{ color: biasColor }}>{result.bias}</span>
            </div>
          )}
          {result.trend && <Row label="מגמה" value={result.trend} />}
          {result.pattern && <Row label="דפוס" value={result.pattern} />}
          {result.timeframe && <Row label="טווח זמן" value={result.timeframe} />}

          {(result.support_levels?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-tg-muted mb-1">תמיכות</p>
              <div className="flex flex-wrap gap-1">
                {result.support_levels!.map((l, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--color-tg-success-muted)', color: 'var(--color-tg-success)' }}>{l}</span>
                ))}
              </div>
            </div>
          )}
          {(result.resistance_levels?.length ?? 0) > 0 && (
            <div>
              <p className="text-xs text-tg-muted mb-1">התנגדויות</p>
              <div className="flex flex-wrap gap-1">
                {result.resistance_levels!.map((l, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--color-tg-danger-muted)', color: 'var(--color-tg-danger)' }}>{l}</span>
                ))}
              </div>
            </div>
          )}

          {result.recommendation && (
            <div className="p-3 rounded-xl"
              style={{ background: 'var(--color-tg-primary-muted)', border: '1px solid var(--color-tg-primary)30' }}>
              <p className="text-xs font-semibold" style={{ color: 'var(--color-tg-primary)' }}>המלצה</p>
              <p className="text-xs text-tg-text mt-1 leading-relaxed">{result.recommendation}</p>
            </div>
          )}

          {result.risk_notes && (
            <div className="p-3 rounded-xl" style={{ background: 'var(--color-tg-warning-muted)' }}>
              <p className="text-xs text-tg-warning leading-relaxed">⚠️ {result.risk_notes}</p>
            </div>
          )}

          <Button variant="secondary" size="sm" onClick={reset}>ניתוח גרף חדש</Button>
        </div>
      )}
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-tg-border last:border-0">
      <span className="text-xs text-tg-text-2">{label}</span>
      <span className="text-xs font-medium text-tg-text">{value}</span>
    </div>
  );
}
