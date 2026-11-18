-- AVIA: presentation names only, booking keys remain the unchanged location_name/external_id.
UPDATE public.partner_locations
SET display_name = CASE external_id
  WHEN 'HR-DUB-DBV' THEN 'Dubrovnik Airport (DBV)'
  WHEN 'HR-PUL-PUY' THEN 'Pula Airport (PUY)'
  WHEN 'HR-SPL-SPU' THEN 'Split Airport (SPU)'
  WHEN 'HR-ZAD-ZAD' THEN 'Zadar Airport (ZAD)'
  WHEN 'HR-ZAG-ZAG' THEN 'Zagreb Airport (ZAG)'
  ELSE display_name END
WHERE partner_id = '91e04805-31da-4242-9e6f-b6075019d784'
  AND country = 'Croatia'
  AND type = 'airport'
  AND external_id IN ('HR-DUB-DBV','HR-PUL-PUY','HR-SPL-SPU','HR-ZAD-ZAD','HR-ZAG-ZAG');
