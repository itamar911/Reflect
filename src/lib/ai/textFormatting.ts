// Shared text-cleanup primitives for rendering AI-generated Hebrew text.
//
// Two categories of surface exist in this app:
//  - "structural" surfaces (ai-chart, weekly-summary) that intentionally ask
//    the model for #/** as a wire format, parsed into headings/cards. These
//    use segmentByLineMarker() below to split on a heading marker that must
//    occupy its own line — never a whole-text regex split, which misfires the
//    moment the model adds an unrelated inline "**word**" inside a sentence.
//  - every other surface, which wants plain prose and nothing else. These use
//    renderPlainAiText(), a full sanitizer that strips markdown regardless of
//    whether the prompt already forbids it — prompt compliance alone isn't
//    reliable enough to trust as the only defense.

// Checkmark/cross-mark code points the AI might still produce despite being
// told not to.
export const CHECK_CHARS = '✅✔✓☑';
export const CROSS_CHARS = '✖✗✘❌❎';

const HEADING_LINE_RE = /^#{1,6}\s+/;
const BULLET_LINE_RE = /^[-*•]\s+/;
const NUMBERED_LINE_RE = /^\d+[.)]\s+/;
const RULE_LINE_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const CHECK_CROSS_LINE_PREFIX_RE = new RegExp(`^[${CHECK_CHARS}${CROSS_CHARS}]\\s*`, 'u');
const CHECK_CROSS_ANYWHERE_RE = new RegExp(`[${CHECK_CHARS}${CROSS_CHARS}]`, 'gu');
const EMOJI_ANYWHERE_RE = new RegExp('\\p{Extended_Pictographic}|\\uFE0F', 'gu');
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /\*([^*\n]+)\*/g;
const INLINE_HASHTAG_RE = /(^|\s)#(\S+)/g;

/**
 * Splits text into segments anchored on a heading-marker regex that must
 * match a whole trimmed line — never mid-sentence. This is the line-anchored
 * strategy weekly-summary's parser proved out for `#`/`##` headings;
 * ai-chart's `**heading**` section markers reuse the exact same function with
 * their own marker regex instead of a fragile whole-text split.
 *
 * `markerRe` must capture the heading label in group 1. Any text before the
 * first matching line is dropped, matching the existing weekly-summary
 * behavior of discarding the AI's intro/greeting.
 */
export function segmentByLineMarker(
  text: string,
  markerRe: RegExp,
): { heading: string; lines: string[] }[] {
  const segments: { heading: string; lines: string[] }[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const rawLine of text.split('\n')) {
    const match = rawLine.trim().match(markerRe);
    if (match) {
      current = { heading: (match[1] ?? '').trim(), lines: [] };
      segments.push(current);
      continue;
    }
    current?.lines.push(rawLine);
  }
  return segments;
}

/** Joins lines into a single blob, stripping list/quote/rule markers per line. */
export function joinLines(lines: string[]): string {
  return lines
    .map(l => l.trim())
    .filter(l => l && !RULE_LINE_RE.test(l))
    .map(l => l
      .replace(BULLET_LINE_RE, '')
      .replace(NUMBERED_LINE_RE, '')
      .replace(CHECK_CROSS_LINE_PREFIX_RE, ''))
    .join(' ');
}

/**
 * Full sanitizer for surfaces that must read as plain, continuous prose with
 * zero visible markup — regardless of what the model actually emitted.
 * Strips heading markers, bullet/numbered list markers, bold/italic
 * asterisks (keeping their text), inline hashtags, and stray emoji/check/
 * cross glyphs, line by line so structure never leaks mid-sentence.
 *
 * This is the shared defense wired into every raw AI render site in the app
 * except ai-chart and weekly-summary, which intentionally keep markdown as a
 * structural wire format for their card-based renderers.
 */
export function renderPlainAiText(raw: string | null | undefined): string {
  if (!raw) return '';

  const lines = raw.split('\n').map(line => {
    const trimmed = line.trim();
    if (RULE_LINE_RE.test(trimmed)) return '';
    return trimmed
      .replace(HEADING_LINE_RE, '')
      .replace(BULLET_LINE_RE, '')
      .replace(NUMBERED_LINE_RE, '')
      .replace(CHECK_CROSS_LINE_PREFIX_RE, '');
  });

  const text = lines
    .join('\n')
    .replace(BOLD_RE, '$1')
    .replace(ITALIC_RE, '$1')
    .replace(INLINE_HASHTAG_RE, '$1$2')
    .replace(CHECK_CROSS_ANYWHERE_RE, '')
    .replace(EMOJI_ANYWHERE_RE, '');

  return text
    .split('\n')
    .map(l => l.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
