import type { PlaceholderVideo } from './landingImages';

/**
 * The one real testimonial creative on the landing page: a 9:16 (1080x1920),
 * ~92s talking-head clip with spoken audio. It is a watch-on-purpose clip, not
 * a decorative loop — hence native controls and no autoplay.
 *
 * The source file is ~32MB, so preload MUST stay at "metadata". Anything more
 * pulls the whole clip down for every visitor who never presses play.
 *
 * Sizing lives in .featured-video-frame (landing.css): a vertical clip at full
 * container width would be ~2000px tall on desktop, so the width is clamped by
 * both a fixed max and the viewport height. The aspect-[9/16] on the frame
 * reserves the box up front, so nothing shifts when metadata or the poster
 * lands.
 *
 * dir="ltr" on the <video> follows the same rule as the recharts containers:
 * a media scrubber runs left-to-right regardless of page direction, so the
 * native control bar should not be mirrored by the RTL shell. The caption
 * around it stays RTL.
 */
export function FeaturedVideo({ video }: { video: PlaceholderVideo }) {
  return (
    <figure className="featured-video-frame m-0 mx-auto flex flex-col gap-4">
      <div className="glass-card relative w-full aspect-[9/16] rounded-2xl overflow-hidden">
        <video
          dir="ltr"
          className="block w-full h-full object-cover bg-black"
          src={video.videoUrl}
          poster={video.poster}
          preload="metadata"
          controls
          playsInline
        />
      </div>

      <figcaption className="text-center px-1">
        <p className="text-base text-tg-text-2 leading-relaxed">&quot;{video.quote}&quot;</p>
        <p className="text-sm text-tg-muted mt-1">{video.name}</p>
      </figcaption>
    </figure>
  );
}
