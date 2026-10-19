const PRODUCTION_APP = 'pl.ride24.client';
const TEST_APP = 'pl.ride24.client.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function androidPaymentReturnUrl(baseUrl, bookingId, status, appId, language) {
  if (!UUID.test(bookingId)) throw new Error('INVALID_BOOKING');
  const url = new URL('/functions/v1/payment-return', baseUrl);
  url.searchParams.set('status', status === 'success' ? 'success' : 'cancel');
  url.searchParams.set('booking_id', bookingId);
  url.searchParams.set('app', appId === TEST_APP ? 'test' : 'production');
  url.searchParams.set('lang', language === 'en' ? 'en' : 'pl');
  return url.toString();
}

/** HTTPS bridge keeps a usable button even when a browser blocks automatic app opening. */
export function paymentReturnBridgeUrl(requestUrl) {
  const source = new URL(requestUrl);
  const id = source.searchParams.get('booking_id') || '';
  if (!UUID.test(id)) throw new Error('INVALID_BOOKING');
  const target = new URL('https://ride24.pl/auth/payment-return.html');
  target.searchParams.set('status', source.searchParams.get('status') === 'success' ? 'success' : 'cancel');
  target.searchParams.set('booking_id', id);
  target.searchParams.set('app', source.searchParams.get('app') === 'test' ? 'test' : 'production');
  target.searchParams.set('lang', source.searchParams.get('lang') === 'en' ? 'en' : 'pl');
  return target.toString();
}
