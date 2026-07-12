import { AuthShowcase } from '@/components/auth/AuthShowcase';
import '@/components/auth/auth.css';

// One unified rounded container centered on the page: the form surface and
// the illustrated showcase are two flush halves of the same box — all corners
// belong to the outer container, page background shows around it on all sides.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 py-6 lg:px-10 lg:py-8"
      style={{ background: 'var(--color-tg-bg)' }}
    >
      <div
        className="w-full max-w-[440px] lg:max-w-[1150px] rounded-[28px] overflow-hidden border border-tg-border lg:grid lg:grid-cols-2 lg:h-[min(820px,calc(100dvh-4rem))]"
        style={{
          background: 'var(--color-tg-surface)',
          boxShadow: '0 30px 80px rgba(0, 0, 0, 0.28), 0 8px 24px rgba(0, 0, 0, 0.14)',
        }}
      >
        {/* Form half — first child ⇒ inline-start column, visually right in RTL */}
        <div className="flex items-center justify-center px-6 py-10 sm:px-10 lg:overflow-y-auto">
          {children}
        </div>

        {/* Illustrated showcase half — flush against the form, lg+ only */}
        <aside className="hidden lg:block min-h-0" aria-hidden="true">
          <AuthShowcase />
        </aside>
      </div>
    </div>
  );
}
