-- Permit zero-valued catalog placeholders for API-managed car classes only.
-- Rental totals are fetched from live API availability; local classes still need a positive price.
CREATE OR REPLACE FUNCTION public.calculate_car_price()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  partner_discount numeric;
  global_margin numeric;
  partner_is_api boolean;
BEGIN
  IF NEW.public_price IS NULL OR NEW.public_price < 0 THEN
    RAISE EXCEPTION 'Public price must not be negative or null';
  END IF;

  IF NEW.public_price = 0 THEN
    SELECT p.provider_type = 'api', p.discount_percent
      INTO partner_is_api, partner_discount
      FROM public.partners p WHERE p.id = NEW.partner_id;
    IF NOT FOUND OR NEW.is_api_managed IS NOT TRUE OR partner_is_api IS NOT TRUE THEN
      RAISE EXCEPTION 'Public price must be greater than 0 for non-API catalog';
    END IF;
    global_margin := public.get_global_platform_margin();
    IF coalesce(partner_discount, 15) < 0 OR coalesce(partner_discount, 15) > 100
      OR coalesce(global_margin, 25) <= 0 OR coalesce(global_margin, 25) > 100 THEN
      RAISE EXCEPTION 'INVALID_PRICING_CONFIGURATION';
    END IF;
    NEW.partner_discount_percent := coalesce(partner_discount, 15);
    NEW.platform_margin_percent := coalesce(global_margin, 25);
    NEW.partner_net_price := 0;
    NEW.final_customer_price := 0;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT discount_percent INTO partner_discount
    FROM public.partners WHERE id = NEW.partner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner o ID % nie istnieje', NEW.partner_id;
    END IF;
    NEW.partner_discount_percent := coalesce(partner_discount, 15);
  ELSE
    NEW.partner_discount_percent := coalesce(OLD.partner_discount_percent, 10);
  END IF;

  global_margin := public.get_global_platform_margin();
  NEW.platform_margin_percent := coalesce(global_margin, 25);
  IF NEW.partner_discount_percent < 0 OR NEW.partner_discount_percent > 100
    OR NEW.platform_margin_percent <= 0 OR NEW.platform_margin_percent > 100 THEN
    RAISE EXCEPTION 'INVALID_PRICING_CONFIGURATION';
  END IF;

  NEW.partner_net_price := round(
    (NEW.public_price * (1 - NEW.partner_discount_percent / 100.0))::numeric, 2);
  NEW.final_customer_price := round(
    (NEW.partner_net_price * (1 + NEW.platform_margin_percent / 100.0))::numeric, 2);
  RETURN NEW;
END;
$function$;
