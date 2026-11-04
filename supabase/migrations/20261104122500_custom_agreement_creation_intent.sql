-- A pending custom-PDF upload must never accidentally fall back to the
-- standard agreement while the administrator is creating a partner account.
ALTER TABLE public.partners
  ADD COLUMN IF NOT EXISTS custom_agreement_pending boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_direct_partner_agreement_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF current_user IN ('authenticated','anon') AND NOT EXISTS (
    SELECT 1 FROM public.profiles pr
    WHERE pr.id = (SELECT auth.uid()) AND pr.role = 'admin'
  ) THEN
    IF NEW.agreement_accepted IS DISTINCT FROM OLD.agreement_accepted
       OR NEW.agreement_accepted_at IS DISTINCT FROM OLD.agreement_accepted_at
       OR NEW.agreement_snapshot IS DISTINCT FROM OLD.agreement_snapshot
       OR NEW.agreement_version IS DISTINCT FROM OLD.agreement_version
       OR NEW.agreement_ip IS DISTINCT FROM OLD.agreement_ip
       OR NEW.custom_agreement_pending IS DISTINCT FROM OLD.custom_agreement_pending THEN
       RAISE EXCEPTION 'AGREEMENT_REQUIRES_SERVER_SIGNING';
    END IF;
    IF OLD.agreement_accepted IS DISTINCT FROM TRUE AND
      (NEW.active IS DISTINCT FROM OLD.active OR
       NEW.account_status IS DISTINCT FROM OLD.account_status) THEN
       RAISE EXCEPTION 'PENDING_ACCOUNT_REQUIRES_SERVER_ACTIVATION';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Existing contract signature: explicit pending-custom mode and actual PDF
-- assignments both block standard signing.
CREATE OR REPLACE FUNCTION public.partner_accept_agreement(
  p_version text, p_snapshot text, p_ip text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_partner public.partners%rowtype;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF length(coalesce(p_snapshot,'')) < 50 THEN RAISE EXCEPTION 'INVALID_AGREEMENT_SNAPSHOT'; END IF;
  SELECT * INTO v_partner FROM public.partners p
  WHERE p.user_id = (SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AGREEMENT_NOT_AVAILABLE'; END IF;
  IF v_partner.custom_agreement_pending OR
     EXISTS (SELECT 1 FROM public.partner_agreement_documents d
       WHERE d.partner_id = v_partner.id) THEN
    RAISE EXCEPTION 'CUSTOM_AGREEMENT_ASSIGNED';
  END IF;
  UPDATE public.partners
  SET agreement_accepted = true,
      agreement_accepted_at = now(),
      agreement_version = left(coalesce(p_version,'v1.1'),30),
      agreement_snapshot = p_snapshot,
      agreement_ip = left(coalesce(p_ip,''),100),
      profile_completed = true,
      active = true,
      account_status = 'active'
  WHERE id = v_partner.id AND agreement_accepted = false
    AND profile_completed = true AND rental_terms_url IS NOT NULL
    AND rental_rules_url IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'AGREEMENT_NOT_AVAILABLE'; END IF;
  RETURN true;
END $$;

-- On successful custom signing clear the temporary upload-intent barrier.
CREATE OR REPLACE FUNCTION public.partner_accept_custom_agreement(
  p_sha256 text, p_ip text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_partner public.partners%rowtype;
  v_doc public.partner_agreement_documents%rowtype;
  v_time timestamptz := clock_timestamp();
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT * INTO v_partner FROM public.partners p
  WHERE p.user_id = (SELECT auth.uid()) FOR UPDATE;
  IF NOT FOUND OR v_partner.agreement_accepted IS DISTINCT FROM false
    OR v_partner.profile_completed IS DISTINCT FROM true
    OR v_partner.rental_terms_url IS NULL
    OR v_partner.rental_rules_url IS NULL THEN
    RAISE EXCEPTION 'AGREEMENT_NOT_AVAILABLE';
  END IF;
  SELECT * INTO v_doc FROM public.partner_agreement_documents d
  WHERE d.partner_id = v_partner.id;
  IF NOT FOUND OR v_doc.sha256 <> lower(coalesce(p_sha256,'')) THEN
    RAISE EXCEPTION 'CUSTOM_AGREEMENT_VERSION_MISMATCH';
  END IF;
  UPDATE public.partners SET
    agreement_accepted = true,
    agreement_accepted_at = v_time,
    agreement_version = 'custom_pdf_v1',
    agreement_snapshot = jsonb_build_object(
      'version','custom_pdf_v1','source','custom_pdf',
      'partner_id',v_partner.id,'sha256',v_doc.sha256,
      'filename',v_doc.original_filename,'signed_at',v_time
    )::text,
    agreement_ip = left(coalesce(p_ip,''),100),
    custom_agreement_pending = false,
    profile_completed = true,
    active = true,
    account_status = 'active'
  WHERE id = v_partner.id AND agreement_accepted = false;
  IF NOT FOUND THEN RAISE EXCEPTION 'AGREEMENT_NOT_AVAILABLE'; END IF;
  RETURN true;
END $$;
