import Image from 'next/image';
import { Logo } from '@/components/ui/Logo';

// Small isometric cube — decorative scene prop.
function Cube({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 30 34.5" fill="none" aria-hidden>
      <polygon points="15,0 30,8.6 15,17.2 0,8.6" fill="#19c2c2" />
      <polygon points="0,8.6 15,17.2 15,34.5 0,25.9" fill="#0b7c86" />
      <polygon points="30,8.6 15,17.2 15,34.5 30,25.9" fill="#075e68" />
    </svg>
  );
}

// Decorative product-showcase panel for the (auth) split layout. Purely
// visual (aria-hidden by the layout) and dark by design in both app themes —
// all styling lives in auth.css. The phone screenshot is the curated
// /demo/phone-showcase composition (see src/app/phone-showcase/page.tsx).
export function AuthShowcase() {
  return (
    <div className="auth-showcase">
      <div className="auth-orb auth-orb-1" />
      <div className="auth-orb auth-orb-2" />
      <div className="auth-grid" />

      <div className="relative h-full flex flex-col items-center px-10 pt-11 pb-8">
        <span className="auth-showcase-logo inline-block mb-4" style={{ transform: 'scale(1.15)', transformOrigin: 'center' }}>
          <Logo />
        </span>
        <p className="auth-showcase-tagline text-center">היומן שהופך כל עסקה לשיעור</p>
        <p className="auth-showcase-sub text-center mt-2">
          משמעת, סטטיסטיקות ותובנות AI — במקום אחד
        </p>

        <div className="auth-scene">
          <div className="auth-scene-circle" />

          <span className="auth-shape auth-sphere auth-sphere-1" />
          <span className="auth-shape auth-sphere auth-sphere-2" />
          <span className="auth-shape auth-ring" />
          <span className="auth-shape auth-cube"><Cube /></span>

          <div className="auth-scene-stack">
            <div className="auth-phone">
              <span className="auth-phone-btn auth-phone-btn-action" />
              <span className="auth-phone-btn auth-phone-btn-volup" />
              <span className="auth-phone-btn auth-phone-btn-voldn" />
              <span className="auth-phone-btn auth-phone-btn-power" />
              <div className="auth-phone-body">
                <div className="auth-phone-screen">
                  <div className="auth-phone-island" />
                  <Image
                    src="/auth/phone-demo.png"
                    alt=""
                    width={780}
                    height={1688}
                    priority
                    // The optimizer caches by URL and served us a stale copy after
                    // the capture was regenerated; the mockup renders ~200px wide,
                    // so optimization buys little — serve the file as-is.
                    unoptimized
                    className="auth-phone-shot"
                  />
                </div>
              </div>
            </div>
            <div className="auth-podium">
              <div className="auth-podium-ground" />
              <div className="auth-podium-side" />
              <div className="auth-podium-deck" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
