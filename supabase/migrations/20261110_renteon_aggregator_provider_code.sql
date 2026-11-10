-- Provider code is case-sensitive: "demo" and "Avia" are distinct.
ALTER TABLE public.partner_api_credentials
ADD COLUMN IF NOT EXISTS renteon_provider_code text;
ALTER TABLE public.partner_api_credentials
DROP CONSTRAINT IF EXISTS partner_api_credentials_renteon_provider_code_check;
ALTER TABLE public.partner_api_credentials
ADD CONSTRAINT partner_api_credentials_renteon_provider_code_check
CHECK (renteon_provider_code IS NULL
       OR renteon_provider_code ~ '^[A-Za-z0-9_-]{2,40}$');