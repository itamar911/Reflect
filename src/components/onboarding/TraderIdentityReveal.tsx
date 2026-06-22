'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import {
  CHALLENGE_OPTIONS, AFTER_LOSS_OPTIONS, FALLBACK_ANALYSIS, traderThemeColor,
  type ChallengeId, type AfterLossId, type TraderAnalysis,
} from './onboardingData';

const MIN_ANALYZING_MS = 2200;

interface RevealProps {
  userId: string;
  displayName: string;
  tradingTypeLabel: string;
  experienceLabel: string;
  marketLabel: string;
  minRrRatio: number;
  maxDailyTrades: number;
  biggestChallenge: ChallengeId;
  afterLossBehavior: AfterLossId;
}

export default function TraderIdentityReveal({
  userId, displayName, tradingTypeLabel, experienceLabel, marketLabel,
  minRrRatio, maxDailyTrades, biggestChallenge, afterLossBehavior,
}: RevealProps) {
  const router = useRouter();
  const [analysis, setAnalysis] = useState<TraderAnalysis | null>(null);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    (async () => {
      let result: TraderAnalysis;
      try {
        const res = await fetch('/api/onboarding-analysis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName,
            tradingType: tradingTypeLabel,
            experienceLevel: experienceLabel,
            defaultMarket: marketLabel,
            minRrRatio,
            maxDailyTrades,
            biggestChallenge: CHALLENGE_OPTIONS.find((o) => o.id === biggestChallenge)?.label ?? biggestChallenge,
            afterLossBehavior: AFTER_LOSS_OPTIONS.find((o) => o.id === afterLossBehavior)?.label ?? afterLossBehavior,
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.analysis) throw new Error('analysis request failed');
        result = json.analysis as TraderAnalysis;
      } catch (err) {
        console.error('[onboarding] AI analysis failed, using fallback', err);
        result = FALLBACK_ANALYSIS[biggestChallenge];
      }

      const elapsed = Date.now() - startedAt;
      await new Promise((r) => setTimeout(r, Math.max(MIN_ANALYZING_MS - elapsed, 0)));
      if (cancelled) return;

      const supabase = createClient();
      await supabase.from('profiles').update({ trader_type: result.traderType }).eq('id', userId);
      if (!cancelled) setAnalysis(result);
    })();

    return () => { cancelled = true; };
    // Inputs are fixed for the lifetime of this screen — only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!analysis) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-4"
        style={{ background: 'var(--color-tg-bg)' }}>
        <Loader2 size={36} className="animate-spin" style={{ color: '#00d2d2' }} />
        <p className="text-sm text-tg-text-2">מנתח את הפרופיל שלך...</p>
      </div>
    );
  }

  const color = traderThemeColor(analysis.traderType);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
      style={{ background: 'var(--color-tg-bg)' }}>
      <div className="w-full max-w-md animate-fade-in rounded-2xl border p-6 text-center"
        style={{ borderColor: color, background: 'var(--color-tg-surface)', boxShadow: `0 0 40px ${color}33` }}>
        <p className="text-xs font-semibold tracking-wide text-tg-muted mb-2">זהות הסוחר שלך</p>
        <h1 className="text-2xl font-bold mb-3" style={{ color }}>{analysis.traderTypeHebrew}</h1>
        <p className="text-sm text-tg-text-2 mb-5 leading-relaxed">{analysis.description}</p>

        <div className="flex flex-col gap-2 mb-5">
          {analysis.weaknesses.map((w, i) => (
            <span key={i} className="text-xs font-medium px-3 py-2 rounded-xl"
              style={{ background: `${color}1f`, color }}>
              {w}
            </span>
          ))}
        </div>

        <div className="text-right rounded-xl p-4 mb-6" style={{ background: 'var(--color-tg-surface-2)' }}>
          <p className="text-xs font-semibold text-tg-muted mb-1">הטיפ הראשון שלך</p>
          <p className="text-sm text-tg-text">{analysis.firstTip}</p>
        </div>

        <Button onClick={() => router.push('/dashboard')} fullWidth size="lg" variant="success">
          בואו נתחיל לעקוב →
        </Button>
      </div>
    </div>
  );
}
