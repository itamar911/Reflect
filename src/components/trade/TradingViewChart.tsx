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

const SYMBOL_MAP: Record<string, string> = {
  'NQ': 'CAPITALCOM:NAS100',
  'NQ1': 'CAPITALCOM:NAS100',
  'NQ1!': 'CAPITALCOM:NAS100',
  'ES': 'CAPITALCOM:US500',
  'ES1': 'CAPITALCOM:US500',
  'ES1!': 'CAPITALCOM:US500',
  'NASDAQ': 'NASDAQ:NDX',
  'NSDQ': 'NASDAQ:NDX',
  'NDX': 'NASDAQ:NDX',
  'SPX': 'SP:SPX',
  'SPY': 'AMEX:SPY',
  'QQQ': 'NASDAQ:QQQ',
  'GOLD': 'OANDA:XAUUSD',
  'XAUUSD': 'OANDA:XAUUSD',
  'BTC': 'BINANCE:BTCUSDT',
  'BTCUSD': 'BINANCE:BTCUSDT',
};

function normalizeSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return SYMBOL_MAP[upper] ?? upper;
}

let _counter = 0;

export default function TradingViewChart({ symbol, timeframe }: Props) {
  const tvContainerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TvWidget | null>(null);
  const idRef = useRef<string | null>(null);

  // Lazy one-time init — the `== null` check is the sanctioned pattern for
  // initializing a ref during render.
  if (idRef.current == null) {
    idRef.current = `tv_chart_${++_counter}`;
  }

  useEffect(() => {
    if (!symbol || !tvContainerRef.current) return;

    let cancelled = false;
    let cleanupScript: (() => void) | null = null;

    function build() {
      if (cancelled || !tvContainerRef.current) return;

      const isMobile = window.innerWidth <= 768;
      const w = isMobile ? 380 : 800;
      const h = isMobile ? 214 : 450;

      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      tvContainerRef.current.innerHTML = '';

      const inner = document.createElement('div');
      inner.id = idRef.current!;
      tvContainerRef.current.appendChild(inner);

      widgetRef.current = new window.TradingView!.widget({
        container_id: idRef.current!,
        symbol: normalizeSymbol(symbol),
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

    // 100ms delay lets the bottom-sheet CSS transition finish before the widget initializes.
    const timer = setTimeout(() => {
      if (cancelled) return;
      cleanupScript = loadTvScript(build);
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanupScript?.();
      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      widgetRef.current = null;
    };
  }, [symbol, timeframe]);

  return (
    <>
      <div className="w-full rounded-2xl h-[214px] md:h-[450px]"
        style={{ border: '1px solid var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}
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
      {symbol && (
        <p className="text-[10px] mt-1 text-center" style={{ color: 'var(--color-tg-muted)' }}>
          ⚠️ הנתונים המוצגים הם אינדיקטיביים בלבד ועשויים שלא לשקף את המחיר המדויק של הנכס. יש לאמת מול פלטפורמת המסחר שלך.
        </p>
      )}
    </>
  );
}
