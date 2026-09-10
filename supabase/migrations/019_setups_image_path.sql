-- 019 · REF-69 — store the object path alongside the public URL
--
-- Step 2 of three. This migration is additive and reversible on its own: it
-- adds a column and fills it. It changes no behaviour, breaks nothing if the
-- app is not yet deployed, and does NOT make the bucket private -- that is
-- 020, which must not run until the code reading image_path is live.
--
-- Rollout order, each step independently reversible:
--   019  add + backfill image_path            (no behaviour change)
--   ---  deploy the code that signs URLs      (works while bucket is public)
--   020  flip the bucket to private           (closes the public endpoint)
--
-- image_url is deliberately left in place and still written by the app. While
-- it survives, reverting is just "run 020's rollback and redeploy the previous
-- build" -- no data restore. It becomes vestigial once 020 lands and can be
-- dropped in a later cleanup, once there is no version left that reads it.

ALTER TABLE setups ADD COLUMN IF NOT EXISTS image_path TEXT;

-- Backfill by joining to the objects themselves rather than parsing the URL.
--
-- getPublicUrl() percent-encodes, and existing filenames contain spaces (e.g.
-- "1780383504500-WhatsApp Image 2026-06-02 at 09.57.26.jpeg"), so recovering
-- the key from the URL would mean URL-decoding in SQL -- awkward and easy to
-- get subtly wrong for non-ASCII. Every key instead begins
-- `${user_id}/${Date.now()}-`, which is pure ASCII and never encoded, and a
-- single user cannot produce two uploads in the same millisecond. So that
-- prefix identifies the object exactly, and the name is taken from
-- storage.objects verbatim -- guaranteeing image_path matches a real key
-- rather than a reconstruction of one.
UPDATE setups s
SET image_path = o.name
FROM storage.objects o
WHERE o.bucket_id = 'setup-images'
  AND s.image_path IS NULL
  AND s.image_url IS NOT NULL
  AND (storage.foldername(o.name))[1] = s.user_id::text
  AND s.image_url LIKE '%/setup-images/' || (storage.foldername(o.name))[1] || '/'
                       || split_part(storage.filename(o.name), '-', 1) || '-%';

-- Verify before moving on. Both queries must return zero rows.
--
-- 1. every setup with an image_url resolved to a path:
--      SELECT id, user_id, image_url FROM setups
--      WHERE image_url IS NOT NULL AND image_path IS NULL;
--
-- 2. every path points at an object that actually exists:
--      SELECT s.id, s.image_path FROM setups s
--      WHERE s.image_path IS NOT NULL
--        AND NOT EXISTS (
--          SELECT 1 FROM storage.objects o
--          WHERE o.bucket_id = 'setup-images' AND o.name = s.image_path
--        );
--
-- Rollback:
--   ALTER TABLE setups DROP COLUMN image_path;
