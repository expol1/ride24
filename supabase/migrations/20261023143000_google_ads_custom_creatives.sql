-- Independent, admin-managed Google Ads creatives for the existing Performance Max flow.
-- App install campaigns are a separate Google Ads channel, so their drafts are never fed to PMax.
CREATE TABLE IF NOT EXISTS public.google_ads_creatives (
  marketing_queue_id bigint PRIMARY KEY REFERENCES public.marketing_queue(id) ON DELETE CASCADE,
  objective text NOT NULL CHECK (objective IN ('rental','app_website','app_install')),
  headlines jsonb NOT NULL CHECK (jsonb_typeof(headlines)='array' AND jsonb_array_length(headlines) BETWEEN 3 AND 15),
  long_headline text NOT NULL CHECK (char_length(long_headline) BETWEEN 1 AND 90),
  descriptions jsonb NOT NULL CHECK (jsonb_typeof(descriptions)='array' AND jsonb_array_length(descriptions) BETWEEN 2 AND 5),
  final_url text NOT NULL CHECK (char_length(final_url) BETWEEN 10 AND 2000),
  landscape_url text,
  square_url text,
  app_store_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_ads_creatives_images_pair CHECK (
    (landscape_url IS NULL AND square_url IS NULL) OR
    (landscape_url IS NOT NULL AND square_url IS NOT NULL)
  )
);
ALTER TABLE public.google_ads_creatives ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_ads_creatives FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_ads_creatives TO authenticated;
GRANT ALL ON public.google_ads_creatives TO service_role;
DROP POLICY IF EXISTS google_ads_creatives_admin ON public.google_ads_creatives;
CREATE POLICY google_ads_creatives_admin ON public.google_ads_creatives
  FOR ALL TO authenticated
  USING ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Safeguard: no changes to approved creatives, even from normal admin UI.
CREATE OR REPLACE FUNCTION public.google_ads_creative_draft_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='public', 'pg_temp'
AS $$
DECLARE v_status text; v_platform text;
BEGIN
  SELECT status, platform INTO v_status, v_platform FROM public.marketing_queue
  WHERE id=coalesce(NEW.marketing_queue_id, OLD.marketing_queue_id);
  IF v_platform IS DISTINCT FROM 'google_ads' OR v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only draft Google Ads creatives may be inserted, modified or deleted';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS google_ads_creatives_draft_only ON public.google_ads_creatives;
CREATE TRIGGER google_ads_creatives_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON public.google_ads_creatives
FOR EACH ROW EXECUTE FUNCTION public.google_ads_creative_draft_only();
