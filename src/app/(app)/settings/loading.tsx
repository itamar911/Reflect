export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-5 md:max-w-none">
      <div className="h-7 w-28 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {[120, 280, 180, 200].map((h, i) => (
        <div key={i} className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: h }} />
      ))}
    </div>
  );
}
