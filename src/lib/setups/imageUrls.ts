import type { SupabaseClient } from '@supabase/supabase-js';

export const SETUP_IMAGE_BUCKET = 'setup-images';

/**
 * How long a rendered image URL stays valid.
 *
 * One hour. The page mints these during the server render, so the clock starts
 * when the page is built, not when the image is first shown -- a tab left open
 * past the hour holds URLs the storage API will refuse. Already-decoded images
 * stay on screen (the browser is not re-fetching them); the failure only
 * surfaces if something asks for the bytes again. SetupImage handles that by
 * refreshing the route once, which re-runs this signing and yields fresh URLs.
 */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

export interface SetupImageRow {
  id: string;
  image_path: string | null;
  image_url: string | null;
}

/**
 * A stored path is usable only if it sits directly under this user's prefix.
 *
 * The RLS policy would refuse anything else anyway, so this is not the
 * security boundary -- it is a cheap way to keep a malformed or hand-edited
 * row from turning into a pointless signing round-trip, and to get a log line
 * naming the row instead of a silently blank image.
 */
export function isOwnedPath(path: string | null, userId: string): path is string {
  return typeof path === 'string'
    && path.startsWith(`${userId}/`)
    && path.length > userId.length + 1
    && !path.includes('..');
}

/**
 * Replace each row's `image_url` with a freshly signed URL for its
 * `image_path`.
 *
 * Defined behaviour for every way a path can be unusable -- all of them yield
 * `image_url: null`, which the UI already renders as "no image", so a bad row
 * degrades to a setup without a picture rather than a broken page:
 *
 *   image_path null          row predates 019, or has no image. Silent.
 *   path outside the prefix  malformed or tampered. Logged, skipped.
 *   signing call fails       storage unreachable. Logged, all rows skipped.
 *   per-path signing error   object deleted from under the row. Logged.
 *
 * Signs in one batched call rather than per row.
 */
export async function signSetupImages<T extends SetupImageRow>(
  supabase: SupabaseClient,
  rows: T[],
  userId: string,
): Promise<T[]> {
  const paths: string[] = [];
  for (const row of rows) {
    if (row.image_path === null) continue;
    if (!isOwnedPath(row.image_path, userId)) {
      console.warn('[setup-images] ignoring path outside the owner prefix', {
        setup: row.id, path: row.image_path,
      });
      continue;
    }
    if (!paths.includes(row.image_path)) paths.push(row.image_path);
  }

  const signed = new Map<string, string>();
  if (paths.length > 0) {
    const { data, error } = await supabase.storage
      .from(SETUP_IMAGE_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

    if (error) {
      console.error('[setup-images] batch signing failed', error);
    } else {
      for (const entry of data ?? []) {
        if (entry.error !== null) {
          console.warn('[setup-images] could not sign', { path: entry.path, error: entry.error });
          continue;
        }
        if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    image_url: row.image_path ? signed.get(row.image_path) ?? null : null,
  }));
}
