-- One-time authenticated bootstrap jobs; no endpoint accepts an unverified request.
CREATE TABLE IF NOT EXISTS public.ride24_avia_bootstrap_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','synced','failed')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ride24_avia_bootstrap_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ride24_avia_bootstrap_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.ride24_avia_bootstrap_jobs TO service_role;
COMMENT ON TABLE public.ride24_avia_bootstrap_jobs IS 'Short-lived, single-use authorization for AVIA read-only Renteon setup plus catalog sync. Never grants booking activation.';
