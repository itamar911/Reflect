import Image from 'next/image';
import { Image as ImageIcon } from 'lucide-react';

interface ImagePlaceholderProps {
  id?: string;
  label: string;
  src?: string;
  width?: number;
  height?: number;
  objectPosition?: string;
  aspect?: string;
  fit?: 'cover' | 'contain';
  className?: string;
}

export function ImagePlaceholder({
  id,
  label,
  src,
  width,
  height,
  objectPosition,
  aspect = 'aspect-video',
  fit = 'cover',
  className = '',
}: ImagePlaceholderProps) {
  if (src && fit === 'contain' && width && height) {
    return (
      <div
        id={id}
        className={`relative w-full rounded-2xl border border-tg-border overflow-hidden ${className}`}
        style={{ boxShadow: '0 10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.04)' }}
      >
        <Image
          src={src}
          alt={label}
          width={width}
          height={height}
          sizes="(max-width: 768px) 100vw, 900px"
          className="block w-full h-auto"
        />
      </div>
    );
  }

  if (src) {
    return (
      <div
        id={id}
        className={`relative w-full ${aspect} rounded-2xl border border-tg-border overflow-hidden ${className}`}
        style={{ boxShadow: '0 10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.04)' }}
      >
        <Image
          src={src}
          alt={label}
          fill
          sizes="(max-width: 768px) 100vw, 50vw"
          className="object-cover"
          style={objectPosition ? { objectPosition } : undefined}
        />
      </div>
    );
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
