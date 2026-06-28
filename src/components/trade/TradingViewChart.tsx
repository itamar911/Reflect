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

let _counter = 0;

export default function TradingViewChart({ symbol, timeframe }: Props) {
  console.log('TradingViewChart rendered', symbol);
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
    let timer: ReturnType<typeof setTimeout> | null = null;

    function build() {
      if (cancelled || !tvContainerRef.current || !outerRef.current) return;

      const w = outerRef.current.clientWidth || (window.innerWidth >= 768 ? 600 : 380);
      const h = outerRef.current.clientHeight || (window.innerWidth >= 768 ? 600 : 400);

      if (w === 0 || h === 0) return;

      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      tvContainerRef.current.innerHTML = '';

      const inner = document.createElement('div');
      inner.id = idRef.current!;
      inner.style.width = `${w}px`;
      inner.style.height = `${h}px`;
      tvContainerRef.current.appendChild(inner);

      widgetRef.current = new window.TradingView!.widget({
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
    }

    // 100ms delay lets the bottom-sheet CSS transition finish so clientWidth/Height are non-zero.
    timer = setTimeout(() => {
      if (cancelled) return;
      cleanupScript = loadTvScript(build);
    }, 100);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      cleanupScript?.();
    };
  }, [symbol, timeframe]);

  return (
    <div
      ref={outerRef}
      className="w-full rounded-2xl overflow-hidden h-[400px] md:h-[600px]"
      style={{
        border: '1px solid var(--color-tg-border)',
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
