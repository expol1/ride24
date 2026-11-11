-- AVIA d.o.o. partnership is scoped to Croatia. Preserve external
-- Renteon location records outside Croatia but do not list them as active
-- customer pickup points without validating that AVIA actually serves them.
UPDATE public.partner_locations
SET active = (country = 'Croatia')
WHERE partner_id = '91e04805-31da-4242-9e6f-b6075019d784'
  AND is_api_managed IS TRUE;
