-- Optional, information-only seasonal rental preference for partner offers.
-- The existing partners.min_rental_days remains the sole enforced booking minimum.
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS seasonal_min_rental_days integer,
  ADD COLUMN IF NOT EXISTS seasonal_min_rental_months integer[] NOT NULL DEFAULT ARRAY[]::integer[];

ALTER TABLE public.partners
  ADD CONSTRAINT partners_seasonal_min_days_range
    CHECK (seasonal_min_rental_days IS NULL OR seasonal_min_rental_days BETWEEN 1 AND 366),
  ADD CONSTRAINT partners_seasonal_min_months_valid
    CHECK (seasonal_min_rental_months <@ ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::integer[] AND cardinality(seasonal_min_rental_months) <= 12),
  ADD CONSTRAINT partners_seasonal_min_consistent
    CHECK ((cardinality(seasonal_min_rental_months) = 0 AND seasonal_min_rental_days IS NULL)
        OR (cardinality(seasonal_min_rental_months) > 0 AND seasonal_min_rental_days IS NOT NULL));

COMMENT ON COLUMN public.partners.seasonal_min_rental_days IS
  'Optional informational seasonal preference; does not block reservations or change partners.min_rental_days.';
COMMENT ON COLUMN public.partners.seasonal_min_rental_months IS
  'Months 1-12 by pickup date in which the informational seasonal rental preference applies.';
