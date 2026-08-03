'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { WhatsAppIcon } from './WhatsAppIcon';
import { WHATSAPP_URL } from '@/lib/whatsapp';

const WHATSAPP_GREEN = '#25D366';

// Mounted globally (see layout.tsx) so it never lands inside the
// accessibility filter overlay's DOM subtree — it gates itself to the
// landing page instead of relying on where it's rendered from.
//
// Visibility tracks the hero (#hero, set in HeroSection) and footer via
// IntersectionObserver rather than a scrollY threshold, so it stays correct
// if either section's height changes, and fades out near the footer so the
// fixed button never sits on top of its links or legal text at short
// viewports.
export function FloatingWhatsApp() {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  const [pastHero, setPastHero] = useState(false);
  const [nearFooter, setNearFooter] = useState(false);

  useEffect(() => {
    if (!isLanding) return;
    const hero = document.getElementById('hero');
    const footer = document.querySelector('footer');
    if (!hero || !footer) return;

    const heroObserver = new IntersectionObserver(([entry]) => setPastHero(!entry.isIntersecting), {
      threshold: 0,
    });
    heroObserver.observe(hero);

    const footerObserver = new IntersectionObserver(([entry]) => setNearFooter(entry.isIntersecting), {
      threshold: 0,
      rootMargin: '0px 0px 100px 0px',
    });
    footerObserver.observe(footer);

    return () => {
      heroObserver.disconnect();
      footerObserver.disconnect();
    };
  }, [isLanding]);

  const visible = isLanding && pastHero && !nearFooter;

  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="פתחו שיחה בוואטסאפ"
      className={`fixed bottom-5 left-5 z-40 flex h-12 w-12 items-center justify-center rounded-full text-white transition-all duration-300 sm:bottom-6 sm:left-6 sm:h-14 sm:w-14 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
      style={{ backgroundColor: WHATSAPP_GREEN, boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)' }}
    >
      <WhatsAppIcon size={24} className="sm:hidden" />
      <WhatsAppIcon size={28} className="hidden sm:block" />
    </a>
  );
}
