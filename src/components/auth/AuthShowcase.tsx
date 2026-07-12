import Image from 'next/image';
import { Logo } from '@/components/ui/Logo';

// Decorative product-showcase panel for the (auth) split layout. Purely
// visual (aria-hidden by the layout) and dark by design in both app themes —
// all styling lives in auth.css.
export function AuthShowcase() {
  return (
    <div className="auth-showcase">
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-orb auth-orb-3" />
      <div className="auth-grid" />

      <div className="relative h-full flex flex-col items-center px-10 pt-12">
        <span className="inline-block mb-5" style={{ transform: 'scale(1.3)', transformOrigin: 'center' }}>
          <Logo />
        </span>
        <p className="auth-showcase-tagline text-center">היומן שהופך כל עסקה לשיעור</p>
        <p className="auth-showcase-sub text-center mt-2 mb-9">
          משמעת, סטטיסטיקות ותובנות AI — במקום אחד
        </p>

        <div className="auth-phone-stage w-full">
          <div className="auth-phone-wrap">
            <div className="auth-phone-glow" />
            <div className="auth-phone">
              <div className="auth-phone-screen">
                <div className="auth-phone-island" />
                <div className="auth-phone-appbar">
                  <span>
                    <Logo />
                  </span>
                </div>
                <Image
                  src="/auth/phone-demo.png"
                  alt=""
                  width={780}
                  height={1688}
                  priority
                  className="auth-phone-shot"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
