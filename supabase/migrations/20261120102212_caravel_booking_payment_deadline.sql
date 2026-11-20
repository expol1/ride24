-- Caravel joins Ride24's shared Stripe-first API payment flow (same as Renteon/Arvent).
-- create_checkout_session requires every API booking to carry payment_deadline
-- (the Stripe session expires at it) and expires_at (auto-expiry), set to now + 45
-- minutes by create-booking-request for other API partners. The Caravel atomic RPC
-- inserted neither, so checkout refused with PAYMENT_DEADLINE_EXPIRED.
--
-- Patch the LIVE caravel_commit_pending_booking definition (which already
-- includes the authenticated second-driver snapshot) by adding exactly these two
-- columns to its single INSERT; every other line stays byte-identical. The block
-- fails unless each anchor occurs exactly once, and is a no-op once applied.
DO $patch$
DECLARE
  d text := pg_get_functiondef('public.caravel_commit_pending_booking(uuid,uuid,jsonb)'::regprocedure);
  cols_old text := E'    client_email,client_phone\n  ) VALUES (';
  cols_new text := E'    client_email,client_phone,payment_deadline,expires_at\n  ) VALUES (';
  vals_old text := E'    p_payload->>''client_email'',p_payload->>''client_phone''\n  ) RETURNING id INTO v_id;';
  vals_new text := E'    p_payload->>''client_email'',p_payload->>''client_phone'',\n    v_now + interval ''45 minutes'',v_now + interval ''45 minutes''\n  ) RETURNING id INTO v_id;';
BEGIN
  IF position('payment_deadline' IN d) > 0 THEN
    RAISE NOTICE 'caravel_commit_pending_booking already sets payment_deadline';
    RETURN;
  END IF;
  IF (length(d) - length(replace(d, cols_old, ''))) / length(cols_old) <> 1 OR
     (length(d) - length(replace(d, vals_old, ''))) / length(vals_old) <> 1 THEN
    RAISE EXCEPTION 'CARAVEL_COMMIT_PATCH_ANCHOR_NOT_UNIQUE';
  END IF;
  EXECUTE replace(replace(d, cols_old, cols_new), vals_old, vals_new);
END $patch$;
