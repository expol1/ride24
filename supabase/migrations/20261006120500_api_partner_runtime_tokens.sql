-- Runtime OAuth token cache for API providers such as Renteon.
-- partner_api_credentials already has service-role-only RLS; these values are never exposed to Partner Dashboard.

alter table public.partner_api_credentials
  add column if not exists runtime_access_token text,
  add column if not exists runtime_refresh_token text,
  add column if not exists runtime_token_expires_at timestamptz;

comment on column public.partner_api_credentials.runtime_access_token
  is 'Server-side provider OAuth access token cache. Never expose to browser clients.';
comment on column public.partner_api_credentials.runtime_refresh_token
  is 'Server-side provider OAuth refresh token cache. Never expose to browser clients.';
comment on column public.partner_api_credentials.runtime_token_expires_at
  is 'Expiration timestamp for the provider OAuth access token cache.';
