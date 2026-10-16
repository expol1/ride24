import { cents, partnerItems } from './booking-items.mjs';

export function partnerBookingProjection(booking) {
  return {
    id: booking.id,
    items: booking.pricing_items_snapshot?.version === 2 ? partnerItems(booking.pricing_items_snapshot) : [],
    deposit_cents: booking.deposit_snapshot == null ? null : cents(booking.deposit_snapshot),
  };
}
