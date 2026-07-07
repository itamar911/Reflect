'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ImagePlaceholder } from './ImagePlaceholder';

interface LightboxImageProps {
  id?: string;
  label: string;
  src?: string;
  objectPosition?: string;
  aspect?: string;
  className?: string;
}

export function LightboxImage({ id, label, src, objectPosition, aspect, className = '' }: LightboxImageProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!src) {
    return <ImagePlaceholder id={id} label={label} aspect={aspect} className={className} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`block w-full cursor-zoom-in rounded-2xl text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00d2d2] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f14] ${className}`}
        aria-label={`הגדל תמונה: ${label}`}
      >
        <ImagePlaceholder id={id} label={label} src={src} objectPosition={objectPosition} aspect={aspect} />
      </button>

      {open && (
        <div
          className="lightbox-overlay fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10"
          style={{ background: 'rgba(6,10,16,0.86)' }}
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute top-4 right-4 md:top-6 md:right-6 flex items-center justify-center w-10 h-10 rounded-full text-white/80 transition-colors hover:text-white"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
            aria-label="סגור"
          >
            <X size={20} />
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={label}
            onClick={(e) => e.stopPropagation()}
            className="lightbox-image max-h-[88vh] max-w-[92vw] w-auto h-auto rounded-xl object-contain"
          />
        </div>
      )}
    </>
  );
}
