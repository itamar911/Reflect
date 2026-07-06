import { Image as ImageIcon } from 'lucide-react';

interface ImagePlaceholderProps {
  id?: string;
  label: string;
  src?: string;
  aspect?: string;
  className?: string;
}

export function ImagePlaceholder({ id, label, src, aspect = 'aspect-video', className = '' }: ImagePlaceholderProps) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img id={id} src={src} alt={label} className={`w-full ${aspect} object-cover rounded-2xl ${className}`} />;
  }

  return (
    <div
      id={id}
      className={`relative w-full ${aspect} rounded-2xl border border-tg-border flex flex-col items-center justify-center gap-3 overflow-hidden ${className}`}
      style={{ background: 'var(--color-tg-surface)' }}
    >
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(circle at 30% 20%, rgba(0,210,210,0.14), transparent 60%)' }}
      />
      <ImageIcon className="relative shrink-0" size={32} style={{ color: '#00d2d2' }} />
      <span className="relative text-sm text-tg-muted text-center px-6">{label}</span>
    </div>
  );
}
