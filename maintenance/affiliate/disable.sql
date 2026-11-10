-- Immediate reversible kill switch. No booking/payment/refund changes or lost history.
update ride24_affiliate.settings set enabled=false where id;
