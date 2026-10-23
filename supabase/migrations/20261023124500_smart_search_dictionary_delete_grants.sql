-- Preserve public dictionary reads but allow removal only by authenticated admins under RLS.
REVOKE DELETE ON TABLE public.locations_dictionary FROM anon;
GRANT DELETE ON TABLE public.locations_dictionary TO authenticated;
