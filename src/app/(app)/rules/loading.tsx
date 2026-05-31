export default function Loading() {
  return (
    <div className="px-4 py-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
        <div className="h-6 w-36 rounded-xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      </div>
      {/* Stats strip */}
      <div className="h-16 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* Info banner */}
      <div className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* Editor */}
      <div className="h-96 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
      {/* History */}
      <div className="h-40 rounded-2xl animate-pulse" style={{ background: 'var(--color-tg-surface)' }} />
    </div>
  );
}
