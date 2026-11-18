// Fail closed: an HTTP 2xx or "pending" response is not proof of supplier cancellation.
// Safe for legacy provider adapters as well as the payment-first API workflow.
export function assertSupplierCancellation(response, expectedReference) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || response.status !== 'cancelled') {
    throw new Error('API_CANCEL_NOT_CONFIRMED');
  }
  const reference = response.booking_reference || response.reference;
  if (typeof expectedReference !== 'string' || !expectedReference.trim()
      || typeof reference !== 'string' || reference !== expectedReference) {
    throw new Error('API_CANCEL_REFERENCE_MISMATCH');
  }
  return true;
}
