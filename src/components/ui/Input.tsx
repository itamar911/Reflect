'use client';

import { cn } from '@/lib/utils';
import { type InputHTMLAttributes, forwardRef } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  suffix?: React.ReactNode;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, suffix, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-tg-text-2">
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={inputId}
            className={cn(
              'w-full h-10 px-3 rounded-xl text-sm text-tg-text bg-tg-surface-2 border border-tg-border',
              'placeholder:text-tg-muted',
              'focus:outline-none focus:border-tg-primary focus:ring-1 focus:ring-tg-primary',
              'transition-colors duration-150',
              error && 'border-tg-danger focus:border-tg-danger focus:ring-tg-danger',
              suffix && 'pr-16',
              className
            )}
            {...props}
          />
          {suffix && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-tg-muted">
              {suffix}
            </span>
          )}
        </div>
        {error && <p className="text-xs text-tg-danger">{error}</p>}
        {hint && !error && <p className="text-xs text-tg-muted">{hint}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
export default Input;
