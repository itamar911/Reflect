'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { useModalDialog } from '@/lib/a11y/useModalDialog';

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

// Entry/SL/TP were drawn here as horizontal lines via
// widget.onChartReady() → chart().createShape(). That API belongs to
// TradingView's licensed Charting Library, not to the free tv.js embed widget
// this file loads — both products expose the same `TradingView.widget`
// constructor, so the code typechecked and built, then threw
// "onChartReady is not a function" on every single load. The lines were never
// drawn once. Removed rather than fixed: the embed renders inside a
// cross-origin iframe, so there is no way to draw on it from here at all.
// (This was already diagnosed and removed once in 5118a76, then reintroduced
// in aef5f36 — don't add it back without the paid Charting Library.)

/**
 * Mounts a TradingView Advanced Chart widget into `containerRef` while `active`
 * is true, autosized to fill it, and tears it down on cleanup or when any input
 * changes. Used twice (inline card + fullscreen view) so both stay in sync.
 *
 * Only the symbol and the timeframe reach the widget, so only those two can
 * force a rebuild — editing a price no longer tears down and re-creates the
 * iframe (REF-94).
 */
function useTvWidget(opts: {
  containerRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  symbol: string;
  timeframe: string;
  initDelay: number;
  touchAction: string;
}) {
  const { containerRef, active, symbol, timeframe, initDelay, touchAction } = opts;
  const widgetRef = useRef<TvWidget | null>(null);
  const idRef = useRef<string | null>(null);

  // Lazy one-time init — the `== null` check is the sanctioned pattern for
  // initializing a ref during render.
  if (idRef.current == null) {
    idRef.current = `tv_chart_${++_counter}`;
  }

  useEffect(() => {
    if (!active || !symbol || !containerRef.current) return;

    let cancelled = false;
    let cleanupScript: (() => void) | null = null;

    function build() {
      if (cancelled || !containerRef.current) return;

      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      containerRef.current.innerHTML = '';

      const inner = document.createElement('div');
      inner.id = idRef.current!;
      // autosize measures this element's own box — a plain div only inherits
      // 100% width from its parent by default, not height, so both need to be
      // explicit or autosize collapses to zero height.
      inner.style.width = '100%';
      inner.style.height = '100%';
      containerRef.current.appendChild(inner);

      const widget = new window.TradingView!.widget({
        container_id: idRef.current!,
        autosize: true,
        symbol: normalizeSymbol(symbol),
        interval: TIMEFRAME_MAP[timeframe] || 'D',
        theme: 'dark',
        locale: 'en',
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
      // Safari doesn't reliably honor touch-action set on an iframe's
      // ancestors, so it also has to be set on the widget's own injected
      // iframe — otherwise the inline chart's pan-y (meant to hand vertical
      // drags to the sheet) can silently fail there and trap page scroll.
      const iframe = containerRef.current.querySelector('iframe');
      if (iframe) iframe.style.touchAction = touchAction;
    }

    // Lets any container CSS transition (bottom-sheet slide-up, fullscreen
    // fade-in) finish before the widget measures its box for autosize.
    const timer = setTimeout(() => {
      if (cancelled) return;
      cleanupScript = loadTvScript(build);
    }, initDelay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      cleanupScript?.();
      try { widgetRef.current?.remove(); } catch { /* ignore */ }
      widgetRef.current = null;
    };
  }, [active, symbol, timeframe, containerRef, initDelay, touchAction]);
}

export default function TradingViewChart({ symbol, timeframe }: Props) {
  const tvContainerRef = useRef<HTMLDivElement>(null);
  const fsContainerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useTvWidget({
    containerRef: tvContainerRef,
    active: true,
    symbol, timeframe,
    initDelay: 100,
    touchAction: 'pan-y',
  });

  useTvWidget({
    containerRef: fsContainerRef,
    active: expanded,
    symbol, timeframe,
    initDelay: 0,
    // No page scroll to compete with here (body is locked while expanded),
    // so the fullscreen chart gets full native pan/zoom.
    touchAction: 'auto',
  });

  // CSS overlay, not the native Fullscreen API: iOS Safari doesn't support
  // Element.requestFullscreen() outside <video>. Escape is therefore our own
  // handling rather than the browser's native fullscreenchange — here via
  // useModalDialog, which also matters because this opens *inside* the trade
  // sheet: the shared stack makes Escape close the chart first, then the
  // sheet, instead of both at once.
  const collapse = useCallback(() => setExpanded(false), []);
  const exitRef = useRef<HTMLButtonElement>(null);
  // The chart itself is an unfocusable <div>, so the exit button is both the
  // sensible landing spot and the only control in here.
  const { dialogProps } = useModalDialog({
    open: expanded,
    onClose: collapse,
    label: symbol ? `גרף מסך מלא — ${symbol}` : 'גרף מסך מלא',
    initialFocusRef: exitRef,
  });

  // Prevent the page (and the bottom sheet under it) from scrolling behind
  // the fullscreen overlay.
  useEffect(() => {
    if (!expanded) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  return (
    <>
      <div className="relative w-full rounded-2xl overflow-hidden aspect-[4/3] md:aspect-[16/9]"
        style={{ border: '1px solid var(--color-tg-border)', background: 'var(--color-tg-surface-2)' }}
      >
        {!symbol ? (
          <div className="flex items-center justify-center w-full h-full text-sm"
            style={{ color: 'var(--color-tg-muted)' }}>
            הזן סמל נכס כדי לראות את הגרף
          </div>
        ) : (
          <>
            {/* pan-y: single-finger drags on the small inline chart scroll the
                sheet instead of panning candles, so the chart never traps page
                scroll. Full pan/zoom is still available via the expand button —
                fullscreen has no competing scroll to fight (body is locked). */}
            <div ref={tvContainerRef} style={{ width: '100%', height: '100%', touchAction: 'pan-y' }} />
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="הגדל את הגרף למסך מלא"
              title="מסך מלא"
              className="absolute top-2 end-2 z-10 flex items-center justify-center w-9 h-9 rounded-full transition-opacity hover:opacity-80"
              style={{
                background: 'var(--color-tg-surface)',
                border: '1px solid var(--color-tg-border)',
                color: 'var(--color-tg-text-2)',
              }}
            >
              <Maximize2 size={15} aria-hidden />
            </button>
          </>
        )}
      </div>
      {symbol && (
        <p className="text-[10px] mt-1 text-center" style={{ color: 'var(--color-tg-muted)' }}>
          הנתונים המוצגים הם אינדיקטיביים בלבד ועשויים שלא לשקף את המחיר המדויק של הנכס. יש לאמת מול פלטפורמת המסחר שלך.
        </p>
      )}

      {expanded && typeof document !== 'undefined' && createPortal(
        <div {...dialogProps} className="fixed inset-0 z-[80] animate-fade-in" style={{ background: 'var(--color-tg-bg)' }}>
          <div ref={fsContainerRef} className="w-full h-full" style={{ touchAction: 'auto' }} />

          <button
            ref={exitRef}
            type="button"
            onClick={collapse}
            aria-label="יציאה ממסך מלא"
            title="יציאה ממסך מלא"
            className="fixed z-10 flex items-center justify-center rounded-full transition-opacity hover:opacity-80"
            style={{
              top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
              insetInlineEnd: 'calc(env(safe-area-inset-right, 0px) + 12px)',
              width: 44,
              height: 44,
              // Inline style, not a compiled CSS rule — Lightning CSS never sees
              // this pair, so it's exempt from the backdrop-filter build bug
              // that guts .glass-dark in globals.css (see that memory before
              // "fixing" this by dropping the webkit- prefix). background is an
              // opaque solid regardless, so the button stays legible even on a
              // browser where backdrop-filter doesn't apply at all.
              background: 'var(--color-tg-surface)',
              border: '1px solid var(--color-tg-border)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
          >
            <X size={22} style={{ color: 'var(--color-tg-text-2)' }} aria-hidden />
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
