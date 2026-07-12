import { Logo } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';

interface AuthShellProps {
  tagline?: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

// Shared frame for every (auth) page: centered logo header, the page's
// card(s), and an optional footer link row — keeps login/signup/forgot/reset
// visually in lockstep.
export function AuthShell({ tagline, subtitle, footer, children }: AuthShellProps) {
  return (
    <div className="w-full max-w-sm animate-fade-in">
      <div className="text-center mb-8">
        <div className="flex justify-center mb-3">
          <Logo />
        </div>
        {tagline && <p className="text-xs text-tg-muted mt-0.5 mb-1">{tagline}</p>}
        {subtitle && <p className="text-sm text-tg-text-2 mt-1">{subtitle}</p>}
      </div>
      {children}
      {footer && <p className="text-center text-sm text-tg-text-2 mt-4">{footer}</p>}
    </div>
  );
}

export function AuthCard({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn('rounded-2xl border border-tg-border p-6', className)}
      style={{ background: 'var(--color-tg-surface)' }}
    >
      {children}
    </div>
  );
}
