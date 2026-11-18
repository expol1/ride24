-- Fill AVIA gearbox from standard ACRISS/SIPP position 3; no guessed fuel.
-- Partner's price remains dynamic; API classes keep catalog placeholder 0 EUR.
UPDATE public.car_classes
SET transmission = CASE substring(upper(external_id) from 3 for 1)
  WHEN 'A' THEN 'automatic'
  WHEN 'B' THEN 'automatic'
  WHEN 'D' THEN 'automatic'
  WHEN 'M' THEN 'manual'
  WHEN 'N' THEN 'manual'
  WHEN 'C' THEN 'manual'
  ELSE transmission
END
WHERE partner_id = '91e04805-31da-4242-9e6f-b6075019d784'
  AND is_api_managed IS TRUE
  AND length(external_id) = 4
  AND substring(upper(external_id) from 3 for 1) IN ('A','B','D','M','N','C');
