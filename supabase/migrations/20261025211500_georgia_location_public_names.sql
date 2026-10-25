-- Non-breaking Georgia normalization: canonical public labels live beside legacy
-- location_name. Do not rename or delete location_name: older Android clients use it.
ALTER TABLE public.partner_locations ADD COLUMN IF NOT EXISTS display_name text;
COMMENT ON COLUMN public.partner_locations.display_name IS
  'Public display label. The legacy location_name stays unchanged for Android/API matching.';

-- Keep every UUID, pickup/return surcharge, contact rule and active flag.
UPDATE public.partner_locations SET
  region = 'Tbilisi', city = 'Tbilisi',
  display_name = 'Tbilisi International Airport (TBS)'
WHERE id = 'bbf58b63-fa73-48f9-8142-43e5e6c9867d'::uuid
  AND partner_id = 'a375fb22-8ec3-410e-8798-ad0772ac4d8e'::uuid
  AND country = 'Georgia' AND type::text = 'airport';

UPDATE public.partner_locations SET
  region = 'Tbilisi', city = 'Tbilisi', display_name = 'Tbilisi City'
WHERE id = 'cfb97954-5f50-410a-a447-48fe148238b1'::uuid
  AND partner_id = 'a375fb22-8ec3-410e-8798-ad0772ac4d8e'::uuid
  AND country = 'Georgia' AND type::text = 'city';

UPDATE public.partner_locations SET
  region = 'Imereti', city = 'Kutaisi',
  display_name = 'Kutaisi International Airport (KUT)'
WHERE id = '8b3f055d-7a12-4d7d-9499-40d72d228885'::uuid
  AND partner_id = 'a375fb22-8ec3-410e-8798-ad0772ac4d8e'::uuid
  AND country = 'Georgia' AND type::text = 'airport';

UPDATE public.partner_locations SET
  region = 'Adjara', city = 'Batumi',
  display_name = 'Batumi International Airport (BUS)'
WHERE id = '93fb244e-6d21-4ce4-a858-b9ffe9fae88d'::uuid
  AND partner_id = 'a375fb22-8ec3-410e-8798-ad0772ac4d8e'::uuid
  AND country = 'Georgia' AND type::text = 'airport';

-- Add only missing dictionary entries. Do not overwrite translator-edited rows.
INSERT INTO public.locations_dictionary (category, name_en, name_pl, keywords, slug, parent_country_en, parent_region_en) VALUES
('country','Georgia','Gruzja','gruzja, georgia, sakartvelo','georgia',NULL,NULL),
('city','Tbilisi','Tbilisi','Tiflis, stolica Gruzji','georgia-tbilisi','Georgia','Tbilisi'),
('city','Kutaisi','Kutaisi','Kutaisi, Imereti','georgia-kutaisi','Georgia','Imereti'),
('city','Batumi','Batumi','Batumi, Adjara','georgia-batumi','Georgia','Adjara'),
('location','Tbilisi International Airport (TBS)','Lotnisko Tbilisi (TBS)','TBS, Tbilisi, lotnisko Tbilisi','georgia-tbs','Georgia','Tbilisi'),
('location','Tbilisi City','Tbilisi — centrum','Tbilisi, Tiflis, centrum','georgia-tbilisi-city','Georgia','Tbilisi'),
('location','Kutaisi International Airport (KUT)','Lotnisko Kutaisi (KUT)','KUT, Kutaisi, lotnisko Kutaisi','georgia-kut','Georgia','Imereti'),
('location','Batumi International Airport (BUS)','Lotnisko Batumi (BUS)','BUS, Batumi, lotnisko Batumi','georgia-bus','Georgia','Adjara')
ON CONFLICT (slug) DO NOTHING;
