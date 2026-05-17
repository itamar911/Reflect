import { cn } from '@/lib/utils';

interface CardProps {
  className?: string;
  children: React.ReactNode;
  padding?: 'sm' | 'md' | 'lg' | 'none';
  gold?: boolean;
}

export default function Card({ className, children, padding = 'md', gold = false }: CardProps) {
  const paddings = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' };

  return (
    <div
      className={cn(
        'rounded-2xl border',
        paddings[padding],
        gold ? 'border-tg-primary/30 bg-tg-primary-muted' : 'border-tg-border bg-tg-surface',
        className
      )}
    >
      {children}
    </div>
  );
}
