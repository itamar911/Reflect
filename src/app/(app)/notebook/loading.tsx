export default function Loading() {
  return (
    <>
      {/* Desktop skeleton */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: '236px 1fr 216px', height: '100dvh', direction: 'ltr' }}
      >
        {/* Left column */}
        <div style={{ borderLeft: '1px solid var(--color-tg-border)', background: 'var(--color-tg-surface)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="h-7 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          {[80, 64, 64, 80, 64].map((h, i) => (
            <div key={i} className="rounded-xl animate-pulse" style={{ height: h, background: 'var(--color-tg-surface-2)' }} />
          ))}
        </div>

        {/* Middle column */}
        <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12, borderLeft: '1px solid var(--color-tg-border)' }}>
          <div className="h-8 w-56 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
          <div className="flex-1 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        </div>

        {/* Right column */}
        <div style={{ background: 'var(--color-tg-surface)', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="h-3 w-12 rounded animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          {[1, 2, 3].map(i => (
            <div key={i} className="h-10 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          ))}
          <div className="h-3 w-16 rounded animate-pulse mt-4" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-7 w-16 rounded-full animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
            ))}
          </div>
        </div>
      </div>

      {/* Mobile skeleton */}
      <div className="md:hidden flex flex-col" style={{ height: '100dvh' }}>
        <div style={{ padding: 12, background: 'var(--color-tg-surface)', borderBottom: '1px solid var(--color-tg-border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="h-7 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
        </div>
        {[80, 64, 64, 80].map((h, i) => (
          <div key={i} className="animate-pulse mx-3 mt-2 rounded-xl" style={{ height: h, background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
    </>
  );
}
