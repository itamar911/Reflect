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

function loadTvScript(onReady: () => void): () => void {
  if (typeof window.TradingView !== 'undefined') {
    onReady();
    return () => {};
  }

  const existing = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);
  if (existing) {
    let active = true;
    const poll = setInterval(() => {
      if (typeof window.TradingView !== 'undefined') {
        clearInterval(poll);
        if (active) onReady();
      }
    }, 100);
    return () => { active = false; clearInterval(poll); };
  }

  const script = document.createElement('script');
  script.src = TV_SCRIPT_SRC;
  script.async = true;
  script.onload = onReady;
  document.head.appendChild(script);
  return () => { script.onload = null; };
}

// Stable unique ID per component instance, generated only on client.
let _counter = 0;

export default function TradingViewChart({ symbol, timeframe, entryPrice, stopLoss, takeProfit }: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const tvContainerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TvWidget | null>(null);
  const idRef = useRef<string | null>(null);

  if (!idRef.current) {
    idRef.current = `tv_chart_${++_counter}`;
  }

  useEffect(() => {
    if (!symbol || !tvContainerRef.current) return;

    let cancelled = false;
    let cleanupScript: (() => void) | null = null;

    function build() {
      if (cancelled || !tvContainerRef.current) return;

      // Destroy previous widget
      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      tvContainerRef.current.innerHTML = '';

      // Read real pixel dimensions from the outer wrapper
      const h = outerRef.current?.clientHeight ?? 400;
      const w = outerRef.current?.clientWidth ?? 600;

      // TV widget needs a real DOM element by ID
      const inner = document.createElement('div');
      inner.id = idRef.current!;
      inner.style.width = `${w}px`;
      inner.style.height = `${h}px`;
      tvContainerRef.current.appendChild(inner);

      const widget = new window.TradingView.widget({
        container_id: idRef.current!,
        symbol,
        interval: TIMEFRAME_MAP[timeframe] || 'D',
        theme: 'dark',
        locale: 'en',
        width: w,
        height: h,
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

      widgetRef.current = widget;

      widget.onChartReady(() => {
        if (cancelled) return;
        const chart = widget.chart();
        const now = Math.floor(Date.now() / 1000);

        const lines: Array<{ price: number | null; color: string; label: string }> = [
          { price: entryPrice, color: '#2962FF', label: 'Entry' },
          { price: stopLoss,   color: '#F23645', label: 'SL'    },
          { price: takeProfit, color: '#089981', label: 'TP'    },
        ];

        for (const { price, color, label } of lines) {
          if (price === null) continue;
          try {
            chart.createShape({ time: now, price }, {
              shape: 'horizontal_line',
              overrides: {
                linecolor: color,
                linewidth: 2,
                linestyle: 0,
                showLabel: true,
                text: label,
                textcolor: color,
                horzLabelsAlign: 'right',
              },
            });
          } catch { /* free widget may not expose shape API */ }
        }
      });
    }

    cleanupScript = loadTvScript(build);

    return () => {
      cancelled = true;
      cleanupScript?.();
    };
  }, [symbol, timeframe, entryPrice, stopLoss, takeProfit]);

  // The outer div always renders so it takes up space in the form.
  // Inside: placeholder when no symbol, TV container when symbol is set.
  return (
    <div
      ref={outerRef}
      className="w-full rounded-2xl overflow-hidden"
      style={{
        height: 'clamp(300px, 40vw, 500px)',
        border: '1px solid var(--color-tg-border)',
        background: 'var(--color-tg-surface-2)',
      }}
    >
      {!symbol ? (
        <div className="flex items-center justify-center w-full h-full text-sm"
          style={{ color: 'var(--color-tg-muted)' }}>
          הזן סמל נכס כדי לראות את הגרף
        </div>
      ) : (
        <div ref={tvContainerRef} style={{ width: '100%', height: '100%' }} />
      )}
    </div>
  );
}
