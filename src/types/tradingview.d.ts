// Global TradingView widget types — single declaration for the whole project.

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

interface Window {
  TradingView?: {
    widget: new (config: Record<string, unknown>) => TvWidget;
  };
}
