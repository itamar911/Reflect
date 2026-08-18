import { PlayCircle } from 'lucide-react';
import type { PlaceholderVideo } from './landingImages';

/**
 * One testimonial in the social-proof row. Every card — real clip or pending
 * placeholder — renders the same 9:16 box and the same caption block, so the
 * row reads as one set rather than a spotlight plus filler.
 *
 * Real clips are 1080x1920 talking-head videos with spoken audio and burned-in
 * Hebrew subtitles. They are watch-on-purpose, not decorative loops — hence
 * native controls and no autoplay.
 *
 * The source file is ~33MB, so preload MUST stay at "metadata". Anything more
 * pulls the whole clip down for every visitor who never presses play.
 *
 * aspect-[9/16] reserves the box up front, so nothing shifts when the poster
 * or metadata lands. object-cover never crops here (the box and the source
 * share the ratio) — which is what keeps the burned-in subtitles intact.
 *
 * dir="ltr" on the <video> follows the same rule as the recharts containers:
 * a media scrubber runs left-to-right regardless of page direction, so the
 * native control bar should not be mirrored by the RTL shell. The caption
 * around it stays RTL.
 *
 * Pending cards have no video behind them, so they deliberately carry no
 * hover lift, no pointer cursor, and a dimmed icon over a "בקרוב" label —
 * nothing that invites a click that would do nothing.
 */
export function TestimonialCard({ video }: { video: PlaceholderVideo }) {
  const isPending = !video.videoUrl;

  return (
    <figure className="m-0 flex flex-col gap-3 shrink-0 w-[min(78vw,300px)] snap-center md:w-full md:max-w-[360px] md:mx-auto">
      <div
        id={video.id}
        className="glass-card relative w-full aspect-[9/16] rounded-2xl overflow-hidden flex items-center justify-center"
      >
        {isPending ? (
          <>
            <div
              className="absolute inset-0"
              style={{ background: 'radial-gradient(circle at 50% 30%, rgba(0,210,210,0.14), transparent 65%)' }}
            />
            <div className="relative flex flex-col items-center gap-3">
              <span
                className="flex items-center justify-center w-16 h-16 rounded-full"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.14)' }}
              >
                <PlayCircle aria-hidden="true" size={36} style={{ color: 'rgba(255,255,255,0.3)' }} />
              </span>
              <span className="text-sm text-tg-muted/45">בקרוב</span>
            </div>
          </>
        ) : (
          <video
            dir="ltr"
            className="block w-full h-full object-cover bg-black"
            src={video.videoUrl}
            poster={video.poster}
            preload="metadata"
            controls
            playsInline
          />
        )}
      </div>

      <figcaption className="px-1">
        <p className="text-lg font-semibold text-tg-text-2">&quot;{video.quote}&quot;</p>
        <p className="text-sm text-tg-muted/60 mt-1">{video.name}</p>
      </figcaption>
    </figure>
  );
}
