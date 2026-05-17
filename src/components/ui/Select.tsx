'use client';

import { cn } from '@/lib/utils';
import { type SelectHTMLAttributes, forwardRef } from 'react';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  options: { value: string; label: string }[];
  placeholder?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, hint, options, placeholder, id, ...props }, ref) => {
    const selectId = id ?? label?.toLowerCase().replace(/\s+/g, '-');

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={selectId} className="text-sm font-medium text-tg-text-2">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={cn(
            'w-full h-10 px-3 rounded-xl text-sm text-tg-text bg-tg-surface-2 border border-tg-border',
            'focus:outline-none focus:border-tg-primary focus:ring-1 focus:ring-tg-primary',
            'transition-colors duration-150 appearance-none cursor-pointer',
            error && 'border-tg-danger focus:border-tg-danger focus:ring-tg-danger',
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}
              style={{ background: 'var(--color-tg-surface-2)', color: 'var(--color-tg-text)' }}>
              {opt.label}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-tg-danger">{error}</p>}
        {hint && !error && <p className="text-xs text-tg-muted">{hint}</p>}
      </div>
    );
  }
);

Select.displayName = 'Select';
export default Select;
