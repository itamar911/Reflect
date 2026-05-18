export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-4 max-w-2xl mx-auto">
      <div className="h-7 w-40 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="h-11 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: 120 }} />
      ))}
    </div>
  );
}
