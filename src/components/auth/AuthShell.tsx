import { Logo } from '@/components/ui/Logo';

interface AuthShellProps {
  tagline?: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

// Shared inner block for every (auth) page: centered logo header, the page's
// form content, and an optional footer link row — keeps login/signup/forgot/
// reset visually in lockstep. The surrounding surface (rounded container,
// border, shadow) is owned by the (auth) layout; this is just the content.
export function AuthShell({ tagline, subtitle, footer, children }: AuthShellProps) {
  return (
    <div className="w-full max-w-[400px] animate-fade-in">
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
  );
}
