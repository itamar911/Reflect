export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        <div className="flex flex-col gap-2 flex-1">
          <div className="h-5 w-32 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
          <div className="h-3 w-2/3 rounded-lg animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-52 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        ))}
      </div>
    </div>
  );
}
