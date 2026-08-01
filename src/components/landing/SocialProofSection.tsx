import { ScrollReveal } from './ScrollReveal';
import { SectionHeading } from './SectionHeading';
import { TestimonialCard } from './TestimonialCard';
import { landingImages } from './landingImages';

/**
 * All four testimonials share one row — real clips first, pending placeholders
 * after — so the set reads as a single strip rather than a spotlight plus
 * filler. Order is DOM order; the RTL shell puts the first card on the right.
 *
 * Layout by width:
 *   < 768px   snap-scroll carousel, cards at min(78vw, 300px) — one card at a
 *             time, wide enough that the burned-in subtitles stay readable
 *   >= 768px  2 columns (cards capped at 360px so a 9:16 box can't run past
 *             ~640px tall)
 *   >= 1280px 4 columns — all four visible at once, ~285px cards at 1280 and
 *             ~325px once the 1360px container caps out, which is close to the
 *             old featured player's 360px
 *
 * The 4-up switch is at xl, not lg, deliberately: at 1024px four columns leave
 * only ~219px per card, which is too narrow to read the burned-in subtitles.
 */
export function SocialProofSection() {
  const videos = [...landingImages.videos].sort(
    (a, b) => Number(Boolean(b.videoUrl)) - Number(Boolean(a.videoUrl)),
  );

  return (
    <section className="section-alt cv-auto relative py-24 px-4 md:px-8 lg:px-10">
      <div className="section-glow" aria-hidden />
      <div className="max-w-[1360px] mx-auto relative">
        <SectionHeading>סוחרים אמיתיים. שינוי אמיתי.</SectionHeading>

        <ScrollReveal delay={120}>
          <div className="flex gap-5 overflow-x-auto pb-4 px-1 snap-x snap-mandatory scrollbar-none md:grid md:grid-cols-2 md:gap-8 md:overflow-x-visible md:pb-0 xl:grid-cols-4 xl:gap-5">
            {videos.map((video) => (
              <TestimonialCard key={video.id} video={video} />
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
