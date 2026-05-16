import { cn } from '@/lib/utils';

interface CardProps {
  className?: string;
  children: React.ReactNode;
  padding?: 'sm' | 'md' | 'lg' | 'none';
}

export default function Card({ className, children, padding = 'md' }: CardProps) {
  const paddings = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' };

  return (
    <div
      className={cn(
        'rounded-2xl border border-tg-border bg-tg-surface',
        paddings[padding],
        className
      )}
    >
      {children}
    </div>
  );
}
