-- NULL means the historic behavior: a class can be picked up/returned at
-- any active location of its own partner. An explicit nonempty array narrows both
-- pickup and dropoff. Scooters/ATV (group '0') must explicitly select locations.
BEGIN;
ALTER TABLE public.car_classes
  ADD COLUMN IF NOT EXISTS allowed_location_ids uuid[] DEFAULT NULL;

CREATE OR REPLACE FUNCTION public.ride24_validate_car_location_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $func$
DECLARE valid_count integer;
BEGIN
  IF NEW.active IS TRUE AND NEW.class_code = '0' AND NEW.allowed_location_ids IS NULL THEN
    RAISE EXCEPTION 'SCOOTER_LOCATION_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NEW.allowed_location_ids IS NOT NULL THEN
    IF cardinality(NEW.allowed_location_ids) NOT BETWEEN 1 AND 25
       OR array_position(NEW.allowed_location_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_CAR_LOCATION_SCOPE' USING ERRCODE='23514';
    END IF;
    SELECT count(DISTINCT l.id)
      INTO valid_count
      FROM public.partner_locations l
      WHERE l.id = ANY(NEW.allowed_location_ids)
        AND l.partner_id = NEW.partner_id
        AND l.active = true;
    IF valid_count IS DISTINCT FROM cardinality(NEW.allowed_location_ids) THEN
      RAISE EXCEPTION 'CAR_LOCATION_NOT_OWNED_OR_INACTIVE' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS ride24_car_location_scope_check ON public.car_classes;
CREATE TRIGGER ride24_car_location_scope_check
  BEFORE INSERT OR UPDATE OF allowed_location_ids, class_code, partner_id, active
  ON public.car_classes
  FOR EACH ROW
  EXECUTE FUNCTION public.ride24_validate_car_location_scope();

COMMENT ON COLUMN public.car_classes.allowed_location_ids IS
  'NULL = all partner active locations; nonempty UUID array = only these owned/active locations for pickup AND return; required for group 0.';
COMMIT;