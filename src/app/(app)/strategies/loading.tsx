export default function Loading() {
  return (
    <div dir="rtl" className="px-4 py-5 flex flex-col gap-4">
      <div className="h-7 w-48 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {[1, 2, 3].map(i => (
        <div key={i} className="rounded-2xl p-4 flex flex-col gap-3 animate-pulse"
          style={{ background: 'var(--color-tg-surface)', border: '1px solid var(--color-tg-border)' }}>
          <div className="flex justify-between">
            <div className="h-5 w-40 rounded-lg" style={{ background: 'var(--color-tg-surface-2)' }} />
            <div className="h-5 w-16 rounded-lg" style={{ background: 'var(--color-tg-surface-2)' }} />
          </div>
          <div className="h-3 w-full rounded" style={{ background: 'var(--color-tg-surface-2)' }} />
          <div className="grid grid-cols-4 gap-2">
            {[1,2,3,4].map(j => (
              <div key={j} className="h-12 rounded-xl" style={{ background: 'var(--color-tg-surface-2)' }} />
            ))}
          </div>
          <div className="h-9 rounded-xl" style={{ background: 'var(--color-tg-surface-2)' }} />
        </div>
      ))}
    </div>
  );
}
