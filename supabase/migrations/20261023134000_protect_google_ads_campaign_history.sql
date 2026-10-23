-- Never silently delete Google Ads campaigns when social or campaign-creative rows are removed.
-- The old ON DELETE CASCADE erased campaign history when marketing_queue was cleaned up.
ALTER TABLE public.google_ads_campaigns
  DROP CONSTRAINT google_ads_campaigns_marketing_queue_id_fkey;
ALTER TABLE public.google_ads_campaigns
  ADD CONSTRAINT google_ads_campaigns_marketing_queue_id_fkey
  FOREIGN KEY (marketing_queue_id) REFERENCES public.marketing_queue(id)
  ON DELETE RESTRICT;
