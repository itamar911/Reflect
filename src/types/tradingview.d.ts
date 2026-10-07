// Global TradingView widget types — single declaration for the whole project.
//
// Hand-written, and therefore an assertion rather than a verified contract:
// nothing checks it against what s3.tradingview.com/tv.js actually ships. It
// previously also declared onChartReady()/chart()/createShape() — methods of
// TradingView's licensed Charting Library, which the free embed widget does not
// have — and because the declaration said they existed, tsc and the build
// stayed green while every call threw at runtime. Only add a method here after
// confirming the embed widget really exposes it.

interface TvWidget {
  remove(): void;
}

interface Window {
  TradingView?: {
    widget: new (config: Record<string, unknown>) => TvWidget;
  };
}
