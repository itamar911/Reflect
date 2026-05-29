'use client';

import { Component, useEffect, useRef, useState } from 'react';

// ── TradingView global types ──────────────────────────────────────────────────

declare global {
  interface Window {
    TradingView?: { widget: new (config: Record<string, unknown>) => TVWidget };
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
  remove?(): void;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitPrice?: number | null;
  submittedAt: string;
  closedAt?: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  if (window._tvScriptLoaded) { onReady(); return; }
  if (!window._tvScriptCallbacks) window._tvScriptCallbacks = [];
  window._tvScriptCallbacks.push(onReady);
  if (document.querySelector('script[src*="tradingview.com/tv.js"]')) return;

  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/tv.js';
  script.async = true;
  script.onload = () => {
    window._tvScriptLoaded = true;
    (window._tvScriptCallbacks ?? []).forEach((cb) => cb());
    window._tvScriptCallbacks = [];
  };
  script.onerror = () => {
    console.error('[TradingView] Failed to load tv.js script');
  };
  document.head.appendChild(script);
}

// ── Error Boundary ────────────────────────────────────────────────────────────

interface BoundaryState { error: Error | null }

class ChartErrorBoundary extends Component<{ children: React.ReactNode; onReset: () => void }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    console.error('[TradingView] Error boundary caught:', error);
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[TradingView] componentDidCatch:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-tg-border flex flex-col items-center justify-center gap-3 py-10"
          style={{ background: 'var(--color-tg-surface)', minHeight: 200 }}>
          <p className="text-sm text-tg-text-2">לא ניתן לטעון את הגרף</p>
          <button
            className="text-xs px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text-2)', border: '1px solid var(--color-tg-border)' }}
            onClick={() => { this.setState({ error: null }); this.props.onReset(); }}
          >
            נסה שוב
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Inner chart component ─────────────────────────────────────────────────────

function TradingViewChartInner({
  symbol, entryPrice, stopLoss, takeProfit, exitPrice, submittedAt, closedAt,
}: Props) {
  // A fresh unique ID on every mount — avoids TradingView's internal ID collision
  // when the component unmounts and remounts at the same tree position.
  // useId() returns the same value for the same position; useRef avoids that.
  const containerIdRef = useRef<string>(
    `tv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  );
  const containerId = containerIdRef.current;
  const widgetRef = useRef<TVWidget | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tvSymbol = toTvSymbol(symbol);
    const interval = getInterval(submittedAt, closedAt);

    function initWidget() {
      if (cancelled) {
        console.warn('[TradingView] initWidget skipped — component already unmounted');
        return;
      }

      const container = document.getElementById(containerId);
      if (!container) {
        console.error('[TradingView] Container not found:', containerId);
        return;
      }
      if (!window.TradingView) {
        console.error('[TradingView] window.TradingView not available after script load');
        return;
      }

      // Wipe any residual iframe from the previous widget instance
      container.innerHTML = '';

      let widget: TVWidget;
      try {
        console.info('[TradingView] Creating widget in', containerId, 'symbol:', tvSymbol);
        widget = new window.TradingView.widget({
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
      } catch (err) {
        console.error('[TradingView] widget constructor threw:', err);
        setInitError(String(err));
        return;
      }

      if (cancelled) {
        // Unmounted between constructor and here — clean up immediately
        console.warn('[TradingView] Widget created but component already unmounted, removing');
        try { widget.remove?.(); } catch { /* ignore */ }
        container.innerHTML = '';
        return;
      }

      widgetRef.current = widget;

      try {
        widget.onChartReady(() => {
          if (cancelled) return;
          try {
            const chart = widget.activeChart();
            const isWin = exitPrice != null ? exitPrice > entryPrice : null;

            chart.createShape({ price: entryPrice }, {
              shape: 'horizontal_line', text: `Entry ${entryPrice}`,
              overrides: { linecolor: '#60a5fa', linewidth: 2, linestyle: 0, showLabel: true, textcolor: '#60a5fa', fontsize: 11 },
            });
            chart.createShape({ price: stopLoss }, {
              shape: 'horizontal_line', text: `SL ${stopLoss}`,
              overrides: { linecolor: '#f87171', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#f87171', fontsize: 11 },
            });
            chart.createShape({ price: takeProfit }, {
              shape: 'horizontal_line', text: `TP ${takeProfit}`,
              overrides: { linecolor: '#4ade80', linewidth: 1, linestyle: 2, showLabel: true, textcolor: '#4ade80', fontsize: 11 },
            });
            if (exitPrice != null) {
              chart.createShape({ price: exitPrice }, {
                shape: 'horizontal_line', text: `Exit ${exitPrice}`,
                overrides: { linecolor: isWin ? '#4ade80' : '#f87171', linewidth: 2, linestyle: 0, showLabel: true, textcolor: isWin ? '#4ade80' : '#f87171', fontsize: 11 },
              });
            }
          } catch (err) {
            // createShape failure is non-fatal; chart still renders
            console.warn('[TradingView] createShape failed (non-fatal):', err);
          }
        });
      } catch (err) {
        console.error('[TradingView] onChartReady registration threw:', err);
      }
    }

    try {
      loadTvScript(initWidget);
    } catch (err) {
      console.error('[TradingView] loadTvScript threw:', err);
      setInitError(String(err));
    }

    return () => {
      cancelled = true;
      const widget = widgetRef.current;
      widgetRef.current = null;

      if (widget) {
        try { widget.remove?.(); } catch (err) {
          console.warn('[TradingView] widget.remove() threw during cleanup:', err);
        }
      }

      const container = document.getElementById(containerId);
      if (container) container.innerHTML = '';
    };
  }, [containerId, symbol, entryPrice, stopLoss, takeProfit, exitPrice, submittedAt, closedAt]);

  if (initError) {
    return (
      <div className="rounded-xl border border-tg-border flex items-center justify-center py-10"
        style={{ background: 'var(--color-tg-surface)' }}>
        <p className="text-sm text-tg-text-2">לא ניתן לאתחל את הגרף</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-tg-border" style={{ background: '#0f0f10' }}>
      <div id={containerId} style={{ height: 400 }} />
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

// ── Public export (wrapped in error boundary) ─────────────────────────────────

export default function TradingViewChart(props: Props) {
  // Changing the key forces a full remount of both the boundary and the inner
  // chart, resetting all state after the user clicks "נסה שוב".
  const [resetKey, setResetKey] = useState(0);

  return (
    <ChartErrorBoundary key={resetKey} onReset={() => setResetKey((k) => k + 1)}>
      <TradingViewChartInner {...props} />
    </ChartErrorBoundary>
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
