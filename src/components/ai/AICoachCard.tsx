'use client';

import { useState, useEffect, type ReactNode } from 'react';
import Card from '@/components/ui/Card';
import { AlertTriangle, Clock, Heart, TrendingUp, Search, Target, DollarSign } from 'lucide-react';

interface Insight {
  type: 'time' | 'emotional' | 'revenge' | 'performance' | 'pattern' | 'discipline';
  text: string;
}

interface Trade {
  status: string;
  emotional_state: number;
  rr_ratio: number;
  strategy: string;
  submitted_at: string;
  entry_price: number;
  exit_price: number | null;
}

const TYPE_CONFIG: Record<string, { icon: ReactNode; color: string; label: string }> = {
  time:        { icon: <Clock size={14} />,         color: '#00d2d2', label: 'שעות מסחר' },
  emotional:   { icon: <Heart size={14} />,         color: '#60A5FA', label: 'מצב רגשי' },
  revenge:     { icon: <AlertTriangle size={14} />, color: '#FF3B30', label: 'Revenge Trading' },
  performance: { icon: <TrendingUp size={14} />,    color: '#00C853', label: 'ביצועים' },
  pattern:     { icon: <Search size={14} />,        color: '#A78BFA', label: 'דפוס' },
  discipline:  { icon: <Target size={14} />,        color: '#00d2d2', label: 'משמעת' },
};

export default function AICoachCard({ trades }: { trades: Trade[] }) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function fetchInsights() {
    if (trades.length === 0) return;
    setLoading(true);
    try {
      const res = await fetch('/api/ai-coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades }),
      });
      const data = await res.json();
      setInsights(data.insights ?? []);
      setLoaded(true);
    } catch {
      setInsights([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Fetch-once-per-dataset effect: setLoading(true) flags the request this
    // effect itself starts — deferring it would blank the spinner for a frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the in-flight state of the fetch started here
    if (trades.length >= 3 && !loaded) fetchInsights();
    // Keyed to trades.length on purpose: `trades` gets a fresh identity every
    // parent render and `loaded` only flips inside this flow — canonical deps
    // would refetch the AI insights on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades.length]);

  if (trades.length < 3) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <DollarSign size={18} />
          <h3 className="text-sm font-semibold text-tg-text">ניתוח השפעה פיננסית</h3>
        </div>
        <p className="text-xs text-tg-text-2">נדרשות לפחות 3 עסקאות כדי לחשב כמה אתה חוסך ומרוויח</p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: 'var(--color-tg-primary-muted)', border: '1px solid var(--color-tg-primary)' }}>
            <DollarSign size={14} />
          </div>
          <h3 className="text-sm font-semibold text-tg-text">ניתוח השפעה פיננסית</h3>
        </div>
        {!loading && (
          <button onClick={fetchInsights}
            className="hit-40 relative text-xs font-medium px-2 py-1 rounded-lg transition-colors"
            style={{ color: 'var(--color-tg-primary)', background: 'var(--color-tg-primary-muted)' }}>
            רענן
          </button>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          ))}
        </div>
      )}

      {!loading && insights.length === 0 && loaded && (
        <p className="text-xs text-tg-text-2">לא נמצאו תובנות כרגע</p>
      )}

      {!loading && insights.length > 0 && (
        <div className="flex flex-col gap-2">
          {insights.map((ins, i) => {
            const cfg = TYPE_CONFIG[ins.type] ?? TYPE_CONFIG.performance;
            return (
              <div key={i}
                className="flex items-start gap-3 p-3 rounded-xl animate-fade-in"
                style={{ background: 'var(--color-tg-surface-2)', border: '1px solid var(--color-tg-border)' }}>
                <span className="text-base shrink-0 mt-0.5">{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-medium" style={{ color: cfg.color }}>{cfg.label}</span>
                  <p className="text-xs text-tg-text mt-0.5 leading-relaxed">{ins.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
