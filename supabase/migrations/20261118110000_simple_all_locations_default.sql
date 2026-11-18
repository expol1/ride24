-- One simple location selector for all partner vehicle groups, including group 0.
-- NULL = all active owned partner locations; uuid[] = selected active owned locations.
-- Keep ownership, active-location, nonempty-array and 25-location validation.
BEGIN;
CREATE OR REPLACE FUNCTION public.ride24_validate_car_location_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=public,pg_catalog
AS $func$
DECLARE valid_count integer;
BEGIN
  IF NEW.allowed_location_ids IS NOT NULL THEN
    IF cardinality(NEW.allowed_location_ids) NOT BETWEEN 1 AND 25
      OR array_position(NEW.allowed_location_ids,NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_CAR_LOCATION_SCOPE' USING ERRCODE='23514';
    END IF;
    SELECT count(DISTINCT l.id) INTO valid_count
    FROM public.partner_locations l
    WHERE l.id=ANY(NEW.allowed_location_ids)
      AND l.partner_id=NEW.partner_id
      AND l.active=true;
    IF valid_count IS DISTINCT FROM cardinality(NEW.allowed_location_ids) THEN
      RAISE EXCEPTION 'CAR_LOCATION_NOT_OWNED_OR_INACTIVE' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$func$;
COMMENT ON COLUMN public.car_classes.allowed_location_ids IS
  'NULL = every active partner location for any group, including scooters; nonempty UUID array = only the listed owned, active pickup AND return locations.';
COMMIT;