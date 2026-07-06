import { Poppins, Montserrat } from 'next/font/google';
import { SIDEBAR_TRANSITION } from '@/lib/motion';

const poppins = Poppins({ variable: '--font-logo-poppins', subsets: ['latin'], weight: '700', display: 'swap' });
const montserrat = Montserrat({ variable: '--font-logo-montserrat', subsets: ['latin'], weight: '600', display: 'swap' });

interface LogoProps {
  showWordmark?: boolean;
}

export function Logo({ showWordmark = true }: LogoProps) {
  return (
    <span
      className={`${poppins.variable} ${montserrat.variable} inline-flex items-center`}
      style={{ gap: 10 }}
    >
      <span className="inline-flex items-center" style={{ direction: 'ltr' }}>
        <span
          style={{
            fontFamily: 'var(--font-logo-poppins)',
            fontWeight: 700,
            fontSize: 38,
            lineHeight: 1,
            padding: 2,
            background: 'linear-gradient(135deg, #00c9c9, #0a4f6e)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          R
        </span>
        <span
          style={{
            width: 1,
            height: 32,
            margin: '0 2px',
            background: 'linear-gradient(to bottom, rgba(0,201,201,0), rgba(0,201,201,0.55), rgba(0,201,201,0))',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-logo-poppins)',
            fontWeight: 700,
            fontSize: 38,
            lineHeight: 1,
            padding: 2,
            transform: 'scaleX(-1)',
            color: '#15535f',
          }}
        >
          R
        </span>
      </span>
      <span
        aria-hidden={!showWordmark}
        style={{
          fontFamily: 'var(--font-logo-montserrat)',
          fontWeight: 600,
          fontSize: 18,
          color: 'var(--color-tg-text)',
          letterSpacing: 5,
          whiteSpace: 'nowrap',
          opacity: showWordmark ? 1 : 0,
          transform: showWordmark ? 'translateX(0)' : 'translateX(6px)',
          transition: `opacity ${SIDEBAR_TRANSITION}, transform ${SIDEBAR_TRANSITION}`,
          pointerEvents: showWordmark ? 'auto' : 'none',
        }}
      >
        REFLECT
      </span>
    </span>
  );
}
