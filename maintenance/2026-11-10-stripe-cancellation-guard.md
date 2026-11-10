# Stripe cancellation guard

Deployed stripe-webhook v82 on 2026-11-10. Previous production source v81 is in backups/stripe-webhook-v81-20261110.ts.

Cancelled status or non-null cancelled_at stops payment confirmation side effects. A conditional UPDATE checks both cancellation markers and the previously read status, so cancellation winning the row update is never overwritten. Late events are recorded in booking_review_queue (provider stripe, session-specific provider_status) with payment metadata; manual_review is set on the booking. No automatic refunds or changes to client cancellation/refund SQL.

The review queue is an internal database queue; this change adds no new admin UI or notification. Concurrent duplicate late events can produce duplicate review rows (existing table has no matching unique key); they cannot reactivate a booking or issue a refund. This narrow patch does not make all voucher/email side effects transactional with cancellation occurring after the paid update.

Validation: 11 isolated handler tests passed: ordinary payment, paid duplicate, voucher recovery, cancelled status, cancellation timestamp, cancellation between read/write, repeated late event, review write failure, lookup failure, missing/invalid signature. Production unsigned POST returned 400. Deployed source retrieved and matched. No real charge/refund was made. Existing test-payment-source-sync.mjs fails on the pre-existing create_checkout_session snapshot hash mismatch (unmodified file).

Rollback: redeploy stripe-webhook using backups/stripe-webhook-v81-20261110.ts as stripe-webhook/index.ts plus stripe-webhook/deno.json containing {"imports":{}}; set explicit import_map_path and verify_jwt=false (Stripe signature authentication remains in handler). No database migration is required.
