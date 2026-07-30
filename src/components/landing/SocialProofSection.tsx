import { PlayCircle } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { FeaturedVideo } from './FeaturedVideo';
import { landingImages } from './landingImages';

export function SocialProofSection() {
  // Entries that have a real file get the full-size player; the rest stay in
  // the placeholder strip until their clip exists.
  const featured = landingImages.videos.filter((v) => v.videoUrl);
  const pending = landingImages.videos.filter((v) => !v.videoUrl);

  return (
    <section className="section-alt cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading>סוחרים אמיתיים. שינוי אמיתי.</SectionHeading>

        {featured.map((video) => (
          <ScrollReveal key={video.id} delay={120}>
            <div id={video.id} className="mb-16">
              <FeaturedVideo video={video} />
            </div>
          </ScrollReveal>
        ))}

        {pending.length > 0 && (
          <ScrollReveal delay={120}>
            <div className="flex gap-5 overflow-x-auto pb-4 px-1 snap-x snap-mandatory scrollbar-none">
              {pending.map((video) => (
                <div key={video.id} className="shrink-0 w-56 md:w-64 snap-center flex flex-col gap-3">
                  <div
                    id={video.id}
                    className="glass-card card-hover relative w-full aspect-[9/16] rounded-2xl overflow-hidden flex items-center justify-center"
                  >
                    <div
                      className="absolute inset-0"
                      style={{ background: 'radial-gradient(circle at 50% 30%, rgba(0,210,210,0.14), transparent 65%)' }}
                    />
                    <span
                      className="relative flex items-center justify-center w-16 h-16 rounded-full"
                      style={{ background: 'rgba(0,210,210,0.1)', border: '1px solid rgba(0,210,210,0.35)' }}
                    >
                      <PlayCircle size={40} style={{ color: '#00d2d2' }} />
                    </span>
                  </div>
                  <div className="px-1">
                    <p className="text-base text-tg-text-2 leading-relaxed">&quot;{video.quote}&quot;</p>
                    <p className="text-sm text-tg-muted mt-1">{video.name}</p>
                  </div>
                </div>
              ))}
            </div>
          </ScrollReveal>
        )}
      </div>
    </section>
  );
}
