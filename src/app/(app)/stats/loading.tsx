export default function Loading() {
  return (
    <div className="px-4 py-6 flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        <div className="h-6 w-32 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      </div>
      {/* 2×2 summary */}
      <div className="grid grid-cols-2 gap-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      {/* Avg row */}
      <div className="grid grid-cols-2 gap-3">
        {[1, 2].map(i => (
          <div key={i} className="h-14 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      {/* Chart */}
      <div className="h-44 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* Strategy */}
      <div className="h-48 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* DoW + Hour */}
      <div className="h-36 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="h-36 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* Streaks */}
      <div className="h-52 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
    </div>
  );
}
