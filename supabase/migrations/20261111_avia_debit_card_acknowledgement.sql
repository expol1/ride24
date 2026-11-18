ALTER TABLE public.bookings
 ADD COLUMN IF NOT EXISTS avia_debit_card_acknowledged boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.bookings.avia_debit_card_acknowledged IS
 'Only a boolean acknowledgement of AVIA physical personal bank debit card requirement. No payment card data stored.';
