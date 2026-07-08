'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn } from 'lucide-react';
import { ImagePlaceholder } from './ImagePlaceholder';
import { openLightbox, closeLightbox, subscribeLightbox, getLightboxSnapshot } from './lightboxStore';

interface LightboxImageProps {
  id?: string;
  label: string;
  src?: string;
  objectPosition?: string;
  aspect?: string;
  className?: string;
  topFade?: boolean;
}

export function LightboxImage({ id, label, src, objectPosition, aspect, className = '', topFade = false }: LightboxImageProps) {
  const { src: openSrc, label: openLabel } = useSyncExternalStore(subscribeLightbox, getLightboxSnapshot, getLightboxSnapshot);
  const isOpen = Boolean(src) && openSrc === src;

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  if (!src) {
    return <ImagePlaceholder id={id} label={label} aspect={aspect} className={className} />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => openLightbox(src, label)}
        className={`group relative block w-full cursor-zoom-in rounded-2xl text-right focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00d2d2] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0f14] ${className}`}
        aria-label={`הגדל תמונה: ${label}`}
      >
        <ImagePlaceholder id={id} label={label} src={src} objectPosition={objectPosition} aspect={aspect} />
        {topFade && (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-10 rounded-t-2xl"
            style={{ background: 'linear-gradient(to bottom, rgba(20,23,29,0.5), transparent)' }}
            aria-hidden
          />
        )}
        <div
          className="pointer-events-none absolute inset-0 rounded-2xl flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{ background: 'rgba(10,12,16,0.35)' }}
          aria-hidden
        >
          <span
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold text-white"
            style={{ background: 'rgba(10,12,16,0.7)', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            <ZoomIn size={14} />
            פתח תצוגה
          </span>
        </div>
      </button>

      {isOpen &&
        createPortal(
          <div
            className="lightbox-overlay fixed inset-0 z-[9999] flex items-center justify-center p-4 md:p-10"
            style={{ background: 'rgba(10,12,16,0.92)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
            onClick={() => closeLightbox()}
            role="dialog"
            aria-modal="true"
            aria-label={openLabel}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeLightbox();
              }}
              className="absolute top-4 right-4 md:top-6 md:right-6 flex items-center justify-center w-10 h-10 rounded-full text-white/80 transition-colors hover:text-white"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
              aria-label="סגור"
            >
              <X size={20} />
            </button>

            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={openSrc ?? src}
              alt={openLabel}
              onClick={(e) => e.stopPropagation()}
              className="lightbox-image max-h-[85vh] max-w-[90vw] w-auto h-auto rounded-xl object-contain"
            />
          </div>,
          document.body
        )}
    </>
  );
}
