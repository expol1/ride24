-- Isolated PGlite fixture, never applied to the production project.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, role text);
INSERT INTO profiles VALUES ('00000000-0000-4000-8000-000000000001','admin'),
('00000000-0000-4000-8000-000000000002','client'),
('00000000-0000-4000-8000-000000000003','partner');
CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin') $$;
CREATE TABLE public.locations_dictionary(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),category text,
name_en text,name_pl text,keywords text,slug text UNIQUE,parent_country_en text,parent_region_en text,
CONSTRAINT locations_dictionary_category_check CHECK(category IN ('country','region','city')));
ALTER TABLE locations_dictionary ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON locations_dictionary TO anon, authenticated;
GRANT ALL ON locations_dictionary TO service_role;
CREATE POLICY dictionary_public_read ON locations_dictionary FOR SELECT TO anon, authenticated USING(true);
CREATE POLICY dictionary_admin_insert ON locations_dictionary FOR INSERT TO authenticated WITH CHECK((SELECT is_admin()));
CREATE POLICY dictionary_admin_update ON locations_dictionary FOR UPDATE TO authenticated USING((SELECT is_admin())) WITH CHECK((SELECT is_admin()));
CREATE TABLE public.partner_locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),active boolean);
INSERT INTO partner_locations(active) VALUES(true),(false);
ALTER TABLE partner_locations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON partner_locations TO anon,authenticated;
CREATE POLICY public_active_locations ON partner_locations FOR SELECT USING(active);
CREATE TABLE public.search_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),query text,created_at timestamptz DEFAULT now());
ALTER TABLE search_logs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON search_logs TO anon,authenticated,service_role;
CREATE FUNCTION public.get_top_searches() RETURNS TABLE(query text,count bigint) LANGUAGE sql AS $$
SELECT query,count(*) FROM search_logs GROUP BY query LIMIT 5 $$;
