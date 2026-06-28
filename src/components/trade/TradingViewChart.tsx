'use client';

import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    TradingView: {
      widget: new (config: Record<string, unknown>) => TvWidget;
    };
  }
}

interface TvWidget {
  onChartReady(cb: () => void): void;
  chart(): TvChart;
  remove(): void;
}

interface TvChart {
  createShape(
    point: { time: number; price: number },
    options: Record<string, unknown>,
  ): void;
}

const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1H': '60',
  '4H': '240',
  'Daily': 'D',
  'Weekly': 'W',
};

interface Props {
  symbol: string;
  timeframe: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';

function loadTvScript(onReady: () => void) {
  if (typeof window.TradingView !== 'undefined') {
    onReady();
    return;
  }
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);
  if (existing) {
    const poll = setInterval(() => {
      if (typeof window.TradingView !== 'undefined') {
        clearInterval(poll);
        onReady();
      }
    }, 100);
    return;
  }
  const script = document.createElement('script');
  script.src = TV_SCRIPT_SRC;
  script.async = true;
  script.onload = onReady;
  document.head.appendChild(script);
}

export default function TradingViewChart({ symbol, timeframe, entryPrice, stopLoss, takeProfit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TvWidget | null>(null);
  const idRef = useRef(`tv_${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    if (!symbol || !containerRef.current) return;

    let cancelled = false;

    function build() {
      if (cancelled || !containerRef.current) return;

      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      containerRef.current.innerHTML = '';

      const div = document.createElement('div');
      div.id = idRef.current;
      div.style.width = '100%';
      div.style.height = '100%';
      containerRef.current.appendChild(div);

      const w = new window.TradingView.widget({
        container_id: idRef.current,
        symbol,
        interval: TIMEFRAME_MAP[timeframe] || 'D',
        theme: 'dark',
        locale: 'en',
        autosize: true,
        allow_symbol_change: false,
        hide_side_toolbar: false,
        save_image: false,
        style: '1',
        toolbar_bg: '#131722',
        withdateranges: true,
        details: false,
        hotlist: false,
        calendar: false,
      });

      widgetRef.current = w;

      w.onChartReady(() => {
        if (cancelled) return;
        const chart = w.chart();
        const now = Math.floor(Date.now() / 1000);

        if (entryPrice !== null) {
          try {
            chart.createShape({ time: now, price: entryPrice }, {
              shape: 'horizontal_line',
              overrides: {
                linecolor: '#2962FF',
                linewidth: 2,
                linestyle: 0,
                showLabel: true,
                text: 'Entry',
                textcolor: '#2962FF',
                horzLabelsAlign: 'right',
              },
            });
          } catch { /* free widget may not support shape API */ }
        }

        if (stopLoss !== null) {
          try {
            chart.createShape({ time: now, price: stopLoss }, {
              shape: 'horizontal_line',
              overrides: {
                linecolor: '#F23645',
                linewidth: 2,
                linestyle: 0,
                showLabel: true,
                text: 'SL',
                textcolor: '#F23645',
                horzLabelsAlign: 'right',
              },
            });
          } catch { /* free widget may not support shape API */ }
        }

        if (takeProfit !== null) {
          try {
            chart.createShape({ time: now, price: takeProfit }, {
              shape: 'horizontal_line',
              overrides: {
                linecolor: '#089981',
                linewidth: 2,
                linestyle: 0,
                showLabel: true,
                text: 'TP',
                textcolor: '#089981',
                horzLabelsAlign: 'right',
              },
            });
          } catch { /* free widget may not support shape API */ }
        }
      });
    }

    loadTvScript(build);

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, entryPrice, stopLoss, takeProfit]);

  if (!symbol) {
    return (
      <div
        className="flex items-center justify-center rounded-2xl text-sm text-tg-muted"
        style={{
          height: 300,
          background: 'var(--color-tg-surface-2)',
          border: '1px solid var(--color-tg-border)',
        }}
      >
        הזן סמל נכס כדי לראות את הגרף
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="rounded-2xl overflow-hidden w-full"
      style={{ height: 'clamp(300px, 40vw, 500px)' }}
    />
  );
}
