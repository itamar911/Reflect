-- 018 · REF-72 — setup-images: scope the SELECT policy
--
-- The bucket carried three policies. Two were already correct:
--
--   setup_images_insert  INSERT  {authenticated}
--     with_check: bucket_id = 'setup-images'
--                 AND (storage.foldername(name))[1] = auth.uid()::text
--   setup_images_delete  DELETE  {authenticated}
--     qual:       same prefix pin
--
-- The third was not:
--
--   setup_images_select  SELECT  {public}
--     qual:       bucket_id = 'setup-images'
--
-- Role `public` includes `anon`, and there is no prefix condition, so any
-- caller holding the anon key -- which ships in the browser bundle, so
-- everyone -- could list every object in the bucket. Confirmed live, not
-- inferred: POST /storage/v1/object/list/setup-images with the anon key
-- returned HTTP 200 and both user folders. Paths are
-- `${userId}/${Date.now()}-${filename}`, so the listing leaked user ids,
-- upload times and original filenames, and (the bucket being public) each
-- path was a working URL to the image itself.
--
-- This migration brings SELECT in line with the other two: same role, same
-- prefix pin. It deliberately does NOT drop the policy outright. Storage
-- resolves an object before deleting it, so DELETE requires SELECT as well --
-- dropping it would break setup_images_delete, and with it the object cleanup
-- that lands in the following step.
--
-- Scope: this closes enumeration only. The bucket is still marked public, so
-- GET /storage/v1/object/public/setup-images/<path> continues to serve any
-- known path to anyone, with no credential. That is REF-69 and the next
-- migration; do not read this one as closing the exposure on its own.
--
-- Verify after running (scripts/probe-bucket.mjs):
--   A1  anon list  -> 200 with ZERO entries (RLS filters the rows; some
--                     storage-api versions 400 instead -- either is a pass,
--                     the criterion is that no paths come back)
--   A2  no apikey  -> 400, unchanged
--   A4  public GET -> 200, UNCHANGED AND EXPECTED. Step 2 closes this.
--
-- Rollback, should image display or upload regress unexpectedly:
--   DROP POLICY IF EXISTS setup_images_select ON storage.objects;
--   CREATE POLICY setup_images_select ON storage.objects FOR SELECT
--     USING (bucket_id = 'setup-images');

DROP POLICY IF EXISTS setup_images_select ON storage.objects;

CREATE POLICY setup_images_select
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'setup-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
