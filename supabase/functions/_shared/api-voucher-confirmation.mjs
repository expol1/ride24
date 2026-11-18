// Only a finished voucher response may close a paid supplier-confirmed workflow.
// A 202 generating response is progress, not proof of voucher/email completion.
export function assertVoucherCompleted(httpStatus, body) {
 if (httpStatus !== 200 || !body || body.success !== true ||
     body.skipped === true || body.generating === true ||
     typeof body.reservation_code !== 'string' || !body.reservation_code.trim()) {
   throw new Error('API_CONFIRMATION_DELIVERY_INCOMPLETE');
 }
 return true;
}
