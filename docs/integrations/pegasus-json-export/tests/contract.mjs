export const PEGASUS_PARTNER = 'B61DFC7B';
export function validateBooking(item) {
  const errors = [];
  if (!item || typeof item !== 'object') return ['invalid booking'];
  if (!/^[0-9a-f-]{36}$/i.test(item.bookingId ?? '')) errors.push('invalid bookingId');
  if (!['paid','cancelled'].includes(item.status)) errors.push('invalid status');
  if (!Number.isSafeInteger(item.revision) || item.revision < 1) errors.push('missing monotonic revision');
  if (!item.lastModifiedAt || Number.isNaN(Date.parse(item.lastModifiedAt))) errors.push('invalid lastModifiedAt');
  if (!item.category?.code) errors.push('missing category code');
  if (item.vehicleId !== null) errors.push('vehicle must remain unassigned');
  if (!['EUR','USD'].includes(item.rental?.currency)) errors.push('invalid currency');
  if (!Number.isFinite(item.rental?.amountPayableToPartner) || item.rental.amountPayableToPartner < 0) errors.push('invalid supplier amount');
  if (typeof item.rental?.extrasIncludedInAmount !== 'boolean') errors.push('unknown extras inclusion');
  if (item.status === 'cancelled' && !item.cancelledAt) errors.push('missing cancellation timestamp');
  return errors;
}
export function applyVersioned(current, incoming) {
  const errors=validateBooking(incoming);
  if(errors.length) return {outcome:'rejected',errors};
  if(!current) return {outcome:'created',record:structuredClone(incoming)};
  if(current.bookingId!==incoming.bookingId) return {outcome:'rejected',errors:['bookingId mismatch']};
  if(incoming.revision < current.revision) return {outcome:'stale',record:current};
  if(incoming.revision === current.revision) {
    if(JSON.stringify(current) === JSON.stringify(incoming)) return {outcome:'duplicate',record:current};
    return {outcome:'conflict',errors:['same revision with different content']};
  }
  return {outcome:'updated',record:structuredClone(incoming)};
}
