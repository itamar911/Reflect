'use client';

import { FaWhatsapp } from 'react-icons/fa';
import { useScrollY } from '@/lib/hooks';

const WHATSAPP_DIGITS = '972502255903';
const SHOW_AFTER_SCROLL_Y = 400;
const WHATSAPP_GREEN = '#25D366';

export function FloatingWhatsApp() {
  const scrollY = useScrollY();
  const visible = scrollY > SHOW_AFTER_SCROLL_Y;

  return (
    <a
      href={`https://wa.me/${WHATSAPP_DIGITS}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="פתחו שיחה בוואטסאפ"
      className={`fixed bottom-5 left-5 z-40 flex h-14 w-14 items-center justify-center rounded-full text-white transition-all duration-300 sm:bottom-6 sm:left-6 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
      style={{ backgroundColor: WHATSAPP_GREEN, boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)' }}
    >
      <FaWhatsapp size={28} aria-hidden />
    </a>
  );
}
