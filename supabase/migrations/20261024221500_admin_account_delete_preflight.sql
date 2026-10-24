-- Preflight only. Never delete bookings, payments, partners or Auth through SQL.
-- The privileged Edge Function performs the Auth Admin API deletion after this guard.
CREATE OR REPLACE FUNCTION public.admin_account_delete_preflight(p_uid uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  p_role text;
  p_requested boolean;
  p_partner public.partners%ROWTYPE;
  p_n int;
  blockers text[] := ARRAY[]::text[];
BEGIN
  IF current_setting('role',true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  SELECT role::text,deletion_requested INTO p_role,p_requested
  FROM public.profiles WHERE id=p_uid;
  IF p_role IS NULL THEN
    RETURN jsonb_build_object('eligible',false,'blockers',jsonb_build_array('Nie znaleziono profilu.'));
  END IF;
  IF p_role NOT IN ('client','partner') THEN
    blockers:=array_append(blockers,'Nie można usunąć konta administratora ani innej roli.');
  ELSIF p_role='client' AND p_requested IS DISTINCT FROM true THEN
    blockers:=array_append(blockers,'Klient nie zgłosił usunięcia konta.');
  ELSIF p_role='partner' THEN
    SELECT * INTO p_partner FROM public.partners WHERE user_id=p_uid;
    IF NOT FOUND OR p_partner.account_status NOT IN ('deleted','disabled')
       OR p_partner.active IS TRUE THEN
      blockers:=array_append(blockers,'Najpierw oznacz partnera jako usuniętego lub wyłączonego. Status pending nie jest wnioskiem o usunięcie.');
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.bookings WHERE client_id=p_uid) THEN
    blockers:=array_append(blockers,'Klient ma historię rezerwacji; zachowaj dokumentację i rozpatrz żądanie indywidualnie.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_logs WHERE changed_by=p_uid) THEN
    blockers:=array_append(blockers,'Użytkownik figuruje w dzienniku rezerwacji.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.social_connections WHERE user_id=p_uid) THEN
    blockers:=array_append(blockers,'Konto ma powiązane połączenia społecznościowe.');
  END IF;
  IF EXISTS(SELECT 1 FROM storage.objects WHERE owner_id=p_uid::text) THEN
    blockers:=array_append(blockers,'Konto posiada pliki Storage. Bezpiecznie usuń jego własne pliki przed ponowieniem.');
  END IF;
  IF p_role='partner' AND p_partner.id IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.bookings WHERE partner_id=p_partner.id) THEN
      blockers:=array_append(blockers,'Wypożyczalnia ma historię rezerwacji i rozliczeń.');
    END IF;
    IF EXISTS(SELECT 1 FROM public.partner_extras WHERE partner_id=p_partner.id) THEN
      blockers:=array_append(blockers,'Wypożyczalnia ma przypisane dodatki wymagające kontrolowanego usunięcia.');
    END IF;
    IF EXISTS(SELECT 1 FROM public.partner_time_fees WHERE partner_id=p_partner.id)
       OR EXISTS(SELECT 1 FROM public.partner_time_blocks WHERE partner_id=p_partner.id)
       OR EXISTS(SELECT 1 FROM public.partner_conditional_fees WHERE partner_id=p_partner.id) THEN
      blockers:=array_append(blockers,'Wypożyczalnia ma reguły opłat/czasu wymagające kontrolowanego usunięcia.');
    END IF;
  END IF;
  RETURN jsonb_build_object('eligible',cardinality(blockers)=0,'role',p_role,'blockers',to_jsonb(blockers));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_account_delete_preflight(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_account_delete_preflight(uuid) TO service_role;
