-- Existing marketing-images policies remain unchanged for all other assets.
-- Only Google Ads custom uploads within the dedicated prefix require an admin.
DROP POLICY IF EXISTS marketing_google_ads_images_admin_only ON storage.objects;
CREATE POLICY marketing_google_ads_images_admin_only
ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  bucket_id <> 'marketing-images'
  OR name NOT LIKE 'google-ads/%'
  OR (SELECT public.is_admin())
);
