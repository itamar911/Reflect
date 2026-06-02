export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      <div className="h-7 w-40 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => (
          <div key={i} className="h-20 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      <div className="h-10 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="h-64 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
    </div>
  );
}
