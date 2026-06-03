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
      className={cn('rounded-2xl border', paddings[padding], className)}
      style={gold ? {
        background: 'linear-gradient(135deg, rgba(0,210,210,0.09) 0%, rgba(13,17,23,0.95) 100%)',
        borderColor: 'rgba(0,210,210,0.22)',
        boxShadow: '0 0 24px rgba(0,210,210,0.09), inset 0 1px 0 rgba(0,210,210,0.13)',
      } : {
        background: 'linear-gradient(160deg, var(--color-tg-surface) 0%, var(--color-tg-surface-2) 100%)',
        borderColor: 'var(--color-tg-border)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.02), 0 4px 20px rgba(0,0,0,0.35)',
      }}
    >
      {children}
    </div>
  );
}
