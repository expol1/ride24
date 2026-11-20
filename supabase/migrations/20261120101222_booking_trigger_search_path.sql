-- Booking insert triggers must not depend on the caller's search_path.
-- caravel_commit_pending_booking runs with search_path = '' and its INSERT into
-- public.bookings fired set_reservation_code(), which calls
-- generate_reservation_code() unqualified -> "function generate_reservation_code()
-- does not exist" (first Caravel booking attempts, 20 Nov 2026). Pinning the
-- path keeps behaviour identical for every other caller (they already use public).
ALTER FUNCTION public.set_reservation_code() SET search_path = public, pg_catalog;
ALTER FUNCTION public.generate_reservation_code() SET search_path = public, pg_catalog;
ALTER FUNCTION public.set_partner_deadline() SET search_path = public, pg_catalog;
