export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-2xl mx-auto">
      <div className="h-8 w-48 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="grid grid-cols-3 gap-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      {[140, 100, 200].map((h, i) => (
        <div key={i} className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: h }} />
      ))}
    </div>
  );
}
