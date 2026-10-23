-- Ride24 platform-wide mandatory terms: no credit card and no card hold.
-- This is a database invariant, not an optional vehicle/partner feature.
CREATE OR REPLACE FUNCTION public.ride24_enforce_cardless_features()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.features := (
    CASE
      WHEN jsonb_typeof(NEW.features) = 'object' THEN NEW.features
      ELSE '{}'::jsonb
    END
    - 'creditCardRequired'
    - 'requiresCreditCard'
    - 'cardHoldRequired'
    - 'requiresCardHold'
  ) || '{"noCreditCard":true,"noCardHold":true}'::jsonb;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.ride24_enforce_cardless_features() FROM PUBLIC;

DROP TRIGGER IF EXISTS ride24_enforce_cardless_features_before_write ON public.car_classes;
CREATE TRIGGER ride24_enforce_cardless_features_before_write
BEFORE INSERT OR UPDATE OF features ON public.car_classes
FOR EACH ROW
EXECUTE FUNCTION public.ride24_enforce_cardless_features();

ALTER TABLE public.car_classes
  ALTER COLUMN features SET DEFAULT '{"noCreditCard":true,"noCardHold":true}'::jsonb;

-- The trigger normalizes existing vehicles without changing rental prices or any other terms.
UPDATE public.car_classes SET features = features
WHERE features IS NULL
   OR features->'noCreditCard' IS DISTINCT FROM 'true'::jsonb
   OR features->'noCardHold' IS DISTINCT FROM 'true'::jsonb
   OR features ?| ARRAY['creditCardRequired','requiresCreditCard','cardHoldRequired','requiresCardHold'];

ALTER TABLE public.car_classes
  ADD CONSTRAINT ride24_car_classes_no_credit_card_or_hold
  CHECK (
    features IS NOT NULL
    AND jsonb_typeof(features) = 'object'
    AND features->'noCreditCard' = 'true'::jsonb
    AND features->'noCardHold' = 'true'::jsonb
    AND NOT (features ?| ARRAY['creditCardRequired','requiresCreditCard','cardHoldRequired','requiresCardHold'])
  );

COMMENT ON CONSTRAINT ride24_car_classes_no_credit_card_or_hold ON public.car_classes
  IS 'Ride24 requires no credit card and no credit-card authorization/hold for every existing and future vehicle, including API imports.';
