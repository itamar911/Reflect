'use client';

import { useEffect, useId, useRef } from 'react';

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => TVWidget;
    };
    _tvScriptLoaded?: boolean;
    _tvScriptCallbacks?: Array<() => void>;
  }
}

interface TVChart {
  createShape(point: { price: number }, options: Record<string, unknown>): void;
}

interface TVWidget {
  onChartReady(callback: () => void): void;
  activeChart(): TVChart;
}

interface Props {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice?: number | null;
  submittedAt: string;
  closedAt?: string | null;
}

// Resolve symbol to TradingView format
function toTvSymbol(sym: string): string {
  const s = sym.toUpperCase().trim();
  if (!s) return 'SPY';
  if (s.includes(':')) return s;

  const fxBases = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'NOK', 'SEK', 'DKK'];
  if (s.length === 6) {
    const base = s.slice(0, 3);
    const quote = s.slice(3);
    if (fxBases.includes(base) && fxBases.includes(quote)) return `FX_IDC:${s}`;
  }

  if (s === 'BTC' || s === 'BTCUSD' || s === 'BTCUSDT') return 'BINANCE:BTCUSDT';
  if (s === 'ETH' || s === 'ETHUSD' || s === 'ETHUSDT') return 'BINANCE:ETHUSDT';

  return s;
}

function getInterval(submittedAt: string, closedAt?: string | null): string {
  if (!closedAt) return '60';
  const diffMs = new Date(closedAt).getTime() - new Date(submittedAt).getTime();
  const hours = diffMs / 3_600_000;
  if (hours < 4) return '5';
  if (hours < 48) return '60';
  if (hours < 336) return 'D';
  return 'W';
}

function loadTvScript(onReady: () => void) {
  if (window._tvScriptLoaded) {
    onReady();
    return;
  }
  if (!window._tvScriptCallbacks) {
    window._tvScriptCallbacks = [];
  }
  window._tvScriptCallbacks.push(onReady);

  // Only add the script tag once
  if (document.querySelector('script[src*="tradingview.com/tv.js"]')) return;

  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/tv.js';
  script.async = true;
  script.onload = () => {
    window._tvScriptLoaded = true;
    (window._tvScriptCallbacks ?? []).forEach((cb) => cb());
    window._tvScriptCallbacks = [];
  };
  document.head.appendChild(script);
}

export default function TradingViewChart({
  symbol,
  entryPrice,
  stopLoss,
  takeProfit,
  exitPrice,
  submittedAt,
  closedAt,
}: Props) {
  const rawId = useId().replace(/:/g, '');
  const containerId = `tv_${rawId}`;
  const widgetRef = useRef<TVWidget | null>(null);

  useEffect(() => {
    // Each effect invocation gets its own cancelled flag.
    // This prevents a stale initWidget (queued in _tvScriptCallbacks before unmount)
    // from running after the component has already been torn down or remounted.
    let cancelled = false;

    const tvSymbol = toTvSymbol(symbol);
    const interval = getInterval(submittedAt, closedAt);

    function initWidget() {
      if (cancelled) return;

      const container = document.getElementById(containerId);
      if (!container || !window.TradingView) return;

      // Wipe any leftover iframe/content from a previous widget instance
      // before handing the container to a new widget.
      container.innerHTML = '';

      const widget = new window.TradingView.widget({
        container_id: containerId,
        symbol: tvSymbol,
        interval,
        theme: 'dark',
        style: '1',
        locale: 'en',
        width: '100%',
        height: 400,
        save_image: false,
        hide_side_toolbar: true,
        allow_symbol_change: true,
        backgroundColor: '#0f0f10',
        gridColor: '#1a1a1f',
      });

      widgetRef.current = widget;

      widget.onChartReady(() => {
        // Guard: component may have unmounted while the widget was initialising
        if (cancelled) return;
        try {
          const chart = widget.activeChart();
          const isWin = exitPrice != null ? exitPrice > entryPrice : null;

          chart.createShape(
            { price: entryPrice },
            { shape: 'horizontal_line', text: `Entry ${entryPrice}`, overrides: { linecolor: '#60a5fa', linewidth: 2, linestyle: 0, showLabel: true, textcolor: '#60a5fa', fontsize: 11 } },
          );
          chart.createShape(
            { price: stopLoss },
            { shape: 'horizontal_line', text: `SL ${stopLoss}`, overrides: { linecolor: '#f87171', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#f87171', fontsize: 11 } },
          );
          chart.createShape(
            { price: takeProfit },
            { shape: 'horizontal_line', text: `TP ${takeProfit}`, overrides: { linecolor: '#4ade80', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#4ade80', fontsize: 11 } },
          );
          if (exitPrice != null) {
            chart.createShape(
              { price: exitPrice },
              { shape: 'horizontal_line', text: `Exit ${exitPrice}`, overrides: { linecolor: isWin ? '#4ade80' : '#f87171', linewidth: 2, linestyle: 0, showLabel: true, textcolor: isWin ? '#4ade80' : '#f87171', fontsize: 11 } },
            );
          }
        } catch {
          // createShape may be unavailable; chart still renders normally
        }
      });
    }

    loadTvScript(initWidget);

    return () => {
      cancelled = true;
      widgetRef.current = null;
      const container = document.getElementById(containerId);
      if (container) container.innerHTML = '';
    };
  }, [containerId, symbol, entryPrice, stopLoss, takeProfit, exitPrice, submittedAt, closedAt]);

  return (
    <div className="rounded-xl overflow-hidden border border-tg-border" style={{ background: '#0f0f10' }}>
      <div id={containerId} style={{ height: 400 }} />
      {/* Price level legend */}
      <div className="flex items-center gap-4 px-3 py-2 flex-wrap" style={{ background: 'var(--color-tg-surface-2)' }}>
        <LegendItem color="#60a5fa" label="כניסה" value={entryPrice} />
        <LegendItem color="#f87171" label="SL" value={stopLoss} />
        <LegendItem color="#4ade80" label="TP" value={takeProfit} />
        {exitPrice != null && (
          <LegendItem color={exitPrice > entryPrice ? '#4ade80' : '#f87171'} label="יציאה" value={exitPrice} />
        )}
      </div>
    </div>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-3 h-0.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-xs text-tg-muted">{label}</span>
      <span className="text-xs font-mono font-semibold text-tg-text">{value}</span>
    </div>
  );
}
