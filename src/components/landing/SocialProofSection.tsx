import { PlayCircle } from 'lucide-react';
import { ScrollReveal } from './ScrollReveal';
import { landingImages } from './landingImages';

export function SocialProofSection() {
  return (
    <section className="relative py-20 px-4 md:px-6">
      <div className="max-w-[1100px] mx-auto">
        <ScrollReveal>
          <h2 className="text-2xl md:text-4xl font-bold text-white text-center mb-12">
            סוחרים אמיתיים. שינוי אמיתי.
          </h2>
        </ScrollReveal>

        <ScrollReveal delay={100}>
          <div className="flex gap-5 overflow-x-auto pb-4 px-1 snap-x snap-mandatory scrollbar-none">
            {landingImages.videos.map((video) => (
              <div key={video.id} className="shrink-0 w-56 md:w-64 snap-center flex flex-col gap-3">
                <div
                  id={video.id}
                  className="relative w-full aspect-[9/16] rounded-2xl border border-tg-border overflow-hidden flex items-center justify-center"
                  style={{ background: 'var(--color-tg-surface)' }}
                >
                  {video.videoUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={video.videoUrl} poster={video.poster} controls className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <div
                        className="absolute inset-0"
                        style={{ background: 'radial-gradient(circle at 50% 30%, rgba(0,210,210,0.14), transparent 65%)' }}
                      />
                      <PlayCircle size={44} className="relative" style={{ color: '#00d2d2' }} />
                    </>
                  )}
                </div>
                <div className="px-1">
                  <p className="text-sm text-tg-text-2 leading-relaxed">&quot;{video.quote}&quot;</p>
                  <p className="text-xs text-tg-muted mt-1">{video.name}</p>
                </div>
              </div>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
