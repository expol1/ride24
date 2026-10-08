CREATE INDEX IF NOT EXISTS idx_car_classes_partner ON public.car_classes USING btree (partner_id);
CREATE INDEX IF NOT EXISTS idx_bookings_partner_id ON public.bookings USING btree (partner_id);

