/**
 * Shared shell for the 6 feature mini-mocks: dark glass card, static
 * ambient box-shadow glow, and the same tilted-perspective treatment as
 * HeroMock (flattens on hover of the parent .card-hover feature card —
 * see .feature-mock-wrap / .feature-mock-card in landing.css). Height
 * defaults to 300px (five of the six mocks use the default, so their cards
 * stay the same size) but is overridable per mock.
 *
 * This is a min-height, not a height: at the accessibility widget's larger
 * text-scale steps, rem-based labels inside the mock grow past this figure,
 * and a hard height combined with overflow-hidden would clip them. Each
 * mock's own root wrapper uses flex-1 (not h-full) to fill it, since a
 * percentage height only resolves against a parent with a *definite*
 * height — min-height doesn't count — while flex-grow correctly fills a
 * flex container's resolved size either way.
 *
 * Font sizes inside the six mocks are deliberately px, not rem — do not
 * "fix" them in a later accessibility pass. These are illustrations of UI,
 * not reading copy, and their text sits inside this frame's fixed geometry.
 * Pinning it in px is precisely why they survived the 150% text-scale audit:
 * converting them to rem would grow the text inside a frame sized in px and
 * re-open the clipping that the min-height + flex-1 arrangement above closed.
 * The landing page's actual reading copy (section headings, body paragraphs,
 * FAQ questions, CTA labels) is rem, so it follows the browser's font-size
 * preference and the widget's text scale.
 *
 * .mock-ambient-glow is a slow-drifting radial blob sitting at z-index:-1
 * (behind normal-flow content, in front of the card background) that gives
 * any leftover empty space inside a mock a sense of depth instead of reading
 * as dead space.
 */
export function MockFrame({
  children,
  className = '',
  height = 300,
}: {
  children: React.ReactNode;
  className?: string;
  height?: number;
}) {
  return (
    <div className="feature-mock-wrap w-full">
      <div
        className={`feature-mock-card relative w-full rounded-2xl border p-4 overflow-hidden flex flex-col ${className}`}
        style={{
          minHeight: height,
          borderColor: 'rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.04)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.35), 0 0 26px rgba(0,210,210,0.08)',
        }}
      >
        <span className="mock-ambient-glow" aria-hidden />
        {children}
      </div>
    </div>
  );
}
