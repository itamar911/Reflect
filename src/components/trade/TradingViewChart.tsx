'use client';

import { useEffect, useRef } from 'react';

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
    console.log('TV: TradingView already loaded, calling onReady immediately');
    onReady();
    return () => {};
  }

  const existing = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);
  if (existing) {
    console.log('TV: script tag exists, polling for TradingView...');
    let active = true;
    const poll = setInterval(() => {
      if (typeof window.TradingView !== 'undefined') {
        clearInterval(poll);
        console.log('TV: script loaded (poll), TradingView available:', typeof window.TradingView);
        if (active) onReady();
      }
    }, 100);
    return () => { active = false; clearInterval(poll); };
  }

  console.log('TV: injecting script tag from', TV_SCRIPT_SRC);
  const script = document.createElement('script');
  script.src = TV_SCRIPT_SRC;
  script.async = true;
  script.onload = () => {
    console.log('TV: script loaded (onload), TradingView available:', typeof window.TradingView);
    onReady();
  };
  script.onerror = (e) => console.error('TV: script failed to load', e);
  document.head.appendChild(script);
  return () => { script.onload = null; };
}

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
    console.log('TV: component mounted, symbol=', symbol);
    if (!symbol || !tvContainerRef.current) return;

    let cancelled = false;
    let cleanupScript: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function build() {
      if (cancelled || !tvContainerRef.current || !outerRef.current) return;

      const w = outerRef.current.clientWidth || (window.innerWidth >= 768 ? 600 : 380);
      const h = outerRef.current.clientHeight || (window.innerWidth >= 768 ? 600 : 400);

      console.log('TV: creating widget with container:', w, 'x', h);

      if (w === 0 || h === 0) {
        console.log('TV: container has zero dimensions, aborting');
        return;
      }

      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      tvContainerRef.current.innerHTML = '';

      const inner = document.createElement('div');
      inner.id = idRef.current!;
      inner.style.width = `${w}px`;
      inner.style.height = `${h}px`;
      tvContainerRef.current.appendChild(inner);

      console.log('TV: calling new TradingView.widget(), container_id=', idRef.current);
      const widget = new window.TradingView!.widget({
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
      console.log('TV: widget created', widget);

      widget.onChartReady(() => {
        console.log('TV: onChartReady fired');
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

    // 100ms delay gives the bottom-sheet time to finish its CSS transition
    // and paint the container at its real dimensions before we read them.
    function scheduleAndLoad() {
      console.log('TV: scheduling script load in 100ms');
      timer = setTimeout(() => {
        if (cancelled) return;
        console.log('TV: 100ms elapsed, loading script...');
        cleanupScript = loadTvScript(build);
      }, 100);
    }

    scheduleAndLoad();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      cleanupScript?.();
    };
  }, [symbol, timeframe, entryPrice, stopLoss, takeProfit]);

  // Explicit pixel heights so clientHeight is never 0 when we read it.
  // 400px on mobile (< md), 600px on desktop.
  return (
    <div
      ref={outerRef}
      className="w-full rounded-2xl overflow-hidden h-[400px] md:h-[600px]"
      style={{
        border: '2px solid red',
        background: 'var(--color-tg-surface-2)',
      }}
    >
      {!symbol ? (
        <div
          className="flex items-center justify-center w-full h-full text-sm"
          style={{ color: 'var(--color-tg-muted)' }}
        >
          הזן סמל נכס כדי לראות את הגרף
        </div>
      ) : (
        <div ref={tvContainerRef} style={{ width: '100%', height: '100%' }} />
      )}
    </div>
  );
}
