CREATE OR REPLACE FUNCTION public.delete_partner_account(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_partner_id UUID;
BEGIN

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required' USING ERRCODE = '22004';
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
        IF auth.uid() IS NULL THEN
            RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
        END IF;
        IF auth.uid() <> p_user_id AND NOT COALESCE(public.is_admin(), FALSE) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT id INTO v_partner_id 
    FROM partners 
    WHERE user_id = p_user_id;

    IF v_partner_id IS NULL THEN
        RETURN;
    END IF;

    -- 1. payments
    DELETE FROM payments 
    WHERE booking_id IN (SELECT id FROM bookings WHERE partner_id = v_partner_id);

    -- 2. vouchers
    DELETE FROM vouchers 
    WHERE booking_id IN (SELECT id FROM bookings WHERE partner_id = v_partner_id);

    -- 3. transactions
    DELETE FROM transactions 
    WHERE booking_id IN (SELECT id FROM bookings WHERE partner_id = v_partner_id);

    -- 4. booking_logs
    DELETE FROM booking_logs 
    WHERE booking_id IN (SELECT id FROM bookings WHERE partner_id = v_partner_id);

    -- 5. bookings
    DELETE FROM bookings WHERE partner_id = v_partner_id;

    -- 6. car_classes
    DELETE FROM car_classes WHERE partner_id = v_partner_id;

    -- 7. partner_locations
    DELETE FROM partner_locations WHERE partner_id = v_partner_id;

    -- 8. partners
    DELETE FROM partners WHERE id = v_partner_id;

    -- 🔥 9. profiles
    DELETE FROM profiles WHERE id = p_user_id;

    -- 🔥 10. auth.users
    DELETE FROM auth.users WHERE id = p_user_id;

END;
$function$;


REVOKE ALL ON FUNCTION public.delete_partner_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_partner_account(uuid) TO authenticated, service_role;

-- Zachowuje API i sciezki plikow. Odczyt prywatnego rachunku: klient wskazany w rezerwacji lub administrator.
ALTER POLICY authenticated_read_receipts ON storage.objects
USING (
  bucket_id = 'receipts'
  AND (
    public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.receipts r
      JOIN public.bookings b ON b.id = r.booking_id
      WHERE b.client_id = (SELECT auth.uid())
        AND (
          r.pdf_url = storage.objects.name
          OR r.pdf_url = 'https://zwyerdeuvyzgkgwglowr.supabase.co/storage/v1/object/public/receipts/' || storage.objects.name
        )
    )
  )
);
