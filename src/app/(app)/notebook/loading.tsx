export default function Loading() {
  return (
    <>
      {/* Desktop skeleton */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: '200px 300px 1fr', height: '100dvh', direction: 'rtl' }}
      >
        {/* Sidebar */}
        <div style={{ background: 'var(--color-tg-surface)', padding: 12, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="h-7 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-8 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-7 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
            ))}
          </div>
        </div>

        {/* Page list */}
        <div style={{ borderRight: '1px solid var(--color-tg-border)', borderLeft: '1px solid var(--color-tg-border)', background: 'var(--color-tg-surface)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h-8 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          {[92, 78, 92, 78, 92].map((h, i) => (
            <div key={i} className="rounded-2xl animate-pulse" style={{ height: h, background: 'var(--color-tg-surface-2)' }} />
          ))}
        </div>

        {/* Editor */}
        <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="h-8 w-56 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
          <div className="h-6 w-72 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
          <div className="flex-1 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        </div>
      </div>

      {/* Mobile skeleton */}
      <div className="md:hidden flex flex-col" style={{ height: '100dvh' }}>
        <div style={{ padding: 12, background: 'var(--color-tg-surface)', borderBottom: '1px solid var(--color-tg-border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="h-7 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface-2)' }} />
        </div>
        {[80, 64, 64, 80].map((h, i) => (
          <div key={i} className="animate-pulse mx-3 mt-2 rounded-2xl" style={{ height: h, background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
    </>
  );
}
