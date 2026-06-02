const S  = 'var(--color-tg-surface)';
const S2 = 'var(--color-tg-surface-2)';

function Bone({ className = '', style = {} }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`animate-pulse rounded-2xl ${className}`} style={{ background: S, ...style }} />
  );
}

function CircleBone({ size = 72 }: { size?: number }) {
  return (
    <div className="animate-pulse rounded-full shrink-0" style={{ width: size, height: size, background: S2 }} />
  );
}

export default function Loading() {
  return (
    <div dir="rtl" className="min-h-screen px-4 py-5 flex flex-col gap-5">

      {/* Greeting */}
      <div className="flex flex-col gap-1.5">
        <Bone style={{ height: 12, width: 96 }} />
        <Bone style={{ height: 22, width: 180 }} />
      </div>

      {/* 4 stat cards */}
      <div className="grid grid-cols-2 gap-3">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="rounded-2xl p-4 flex flex-col gap-2"
            style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
            <Bone style={{ height: 10, width: 72, background: S2 }} />
            <div className="flex items-center gap-3">
              <CircleBone size={72} />
              <div className="flex flex-col gap-1.5 flex-1">
                <Bone style={{ height: 9, width: '70%', background: S2 }} />
                <Bone style={{ height: 9, width: '55%', background: S2 }} />
                <Bone style={{ height: 9, width: '45%', background: S2 }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 3 mid cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Radar */}
        <div className="rounded-2xl p-4" style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
          <Bone style={{ height: 10, width: 100, background: S2 }} />
          <div className="flex justify-center my-4">
            <div className="animate-pulse rounded-full" style={{ width: 240, height: 240, background: S2 }} />
          </div>
          <div className="grid grid-cols-3 gap-1">
            {[0,1,2,3,4,5].map(i => (
              <Bone key={i} style={{ height: 32, background: S2 }} />
            ))}
          </div>
        </div>

        {/* Bar chart */}
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
          <div className="flex items-center justify-between">
            <Bone style={{ height: 10, width: 60, background: S2 }} />
            <div className="flex gap-1">
              {[0,1,2].map(i => <Bone key={i} style={{ height: 20, width: 40, background: S2 }} />)}
            </div>
          </div>
          {/* Bar stubs */}
          <div className="flex items-end gap-1 h-[118px] pt-2">
            {Array.from({ length: 20 }, (_, i) => {
              const h = 20 + Math.sin(i * 0.9) * 40 + 40;
              const pos = (i % 3) !== 1;
              return (
                <div key={i} className="flex-1 animate-pulse rounded-sm"
                  style={{ height: `${Math.abs(h)}%`, background: pos ? 'rgba(74,222,128,0.15)' : 'rgba(248,113,113,0.15)' }} />
              );
            })}
          </div>
          <div className="flex gap-1">
            {[80,60,90,50,70].map((w,i) => (
              <Bone key={i} style={{ height: 7, width: `${w}%`, background: S2 }} />
            ))}
          </div>
        </div>

        {/* Line chart */}
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
          <div className="flex items-center justify-between">
            <Bone style={{ height: 10, width: 72, background: S2 }} />
            <div className="flex gap-1">
              {[0,1].map(i => <Bone key={i} style={{ height: 20, width: 48, background: S2 }} />)}
            </div>
          </div>
          {/* Wavy line stub */}
          <div className="rounded-xl overflow-hidden" style={{ height: 118, background: S2 }}>
            <svg width="100%" height="100%" viewBox="0 0 400 100" preserveAspectRatio="none">
              <path
                d="M0,60 C40,40 80,80 120,50 C160,20 200,70 240,45 C280,20 320,60 360,35 L400,40 L400,100 L0,100 Z"
                fill="rgba(74,222,128,0.07)"
              />
              <path
                d="M0,60 C40,40 80,80 120,50 C160,20 200,70 240,45 C280,20 320,60 360,35 L400,40"
                fill="none" stroke="rgba(74,222,128,0.2)" strokeWidth="2"
              />
            </svg>
          </div>
          <Bone style={{ height: 14, width: 56, background: S2 }} />
        </div>
      </div>

      {/* Bottom 2 cols */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* Calendar */}
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
          <Bone style={{ height: 10, width: 80, background: S2 }} />
          {/* Month nav */}
          <div className="flex items-center justify-between">
            <Bone style={{ height: 28, width: 28, background: S2, borderRadius: 8 }} />
            <Bone style={{ height: 12, width: 96, background: S2 }} />
            <Bone style={{ height: 28, width: 28, background: S2, borderRadius: 8 }} />
          </div>
          {/* Day headers */}
          <div className="grid gap-0.5" style={{ gridTemplateColumns: 'repeat(8,1fr)' }}>
            {Array.from({ length: 8 }, (_, i) => (
              <Bone key={i} style={{ height: 10, background: S2, borderRadius: 4 }} />
            ))}
          </div>
          {/* Week rows */}
          {[0,1,2,3,4].map(w => (
            <div key={w} className="grid gap-0.5" style={{ gridTemplateColumns: 'repeat(8,1fr)' }}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="animate-pulse rounded"
                  style={{ height: 30, background: i === 7 ? S2 : i % 4 === 0 ? 'rgba(74,222,128,0.08)' : i % 5 === 0 ? 'rgba(248,113,113,0.08)' : 'transparent' }} />
              ))}
            </div>
          ))}
          {/* Summary */}
          <div className="grid grid-cols-3 gap-2 mt-1">
            {[0,1,2].map(i => <Bone key={i} style={{ height: 40, background: S2 }} />)}
          </div>
        </div>

        {/* Recent trades */}
        <div className="rounded-2xl p-4 flex flex-col gap-0" style={{ background: S, border: '1px solid var(--color-tg-border)' }}>
          <Bone style={{ height: 10, width: 96, background: S2, marginBottom: 12 }} />
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-2 py-2.5"
              style={{ borderTop: i > 0 ? '1px solid var(--color-tg-border)' : undefined }}>
              <div className="flex-1 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Bone style={{ height: 13, width: 48 + (i % 3) * 16, background: S2 }} />
                  <Bone style={{ height: 13, width: 36, background: S2 }} />
                </div>
                <Bone style={{ height: 9, width: '70%', background: S2 }} />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Bone style={{ height: 14, width: 40, background: S2 }} />
                <Bone style={{ height: 26, width: 44, background: S2, borderRadius: 10 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
