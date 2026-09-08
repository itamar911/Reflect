'use client';

import { cn } from '@/lib/utils';
import { type ButtonHTMLAttributes, forwardRef } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'long' | 'short';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, fullWidth, children, disabled, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none active:scale-[0.97]';

    const variants = {
      primary: 'bg-tg-primary hover:bg-tg-primary-hover text-black',
      secondary: 'bg-tg-surface-2 hover:bg-tg-border text-tg-text border border-tg-border',
      ghost: 'hover:bg-tg-surface-2 text-tg-text-2 hover:text-tg-text',
      danger: 'bg-tg-danger hover:opacity-90 text-white',
      success: 'bg-tg-success hover:opacity-90 text-white',
      long: 'bg-tg-success hover:opacity-90 text-white',
      short: 'bg-tg-danger hover:opacity-90 text-white',
    };

    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-10 px-4 text-sm',
      lg: 'h-12 px-6 text-base',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(base, variants[variant], sizes[size], fullWidth && 'w-full', className)}
        {...props}
      >
        {/* Always mounted and toggled with a display:none class, rather than
            conditionally rendered. As a conditional child this <svg> was the
            node React inserted *before* {children} whenever `loading` flipped —
            and when {children} is a plain string, browser translation will have
            replaced that text node with a <font> wrapper, so the reference React
            recorded is no longer a child of the button and insertBefore throws,
            unmounting the page. Keeping the node mounted means React never
            inserts anything at this position.

            Wrapping {children} in a <span> would have fixed it too, but this is
            a shared button: callers pass an icon plus a label as separate
            children and rely on the `gap-2` between them, and a wrapper would
            collapse them into one flex item. A hidden sibling takes no space and
            adds no gap, so every caller lays out exactly as before. */}
        <svg
          aria-hidden="true"
          className={cn('h-4 w-4 shrink-0', loading ? 'animate-spin' : 'hidden')}
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
export default Button;
