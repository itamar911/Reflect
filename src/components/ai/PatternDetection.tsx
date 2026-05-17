'use client';

import { useState, useEffect } from 'react';
import Card from '@/components/ui/Card';

interface Pattern {
  type: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  occurrences: number;
  recommendation: string;
}

interface Trade {
  status: string;
  emotional_state: number;
  rr_ratio: number;
  strategy: string;
  submitted_at: string;
  entry_price: number;
  exit_price: number | null;
  stop_loss: number;
}

const SEVERITY_COLOR = { high: '#FF3B30', medium: '#F59E0B', low: '#00C853' };
const TYPE_ICON: Record<string, string> = {
  revenge: '🔄', loss_hours: '⏰', weak_setup: '📉',
  emotional: '😤', discipline: '⚠️', positive: '✅',
};

export default function PatternDetection({ trades }: { trades: Trade[] }) {
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => { if (trades.length >= 5) fetchPatterns(); }, [trades.length]);

  async function fetchPatterns() {
    setLoading(true);
    try {
      const res = await fetch('/api/ai-patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades }),
      });
      const data = await res.json();
      setPatterns(data.patterns ?? []);
    } catch {
      setPatterns([]);
    } finally {
      setLoading(false);
    }
  }

  if (trades.length < 5) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-base">🔍</span>
          <h3 className="text-sm font-semibold text-tg-text">זיהוי דפוסים</h3>
        </div>
        <p className="text-xs text-tg-text-2">נדרשות לפחות 5 עסקאות לזיהוי דפוסים</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-base">🔍</span>
          <h3 className="text-sm font-semibold text-tg-text">דפוסים שזוהו</h3>
        </div>
        {!loading && (
          <button onClick={fetchPatterns}
            className="text-xs px-2 py-1 rounded-lg"
            style={{ color: 'var(--color-tg-primary)', background: 'var(--color-tg-primary-muted)' }}>
            רענן
          </button>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          ))}
        </div>
      )}

      {!loading && patterns.length === 0 && (
        <p className="text-xs text-tg-text-2">לחץ רענן לזיהוי דפוסים</p>
      )}

      {!loading && patterns.length > 0 && (
        <div className="flex flex-col gap-2">
          {patterns.map((p, i) => (
            <div key={i}>
              <button
                onClick={() => setExpanded(expanded === i ? null : i)}
                className="w-full flex items-center gap-3 p-3 rounded-xl text-right transition-colors"
                style={{ background: 'var(--color-tg-surface-2)', border: `1px solid ${SEVERITY_COLOR[p.severity]}30` }}>
                <span className="text-base shrink-0">{TYPE_ICON[p.type] ?? '📊'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-tg-text">{p.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full"
                      style={{ background: `${SEVERITY_COLOR[p.severity]}20`, color: SEVERITY_COLOR[p.severity] }}>
                      {p.occurrences}x
                    </span>
                  </div>
                  <p className="text-[11px] text-tg-text-2 mt-0.5 truncate">{p.description}</p>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className="shrink-0 text-tg-muted transition-transform"
                  style={{ transform: expanded === i ? 'rotate(180deg)' : 'none' }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {expanded === i && (
                <div className="mt-1 px-3 py-2 rounded-xl text-xs text-tg-text-2 animate-fade-in"
                  style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}>
                  <strong style={{ color: 'var(--color-tg-primary)' }}>המלצה:</strong> {p.recommendation}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
