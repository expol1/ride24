-- Allow admins to dismiss unpublished SEO proposals without losing their draft data.
-- Keeping the topic_key means future location syncs will not recreate dismissed duplicates.
ALTER TABLE public.seo_documents DROP CONSTRAINT seo_documents_state_check;
ALTER TABLE public.seo_documents ADD CONSTRAINT seo_documents_state_check
  CHECK (state IN ('queued','draft','published','changed','dismissed'));
