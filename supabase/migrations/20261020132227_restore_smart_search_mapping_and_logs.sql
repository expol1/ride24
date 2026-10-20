-- Add exact pickup-point translations without renaming any partner location.
SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE public.locations_dictionary
  DROP CONSTRAINT locations_dictionary_category_check;
ALTER TABLE public.locations_dictionary
  ADD CONSTRAINT locations_dictionary_category_check
  CHECK (category IN ('country', 'region', 'city', 'location'));

-- New/inactive partner points need translation too. Existing public and partner
-- policies remain untouched; this grants only the stored admin role more reads.
CREATE POLICY ride24_partner_locations_admin_dictionary_read
ON public.partner_locations FOR SELECT TO authenticated
USING ((SELECT public.is_admin()));

-- Visitors cannot directly create/read logs. The validated Edge Function is the
-- sole writer; the existing stored admin role controls the dashboard read.
ALTER TABLE public.search_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.search_logs FROM anon, authenticated;
GRANT SELECT ON TABLE public.search_logs TO authenticated;
GRANT SELECT, INSERT ON TABLE public.search_logs TO service_role;
CREATE POLICY ride24_search_logs_admin_read
ON public.search_logs FOR SELECT TO authenticated
USING ((SELECT public.is_admin()));

CREATE INDEX IF NOT EXISTS ride24_search_logs_created_at_idx
ON public.search_logs (created_at DESC);

-- Aggregate in the database, without the old client-side 5,000-row sampling.
-- Resolved spellings disappear from the queue; original logs remain intact.
CREATE OR REPLACE FUNCTION public.get_top_searches()
RETURNS TABLE(query text, count bigint)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
  SELECT lower(btrim(regexp_replace(s.query, '\s+', ' ', 'g'))) AS query,
         count(*) AS count
  FROM public.search_logs s
  WHERE (SELECT public.is_admin())
    AND s.created_at >= now() - interval '90 days'
    AND char_length(btrim(s.query)) BETWEEN 3 AND 80
    AND NOT EXISTS (
      SELECT 1 FROM public.locations_dictionary d
      WHERE lower(btrim(s.query)) IN (lower(btrim(d.name_en)), lower(btrim(d.name_pl)))
        OR EXISTS (
          SELECT 1 FROM unnest(string_to_array(coalesce(d.keywords, ''), ',')) AS k(term)
          WHERE lower(btrim(k.term)) = lower(btrim(s.query))
        )
    )
  GROUP BY 1
  ORDER BY count(*) DESC, query
  LIMIT 30;
$function$;
REVOKE ALL ON FUNCTION public.get_top_searches() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_top_searches() TO authenticated, service_role;
