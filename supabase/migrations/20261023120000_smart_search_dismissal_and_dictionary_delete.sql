-- Reversible Smart Search cleanup: hide unwanted mapping suggestions and search-log phrases.
-- Partner locations and original search logs are never deleted by this table.
CREATE TABLE public.smart_search_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('mapping','search')),
  entry_key text NOT NULL CHECK (length(entry_key) BETWEEN 1 AND 800),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, entry_key)
);
ALTER TABLE public.smart_search_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.smart_search_dismissals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.smart_search_dismissals TO authenticated;
GRANT ALL ON TABLE public.smart_search_dismissals TO service_role;
CREATE POLICY smart_search_admin_read
ON public.smart_search_dismissals FOR SELECT TO authenticated
USING ((SELECT public.is_admin()));
CREATE POLICY smart_search_admin_insert
ON public.smart_search_dismissals FOR INSERT TO authenticated
WITH CHECK ((SELECT public.is_admin()));
CREATE POLICY smart_search_admin_delete
ON public.smart_search_dismissals FOR DELETE TO authenticated
USING ((SELECT public.is_admin()));

-- Admin may delete a translation in the dictionary editor, but not partners' pickup locations.
CREATE POLICY ride24_locations_dictionary_admin_delete
ON public.locations_dictionary FOR DELETE TO authenticated
USING ((SELECT public.is_admin()));

-- Hide dismissed search phrases before ranking/limiting results (rather than filtering only top 30 in JS).
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
    AND NOT EXISTS (
      SELECT 1 FROM public.smart_search_dismissals hidden
      WHERE hidden.kind='search'
        AND hidden.entry_key=lower(btrim(regexp_replace(s.query, '\s+', ' ', 'g')))
    )
  GROUP BY 1
  ORDER BY count(*) DESC, query
  LIMIT 30;
$function$;
REVOKE ALL ON FUNCTION public.get_top_searches() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_top_searches() TO authenticated, service_role;
