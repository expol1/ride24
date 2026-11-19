# Message to Caravel — for Ride24 approval (NOT SENT; Gmail draft to api@caravel.gr)

**Subject:** Ride24 — certification run 15adba20 report, production access and EN v4 terms

Hello,

On our self-serve sandbox account (18 Nov 2026) we completed:

1. Webhook HMAC self-test — POST /_certification/hmac-self-test returned verified: true
   (request_id req_LrHmSwCowGN6twkc, recorded 2026-11-18T15:49:18Z).
2. Hosted certification run 15adba20-a018-4398-b460-4e335e846059 — all ten phases executed
   (15:52:49Z–15:56:07Z), key on every request including capabilities, both suppliers.
3. Independent recomputation of content_hash (rule in TermsDocument.content_hash) — matches
   both sandbox documents (…00d1 and …00d3).

Please send us, or confirm on the account page:

A. The verdict and the machine-readable (JSON) report of run 15adba20, including any
   scenario that is FAIL or INCONCLUSIVE and the reason. If a re-run is needed we will do it.
B. Whether our account is now eligible for "Request production", and the legal/trading
   details you need from us for that request.

For the production account (Greece, EUR) we need, before we sell anything:

C. Terms: the current EN document (you named v4, 17 Nov) served by GET /v1/reference/terms
   with the production key — its document_id, version, published_at and content_hash — and
   confirmation that the full clause tree, including the Premium exclusions and the
   administration fee, is inside that document (not only in PDFs).
D. Clause numbers in that document for: (1) glass, (2) tyres and wheels, (3) undercarriage
   exclusions, and (4) the damage/theft administration fee, with its exact amount and currency
   (we understood EUR 100) and when it applies (damage and/or theft, Premium included).
E. Premium cover: that production Premium quotes return deposit 0, excess 0, theft_excess 0,
   tax_inclusive true, and populated covers/excludes for every vehicle group we may sell.
F. Card at pickup: with deposit 0 under Premium, is any credit or debit card required at the
   desk? (Sandbox EUR policy lists deposit_payment_methods ["credit_card"] and deposit_card_rules;
   rules §5.1 mentions charging a card at pickup.) We state this to customers exactly.
G. Payment model: pay_on_arrival with pay_now = 0 for the production supplier(s). Ride24
   collects only its own separate booking fee and never the rental amount.
H. Production identifiers: supplier_id(s), and confirmation that the locations we will sync
   (GET /v1/reference/locations) publish their timezone, and the vehicle groups (opaque
   vehicle_id) available to Ride24.
I. Distribution channel policy for our production account (whoami shows policy "off" in
   sandbox) and whether we must send a distribution_channel code.
J. API version: our key is pinned to 1.67.0 while 1.68.0 is the latest — is an upgrade
   required before production?
K. Settlement: whether a commission statement reconciliation applies to our agreement
   before sign-off.

Until C–G are confirmed in the production API, Caravel offers stay disabled at Ride24.

Kind regards,
Ride24
