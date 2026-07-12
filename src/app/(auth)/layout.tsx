import { AuthShowcase } from '@/components/auth/AuthShowcase';
import '@/components/auth/auth.css';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-2" style={{ background: 'var(--color-tg-bg)' }}>
      {/* Form panel — first child ⇒ inline-start column, visually right in RTL */}
      <div className="min-h-screen flex items-center justify-center px-4 py-12">
        {children}
      </div>

      {/* Decorative showcase — inline-end column, visually left in RTL */}
      <aside className="hidden lg:block p-5" aria-hidden="true">
        <div className="sticky top-5 h-[calc(100dvh-2.5rem)]">
          <AuthShowcase />
        </div>
      </aside>
    </div>
  );
}
