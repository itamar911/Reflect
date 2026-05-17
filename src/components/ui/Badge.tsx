import { cn } from '@/lib/utils';

interface BadgeProps {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'primary' | 'gold';
  children: React.ReactNode;
  className?: string;
}

export default function Badge({ variant = 'default', children, className }: BadgeProps) {
  const variants = {
    default: 'bg-tg-surface-2 text-tg-text-2 border-tg-border',
    success: 'bg-tg-success-muted text-tg-success border-tg-success/20',
    warning: 'bg-tg-warning-muted text-tg-warning border-tg-warning/20',
    danger: 'bg-tg-danger-muted text-tg-danger border-tg-danger/20',
    primary: 'bg-tg-primary-muted text-tg-primary border-tg-primary/20',
    gold: 'bg-tg-primary text-black border-transparent font-semibold',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
