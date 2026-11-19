-- Display snapshot of the booked vehicle group (class A-F, group name,
-- example model, SIPP, transmission). Written by create-booking-request;
-- independent of later catalogue edits or class deactivation.
alter table public.bookings
  add column if not exists vehicle_snapshot jsonb;

-- A client may always read the vehicle class of their OWN bookings, even
-- after that class was deactivated (previously shown as "? Auto").
-- The public policy already exposes every active class with the same columns.
drop policy if exists client_view_own_booking_car_classes on public.car_classes;
create policy client_view_own_booking_car_classes on public.car_classes
  for select to authenticated
  using (exists (
    select 1 from public.bookings b
    where b.car_class_id = car_classes.id and b.client_id = auth.uid()
  ));
