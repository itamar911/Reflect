export default function Loading() {
  return (
    <div dir="rtl" className="px-4 py-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
          <div className="h-6 w-32 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        </div>
        <div className="h-9 w-24 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-36 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
    </div>
  );
}
