export default function Loading() {
  return (
    <div className="px-4 py-5 flex flex-col gap-4 md:max-w-none">
      <div className="h-7 w-32 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      <div className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: 520 }} />
      <div className="rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)', height: 160 }} />
    </div>
  );
}
