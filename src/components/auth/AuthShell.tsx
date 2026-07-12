import { Logo } from '@/components/ui/Logo';

interface AuthShellProps {
  tagline?: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

// Shared frame for every (auth) page: one compact contained card — logo
// header, the page's form content, and an optional footer link row — keeps
// login/signup/forgot/reset visually in lockstep. The card is deliberately
// narrow (not a full-height column): it floats centered in its half of the
// split layout.
export function AuthShell({ tagline, subtitle, footer, children }: AuthShellProps) {
  return (
    <div className="w-full max-w-[440px] animate-fade-in">
      <div
        className="rounded-3xl border border-tg-border px-6 py-8 sm:px-8"
        style={{
          background: 'var(--color-tg-surface)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.18), 0 4px 14px rgba(0, 0, 0, 0.08)',
        }}
      >
        <div className="text-center mb-7">
          <div className="flex justify-center mb-3">
            <Logo />
          </div>
          {tagline && <p className="text-xs text-tg-muted mt-0.5 mb-1">{tagline}</p>}
          {subtitle && <p className="text-sm text-tg-text-2 mt-1">{subtitle}</p>}
        </div>

        {children}

        {footer && <p className="text-center text-sm text-tg-text-2 mt-6">{footer}</p>}
      </div>
    </div>
  );
}
