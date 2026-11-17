-- Additive column for City Rent's capped daily Green Card. Existing extras retain uncapped behavior.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
alter table public.partner_extras
  add column if not exists max_total_amount numeric(12,2);
alter table public.partner_extras
  add constraint partner_extras_capped_daily_only
  check (max_total_amount is null or
    (max_total_amount > 0 and max_total_amount <= 1000000
     and billing='day' and max_quantity=1));
comment on column public.partner_extras.max_total_amount is
  'Optional cap on the partner subtotal for a daily-billed extra, per rental. Standard Ride24 platform margin still applies to the capped subtotal.';
commit;
