/**
 * Shared shell for the 6 feature mini-mocks: dark glass card, static
 * ambient box-shadow glow, and the same tilted-perspective treatment as
 * HeroMock (flattens on hover of the parent .card-hover feature card —
 * see .feature-mock-wrap / .feature-mock-card in landing.css). Fixed height
 * keeps every mock — and therefore every feature card in the grid row —
 * the same size regardless of content, so nothing shifts on load.
 *
 * .mock-ambient-glow is a slow-drifting radial blob sitting at z-index:-1
 * (behind normal-flow content, in front of the card background) that gives
 * any leftover empty space inside a mock a sense of depth instead of reading
 * as dead space.
 */
export function MockFrame({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="feature-mock-wrap w-full">
      <div
        className={`feature-mock-card relative w-full h-[300px] rounded-2xl border p-4 overflow-hidden flex flex-col ${className}`}
        style={{
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
