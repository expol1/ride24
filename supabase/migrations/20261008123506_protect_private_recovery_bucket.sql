-- A new recovery bucket only; existing partner buckets and policies retain their behavior.
CREATE POLICY ride24_recovery_bucket_private_guard ON storage.objects
AS RESTRICTIVE FOR ALL TO anon, authenticated
USING (bucket_id <> 'ride24-recovery')
WITH CHECK (bucket_id <> 'ride24-recovery');

