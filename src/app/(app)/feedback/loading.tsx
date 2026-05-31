export default function Loading() {
  return (
    <div dir="rtl" className="px-4 py-6 flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        <div className="h-6 w-36 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
      <div className="h-96 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
    </div>
  );
}
